// Orchestration, 5. LOGGER and 6. EQUITY. Paper trading only. Runs in Node and in the browser.
import { CONFIG } from './config.js';
import { discoverMints, fetchPairs, fetchRugReport, simulateSell } from './data.js';
import { universeGate, reportGate, scanner, rugCheck, sizer, estSlippage, manage, isChasing } from './agents.js';

const FEE = 0.0025; // per side, approximates DEX + priority fees

export class Engine {
  constructor({ start, end, cfg = CONFIG, onPersist = null } = {}) {
    this.cfg = cfg;
    this.onPersist = onPersist;
    this.start = start;
    this.end = end;
    this.state = {
      mode: 'PAPER', startBalance: cfg.startBalance, cash: cfg.startBalance,
      peakEquity: cfg.startBalance, lossStreak: 0, paused: null, finished: false,
      positions: {}, closed: [], log: [], curve: [{ t: Date.now(), eq: cfg.startBalance }],
      agents: { SCANNER: 'idle', 'RUG CHECK': 'armed', SIZER: 'idle', EXECUTOR: 'idle', LOGGER: 'on', EQUITY: 'on' },
      stats: { scans: 0, candidates: 0, filtered: 0 }, session: { start, end }, recap: null,
    };
    this.prices = {};
    this.holders = new Map(); // mint -> last holder count
    this.reports = new Map(); // mint -> { at, report }
    this.cooldown = new Map(); // mint -> until ts, avoid re-checking rejects every scan
  }

  // ---------- 5. LOGGER ----------
  log(kind, msg, extra = {}) {
    const line = { t: new Date().toISOString(), kind, msg, ...extra };
    this.state.log.push(line);
    if (this.state.log.length > 2000) this.state.log.shift();
    console.log(`${line.t.slice(11, 19)} ${kind.padEnd(8)} ${msg}`);
    this.persist();
  }

  persist() {
    try { this.onPersist?.(this.state, this.prices); } catch { /* non-fatal */ }
  }

  // ---------- 6. EQUITY ----------
  equity() {
    let eq = this.state.cash;
    for (const p of Object.values(this.state.positions)) eq += p.qty * (this.prices[p.mint] || p.entry);
    return eq;
  }

  markEquity() {
    const eq = this.equity();
    this.state.peakEquity = Math.max(this.state.peakEquity, eq);
    this.state.curve.push({ t: Date.now(), eq: +eq.toFixed(2) });
    if (this.state.curve.length > 5000) this.state.curve.shift();
    const dd = (1 - eq / this.state.peakEquity) * 100;
    if (!this.state.paused && dd >= this.cfg.rules.dailyDrawdownPct) {
      this.state.paused = `drawdown -${dd.toFixed(1)}% from peak $${this.state.peakEquity.toFixed(2)}`;
      this.log('PAUSE', `Daily drawdown limit hit: ${this.state.paused}. No new entries.`);
    }
    return eq;
  }

  async report(mint, maxAgeMs = 120_000) {
    const c = this.reports.get(mint);
    if (c && Date.now() - c.at < maxAgeMs) return c.report;
    const report = await fetchRugReport(mint);
    this.reports.set(mint, { at: Date.now(), report });
    return report;
  }

  filtered(pair, reason) {
    this.state.stats.filtered++;
    this.cooldown.set(pair.baseToken.address, Date.now() + 5 * 60_000);
    this.log('FILTERED', `${pair.baseToken.symbol}: ${reason}`, { mint: pair.baseToken.address });
  }

  // ---------- SCAN LOOP ----------
  async scan() {
    if (this.state.finished) return;
    const s = this.state;
    s.stats.scans++;
    s.agents.SCANNER = 'scanning';
    const mints = (await discoverMints()).filter((m) => (this.cooldown.get(m) || 0) < Date.now() && !s.positions[m]);
    const pairs = await fetchPairs(mints);
    s.agents.SCANNER = `watching ${pairs.size} pairs`;

    for (const pair of pairs.values()) {
      const mint = pair.baseToken.address;
      const gate = universeGate(pair);
      if (gate) { this.cooldown.set(mint, Date.now() + 5 * 60_000); continue; } // silent: noise
      s.stats.candidates++;

      let report;
      try { report = await this.report(mint, 60_000); } catch (e) { continue; }
      const rg = reportGate(report);
      if (rg) { this.filtered(pair, rg); continue; }

      const holders = Number(report.totalHolders) || 0;
      const sc = scanner(pair, holders, this.holders.get(mint) || 0);
      this.holders.set(mint, holders);
      if (!sc.flagged) continue; // keep watching, holder growth needs two looks
      if (isChasing(pair)) { this.filtered(pair, `chasing: +${pair.priceChange.h1}% 1h, no pullback`); continue; }
      if (s.paused) { this.log('FILTERED', `${pair.baseToken.symbol}: paused (${s.paused})`); continue; }

      const eq = this.equity();
      const size = sizer(eq, Object.keys(s.positions).length, s.lossStreak, sc.signals.length);
      if (size <= 0) { s.agents.SIZER = 'max positions open'; continue; }

      s.agents['RUG CHECK'] = `checking ${pair.baseToken.symbol}`;
      const price = Number(pair.priceUsd);
      const rawAmt = (size / price) * 10 ** (report.token?.decimals ?? 6);
      const sell = await simulateSell(mint, rawAmt);
      const rc = rugCheck(report, sell);
      s.agents['RUG CHECK'] = 'armed';
      if (!rc.pass) { this.filtered(pair, `RUG CHECK FAIL: ${rc.fails.join(', ')}`); continue; }

      this.enter(pair, report, size, sc.signals, rc);
    }
    s.agents.SCANNER = `idle (${pairs.size} pairs last scan)`;
    this.markEquity();
  }

  // ---------- 4. EXECUTOR ----------
  enter(pair, report, size, signals, rc) {
    const s = this.state;
    const mint = pair.baseToken.address;
    const liq = Number(pair.liquidity.usd);
    const half = size / this.cfg.executor.entryParts;
    const slip = estSlippage(half, liq);
    if (slip > this.cfg.executor.maxSlippage) return this.filtered(pair, `slippage ${(slip * 100).toFixed(1)}% > 2.5%`);
    const fill = Number(pair.priceUsd) * (1 + slip);
    const qty = (half * (1 - FEE)) / fill;
    s.cash -= half;
    s.positions[mint] = {
      mint, symbol: pair.baseToken.symbol, url: pair.url, entry: fill, qty, initialQty: qty, cost: half,
      plannedSize: size, part2: size - half, openedAt: Date.now(), peak: fill, tpHit: [false, false],
      liqAtEntry: liq, creatorAtEntry: Number(report.creatorBalance) || 0, realized: 0, signals,
    };
    this.prices[mint] = Number(pair.priceUsd);
    s.agents.EXECUTOR = `in ${pair.baseToken.symbol}`;
    this.log('ENTER', `${pair.baseToken.symbol} part 1/2 $${half.toFixed(2)} @ ${fill.toPrecision(4)} ` +
      `| signals: ${signals.join(' + ')} | dev ${rc.devPct.toFixed(1)}% top10 ${rc.top10.toFixed(0)}%`,
    { mint, size: half, fill });
  }

  sell(pos, qty, price, reason) {
    const s = this.state;
    const slip = estSlippage(qty * price, pos.liqNow || pos.liqAtEntry);
    const fill = price * (1 - Math.min(slip, 0.5));
    const proceeds = qty * fill * (1 - FEE);
    const costShare = pos.cost * (qty / pos.qty);
    pos.cost -= costShare;
    pos.qty -= qty;
    pos.realized += proceeds - costShare;
    s.cash += proceeds;
    this.log('EXIT', `${pos.symbol} ${reason}: sold $${proceeds.toFixed(2)} @ ${fill.toPrecision(4)} ` +
      `| PnL ${proceeds - costShare >= 0 ? '+' : ''}$${(proceeds - costShare).toFixed(2)}`,
    { mint: pos.mint, size: proceeds, fill, pnl: proceeds - costShare });
    if (pos.qty * fill < 0.01) this.close(pos);
  }

  close(pos) {
    const s = this.state;
    delete s.positions[pos.mint];
    const total = pos.realized;
    s.lossStreak = total < 0 ? s.lossStreak + 1 : 0;
    s.closed.push({ symbol: pos.symbol, mint: pos.mint, pnl: +total.toFixed(2), openedAt: pos.openedAt, closedAt: Date.now() });
    s.agents.EXECUTOR = Object.keys(s.positions).length ? `in ${Object.values(s.positions).map((p) => p.symbol).join(', ')}` : 'idle';
    s.agents.SIZER = s.lossStreak >= this.cfg.sizer.lossStreak ? `scaled -50% (${s.lossStreak} losses)` : 'normal';
    this.markEquity();
  }

  async tick() {
    const s = this.state;
    const open = Object.values(s.positions);
    if (!open.length) return;
    const pairs = await fetchPairs(open.map((p) => p.mint));
    for (const pos of open) {
      const pair = pairs.get(pos.mint);
      if (!pair) continue;
      const price = Number(pair.priceUsd);
      this.prices[pos.mint] = price;
      pos.liqNow = Number(pair.liquidity?.usd) || 0;

      // part 2 of the split entry: only if price held up
      if (pos.part2 > 0 && Date.now() - pos.openedAt > 20_000) {
        const add = Math.min(pos.part2, s.cash);
        if (price >= pos.entry * 0.97 && add > 0 && estSlippage(add, pos.liqNow) <= this.cfg.executor.maxSlippage) {
          const fill = price * (1 + estSlippage(add, pos.liqNow));
          const q = (add * (1 - FEE)) / fill;
          pos.entry = (pos.entry * pos.qty + fill * q) / (pos.qty + q);
          pos.qty += q; pos.initialQty += q; pos.cost += add; s.cash -= add;
          this.log('ENTER', `${pos.symbol} part 2/2 $${add.toFixed(2)} @ ${fill.toPrecision(4)}`, { mint: pos.mint, size: add, fill });
        } else {
          this.log('ENTER', `${pos.symbol} part 2/2 cancelled (price/slippage)`);
        }
        pos.plannedSize -= pos.part2; pos.part2 = 0;
      }

      const flags = { lpPulled: pos.liqNow < pos.liqAtEntry * 0.5 };
      try {
        const r = await this.report(pos.mint, 60_000);
        flags.devSold = pos.creatorAtEntry > 0 && Number(r.creatorBalance) < pos.creatorAtEntry * 0.5;
      } catch { /* keep last known */ }

      for (const a of manage(pos, price, Date.now(), flags)) {
        if (!s.positions[pos.mint]) break;
        const qty = a.sellPctOfInitial ? Math.min(pos.qty, pos.initialQty * a.sellPctOfInitial) : pos.qty;
        this.sell(pos, qty, price, a.reason);
      }
    }
    this.markEquity();
  }

  // ---------- 07:00 RECAP ----------
  finish() {
    for (const pos of Object.values(this.state.positions)) this.sell(pos, pos.qty, this.prices[pos.mint] || pos.entry, 'session end');
    const s = this.state;
    const end = this.equity();
    const byCoin = {};
    for (const c of s.closed) byCoin[c.symbol] = (byCoin[c.symbol] || 0) + c.pnl;
    const sorted = [...s.closed].sort((a, b) => b.pnl - a.pnl);
    s.recap = {
      start: s.startBalance, end: +end.toFixed(2), pnlPct: +((end / s.startBalance - 1) * 100).toFixed(1),
      totalTrades: s.closed.length, wins: s.closed.filter((c) => c.pnl > 0).length,
      best: sorted[0] || null, worst: sorted[sorted.length - 1] || null,
      top3: Object.entries(byCoin).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([symbol, pnl]) => ({ symbol, pnl: +pnl.toFixed(2) })),
    };
    s.finished = true;
    Object.keys(s.agents).forEach((k) => { s.agents[k] = 'stopped'; });
    this.log('RECAP', JSON.stringify(s.recap));
  }
}

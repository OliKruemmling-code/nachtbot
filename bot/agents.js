// The six agents as pure, testable functions. No I/O here.
import { CONFIG } from './config.js';

const num = (v) => Number(v) || 0;

/** Universe gate on the DexScreener pair alone (cheap, before any API call). */
export function universeGate(pair, now = Date.now(), cfg = CONFIG.universe) {
  const ageH = (now - num(pair.pairCreatedAt)) / 3_600_000;
  if (!pair.pairCreatedAt || ageH > cfg.maxPairAgeHours) return `too old (${ageH.toFixed(1)}h)`;
  if (!cfg.dexes.includes(pair.dexId)) return `dex ${pair.dexId} not allowed`;
  if (num(pair.liquidity?.usd) < cfg.minLiquidityUsd) return `liq $${Math.round(num(pair.liquidity?.usd))}`;
  if (num(pair.volume?.m5) < cfg.minVolume5mUsd) return `5m vol $${Math.round(num(pair.volume?.m5))}`;
  return null;
}

/** Holder and authority gate on the RugCheck report. */
export function reportGate(report, cfg = CONFIG.universe) {
  if (report.freezeAuthority || report.token?.freezeAuthority) return 'freeze authority set';
  if (report.mintAuthority || report.token?.mintAuthority) return 'mint authority open';
  if (num(report.totalHolders) < cfg.minHolders) return `holders ${num(report.totalHolders)}`;
  if (lpLockedPct(report) < CONFIG.rugCheck.minLpLockedPct) return `LP unlocked (${lpLockedPct(report).toFixed(0)}%)`;
  return null;
}

export function lpLockedPct(report) {
  return Math.max(0, ...(report.markets || []).map((m) => num(m.lp?.lpLockedPct)));
}

/** 1. SCANNER: flags only, never trades. */
export function scanner(pair, holdersNow, holdersPrev, cfg = CONFIG.scanner) {
  const signals = [];
  const v5 = num(pair.volume?.m5);
  const avg5 = num(pair.volume?.h1) / 12;
  if (avg5 > 0 && v5 > cfg.volumeSpikeMult * avg5) signals.push(`volume spike ${(v5 / avg5).toFixed(1)}x`);

  const b = num(pair.txns?.m5?.buys);
  const s = num(pair.txns?.m5?.sells);
  if (b + s >= cfg.minTxns5m && b / (b + s) > cfg.minBuyRatio) signals.push(`buy ratio ${Math.round((100 * b) / (b + s))}%`);

  if (holdersPrev > 0) {
    const g = ((holdersNow - holdersPrev) / holdersPrev) * 100;
    if (g >= cfg.holderGrowthPct) signals.push(`holders +${g.toFixed(0)}%`);
  }
  return { signals, flagged: signals.length >= cfg.minSignals };
}

/** 2. RUG CHECK: nothing executes without PASS. */
export function rugCheck(report, sellSim, cfg = CONFIG.rugCheck) {
  const fails = [];
  if (report.rugged) fails.push('marked rugged');

  const supply = num(report.token?.supply);
  const devPct = supply > 0 ? (num(report.creatorBalance) / supply) * 100 : 0;
  if (devPct >= cfg.maxDevPct) fails.push(`dev ${devPct.toFixed(1)}%`);

  const known = report.knownAccounts || {};
  const isPool = (a) => known[a] && known[a].type !== 'CREATOR';
  const top10 = (report.topHolders || [])
    .filter((h) => !isPool(h.owner) && !isPool(h.address))
    .slice(0, 10)
    .reduce((sum, h) => sum + num(h.pct), 0);
  if (top10 >= cfg.maxTop10Pct) fails.push(`top10 ${top10.toFixed(0)}%`);

  const insiders = (report.insiderNetworks || []).length;
  const bundleRisk = (report.risks || []).some((r) => /bundl|insider/i.test(r.name || ''));
  if (insiders > cfg.maxInsiderNetworks || bundleRisk) fails.push('bundled/insider launch');

  const lp = lpLockedPct(report);
  if (lp < cfg.minLpLockedPct) fails.push(`LP locked ${lp.toFixed(0)}%`);

  if ((report.risks || []).some((r) => r.level === 'danger')) fails.push('danger risk flag');
  if (!sellSim?.ok) fails.push('honeypot: sell simulation failed');
  else if (sellSim.impact > CONFIG.executor.maxSlippage) fails.push(`sell impact ${(sellSim.impact * 100).toFixed(1)}%`);

  return { pass: fails.length === 0, fails, devPct, top10 };
}

/** 3. SIZER: percent of current equity, never a fixed ticket. */
export function sizer(equity, openCount, lossStreak, signalCount, cfg = CONFIG.sizer) {
  if (openCount >= cfg.maxOpen || equity <= 0) return 0;
  const conviction = Math.min(1, Math.max(0, (signalCount - 2) / 1)); // 2 signals = min, 3 = max
  let pct = cfg.minPct + (cfg.maxPct - cfg.minPct) * conviction;
  if (lossStreak >= cfg.lossStreak) pct *= cfg.streakScale;
  return +(equity * pct).toFixed(2);
}

/** Simple constant-product slippage estimate for a buy of `usd` into `liqUsd` pool. */
export function estSlippage(usd, liqUsd) {
  const side = liqUsd / 2;
  return side > 0 ? usd / (side + usd) : 1;
}

/** 4. EXECUTOR: decides exits for an open position on each price tick. */
export function manage(pos, price, now, flags = {}, cfg = CONFIG.executor) {
  const actions = [];
  pos.peak = Math.max(pos.peak, price);
  const mult = price / pos.entry;

  if (flags.devSold) return [{ sellPct: 1, reason: 'dev sold' }];
  if (flags.lpPulled) return [{ sellPct: 1, reason: 'LP pulled' }];
  if (mult - 1 <= cfg.hardStop) return [{ sellPct: 1, reason: `hard stop ${((mult - 1) * 100).toFixed(1)}%` }];

  cfg.ladder.forEach((step, i) => {
    if (!pos.tpHit[i] && mult >= step.mult) {
      pos.tpHit[i] = true;
      actions.push({ sellPctOfInitial: step.sellPct, reason: `TP ${step.mult}x` });
    }
  });

  const runnerArmed = pos.tpHit.every(Boolean);
  if (runnerArmed && price <= pos.peak * (1 - cfg.trailingStop)) {
    actions.push({ sellPct: 1, reason: `trailing stop (peak ${(pos.peak / pos.entry).toFixed(2)}x)` });
  } else if (!pos.tpHit[0] && (now - pos.openedAt) / 60_000 >= cfg.timeStopMin) {
    actions.push({ sellPct: 1, reason: `time stop ${cfg.timeStopMin}m` });
  }
  return actions;
}

/** RULE: no chasing coins already +300% in 1h without a pullback. */
export function isChasing(pair, maxPct = CONFIG.rules.maxPump1hPct) {
  const h1 = num(pair.priceChange?.h1);
  const m5 = num(pair.priceChange?.m5);
  return h1 >= maxPct && m5 >= 0;
}

// Public, keyless data sources: DexScreener, RugCheck, Jupiter.
const SOL = 'So11111111111111111111111111111111111111112';

async function getJson(url, timeoutMs = 10_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res.json();
}

const isMint = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

/** Candidate Solana mints from fresh-token feeds. */
export async function discoverMints() {
  const feeds = await Promise.allSettled([
    getJson('https://api.dexscreener.com/token-profiles/latest/v1'),
    getJson('https://api.dexscreener.com/token-boosts/latest/v1'),
    getJson('https://api.rugcheck.xyz/v1/stats/new_tokens'),
    getJson('https://api.rugcheck.xyz/v1/stats/recent'),
    ...[1, 2, 3].map((pg) => getJson(`https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${pg}`)),
    ...[1, 2].map((pg) => getJson(`https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=${pg}`)),
  ]);
  const mints = new Set();
  for (const f of feeds) {
    if (f.status !== 'fulfilled') continue;
    const list = Array.isArray(f.value) ? f.value : (f.value?.data || []).map((d) => ({
      mint: d.relationships?.base_token?.data?.id?.replace(/^solana_/, ''),
    }));
    for (const t of list) {
      if (t.chainId && t.chainId !== 'solana') continue;
      const m = t.tokenAddress || t.mint;
      if (isMint(m)) mints.add(m);
    }
  }
  return [...mints];
}

/** Best (most liquid) pair per mint. DexScreener accepts up to 30 mints per call. */
export async function fetchPairs(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    try {
      const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`);
      for (const p of pairs || []) {
        const m = p.baseToken?.address;
        if (!m || p.quoteToken?.address !== SOL) continue;
        const prev = out.get(m);
        if (!prev || (p.liquidity?.usd || 0) > (prev.liquidity?.usd || 0)) out.set(m, p);
      }
    } catch { /* skip batch, next scan retries */ }
  }
  return out;
}

export async function fetchRugReport(mint) {
  return getJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, 15_000);
}

/** Sell simulation: can tokens be swapped back to SOL, and at what impact? */
export async function simulateSell(mint, rawAmount) {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${SOL}` +
    `&amount=${BigInt(Math.max(1, Math.floor(rawAmount)))}&slippageBps=250`;
  try {
    const q = await getJson(url);
    return { ok: !!q.outAmount && Number(q.outAmount) > 0, impact: Number(q.priceImpactPct || 0) };
  } catch (e) {
    return { ok: false, impact: 1, error: e.message };
  }
}

// All strategy parameters from the overnight prompt, in one place.
const env = globalThis.process?.env || {}; // empty in the browser
export const CONFIG = {
  mode: 'paper', // paper only: no wallet, no real orders
  startBalance: Number(env.START_BALANCE || 70),
  session: { start: env.SESSION_START || '23:00', end: env.SESSION_END || '07:00' },

  universe: {
    maxPairAgeHours: 6,
    dexes: ['pumpswap', 'pumpfun', 'raydium', 'meteora', 'meteoradbc', 'meteoradammv2'],
    minLiquidityUsd: 40_000,
    minVolume5mUsd: 25_000,
    minHolders: 300,
  },

  scanner: {
    volumeSpikeMult: 5, // 5m volume vs. average 5m volume over the last hour
    minBuyRatio: 0.7,
    holderGrowthPct: 10, // growth between scans
    minTxns5m: 10, // buy ratio only counts with enough trades
    minSignals: 2,
  },

  rugCheck: {
    maxDevPct: 5,
    maxTop10Pct: 35,
    minLpLockedPct: 95,
    maxInsiderNetworks: 0,
  },

  sizer: { minPct: 0.2, maxPct: 0.4, maxOpen: 2, lossStreak: 2, streakScale: 0.5 },

  executor: {
    maxSlippage: 0.025,
    entryParts: 2,
    ladder: [
      { mult: 2, sellPct: 0.4 },
      { mult: 4, sellPct: 0.3 },
    ],
    trailingStop: 0.25,
    hardStop: -0.12,
    timeStopMin: 25,
  },

  rules: { maxPump1hPct: 300, dailyDrawdownPct: 30 },

  intervals: { scanMs: 30_000, positionMs: 10_000 },
  dashboardPort: Number(env.PORT || 8787),
  stateFile: env.STATE_FILE || 'data/grok-bot-state.json',
};

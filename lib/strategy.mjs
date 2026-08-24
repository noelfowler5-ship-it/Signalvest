/**
 * Strategy configuration + versioning. Every scored signal and every trade
 * should reference the strategy version that produced it, so historical
 * trades stay attributed to the rules that were active when they were made
 * — changing the weights later must never retroactively reinterpret old
 * decisions.
 */

export const DEFAULT_STRATEGY = Object.freeze({
  id: "sma-rsi-v1",
  version: "1.0",
  name: "SMA20/50 trend + RSI14 momentum",
  description: "Trend via SMA20 vs SMA50, momentum filter via RSI14, volume confirmation, market regime, fundamentals (manual), risk/reward, position sizing.",
  weights: Object.freeze({
    trend: 2,
    momentum: 1,
    volume: 1,
    fundamentals: 2,
    marketRegime: 1,
    riskReward: 2,
    positionSizing: 1
  })
});

export function cloneStrategy(strategy, overrides = {}) {
  return {
    ...strategy,
    ...overrides,
    weights: { ...strategy.weights, ...(overrides.weights || {}) }
  };
}

export function maxPossibleScore(weights) {
  return Object.values(weights).reduce((s, w) => s + Math.abs(Number(w) || 0), 0);
}

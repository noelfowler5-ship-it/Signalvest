/**
 * Shared technical-indicator primitives for the NEW decision/risk/backtest
 * modules (used by scripts/*.mjs and node:test only — Node has no CORS
 * restriction, so importing here is safe).
 *
 * index.html keeps its OWN inline copies of sma/rsi14/atr14/classify (as does
 * scripts/check-signals.mjs), by deliberate project convention — see
 * README.md "Why two copies of the fetch/indicator logic". This file does
 * NOT replace those; it exists only so the new backtest/decision code has a
 * single canonical version instead of a third/fourth copy.
 */

export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function rsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i];
    if (c > 0) avgGain += c; else avgLoss += -c;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0, loss = c < 0 ? -c : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function atr14(highs, lows, closes) {
  const period = 14;
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

export function classify(closes) {
  const s20 = sma(closes, 20), s50 = sma(closes, 50), r = rsi14(closes);
  if (s20 == null || s50 == null || r == null) return null;
  let trend = "flat";
  if (s20 > s50) trend = "up"; else if (s20 < s50) trend = "down";
  let signal = "HOLD";
  if (trend === "up" && r >= 35 && r <= 68) signal = "BUY";
  else if (trend === "up" && r > 68) signal = "HOLD";
  else if (trend === "down" && r < 30) signal = "HOLD";
  else if (trend === "down") signal = "AVOID";
  return { trend, rsi: r, signal, sma20: s20, sma50: s50 };
}

/**
 * Indicator values computed using ONLY bars up to and including index i
 * (no lookahead). Returns null entries until enough history exists.
 * Used by the backtester to build a point-in-time series instead of one
 * global classify() call over the whole array.
 */
export function classifySeries(bars) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    const upToI = closes.slice(0, i + 1);
    const cls = classify(upToI);
    const atr = atr14(highs.slice(0, i + 1), lows.slice(0, i + 1), upToI);
    out.push(cls ? { ...cls, atr } : null);
  }
  return out;
}

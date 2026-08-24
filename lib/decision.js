/**
 * Trade decision engine: turns raw technicals into a transparent, weighted
 * score plus a plain-English explanation. Never emits a bare "BUY" — every
 * call returns the positives, the risks, and the price levels that would
 * invalidate the idea. Nothing here places or suggests placing an order;
 * `approve/reject/watch` (in index.html) only records the human's decision.
 */

import { atr14 } from "./indicators.js";
import { maxPossibleScore } from "./strategy.js";

/**
 * Score one candidate against the active strategy's weights.
 * @param {object} p
 * @param {Array}  p.hist - [{close,high,low,volume}], most recent last
 * @param {object} p.cls - { trend, rsi, sma20, sma50 } from classify()
 * @param {number} p.avgVol20
 * @param {'RISK_ON'|'NEUTRAL'|'RISK_OFF'} p.regime
 * @param {{profitable?:boolean}|null} p.fundamentals - only ever what the user has actually verified; never inferred
 * @param {object} p.strategy - { weights }
 */
export function scoreCandidate({ hist, cls, avgVol20, regime, fundamentals, strategy }) {
  const w = strategy.weights;
  const positives = [];
  const risks = [];
  let score = 0;

  if (cls.trend === "up") {
    score += w.trend;
    positives.push(`Uptrend — SMA20 (RM${cls.sma20.toFixed(3)}) above SMA50 (RM${cls.sma50.toFixed(3)})`);
  } else if (cls.trend === "down") {
    risks.push("Downtrend — SMA20 below SMA50");
  } else {
    risks.push("No clear trend — SMA20 ≈ SMA50");
  }

  if (cls.rsi >= 35 && cls.rsi <= 68) {
    score += w.momentum;
    positives.push(`RSI ${cls.rsi.toFixed(1)} — healthy momentum, not overbought`);
  } else if (cls.rsi > 68) {
    risks.push(`RSI ${cls.rsi.toFixed(1)} — overbought, chasing risk`);
  } else {
    risks.push(`RSI ${cls.rsi.toFixed(1)} — weak or oversold momentum`);
  }

  const lastVol = hist.length ? hist[hist.length - 1].volume : 0;
  const volRatio = avgVol20 > 0 ? lastVol / avgVol20 : null;
  if (volRatio != null) {
    if (volRatio >= 1.2) {
      score += w.volume;
      positives.push(`Volume +${Math.round((volRatio - 1) * 100)}% vs 20d average — confirmation`);
    } else {
      risks.push(`Volume ${Math.round(volRatio * 100)}% of 20d average — weak confirmation`);
    }
  }

  if (fundamentals && typeof fundamentals.profitable === "boolean") {
    if (fundamentals.profitable) {
      score += w.fundamentals;
      positives.push("Profitable (per your own check)");
    } else {
      risks.push("Not confirmed profitable");
    }
  } else {
    risks.push("Fundamentals not verified — check manually before acting");
  }

  if (regime === "RISK_ON") {
    score += w.marketRegime;
    positives.push("Market regime: risk-on");
  } else if (regime === "RISK_OFF") {
    risks.push("Market regime: risk-off — lower-conviction environment");
  } else {
    risks.push("Market regime: neutral");
  }

  return { score, positives, risks };
}

/**
 * Entry/stop/target derived from real fetched price + ATR only — never a
 * fabricated resistance level. Target defaults to a 2:1 reward:risk unless
 * the caller passes a different multiple.
 */
export function computeEntryStopTarget({ currentPrice, highs, lows, closes, targetRR = 2 }) {
  const atr = atr14(highs, lows, closes);
  if (atr == null) return null;
  const entryLow = +currentPrice.toFixed(3);
  const entryHigh = +(currentPrice * 1.03).toFixed(3);
  const stop = +(currentPrice - 2 * atr).toFixed(3);
  const riskPerShare = currentPrice - stop;
  const target = +(currentPrice + targetRR * riskPerShare).toFixed(3);
  return { entryLow, entryHigh, stop, target, riskPerShare, rr: targetRR, atr };
}

export function buildInvalidation(stop) {
  return `Daily close below RM${stop.toFixed(3)}`;
}

/**
 * Assembles the full "signal card": score, why/risks, entry/stop/target,
 * plus a riskReward + positionSizing score bump once a concrete sizing has
 * been computed by the caller (lib/risk.js) and passed in.
 */
export function buildDecisionCard({ ticker, name, currentPrice, base, entryStopTarget, positionSizing, strategy }) {
  const w = strategy.weights;
  let score = base.score;
  const positives = [...base.positives];
  const risks = [...base.risks];

  if (entryStopTarget && entryStopTarget.rr >= 2) {
    score += w.riskReward;
    positives.push(`Risk:reward ${entryStopTarget.rr.toFixed(1)} — favorable`);
  } else if (entryStopTarget) {
    risks.push(`Risk:reward ${entryStopTarget.rr.toFixed(1)} — below 2:1`);
  }

  if (positionSizing && positionSizing.valid && positionSizing.maxShares > 0) {
    score += w.positionSizing;
    positives.push(`Position sizing fits your risk limit and cash (max ${positionSizing.maxShares} shares)`);
  } else if (positionSizing && positionSizing.valid) {
    risks.push("Position sizing rounds to 0 shares at your current risk limit / cash — too small to act on");
  }

  const maxScore = maxPossibleScore(w);
  return {
    ticker, name, price: currentPrice,
    score, maxScore,
    entry: entryStopTarget ? [entryStopTarget.entryLow, entryStopTarget.entryHigh] : null,
    stop: entryStopTarget ? entryStopTarget.stop : null,
    target: entryStopTarget ? entryStopTarget.target : null,
    rr: entryStopTarget ? entryStopTarget.rr : null,
    invalidation: entryStopTarget ? buildInvalidation(entryStopTarget.stop) : null,
    positionSizing: positionSizing || null,
    positives, risks,
    strategyId: strategy.id, strategyVersion: strategy.version
  };
}

/** READY / APPROACHING / WATCH / AVOID bucket for the scanner. */
export function classifyBucket({ score, maxScore, signal, fitsBudget, liquid }) {
  if (!liquid || signal === "AVOID") return "AVOID";
  const pct = maxScore > 0 ? score / maxScore : 0;
  if (signal === "BUY" && pct >= 0.7 && fitsBudget) return "READY";
  if (signal === "BUY" && pct >= 0.5) return "APPROACHING";
  return "WATCH";
}

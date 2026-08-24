import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate, computeEntryStopTarget, buildDecisionCard, classifyBucket } from "../lib/decision.js";
import { DEFAULT_STRATEGY, maxPossibleScore } from "../lib/strategy.js";

test("scoreCandidate: bullish setup scores positively with matching reasons", () => {
  const hist = Array.from({ length: 25 }, (_, i) => ({ close: 3 + i * 0.01, high: 3.05 + i * 0.01, low: 2.95 + i * 0.01, volume: 100000 }));
  hist[hist.length - 1].volume = 200000; // volume surge on the last bar
  const { score, positives, risks } = scoreCandidate({
    hist,
    cls: { trend: "up", rsi: 55, sma20: 3.2, sma50: 3.0 },
    avgVol20: 100000,
    regime: "RISK_ON",
    fundamentals: { profitable: true },
    strategy: DEFAULT_STRATEGY
  });
  assert.ok(score > 0);
  assert.equal(risks.length, 0);
  assert.ok(positives.some(p => p.includes("Uptrend")));
  assert.ok(positives.some(p => p.includes("regime: risk-on")));
});

test("scoreCandidate: never scores fundamentals when unverified, and says so", () => {
  const { risks } = scoreCandidate({
    hist: [{ close: 1, high: 1, low: 1, volume: 0 }],
    cls: { trend: "flat", rsi: 50, sma20: 1, sma50: 1 },
    avgVol20: 0,
    regime: "NEUTRAL",
    fundamentals: null,
    strategy: DEFAULT_STRATEGY
  });
  assert.ok(risks.some(r => r.includes("Fundamentals not verified")));
});

test("computeEntryStopTarget: default 2:1 R:R derived from real ATR only", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 3 + i * 0.02);
  const highs = closes.map(c => c + 0.05);
  const lows = closes.map(c => c - 0.05);
  const r = computeEntryStopTarget({ currentPrice: closes[closes.length - 1], highs, lows, closes });
  assert.ok(r.stop < r.entryLow);
  assert.equal(r.rr, 2);
  assert.ok(r.target > r.entryLow);
});

test("buildDecisionCard adds riskReward/positionSizing score components and never exceeds maxScore weights", () => {
  const base = { score: 3, positives: ["a"], risks: [] };
  const ets = { entryLow: 3, entryHigh: 3.09, stop: 2.8, target: 3.4, rr: 2, atr: 0.1 };
  const sizing = { valid: true, maxShares: 200 };
  const card = buildDecisionCard({ ticker: "X.KL", name: "X", currentPrice: 3, base, entryStopTarget: ets, positionSizing: sizing, strategy: DEFAULT_STRATEGY });
  assert.equal(card.maxScore, maxPossibleScore(DEFAULT_STRATEGY.weights));
  assert.ok(card.score > base.score);
  assert.ok(card.invalidation.includes("2.800"));
});

test("classifyBucket: illiquid or AVOID signal is always AVOID regardless of score", () => {
  assert.equal(classifyBucket({ score: 10, maxScore: 10, signal: "BUY", fitsBudget: true, liquid: false }), "AVOID");
  assert.equal(classifyBucket({ score: 10, maxScore: 10, signal: "AVOID", fitsBudget: true, liquid: true }), "AVOID");
});

test("classifyBucket: READY requires high score AND budget fit; APPROACHING allows either gap", () => {
  const maxScore = maxPossibleScore(DEFAULT_STRATEGY.weights);
  assert.equal(classifyBucket({ score: maxScore, maxScore, signal: "BUY", fitsBudget: true, liquid: true }), "READY");
  assert.equal(classifyBucket({ score: maxScore, maxScore, signal: "BUY", fitsBudget: false, liquid: true }), "APPROACHING");
  assert.equal(classifyBucket({ score: maxScore * 0.3, maxScore, signal: "BUY", fitsBudget: true, liquid: true }), "WATCH");
});

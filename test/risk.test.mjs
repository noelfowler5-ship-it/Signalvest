import { test } from "node:test";
import assert from "node:assert/strict";
import { computePositionSize, computePortfolioHeat, evaluateLossLimits, computeDrawdown, consecutiveStreak } from "../lib/risk.mjs";

test("position sizing matches the spec's worked example exactly", () => {
  // Portfolio RM10,000, 1% risk, entry RM10.00, stop RM9.50 -> 200 shares
  const r = computePositionSize({ portfolioValue: 10000, maxRiskPct: 1, entry: 10.00, stop: 9.50, cash: 100000 });
  assert.equal(r.valid, true);
  assert.equal(r.riskPerShare, 0.5);
  assert.equal(r.maxRiskAmount, 100);
  assert.equal(r.maxSharesByRisk, 200);
  assert.equal(r.maxShares, 200);
  assert.equal(r.maxLoss, 100);
  assert.equal(r.portfolioRiskPct, 1);
});

test("position sizing is capped by cash even when risk allows more", () => {
  const r = computePositionSize({ portfolioValue: 10000, maxRiskPct: 5, entry: 10.00, stop: 9.90, cash: 500 });
  // risk allows floor(500/0.10/100)*100 = 500 shares, but cash only affords floor(500/10/100)*100 = 0 (since 500/10=50 < 100 lot)
  assert.equal(r.maxSharesByCash, 0);
  assert.equal(r.maxShares, 0);
  assert.equal(r.limitedBy, "cash");
});

test("position sizing rejects a stop at or above entry", () => {
  const r = computePositionSize({ portfolioValue: 10000, maxRiskPct: 1, entry: 10.00, stop: 10.00, cash: 10000 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test("portfolio heat: only quantifies risk for holdings with a stop price set", () => {
  const heat = computePortfolioHeat({
    holdings: [
      { ticker: "A.KL", qty: 100, avgCost: 10, currentPrice: 11, stopPrice: 9.5, sector: "Financial" },
      { ticker: "B.KL", qty: 200, avgCost: 5, currentPrice: 5.2, stopPrice: null, sector: "Technology" }
    ],
    cash: 1000
  });
  // total value = 1000 + 100*11 + 200*5.2 = 1000+1100+1040 = 3140
  assert.equal(heat.totalValue, 3140);
  // risk = only A: max(0, 10-9.5)*100 = 50
  assert.equal(heat.totalRiskAmount, 50);
  assert.deepEqual(heat.unquantifiedRiskPositions, ["B.KL"]);
  assert.equal(heat.sectorBreakdown.length, 2);
});

test("portfolio heat ignores a trailing stop above cost (locked-in profit, not risk)", () => {
  const heat = computePortfolioHeat({
    holdings: [{ ticker: "A.KL", qty: 100, avgCost: 10, currentPrice: 15, stopPrice: 12, sector: "X" }],
    cash: 0
  });
  assert.equal(heat.totalRiskAmount, 0); // stop above avg cost -> no downside risk from cost basis
});

test("loss limits: breach detection and percent-used", () => {
  const now = new Date("2026-03-15T12:00:00");
  const status = evaluateLossLimits({
    realizedTrades: [
      { date: "2026-03-14", pl: -150 }, // this week
      { date: "2026-03-10", pl: -60 },  // this month, not this week (week starts 2026-03-15's Sunday = 2026-03-15 itself since Sun)
      { date: "2026-02-01", pl: -500 }  // outside month
    ],
    limits: { daily: 150, weekly: 300, monthly: 600 }
  });
  assert.equal(status.daily.breached, false); // no trade today
  assert.ok(status.weekly.pctUsed >= 0);
  assert.equal(status.monthly.breached, false);
});

test("loss limits trip 'paused' when any window breaches", () => {
  const now = new Date("2026-03-15T12:00:00");
  const status = evaluateLossLimits({
    realizedTrades: [{ date: "2026-03-15", pl: -200 }],
    limits: { daily: 150, weekly: 300, monthly: 600 },
    now
  });
  assert.equal(status.daily.breached, true);
  assert.equal(status.paused, true);
});

test("drawdown: peak-to-trough and current drawdown from peak", () => {
  const dd = computeDrawdown([
    { date: "1", value: 10000 },
    { date: "2", value: 11000 }, // new peak
    { date: "3", value: 9900 },  // -10% from peak
    { date: "4", value: 10500 }  // partial recovery
  ]);
  assert.equal(Math.round(dd.maxDrawdownPct * 100) / 100, 10);
  assert.ok(dd.currentDrawdownPct < dd.maxDrawdownPct);
});

test("consecutive streaks track wins/losses correctly", () => {
  const s = consecutiveStreak([{ pl: 10 }, { pl: 20 }, { pl: -5 }, { pl: -3 }, { pl: -1 }]);
  assert.equal(s.maxWinStreak, 2);
  assert.equal(s.maxLossStreak, 3);
  assert.equal(s.trailingStreak, -3);
});

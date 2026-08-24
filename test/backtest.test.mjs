import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest, summarizeBacktest, splitInOutSample } from "../lib/backtest.js";

function bar(date, o, h, l, c, v = 100000) {
  return { date, open: o, high: h, low: l, close: c, volume: v };
}

test("rejects bars missing `open` rather than silently faking a fill price", () => {
  const r = runBacktest({ bars: [{ date: "1", high: 1, low: 1, close: 1, volume: 1 }] });
  assert.ok(r.error);
});

test("anti-lookahead: a BUY signal on day i fills at day i+1's open, never at day i's own close", () => {
  const bars = [
    bar("d0", 10, 10, 10, 10),
    bar("d1", 12, 12, 12, 12), // signal fires "on" d0 in this synthetic signalFn; entry must use d1's open (12), not d0's close (10)
    bar("d2", 12, 12, 12, 12),
    bar("d3", 12, 12, 12, 12)
  ];
  // Synthetic strategy: BUY once on index 0 only, HOLD forever after (so we can inspect the single resulting trade at the end).
  const signalFn = (b) => b.map((_, i) => (i === 0 ? { signal: "BUY", atr: 1 } : { signal: "HOLD", atr: 1 }));
  const { trades, equityCurve } = runBacktest({ bars, signalFn, initialCapital: 100000, feePct: 0, slippagePct: 0, riskPct: 100 });
  // Position stays open at the end (no AVOID/stop) -> liquidated at last close for the "open-at-end" record.
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryPrice, 12); // d1's open, not d0's close of 10
  assert.equal(trades[0].entryDate, "d1");
});

test("fee and slippage reduce realized P/L exactly as configured", () => {
  const bars = [
    bar("d0", 10, 10, 10, 10),
    bar("d1", 10, 10, 10, 10),   // entry fills here
    bar("d2", 20, 20, 20, 20),   // AVOID signal fires on d1 -> exit fills at d2's open
  ];
  const signalFn = (b) => b.map((_, i) => {
    if (i === 0) return { signal: "BUY", atr: 1 };
    if (i === 1) return { signal: "AVOID", atr: 1 };
    return { signal: "HOLD", atr: 1 };
  });
  const feePct = 0.01, slippagePct = 0.01;
  const { trades } = runBacktest({ bars, signalFn, initialCapital: 100000, feePct, slippagePct, riskPct: 100, lotSize: 100 });
  assert.equal(trades.length, 1);
  const entryExec = 10 * (1 + slippagePct); // 10.10
  const exitExec = 20 * (1 - slippagePct);  // 19.80
  assert.ok(Math.abs(trades[0].entryPrice - entryExec) < 1e-9);
  assert.ok(Math.abs(trades[0].exitPrice - exitExec) < 1e-9);
  const expectedPL = trades[0].qty * exitExec * (1 - feePct) - trades[0].qty * entryExec;
  assert.ok(Math.abs(trades[0].pl - expectedPL) < 1e-6);
});

test("a resting stop fills intraday off the same day's low, not the next day's open", () => {
  const bars = [
    bar("d0", 10, 10, 10, 10),
    bar("d1", 10, 10, 10, 10), // entry fills here at open=10, ATR=1 -> stop = 10 - 2*1 = 8
    bar("d2", 9, 9.5, 7.5, 8.5) // low of 7.5 breaches the stop of 8 intraday
  ];
  const signalFn = (b) => b.map((_, i) => (i === 0 ? { signal: "BUY", atr: 1 } : { signal: "HOLD", atr: 1 }));
  const { trades } = runBacktest({ bars, signalFn, initialCapital: 100000, feePct: 0, slippagePct: 0, riskPct: 100 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].reason, "stop");
  assert.equal(trades[0].exitDate, "d2");
});

test("regimeSeries RISK_OFF blocks new entries even on a BUY signal", () => {
  const bars = [bar("d0", 10, 10, 10, 10), bar("d1", 10, 10, 10, 10), bar("d2", 10, 10, 10, 10)];
  const signalFn = (b) => b.map(() => ({ signal: "BUY", atr: 1 }));
  const { trades } = runBacktest({ bars, signalFn, regimeSeries: ["RISK_OFF", "RISK_OFF", "RISK_OFF"], initialCapital: 100000, riskPct: 100 });
  assert.equal(trades.length, 0);
});

test("summarizeBacktest computes win rate, profit factor and max drawdown correctly", () => {
  const trades = [{ pl: 100 }, { pl: -50 }, { pl: 200 }];
  const equityCurve = [
    { date: "1", value: 10000 },
    { date: "2", value: 10100 },
    { date: "3", value: 9800 },  // drawdown from 10100 peak
    { date: "4", value: 10300 }
  ];
  const s = summarizeBacktest({ trades, equityCurve, initialCapital: 10000 });
  assert.equal(s.trades, 3);
  assert.equal(Math.round(s.winRate), 67);
  assert.equal(s.profitFactor, 300 / 50);
  assert.ok(s.maxDrawdownPct > 0);
  assert.equal(s.finalEquity, 10300);
});

test("splitInOutSample partitions strictly by date with no overlap", () => {
  const bars = [bar("2026-01-01", 1, 1, 1, 1), bar("2026-06-01", 1, 1, 1, 1), bar("2026-12-01", 1, 1, 1, 1)];
  const { inSample, outOfSample } = splitInOutSample(bars, "2026-06-01");
  assert.equal(inSample.length, 1);
  assert.equal(outOfSample.length, 2);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileHoldings } from "../lib/reconcile.js";

test("matching quantities and cost basis report ok", () => {
  const r = reconcileHoldings({
    csvHoldings: [{ ticker: "1155.KL", qty: 500, avgCost: 8.50 }],
    sheetHoldings: [{ ticker: "1155.KL", qty: 500, avgCost: 8.50 }]
  });
  assert.equal(r.ok, true);
  assert.equal(r.mismatches.length, 0);
});

test("quantity mismatch is flagged with the exact difference (regression case: the original '0/6 fills synced' bug)", () => {
  const r = reconcileHoldings({
    csvHoldings: [{ ticker: "0036.KL", qty: 500, avgCost: 0.065 }],
    sheetHoldings: [{ ticker: "0036.KL", qty: 450, avgCost: 0.065 }]
  });
  assert.equal(r.ok, false);
  assert.equal(r.mismatches[0].qtyDiff, -50);
});

test("a ticker missing entirely from the Sheet is caught as a mismatch, not silently skipped", () => {
  const r = reconcileHoldings({
    csvHoldings: [{ ticker: "KGROUP.KL", qty: 300, avgCost: 1.00 }],
    sheetHoldings: []
  });
  assert.equal(r.ok, false);
  assert.equal(r.mismatches[0].sheetQty, 0);
});

test("sub-sen cost rounding differences do not falsely flag a cost mismatch", () => {
  const r = reconcileHoldings({
    csvHoldings: [{ ticker: "A.KL", qty: 100, avgCost: 1.0001 }],
    sheetHoldings: [{ ticker: "A.KL", qty: 100, avgCost: 1.0004 }]
  });
  assert.equal(r.mismatches.length, 0);
});

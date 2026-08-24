import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCorporateActions } from "../lib/corporate-actions.js";

test("2-for-1 split doubles qty and halves avg cost, cost basis unchanged", () => {
  const r = applyCorporateActions(
    { ticker: "A.KL", qty: 100, avgCost: 10 },
    [{ date: "2026-01-01", ticker: "A.KL", type: "Split", ratio: 2 }]
  );
  assert.equal(r.qty, 200);
  assert.equal(r.avgCost, 5);
  assert.equal(r.costBasis, 1000); // unchanged: 100*10 == 200*5
});

test("1-for-5 reverse split: qty divided by 5, avg cost multiplied by 5", () => {
  const r = applyCorporateActions(
    { ticker: "A.KL", qty: 500, avgCost: 2 },
    [{ date: "2026-01-01", ticker: "A.KL", type: "ReverseSplit", ratio: 0.2 }]
  );
  assert.equal(r.qty, 100);
  assert.equal(r.avgCost, 10);
});

test("1-for-10 bonus issue: 10% more shares, cost basis spread over the larger position", () => {
  const r = applyCorporateActions(
    { ticker: "A.KL", qty: 100, avgCost: 10 },
    [{ date: "2026-01-01", ticker: "A.KL", type: "Bonus", ratio: 0.1 }]
  );
  assert.ok(Math.abs(r.qty - 110) < 1e-9);
  assert.ok(Math.abs(r.costBasis - 1000) < 1e-9); // total cost never changes on a bonus issue
});

test("rights issue blends subscription-price shares into average cost like a buy", () => {
  const r = applyCorporateActions(
    { ticker: "A.KL", qty: 100, avgCost: 10 }, // cost basis 1000
    [{ date: "2026-01-01", ticker: "A.KL", type: "Rights", ratio: 0.5, subscriptionPrice: 4 }] // +50 shares @ RM4 = +200
  );
  assert.equal(r.qty, 150);
  assert.ok(Math.abs(r.costBasis - 1200) < 1e-9);
});

test("multiple actions apply in date order", () => {
  const r = applyCorporateActions(
    { ticker: "A.KL", qty: 100, avgCost: 10 },
    [
      { date: "2026-02-01", ticker: "A.KL", type: "Bonus", ratio: 0.1 },
      { date: "2026-01-01", ticker: "A.KL", type: "Split", ratio: 2 }
    ]
  );
  // Split first (200 @ 5), then bonus 10% (220 @ ~4.545)
  assert.ok(Math.abs(r.qty - 220) < 1e-9);
  assert.ok(Math.abs(r.costBasis - 1000) < 1e-9);
});

test("mergers/delistings are never auto-adjusted — flagged for manual review instead", () => {
  const r = applyCorporateActions(
    { ticker: "A.KL", qty: 100, avgCost: 10 },
    [{ date: "2026-01-01", ticker: "A.KL", type: "Delisting", notes: "Suspended from trading" }]
  );
  assert.equal(r.qty, 100); // untouched
  assert.equal(r.manualReviewNeeded.length, 1);
  assert.equal(r.manualReviewNeeded[0].type, "Delisting");
});

test("actions for a different ticker are ignored", () => {
  const r = applyCorporateActions(
    { ticker: "A.KL", qty: 100, avgCost: 10 },
    [{ date: "2026-01-01", ticker: "B.KL", type: "Split", ratio: 2 }]
  );
  assert.equal(r.qty, 100);
  assert.equal(r.avgCost, 10);
});

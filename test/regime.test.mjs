import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRegime } from "../lib/regime.js";

test("not enough history returns NEUTRAL with an honest reason, never a guess", () => {
  const r = classifyRegime({ klciCloses: [1500, 1510, 1520] });
  assert.equal(r.regime, "NEUTRAL");
  assert.equal(r.confidence, 0);
});

test("strong uptrend across all signals classifies RISK_ON", () => {
  const closes = Array.from({ length: 220 }, (_, i) => 1400 + i * 2); // steadily rising
  const r = classifyRegime({ klciCloses: closes, breadthPct: 70 });
  assert.equal(r.regime, "RISK_ON");
  assert.equal(r.votes, r.total);
});

test("strong downtrend across all signals classifies RISK_OFF", () => {
  const closes = Array.from({ length: 220 }, (_, i) => 1900 - i * 2);
  const r = classifyRegime({ klciCloses: closes, breadthPct: 20 });
  assert.equal(r.regime, "RISK_OFF");
});

test("regime always carries the non-predictive disclaimer", () => {
  const r = classifyRegime({ klciCloses: [1500, 1510] });
  assert.ok(r.disclaimer.toLowerCase().includes("not a prediction"));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBehaviorStats } from "../lib/journal.js";

test("empty trade list returns zeroed stats, not NaN/Infinity", () => {
  const s = computeBehaviorStats([]);
  assert.equal(s.count, 0);
  assert.equal(s.winRate, 0);
  assert.equal(Number.isNaN(s.expectancy), false);
});

test("win rate, expectancy and profit factor on a known small sample", () => {
  const s = computeBehaviorStats([
    { pl: 100 }, { pl: 100 }, { pl: -50 }, { pl: -50 }
  ]);
  assert.equal(s.winRate, 50);
  assert.equal(s.avgWin, 100);
  assert.equal(s.avgLoss, -50);
  assert.equal(s.profitFactor, 200 / 100);
  assert.equal(s.expectancy, 0.5 * 100 + 0.5 * -50);
});

test("setup/emotion breakdowns identify best and worst without fabricating a verdict when untagged", () => {
  const s = computeBehaviorStats([
    { pl: 50, setup: "Breakout", emotion: "Confidence" },
    { pl: -80, setup: "FOMO entry", emotion: "FOMO" },
    { pl: 20, setup: "Breakout", emotion: "Neutral" }
  ]);
  assert.equal(s.bestSetup.key, "Breakout");
  assert.equal(s.worstSetup.key, "FOMO entry");
  assert.equal(s.worstEmotion.key, "FOMO");
});

test("all-untagged trades produce no bestSetup/worstSetup rather than a misleading pick", () => {
  const s = computeBehaviorStats([{ pl: 10 }, { pl: -5 }]);
  assert.equal(s.bestSetup, null);
  assert.equal(s.worstSetup, null);
});

test("rule-broken P/L is isolated from rule-followed P/L", () => {
  const s = computeBehaviorStats([
    { pl: 100, ruleFollowed: true },
    { pl: -200, ruleFollowed: false }
  ]);
  assert.equal(s.ruleFollowedCount, 1);
  assert.equal(s.ruleBrokenCount, 1);
  assert.equal(s.ruleBrokenPL, -200);
});

/**
 * Behavior analytics over realized (closed) trades. Every field here is
 * computed straight from your own logged trades — nothing inferred or
 * estimated. Optional tags (setup/emotion/ruleFollowed) only produce a
 * breakdown if you actually filled them in; an all-"Unspecified" bucket is
 * expected and fine until you start tagging trades.
 */

function groupBy(trades, key) {
  const map = new Map();
  for (const t of trades) {
    const k = t[key] || "Unspecified";
    const g = map.get(k) || { key: k, count: 0, pl: 0 };
    g.count++;
    g.pl += t.pl;
    map.set(k, g);
  }
  return [...map.values()].sort((a, b) => b.pl - a.pl);
}

export function computeBehaviorStats(realizedTrades) {
  const n = realizedTrades.length;
  if (!n) {
    return {
      count: 0, winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, expectancy: 0,
      grossProfit: 0, grossLoss: 0, bySetup: [], byEmotion: [],
      ruleFollowedCount: 0, ruleBrokenCount: 0, ruleBrokenPL: 0,
      bestSetup: null, worstSetup: null, worstEmotion: null
    };
  }

  const wins = realizedTrades.filter(t => t.pl > 0);
  const losses = realizedTrades.filter(t => t.pl < 0);
  const winRate = (wins.length / n) * 100;
  const grossProfit = wins.reduce((s, t) => s + t.pl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pl, 0));
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;

  const bySetup = groupBy(realizedTrades, "setup");
  const byEmotion = groupBy(realizedTrades, "emotion");
  const ruleFollowedTrades = realizedTrades.filter(t => t.ruleFollowed === true || t.ruleFollowed === "true");
  const ruleBrokenTrades = realizedTrades.filter(t => t.ruleFollowed === false || t.ruleFollowed === "false");
  const ruleBrokenPL = ruleBrokenTrades.reduce((s, t) => s + t.pl, 0);

  const taggedSetups = bySetup.filter(s => s.key !== "Unspecified");
  const taggedEmotions = byEmotion.filter(e => e.key !== "Unspecified");

  return {
    count: n, winRate, avgWin, avgLoss, profitFactor, expectancy, grossProfit, grossLoss,
    bySetup, byEmotion,
    ruleFollowedCount: ruleFollowedTrades.length, ruleBrokenCount: ruleBrokenTrades.length, ruleBrokenPL,
    bestSetup: taggedSetups[0] || null,
    worstSetup: taggedSetups.length ? taggedSetups[taggedSetups.length - 1] : null,
    worstEmotion: taggedEmotions.length ? [...taggedEmotions].sort((a, b) => a.pl - b.pl)[0] : null
  };
}

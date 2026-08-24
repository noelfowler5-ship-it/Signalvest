/**
 * Risk-management primitives: position sizing, portfolio heat, loss limits,
 * drawdown, win/loss streaks. All pure functions — no fetch, no DOM, no
 * Sheet access — so they're identical whether called from a Node script or
 * mirrored into the browser.
 */

/**
 * Maximum Risk Amount ÷ Risk Per Share = Maximum Position Size, rounded down
 * to a whole board lot and capped by available cash.
 */
export function computePositionSize({ portfolioValue, maxRiskPct, entry, stop, cash, target, lotSize = 100 }) {
  const errors = [];
  if (!(portfolioValue > 0)) errors.push("portfolio value must be greater than zero");
  if (!(entry > 0)) errors.push("entry price must be greater than zero");
  if (stop == null || !(stop >= 0)) errors.push("stop price must be zero or greater");
  if (entry > 0 && stop != null && stop >= entry) errors.push("stop must be below entry for a long position");
  if (errors.length) return { valid: false, errors };

  const riskPerShare = entry - stop;
  const maxRiskAmount = portfolioValue * (maxRiskPct / 100);
  const maxSharesByRisk = Math.floor(maxRiskAmount / riskPerShare / lotSize) * lotSize;
  const maxSharesByCash = cash > 0 ? Math.floor(cash / entry / lotSize) * lotSize : 0;
  const maxShares = Math.max(0, Math.min(maxSharesByRisk, maxSharesByCash));
  const maxCapital = maxShares * entry;
  const maxLoss = maxShares * riskPerShare;
  const portfolioRiskPct = portfolioValue > 0 ? (maxLoss / portfolioValue) * 100 : null;
  const rr = target != null && target > entry ? (target - entry) / riskPerShare : null;

  return {
    valid: true, riskPerShare, maxRiskAmount, maxSharesByRisk, maxSharesByCash,
    maxShares, maxCapital, maxLoss, portfolioRiskPct, rr,
    limitedBy: maxSharesByRisk <= maxSharesByCash ? "risk" : "cash"
  };
}

/**
 * Portfolio-level heat: how much of total value is genuinely at risk right
 * now (i.e., what you'd actually lose if every stop were hit), plus sector
 * concentration. A holding with no stop price set can't be quantified and is
 * called out separately rather than silently treated as zero risk.
 */
export function computePortfolioHeat({ holdings, cash }) {
  const investedCapital = holdings.reduce((s, h) => s + h.qty * (h.currentPrice ?? h.avgCost), 0);
  const totalValue = cash + investedCapital;
  let totalRisk = 0;
  const bySector = new Map();
  let largestPosition = null;
  const unquantified = [];

  for (const h of holdings) {
    const value = h.qty * (h.currentPrice ?? h.avgCost);
    if (h.stopPrice != null) {
      totalRisk += Math.max(0, h.avgCost - h.stopPrice) * h.qty;
    } else {
      unquantified.push(h.ticker);
    }
    const sector = h.sector || "Unclassified";
    bySector.set(sector, (bySector.get(sector) || 0) + value);
    if (!largestPosition || value > largestPosition.value) largestPosition = { ticker: h.ticker, value };
  }

  const sectorBreakdown = [...bySector.entries()]
    .map(([sector, value]) => ({ sector, value, pct: totalValue > 0 ? (value / totalValue) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);

  return {
    totalValue, cash, investedCapital,
    portfolioHeatPct: totalValue > 0 ? (totalRisk / totalValue) * 100 : 0,
    totalRiskAmount: totalRisk,
    unquantifiedRiskPositions: unquantified,
    sectorBreakdown,
    largestSector: sectorBreakdown[0] || null,
    largestPosition
  };
}

/**
 * Daily/weekly/monthly loss-limit check against realized trades only
 * (unrealized drawdown is a separate, non-actionable number — this is
 * specifically "how much have I actually locked in losing this period").
 */
export function evaluateLossLimits({ realizedTrades, limits, now = new Date() }) {
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay); startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  function windowStatus(sinceDate, limit) {
    const net = realizedTrades
      .filter(t => new Date(t.date) >= sinceDate)
      .reduce((s, t) => s + t.pl, 0);
    const loss = net < 0 ? -net : 0;
    const lim = Number(limit) || 0;
    const pctUsed = lim > 0 ? (loss / lim) * 100 : 0;
    return { netPL: net, loss, limit: lim, pctUsed, breached: lim > 0 && loss >= lim };
  }

  const daily = windowStatus(startOfDay, limits.daily);
  const weekly = windowStatus(startOfWeek, limits.weekly);
  const monthly = windowStatus(startOfMonth, limits.monthly);
  return { daily, weekly, monthly, paused: daily.breached || weekly.breached || monthly.breached };
}

/** Peak-to-trough drawdown over an ascending {date, value} equity series. */
export function computeDrawdown(equitySeries) {
  if (!equitySeries.length) return { maxDrawdownPct: 0, currentDrawdownPct: 0, peak: null, peakDate: null };
  let peak = equitySeries[0].value, peakDate = equitySeries[0].date;
  let maxDD = 0, maxDDDate = null;
  for (const pt of equitySeries) {
    if (pt.value > peak) { peak = pt.value; peakDate = pt.date; }
    const dd = peak > 0 ? ((peak - pt.value) / peak) * 100 : 0;
    if (dd > maxDD) { maxDD = dd; maxDDDate = pt.date; }
  }
  const last = equitySeries[equitySeries.length - 1];
  const currentDD = peak > 0 ? ((peak - last.value) / peak) * 100 : 0;
  return { maxDrawdownPct: maxDD, maxDrawdownDate: maxDDDate, currentDrawdownPct: currentDD, peak, peakDate };
}

/** Longest winning/losing streaks, plus the streak currently in effect. */
export function consecutiveStreak(realizedTradesAsc) {
  let runWin = 0, runLoss = 0, maxWinStreak = 0, maxLossStreak = 0;
  for (const t of realizedTradesAsc) {
    if (t.pl > 0) { runWin++; runLoss = 0; maxWinStreak = Math.max(maxWinStreak, runWin); }
    else if (t.pl < 0) { runLoss++; runWin = 0; maxLossStreak = Math.max(maxLossStreak, runLoss); }
    else { runWin = 0; runLoss = 0; }
  }
  const last = realizedTradesAsc[realizedTradesAsc.length - 1];
  const trailingStreak = last ? (last.pl > 0 ? runWin : last.pl < 0 ? -runLoss : 0) : 0;
  return { maxWinStreak, maxLossStreak, trailingStreak };
}

/**
 * Compares what Moomoo actually reports (from a fresh CSV export, replayed
 * through lib/ledger.js) against what the Sheet currently shows, per
 * ticker. Never auto-corrects a mismatch — it only surfaces it so you can
 * investigate which side is wrong.
 *
 * Honest limitation: the Moomoo CSV export used by this app is a fill
 * history, not an account statement — it has no cash-balance line — so
 * cash cannot be reconciled from it. Only quantity and average cost are
 * compared here.
 */

const COST_TOLERANCE = 0.005; // RM, sub-sen rounding

export function reconcileHoldings({ csvHoldings, sheetHoldings }) {
  const byTicker = new Map();
  for (const h of csvHoldings) {
    byTicker.set(h.ticker, { ticker: h.ticker, csvQty: h.qty, csvAvgCost: h.avgCost });
  }
  for (const h of sheetHoldings) {
    const e = byTicker.get(h.ticker) || { ticker: h.ticker, csvQty: 0, csvAvgCost: null };
    e.sheetQty = h.qty;
    e.sheetAvgCost = h.avgCost;
    byTicker.set(h.ticker, e);
  }

  const rows = [...byTicker.values()].map(e => {
    const sheetQty = e.sheetQty ?? 0;
    const csvQty = e.csvQty ?? 0;
    const qtyDiff = sheetQty - csvQty;
    const qtyMatch = qtyDiff === 0;
    let costMatch = null;
    if (e.sheetAvgCost != null && e.csvAvgCost != null && csvQty > 0 && sheetQty > 0) {
      costMatch = Math.abs(e.sheetAvgCost - e.csvAvgCost) < COST_TOLERANCE;
    }
    return {
      ticker: e.ticker,
      csvQty, sheetQty: e.sheetQty ?? 0, qtyDiff, qtyMatch,
      csvAvgCost: e.csvAvgCost ?? null, sheetAvgCost: e.sheetAvgCost ?? null, costMatch
    };
  }).sort((a, b) => {
    if (a.qtyMatch !== b.qtyMatch) return a.qtyMatch ? 1 : -1;
    return a.ticker.localeCompare(b.ticker);
  });

  const mismatches = rows.filter(r => !r.qtyMatch || r.costMatch === false);
  return { rows, mismatches, ok: mismatches.length === 0, note: "Cash cannot be reconciled — the Moomoo CSV export is a fill history, not an account statement." };
}

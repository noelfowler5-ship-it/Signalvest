/**
 * Adjusts a CURRENT holding's qty/avg-cost for splits, reverse splits and
 * bonus issues — as a display-time overlay, never by rewriting the
 * Transactions ledger (which stays append-only per README/spec).
 *
 * Mergers, ticker changes and delistings are NOT auto-adjusted — they're
 * too idiosyncratic to model generically without risking a wrong number
 * that looks authoritative. Those are logged for your own manual review
 * instead (see the CorporateActions Sheet tab).
 */

const AUTO_ADJUST_TYPES = new Set(["Split", "ReverseSplit", "Bonus", "Rights"]);

/**
 * @param {{ticker, qty, avgCost}} holding
 * @param {Array<{date, ticker, type, ratio, subscriptionPrice}>} actions - only entries for this ticker matter
 */
export function applyCorporateActions(holding, actions) {
  const relevant = actions
    .filter(a => a.ticker === holding.ticker && AUTO_ADJUST_TYPES.has(a.type))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  let qty = holding.qty;
  let avgCost = holding.avgCost;
  const applied = [];
  const manualReviewNeeded = actions
    .filter(a => a.ticker === holding.ticker && !AUTO_ADJUST_TYPES.has(a.type))
    .map(a => ({ date: a.date, type: a.type, notes: a.notes || "" }));

  for (const a of relevant) {
    if (a.type === "Split" || a.type === "ReverseSplit") {
      // ratio = new shares per old share (e.g. 2-for-1 split -> ratio 2; 1-for-5 reverse split -> ratio 0.2)
      const r = Number(a.ratio);
      if (!(r > 0)) continue;
      qty = qty * r;
      avgCost = avgCost / r;
      applied.push({ date: a.date, type: a.type, ratio: r, qtyAfter: qty, avgCostAfter: avgCost });
    } else if (a.type === "Bonus") {
      // ratio = free shares per existing share (e.g. 1-for-10 bonus -> ratio 0.1)
      const r = Number(a.ratio);
      if (!(r >= 0)) continue;
      const newQty = qty * (1 + r);
      avgCost = avgCost * (qty / newQty); // total cost basis unchanged, spread over more shares
      qty = newQty;
      applied.push({ date: a.date, type: a.type, ratio: r, qtyAfter: qty, avgCostAfter: avgCost });
    } else if (a.type === "Rights") {
      // Simplified model: rights taken up are treated like an additional buy at the
      // subscription price, blended into average cost — same math the Sheet already
      // uses for a normal Buy row.
      const rightsQty = Number(a.ratio) * qty; // ratio = new shares per existing share offered
      const price = Number(a.subscriptionPrice);
      if (!(rightsQty > 0) || !(price >= 0)) continue;
      const totalCostBefore = qty * avgCost;
      const totalCostAfter = totalCostBefore + rightsQty * price;
      qty = qty + rightsQty;
      avgCost = qty > 0 ? totalCostAfter / qty : 0;
      applied.push({ date: a.date, type: a.type, rightsQty, subscriptionPrice: price, qtyAfter: qty, avgCostAfter: avgCost });
    }
  }

  return {
    ticker: holding.ticker,
    qty, avgCost, costBasis: qty * avgCost,
    applied, manualReviewNeeded
  };
}

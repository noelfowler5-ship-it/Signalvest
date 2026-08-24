/**
 * Turns the raw, append-only Transactions log into current holdings +
 * realized trades, using the SAME average-cost convention as the Sheet's
 * Holdings formulas (avg cost of the remaining position is the average of
 * ALL buys ever, unaffected by intervening sells — selling only reduces qty
 * and books a realized P/L against that average, it never rebases it).
 *
 * This is intentionally separate from the Sheet: the Sheet has no realized
 * P/L concept today, and this file adds one without touching the Sheet's
 * existing MAP+LAMBDA formulas.
 */

const CASH_TYPES = new Set(["Deposit", "Withdrawal"]);

export function normalizeTx(raw, index = 0) {
  const side = raw.side || (raw.type === "Buy" || raw.type === "Sell" ? raw.type : "");
  return {
    _index: index,
    date: raw.date,
    type: raw.type || side || "Buy",
    side,
    ticker: (raw.ticker || "").toUpperCase(),
    qty: Number(raw.qty) || 0,
    price: Number(raw.price) || 0,
    amount: raw.amount != null && raw.amount !== "" ? Number(raw.amount) : (Number(raw.qty) || 0) * (Number(raw.price) || 0),
    fee: Number(raw.fee) || 0,
    currency: raw.currency || "MYR",
    source: raw.source || "",
    setup: raw.setup || "",
    emotion: raw.emotion || "",
    thesis: raw.thesis || "",
    invalidation: raw.invalidation || "",
    strategyVersion: raw.strategyVersion || "",
    signalScore: raw.signalScore !== undefined && raw.signalScore !== "" ? Number(raw.signalScore) : null,
    ruleFollowed: raw.ruleFollowed
  };
}

export function sortByDate(txs) {
  return [...txs].sort((a, b) => {
    const da = new Date(a.date).getTime(), db = new Date(b.date).getTime();
    if (da !== db) return da - db;
    return a._index - b._index;
  });
}

/**
 * @param {Array<object>} rawTransactions - raw rows as read from the Sheet or CSV
 * @returns {{holdings:Array, realizedTrades:Array, dividends:Array, cashFlows:Array, realizedPLTotal:number, warnings:Array<string>}}
 */
export function reduceLedger(rawTransactions) {
  const txs = sortByDate(rawTransactions.map(normalizeTx));
  const positions = new Map();
  const realizedTrades = [];
  const dividends = [];
  const cashFlows = [];
  const warnings = [];
  let realizedPLTotal = 0;

  for (const t of txs) {
    if (t.type === "Dividend") {
      dividends.push({ date: t.date, ticker: t.ticker, amount: t.amount, fee: t.fee });
      continue;
    }
    if (CASH_TYPES.has(t.type)) {
      cashFlows.push({ date: t.date, type: t.type, amount: t.amount });
      continue;
    }
    if (t.type === "CorporateAction") continue; // handled by applyCorporateActions, not the P/L ledger

    if (!t.ticker || !(t.qty > 0)) continue;

    const pos = positions.get(t.ticker) || { qty: 0, buyQty: 0, buyAmount: 0 };
    if (t.side === "Buy" || t.type === "Buy") {
      pos.qty += t.qty;
      pos.buyQty += t.qty;
      pos.buyAmount += t.qty * t.price;
      positions.set(t.ticker, pos);
    } else if (t.side === "Sell" || t.type === "Sell") {
      const avgCostAtSale = pos.buyQty > 0 ? pos.buyAmount / pos.buyQty : 0;
      let sellQty = t.qty;
      if (sellQty > pos.qty) {
        warnings.push(`${t.ticker} on ${t.date}: sell of ${t.qty} exceeds tracked position (${pos.qty}) — likely a missing buy row or an out-of-order import. Capped at ${pos.qty}.`);
        sellQty = pos.qty;
      }
      const pl = (t.price - avgCostAtSale) * sellQty - t.fee;
      realizedPLTotal += pl;
      realizedTrades.push({
        date: t.date, ticker: t.ticker, qty: sellQty, exitPrice: t.price,
        avgCostAtSale, pl, fee: t.fee,
        setup: t.setup, emotion: t.emotion, ruleFollowed: t.ruleFollowed,
        strategyVersion: t.strategyVersion, signalScore: t.signalScore
      });
      pos.qty -= sellQty;
      positions.set(t.ticker, pos);
    }
  }

  const holdings = [];
  for (const [ticker, pos] of positions.entries()) {
    if (pos.qty > 0) {
      const avgCost = pos.buyQty > 0 ? pos.buyAmount / pos.buyQty : 0;
      holdings.push({ ticker, qty: pos.qty, avgCost, costBasis: pos.qty * avgCost });
    }
  }

  return { holdings, realizedTrades, dividends, cashFlows, realizedPLTotal, warnings };
}

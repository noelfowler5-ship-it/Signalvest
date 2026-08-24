import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceLedger, normalizeTx } from "../lib/ledger.mjs";

test("simple buy then full sell: qty zeroed, realized P/L correct", () => {
  const { holdings, realizedTrades, realizedPLTotal } = reduceLedger([
    { date: "2026-01-01", side: "Buy", ticker: "0036.KL", qty: 100, price: 1.00 },
    { date: "2026-02-01", side: "Sell", ticker: "0036.KL", qty: 100, price: 1.20 }
  ]);
  assert.equal(holdings.length, 0);
  assert.equal(realizedTrades.length, 1);
  assert.ok(Math.abs(realizedTrades[0].pl - 20) < 1e-9); // (1.20 - 1.00) * 100, modulo float rounding
  assert.ok(Math.abs(realizedPLTotal - 20) < 1e-9);
});

test("multiple buys average cost, partial sell leaves remaining position at same avg cost", () => {
  const { holdings, realizedTrades } = reduceLedger([
    { date: "2026-01-01", side: "Buy", ticker: "1155.KL", qty: 100, price: 8.00 },
    { date: "2026-01-10", side: "Buy", ticker: "1155.KL", qty: 100, price: 9.00 },
    { date: "2026-02-01", side: "Sell", ticker: "1155.KL", qty: 100, price: 10.00 }
  ]);
  // avg cost of all buys = (800+900)/200 = 8.50
  assert.equal(realizedTrades[0].avgCostAtSale, 8.5);
  assert.equal(realizedTrades[0].pl, (10 - 8.5) * 100);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].qty, 100);
  assert.equal(holdings[0].avgCost, 8.5); // matches Sheet convention: avg cost unaffected by the sell
});

test("fees reduce realized P/L", () => {
  const { realizedTrades } = reduceLedger([
    { date: "2026-01-01", side: "Buy", ticker: "X.KL", qty: 100, price: 1.00, fee: 0 },
    { date: "2026-02-01", side: "Sell", ticker: "X.KL", qty: 100, price: 1.10, fee: 2.5 }
  ]);
  assert.equal(realizedTrades[0].pl, (1.10 - 1.00) * 100 - 2.5);
});

test("overselling is capped and warned, never goes negative", () => {
  const { holdings, warnings, realizedTrades } = reduceLedger([
    { date: "2026-01-01", side: "Buy", ticker: "Y.KL", qty: 100, price: 1.00 },
    { date: "2026-02-01", side: "Sell", ticker: "Y.KL", qty: 300, price: 1.50 }
  ]);
  assert.equal(realizedTrades[0].qty, 100);
  assert.equal(holdings.length, 0);
  assert.equal(warnings.length, 1);
});

test("out-of-order rows are sorted by date before reducing", () => {
  const { realizedTrades } = reduceLedger([
    { date: "2026-02-01", side: "Sell", ticker: "Z.KL", qty: 100, price: 2.00 },
    { date: "2026-01-01", side: "Buy", ticker: "Z.KL", qty: 100, price: 1.00 }
  ]);
  assert.equal(realizedTrades.length, 1);
  assert.equal(realizedTrades[0].pl, 100);
});

test("dividend, deposit and withdrawal rows are separated out, not treated as trades", () => {
  const { dividends, cashFlows, holdings } = reduceLedger([
    { date: "2026-01-01", type: "Deposit", amount: 1000 },
    { date: "2026-01-02", side: "Buy", ticker: "Q.KL", qty: 100, price: 1.00 },
    { date: "2026-03-01", type: "Dividend", ticker: "Q.KL", amount: 5 },
    { date: "2026-04-01", type: "Withdrawal", amount: 200 }
  ]);
  assert.equal(dividends.length, 1);
  assert.equal(dividends[0].amount, 5);
  assert.equal(cashFlows.length, 2);
  assert.equal(holdings[0].qty, 100);
});

test("normalizeTx defaults missing fee/currency/type safely (backward compatible with legacy rows)", () => {
  const t = normalizeTx({ date: "2026-01-01", side: "Buy", ticker: "A.KL", qty: 100, price: 1 }, 0);
  assert.equal(t.fee, 0);
  assert.equal(t.currency, "MYR");
  assert.equal(t.type, "Buy");
});

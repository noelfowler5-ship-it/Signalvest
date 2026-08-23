/**
 * Signalvest — Apps Script Web App
 *
 * Bound to your "Signalvest — Portfolio & Net Worth" Google Sheet.
 * This is the only place your real trade history, cash balance and net
 * worth ever live — none of it is committed to the (public) GitHub repo.
 *
 * One-time setup:
 *   1. Extensions > Apps Script, paste this file in as Code.gs.
 *   2. Run `setupSheet` once from the editor (▶ button) and approve the
 *      permission prompts — this builds the tabs below with headers only.
 *   3. Run `setSharedSecret` once (see instructions in that function) to
 *      generate the secret the app and GitHub Action authenticate with.
 *   4. Deploy > New deployment > Web app. Execute as "Me", access "Anyone".
 *      Copy the resulting /exec URL into the app's Settings tab and into
 *      your GitHub repo secrets (SHEET_ENDPOINT).
 */

const SHEET_NAMES = {
  TRANSACTIONS: "Transactions",
  HOLDINGS: "Holdings",
  BUDGET: "Budget",
  NET_WORTH: "Net Worth"
};

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Transactions: append-only log. Everything else is derived from this.
  let tx = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (!tx) tx = ss.insertSheet(SHEET_NAMES.TRANSACTIONS);
  tx.clear();
  tx.getRange(1, 1, 1, 7).setValues([["Date", "Side", "Ticker", "Qty", "Price (RM)", "Amount (RM)", "Source"]]);
  tx.setFrozenRows(1);

  // Holdings: live formula view of open positions, derived from Transactions.
  let hold = ss.getSheetByName(SHEET_NAMES.HOLDINGS);
  if (!hold) hold = ss.insertSheet(SHEET_NAMES.HOLDINGS);
  hold.clear();
  hold.getRange(1, 1, 1, 4).setValues([["Ticker", "Qty Held", "Avg Cost (RM)", "Cost Basis (RM)"]]);
  hold.getRange("A2").setFormula(
    '=SORT(UNIQUE(FILTER(Transactions!C2:C, Transactions!C2:C<>"")))'
  );
  // Net qty held = buys - sells.
  hold.getRange("B2").setFormula(
    '=ARRAYFORMULA(IF(A2:A="","",' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,A2:A,Transactions!B:B,"Buy") - ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,A2:A,Transactions!B:B,"Sell")))'
  );
  hold.getRange("C2").setFormula(
    '=ARRAYFORMULA(IF(A2:A="","",IFERROR(' +
      'SUMIFS(Transactions!F:F,Transactions!C:C,A2:A,Transactions!B:B,"Buy") / ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,A2:A,Transactions!B:B,"Buy"),0)))'
  );
  hold.getRange("D2").setFormula('=ARRAYFORMULA(IF(A2:A="","",B2:B*C2:C))');

  // Budget: you maintain "Cash available" by hand; everything else reads it.
  let budget = ss.getSheetByName(SHEET_NAMES.BUDGET);
  if (!budget) budget = ss.insertSheet(SHEET_NAMES.BUDGET);
  budget.clear();
  budget.getRange("A1").setValue("Cash available to invest (RM)");
  budget.getRange("B1").setValue(0);
  budget.getRange("A2").setValue("Shared secret (paste a long random string, matches SHARED_SECRET script property)");

  // Net Worth: simple roll-up. Fill in EPF / other-assets / debt cells by hand each month.
  let nw = ss.getSheetByName(SHEET_NAMES.NET_WORTH);
  if (!nw) nw = ss.insertSheet(SHEET_NAMES.NET_WORTH);
  nw.clear();
  nw.getRange(1, 1, 6, 2).setValues([
    ["EPF / KWSP balance (RM)", 0],
    ["Other assets — cash, ASB, etc (RM)", 0],
    ["Moomoo portfolio value (RM)", "=SUM(Holdings!D2:D)"],
    ["Total debt (RM)", 0],
    ["Net worth (RM)", "=B1+B2+B3-B4"],
    ["Last updated", "=TODAY()"]
  ]);

  ss.toast("Signalvest tabs created. Next: run setSharedSecret, then deploy as a Web App.");
}

/**
 * Run this once from the editor after editing SECRET below to something
 * long and random (e.g. from a password generator). It is stored as a
 * script property, not in a cell, so it never appears in the Sheet itself.
 */
function setSharedSecret() {
  const SECRET = "REPLACE_WITH_A_LONG_RANDOM_STRING";
  PropertiesService.getScriptProperties().setProperty("SHARED_SECRET", SECRET);
  SpreadsheetApp.getActiveSpreadsheet().toast("Secret saved. Use this same string in the app's Settings tab and as your GitHub SHEET_SECRET.");
}

function checkSecret_(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
  return expected && secret === expected;
}

function doGet(e) {
  const secret = e.parameter.secret || "";
  if (!checkSecret_(secret)) return json_({ error: "unauthorized" });

  const action = e.parameter.action || "holdings";
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (action === "holdings") {
    const hold = ss.getSheetByName(SHEET_NAMES.HOLDINGS);
    const rows = hold.getDataRange().getValues().slice(1).filter(r => r[0] && r[1] > 0);
    return json_({
      holdings: rows.map(r => ({ ticker: r[0], qty: r[1], avgCost: r[2] }))
    });
  }

  if (action === "budget") {
    const budget = ss.getSheetByName(SHEET_NAMES.BUDGET);
    return json_({ cashAvailable: Number(budget.getRange("B1").getValue()) || 0 });
  }

  // Logging via GET, not just POST: Apps Script Web Apps 302-redirect every
  // request internally, and some mobile browsers follow that redirect by
  // converting POST to GET and dropping the body (and the secret in it) —
  // which the GET-only endpoints never hit. This is the reliable path; the
  // POST version below is kept for anything that still uses it.
  if (action === "log") {
    const tx = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    const qty = Number(e.parameter.qty);
    const price = Number(e.parameter.price);
    const amount = qty * price;
    tx.appendRow([e.parameter.date, e.parameter.side, e.parameter.ticker, qty, price, amount, e.parameter.source || "app"]);
    return json_({ ok: true });
  }

  // Last trade date per ticker (any side) — lets the app warn "you just
  // traded this Xd ago" instead of nudging you into a fresh buy every time
  // a mechanical signal flips. Scans the whole log; fine at personal scale.
  if (action === "recentTrades") {
    const tx = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    const rows = tx.getDataRange().getValues().slice(1).filter(r => r[0] && r[2]);
    const last = {};
    rows.forEach(r => {
      const ticker = String(r[2]).toUpperCase();
      const date = new Date(r[0]);
      if (!last[ticker] || date > new Date(last[ticker].date)) {
        last[ticker] = { date: Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd"), side: r[1] };
      }
    });
    return json_({ recentTrades: last });
  }

  return json_({ error: "unknown action" });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: "bad request" }); }
  if (!checkSecret_(body.secret || "")) return json_({ error: "unauthorized" });

  if (body.action === "log") {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tx = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    const amount = Number(body.qty) * Number(body.price);
    tx.appendRow([body.date, body.side, body.ticker, Number(body.qty), Number(body.price), amount, body.source || "app"]);
    return json_({ ok: true });
  }

  return json_({ error: "unknown action" });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

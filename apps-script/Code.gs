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
 *      Safe to re-run later: it will never clear a tab that already has
 *      data in it (Transactions, Budget, Net Worth are additive/idempotent
 *      as of this version).
 *   3. Run `setSharedSecret` once (see instructions in that function) to
 *      generate the secret the app and GitHub Action authenticate with.
 *   4. Deploy > New deployment > Web app. Execute as "Me", access "Anyone".
 *      Copy the resulting /exec URL into the app's Settings tab and into
 *      your GitHub repo secrets (SHEET_ENDPOINT).
 *
 * Upgrading an EXISTING sheet (risk/decision/journal/corporate-actions
 * features): run `migrateSchemaV2` once. It only ever APPENDS new columns
 * to the right of Transactions and creates new tabs (Config, Corporate
 * Actions, Audit Log, Snapshots) — it never touches, reorders, or deletes
 * any existing column, row, or tab. See the column list in migrateSchemaV2's
 * comment before running it.
 */

const SHEET_NAMES = {
  TRANSACTIONS: "Transactions",
  HOLDINGS: "Holdings",
  BUDGET: "Budget",
  NET_WORTH: "Net Worth",
  CONFIG: "Config",
  CORPORATE_ACTIONS: "Corporate Actions",
  AUDIT_LOG: "Audit Log",
  SNAPSHOTS: "Snapshots"
};

// Transactions columns beyond the original A-G (Date/Side/Ticker/Qty/Price/Amount/Source).
// Additive only — never reorders or renames A-G. Every one of these is optional/nullable
// for older rows; normalizeTx() in lib/ledger.js already defaults them safely.
const TX_V2_HEADERS = [
  "Type",            // H — Buy/Sell/Dividend/Deposit/Withdrawal (defaults to Side for Buy/Sell rows)
  "Fee (RM)",         // I
  "Currency",         // J
  "Strategy Version", // K
  "Signal Score",     // L
  "Setup",            // M — e.g. "Breakout", "RSI reversal"
  "Emotion",          // N — e.g. "FOMO", "Confidence", "Revenge"
  "Thesis",           // O — free text: why you took the trade
  "Invalidation",     // P — free text: what would prove the thesis wrong
  "Rule Followed"     // Q — TRUE/FALSE, did you follow your own plan
];

const DEFAULT_CONFIG = [
  ["dailyLossLimit", 150],
  ["weeklyLossLimit", 300],
  ["monthlyLossLimit", 600],
  ["maxRiskPct", 1],
  ["trendWeight", 2],
  ["momentumWeight", 1],
  ["volumeWeight", 1],
  ["fundamentalsWeight", 2],
  ["marketRegimeWeight", 1],
  ["riskRewardWeight", 2],
  ["positionSizingWeight", 1],
  ["strategyVersion", "1.0"]
];

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Transactions: append-only log. NEVER clear an existing tab — that would
  // destroy real trade history if this is accidentally re-run.
  let tx = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (!tx) {
    tx = ss.insertSheet(SHEET_NAMES.TRANSACTIONS);
    tx.getRange(1, 1, 1, 7).setValues([["Date", "Side", "Ticker", "Qty", "Price (RM)", "Amount (RM)", "Source"]]);
    tx.setFrozenRows(1);
  }

  // Holdings: pure formula view, safe to (re)initialize any time — no user data lives here.
  let hold = ss.getSheetByName(SHEET_NAMES.HOLDINGS);
  if (!hold) hold = ss.insertSheet(SHEET_NAMES.HOLDINGS);
  hold.clear();
  hold.getRange(1, 1, 1, 4).setValues([["Ticker", "Qty Held", "Avg Cost (RM)", "Cost Basis (RM)"]]);
  hold.getRange("A2").setFormula(
    '=SORT(UNIQUE(FILTER(Transactions!C2:C, Transactions!C2:C<>"")))'
  );
  // MAP+LAMBDA, not SUMIFS nested inside ARRAYFORMULA — see fixHoldingsFormulas().
  hold.getRange("B2").setFormula(
    '=MAP(A2:A, LAMBDA(t, IF(t="", "", ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,t,Transactions!B:B,"Buy") - ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,t,Transactions!B:B,"Sell"))))'
  );
  hold.getRange("C2").setFormula(
    '=MAP(A2:A, LAMBDA(t, IF(t="", "", IFERROR(' +
      'SUMIFS(Transactions!F:F,Transactions!C:C,t,Transactions!B:B,"Buy") / ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,t,Transactions!B:B,"Buy"),0))))'
  );
  hold.getRange("D2").setFormula('=ARRAYFORMULA(IF(A2:A="","",B2:B*C2:C))');

  // Budget: you maintain "Cash available" by hand (or via the app); never clear an existing one.
  let budget = ss.getSheetByName(SHEET_NAMES.BUDGET);
  if (!budget) {
    budget = ss.insertSheet(SHEET_NAMES.BUDGET);
    budget.getRange("A1").setValue("Cash available to invest (RM)");
    budget.getRange("B1").setValue(0);
    budget.getRange("A2").setValue("Shared secret (paste a long random string, matches SHARED_SECRET script property)");
  }

  // Net Worth: monthly rollup with hand-entered cells; never clear an existing one.
  let nw = ss.getSheetByName(SHEET_NAMES.NET_WORTH);
  if (!nw) {
    nw = ss.insertSheet(SHEET_NAMES.NET_WORTH);
    nw.getRange(1, 1, 6, 2).setValues([
      ["EPF / KWSP balance (RM)", 0],
      ["Other assets — cash, ASB, etc (RM)", 0],
      ["Moomoo portfolio value (RM)", "=SUM(Holdings!D2:D)"],
      ["Total debt (RM)", 0],
      ["Net worth (RM)", "=B1+B2+B3-B4"],
      ["Last updated", "=TODAY()"]
    ]);
  }

  ss.toast("Signalvest tabs created/verified. Existing data (if any) was left untouched. Next: run setSharedSecret, then deploy as a Web App. For the risk/decision/journal upgrade, also run migrateSchemaV2.");
}

/**
 * One-time, additive-only upgrade for an EXISTING sheet. Safe to re-run —
 * every step checks first and skips anything already in place.
 *
 * What it adds:
 *   - Transactions: 10 new columns appended at H:Q (see TX_V2_HEADERS above)
 *     — Type, Fee, Currency, Strategy Version, Signal Score, Setup, Emotion,
 *     Thesis, Invalidation, Rule Followed. Existing columns A:G and all
 *     existing rows are never touched. For existing rows, column H (Type)
 *     is backfilled from column B (Side) only — every other new cell is
 *     left blank, which lib/ledger.js already treats as a safe default.
 *   - Four new tabs: Config (risk limits + strategy weights, seeded with
 *     the same defaults the spec worked example uses), Corporate Actions
 *     (empty, manual entry), Audit Log (empty, append-only), Snapshots
 *     (empty, populated by the GitHub Action going forward).
 */
function migrateSchemaV2() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tx = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  if (!tx) throw new Error("Transactions tab not found — run setupSheet first.");

  const currentLastCol = tx.getLastColumn();
  if (currentLastCol < 8) {
    tx.getRange(1, 8, 1, TX_V2_HEADERS.length).setValues([TX_V2_HEADERS]);
    const lastRow = tx.getLastRow();
    if (lastRow > 1) {
      // Backfill Type (col H) from Side (col B) for existing rows only — every other
      // new column is left blank on purpose.
      const sides = tx.getRange(2, 2, lastRow - 1, 1).getValues();
      tx.getRange(2, 8, lastRow - 1, 1).setValues(sides);
    }
  }

  function ensureTab(name, headers, seedRows) {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
      if (seedRows && seedRows.length) {
        sh.getRange(2, 1, seedRows.length, seedRows[0].length).setValues(seedRows);
      }
    }
    return sh;
  }

  ensureTab(SHEET_NAMES.CONFIG, ["Key", "Value"], DEFAULT_CONFIG);
  ensureTab(SHEET_NAMES.CORPORATE_ACTIONS, ["Date", "Ticker", "Type", "Ratio", "Subscription Price (RM)", "Notes"]);
  ensureTab(SHEET_NAMES.AUDIT_LOG, ["Timestamp", "Event", "Detail", "Old Value", "New Value", "Source"]);
  ensureTab(SHEET_NAMES.SNAPSHOTS, ["Date", "Time", "Portfolio Value (RM)", "Cash (RM)", "Invested Capital (RM)", "Source"]);

  ss.toast("Schema V2 migration complete: Transactions extended with 10 new columns (H:Q), 4 new tabs created. No existing data was modified.");
}

/**
 * Run this once from the editor after editing SECRET below to something
 * long and random (e.g. from a password generator). It is stored as a
 * script property, not in a cell, so it never appears in the Sheet itself.
 */
function setSharedSecret() {
  const SECRET = "REPLACE_WITH_A_LONG_RANDOM_STRING";
  // Guard: re-pasting this file resets SECRET to the placeholder above, and
  // running it unedited would silently overwrite a working secret with it.
  if (SECRET === "REPLACE_WITH_A_LONG_RANDOM_STRING") {
    throw new Error("Edit the SECRET value on the line above to your own text first, then run this again.");
  }
  PropertiesService.getScriptProperties().setProperty("SHARED_SECRET", SECRET);
  SpreadsheetApp.getActiveSpreadsheet().toast("Secret saved. Use this same string in the app's Settings tab and as your GitHub SHEET_SECRET.");
}

/**
 * Run this to see the secret currently stored, so you can compare it against
 * what the app has. View > Logs (or the Execution log) shows the output.
 */
function showSharedSecret() {
  const s = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
  if (!s) {
    Logger.log("No secret is set. Edit SECRET in setSharedSecret and run that function once.");
  } else {
    Logger.log("Current secret is: [" + s + "]  (" + s.length + " characters)");
    Logger.log("Paste exactly what is between the square brackets into the app's Settings tab.");
  }
}

function checkSecret_(secret) {
  const expected = PropertiesService.getScriptProperties().getProperty("SHARED_SECRET");
  return expected && secret === expected;
}

// Appends one row to Audit Log. Called internally by every write action below
// so the audit trail can't be skipped by a client that forgets to log it.
// Never throws — a logging failure must never block the real write it's
// describing.
function logAudit_(ss, event, detail, oldValue, newValue, source) {
  try {
    const sh = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
    if (!sh) return; // migrateSchemaV2 not run yet on this sheet — skip quietly
    sh.appendRow([new Date(), event, detail || "", oldValue == null ? "" : oldValue, newValue == null ? "" : newValue, source || "app"]);
  } catch (e) {
    // swallow — audit logging is best-effort, never fatal
  }
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

  // Lets the app's own Settings tab be the single place you update cash —
  // this writes it into the Sheet too, so the GitHub Actions budget-fit
  // check (which only reads the Sheet) stays in sync automatically.
  if (action === "setBudget") {
    const cash = Number(e.parameter.cash);
    if (isNaN(cash)) return json_({ error: "invalid cash value" });
    const budget = ss.getSheetByName(SHEET_NAMES.BUDGET);
    const old = budget.getRange("B1").getValue();
    budget.getRange("B1").setValue(cash);
    logAudit_(ss, "Budget changed", "Cash available to invest", old, cash, e.parameter.source);
    return json_({ ok: true, cashAvailable: cash });
  }

  // Records a human decision (Approve/Reject/Watch) on a screened candidate —
  // this NEVER places, modifies or implies a Moomoo order. It's purely a
  // decision-journal entry; the trade itself, if any, is still logged
  // separately via `log` once you've actually executed it with your broker.
  if (action === "logDecision") {
    const p = e.parameter;
    logAudit_(ss, "Decision recorded", `${p.decision} — ${p.ticker} (score ${p.score || "?"})`, "", p.decision, p.source);
    return json_({ ok: true });
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
    const p = e.parameter;
    // Columns A:G unchanged; H:Q are the additive V2 columns (blank if this
    // sheet hasn't been migrated yet — appendRow just writes fewer cells).
    const row = [
      p.date, p.side, p.ticker, qty, price, amount, p.source || "app",
      p.type || p.side || "", p.fee ? Number(p.fee) : "", p.currency || "",
      p.strategyVersion || "", p.signalScore !== undefined && p.signalScore !== "" ? Number(p.signalScore) : "",
      p.setup || "", p.emotion || "", p.thesis || "", p.invalidation || "", p.ruleFollowed || ""
    ];
    tx.appendRow(row);
    logAudit_(ss, "Trade logged", `${p.side} ${qty} ${p.ticker} @ RM${price}`, "", amount, p.source);
    return json_({ ok: true });
  }

  // Full raw Transactions rows (all columns), for client-side ledger
  // reduction — realized P/L, loss limits, journal and backtest features
  // all need the full history, not just the aggregated Holdings view.
  if (action === "transactions") {
    const tx = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
    const values = tx.getDataRange().getValues();
    const headers = values[0];
    const rows = values.slice(1).filter(r => r[0]); // has a date
    const keyMap = {
      "Date": "date", "Side": "side", "Ticker": "ticker", "Qty": "qty", "Price (RM)": "price",
      "Amount (RM)": "amount", "Source": "source", "Type": "type", "Fee (RM)": "fee", "Currency": "currency",
      "Strategy Version": "strategyVersion", "Signal Score": "signalScore", "Setup": "setup",
      "Emotion": "emotion", "Thesis": "thesis", "Invalidation": "invalidation", "Rule Followed": "ruleFollowed"
    };
    const keyFor = function (h) { return keyMap[h] || h; };
    const out = rows.map(r => {
      const o = {};
      headers.forEach((h, i) => { o[keyFor(h)] = r[i] instanceof Date ? Utilities.formatDate(r[i], Session.getScriptTimeZone(), "yyyy-MM-dd") : r[i]; });
      return o;
    });
    return json_({ transactions: out });
  }

  // Risk limits + strategy weights, editable from the app's Settings tab.
  if (action === "getConfig") {
    const sh = ss.getSheetByName(SHEET_NAMES.CONFIG);
    if (!sh) return json_({ config: {}, migrated: false });
    const rows = sh.getDataRange().getValues().slice(1).filter(r => r[0]);
    const config = {};
    rows.forEach(r => { config[r[0]] = r[1]; });
    return json_({ config, migrated: true });
  }

  if (action === "setConfig") {
    const sh = ss.getSheetByName(SHEET_NAMES.CONFIG);
    if (!sh) return json_({ error: "Config tab not found — run migrateSchemaV2 first" });
    const key = e.parameter.key;
    const value = e.parameter.value;
    if (!key) return json_({ error: "missing key" });
    const rows = sh.getDataRange().getValues();
    let rowIndex = -1, oldValue = null;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) { rowIndex = i + 1; oldValue = rows[i][1]; break; }
    }
    if (rowIndex === -1) {
      sh.appendRow([key, value]);
    } else {
      sh.getRange(rowIndex, 2).setValue(value);
    }
    logAudit_(ss, "Configuration changed", key, oldValue, value, e.parameter.source);
    return json_({ ok: true, key, value });
  }

  if (action === "corporateActions") {
    const sh = ss.getSheetByName(SHEET_NAMES.CORPORATE_ACTIONS);
    if (!sh) return json_({ corporateActions: [] });
    const rows = sh.getDataRange().getValues().slice(1).filter(r => r[0]);
    return json_({
      corporateActions: rows.map(r => ({
        date: r[0] instanceof Date ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), "yyyy-MM-dd") : r[0],
        ticker: r[1], type: r[2], ratio: r[3], subscriptionPrice: r[4], notes: r[5]
      }))
    });
  }

  if (action === "logCorporateAction") {
    const sh = ss.getSheetByName(SHEET_NAMES.CORPORATE_ACTIONS);
    if (!sh) return json_({ error: "Corporate Actions tab not found — run migrateSchemaV2 first" });
    const p = e.parameter;
    sh.appendRow([p.date, (p.ticker || "").toUpperCase(), p.type, p.ratio || "", p.subscriptionPrice || "", p.notes || ""]);
    logAudit_(ss, "Corporate action logged", `${p.type} ${p.ticker}`, "", p.ratio || p.notes || "", p.source);
    return json_({ ok: true });
  }

  // Recent Audit Log rows (most recent first), for the in-app System/health panel.
  if (action === "audit") {
    const sh = ss.getSheetByName(SHEET_NAMES.AUDIT_LOG);
    if (!sh) return json_({ audit: [] });
    const limit = Math.min(Number(e.parameter.limit) || 100, 500);
    const rows = sh.getDataRange().getValues().slice(1).filter(r => r[0]);
    const recent = rows.slice(-limit).reverse();
    return json_({
      audit: recent.map(r => ({
        timestamp: r[0] instanceof Date ? r[0].toISOString() : r[0],
        event: r[1], detail: r[2], oldValue: r[3], newValue: r[4], source: r[5]
      }))
    });
  }

  // Portfolio value snapshot, appended by the GitHub Action (scripts/check-signals.mjs)
  // roughly 3x/trading day — the basis for benchmarking and drawdown history.
  if (action === "snapshot") {
    const sh = ss.getSheetByName(SHEET_NAMES.SNAPSHOTS);
    if (!sh) return json_({ error: "Snapshots tab not found — run migrateSchemaV2 first" });
    const p = e.parameter;
    sh.appendRow([p.date, p.time || "", Number(p.portfolioValue) || 0, Number(p.cash) || 0, Number(p.investedCapital) || 0, p.source || "check-signals"]);
    return json_({ ok: true });
  }

  if (action === "getSnapshots") {
    const sh = ss.getSheetByName(SHEET_NAMES.SNAPSHOTS);
    if (!sh) return json_({ snapshots: [] });
    const rows = sh.getDataRange().getValues().slice(1).filter(r => r[0]);
    const limit = Math.min(Number(e.parameter.limit) || 500, 2000);
    return json_({
      snapshots: rows.slice(-limit).map(r => ({
        date: r[0] instanceof Date ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), "yyyy-MM-dd") : r[0],
        time: r[1], portfolioValue: r[2], cash: r[3], investedCapital: r[4], source: r[5]
      }))
    });
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

/**
 * One-time fix for a Google Sheets formula bug: the original Holdings
 * formulas (SUMIFS nested inside ARRAYFORMULA, with the criteria itself
 * coming from another formula's array output) don't vectorize per row in
 * Sheets — every row silently repeats row 2's result instead of computing
 * its own ticker. MAP+LAMBDA calls the calculation once per ticker properly.
 * Safe to run any time; does not touch Transactions data.
 */
function fixHoldingsFormulas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hold = ss.getSheetByName(SHEET_NAMES.HOLDINGS);
  hold.getRange("B2").setFormula(
    '=MAP(A2:A, LAMBDA(t, IF(t="", "", ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,t,Transactions!B:B,"Buy") - ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,t,Transactions!B:B,"Sell"))))'
  );
  hold.getRange("C2").setFormula(
    '=MAP(A2:A, LAMBDA(t, IF(t="", "", IFERROR(' +
      'SUMIFS(Transactions!F:F,Transactions!C:C,t,Transactions!B:B,"Buy") / ' +
      'SUMIFS(Transactions!D:D,Transactions!C:C,t,Transactions!B:B,"Buy"),0))))'
  );
  ss.toast("Holdings formulas fixed — each ticker now computes its own qty/avg cost.");
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

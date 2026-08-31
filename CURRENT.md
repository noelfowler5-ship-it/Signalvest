# Signalvest — Current Sprint

**Status**: Phase 2 (Schema V2 migration) in progress

## What's In Flight

### 1. Schema V2 Migration — Core Data & Tests (ACTIVE)

**What's done**:
- [x] `migrateSchemaV2` script written (Apps Script function)
- [x] New columns added to Transactions (Type, Fee, Currency, Strategy Version, Signal Score, Setup, Emotion, Thesis, Invalidation, Rule Followed)
- [x] Five new tabs created (Config, Corporate Actions, Audit Log, Snapshots, Signals, Risk Status)
- [x] Type backfilled from Side on existing rows
- [x] 49+ tests passing (position-sizing, P/L math, portfolio heat, loss limits, decision scoring, backtest anti-lookahead, reconciliation, corporate actions)
- [x] Signals tab + Risk Status row overwritten daily by GitHub Actions
- [x] **`migrateSchemaV2` verified end-to-end (2026-08-31)** — see below

**Verification method (2026-08-31)**: this session had no Google Sheets/Apps Script
execution access (only Drive file-level tools — no cell writes, no script
execution). Verified instead by loading the *real, unmodified* `apps-script/Code.gs`
into a Node.js mock of the `SpreadsheetApp`/`PropertiesService` APIs and executing
the actual `migrateSchemaV2`/`setupSheet` functions against simulated spreadsheet
state (fresh + populated-V1 fixtures, plus targeted edge cases). This runs the
production code, not a reimplementation, so it catches real logic bugs — but it
is not literally Google's servers, so Sheets-API-specific runtime quirks can't
be ruled out. Script used: throwaway, not committed (ephemeral scratchpad).

**Result — fresh/blank sheet**: PASS.
- `migrateSchemaV2` alone on a truly blank spreadsheet (no `Transactions` tab)
  throws a clear `"Transactions tab not found — run setupSheet first."` error
  and creates no partial state — correct guarded behavior, not a bug.
- The real new-user path, `setupSheet()` then `migrateSchemaV2()`, creates all
  10 expected tabs (Transactions, Holdings, Budget, Net Worth, Config, Corporate
  Actions, Audit Log, Snapshots, Signals, Risk Status) with headers matching the
  spec exactly, Transactions A:Q in the correct order, and Config seeded with
  all 12 `DEFAULT_CONFIG` rows.

**Result — copy of a populated V1 sheet**: PASS, after one fix.
- Transactions A:G existing rows preserved byte-for-byte (no data loss, no row
  loss), H:Q headers appended in the correct order, `Type` backfilled from
  `Side` for every existing row (including a non-Buy/Sell "Dividend" row),
  columns I:Q correctly left blank rather than fabricated. Holdings/Budget/Net
  Worth tabs untouched. Running it a second time (idempotency) does not
  duplicate columns/tabs and does not clobber a user-edited Config value or
  existing Audit Log rows.
- **Bug found and fixed**: the original gate `if (tx.getLastColumn() < 8)`
  decided "already migrated" by column count alone. Any real sheet with stray
  content anywhere at or past column H — a manual note, leftover formatting,
  an unrelated column far to the right — would trip that gate and **silently
  skip the entire Transactions upgrade** (no new headers, no `Type` backfill,
  no error, no toast warning). Fixed in `apps-script/Code.gs` to gate on
  whether `H1` actually equals `"Type"` (the real V2 marker) instead of on
  `getLastColumn()`. Re-verified: V2 headers now install correctly even with
  stray content in H1 or in a far-right column, and the idempotency case above
  still passes (second run correctly detects "already migrated" and no-ops).
- Full existing suite (`node --test test/*.test.mjs`, 49 tests) still passes
  after the fix — unaffected, since it doesn't touch `lib/*.js`.

**Safe to run against the real production sheet?** Yes, with one caveat: this
was verified via a faithful mock of the Apps Script runtime, not literally
executed against Google's servers, because this session had no Sheets/Apps
Script API access. The logic itself (column placement, backfill, tab creation,
idempotency, and the column-H edge case) is now verified correct. Recommend
still running it first against a throwaway **copy** of the real sheet in the
actual Apps Script editor before running on production, purely to rule out any
Sheets-API-specific behavior (quota, locking, actual `getLastColumn()`
semantics on a real sheet) that a mock can't reproduce — not because a logic
bug is expected.

**What's next** (Phase 2 completion — separate sessions):
- [ ] Audit Log: verify append-only constraint (no overwrites, no deletes)
- [ ] Snapshots tab: confirm daily portfolio value is being written
- [ ] Config tab: verify decision weights + risk limits sync to browser Settings tab
- [ ] Browser Settings UI: test read/write of Config tab values (risk limits, weights)

---

### 2. Decision Scoring & Position Sizing (BACKLOG, Phase 2+)

**What's done**:
- [x] Scoring logic implemented (`lib/decision.js`)
- [x] Position-sizing formula with Kelly-like logic
- [x] 80% threshold enforcement (mediocre BUY candidates filtered out)
- [x] Risk:reward calculation (ATR-based stops vs swing-high targets)
- [x] Tested against worked example from spec

**What's next** (Phase 2 backlog):
- [ ] Browser screener: display decision card (score, weights, position size) for each candidate
- [ ] Verify browser decision logic matches `lib/decision.js` (currently browser still uses old inline logic)
- [ ] User test: do the weights feel right? (trend/volume/fundamentals/regime weights)

---

### 3. Risk Management UI (BACKLOG, Phase 2+)

**What's done**:
- [x] Risk tab layout (portfolio heat %, sector concentration, daily/weekly/monthly loss-limit usage)
- [x] TRADING PAUSED banner logic

**What's next** (Phase 2 backlog):
- [ ] Risk Status sync: verify risk data flows browser → Sheet on portfolio changes
- [ ] Telegram bot: test that it reads `riskStatus.tradingPaused` and warns before suggesting new positions
- [ ] User test: are loss-limit thresholds realistic? (daily/weekly/monthly)

---

### 4. Market Regime Classification (BACKLOG, Phase 2+)

**What's done**:
- [x] KLCI trend detection (SMA-based)
- [x] Breadth indicator (% of universe in uptrend)
- [x] Regime classification: RISK_ON / NEUTRAL / RISK_OFF

**What's next** (Phase 2 backlog):
- [ ] Browser screener: display market regime banner (current conditions)
- [ ] Verify regime matches GitHub Actions output (scheduled scans)

---

## What's Blocked / Deferred

- **Benchmarking/Drawdown History** (Phase 3+): Snapshots tab is being written daily, but no charting or performance comparison yet. Requires historical P/L calculation + benchmark selection (KLCI?). Deferred.

- **Corporate Actions UI** (Phase 2 backlog → Phase 3+): Tab created, logic works, but no browser form to add splits/bonus/rights yet. Users can edit the sheet manually or wait for UI.

- **Telegram Bot Advisor** (Phase 2+ nice-to-have, optional): Optional setup (Make.com + Gemini). Requires Gemini API key + bot token. Core screener/portfolio works without it.

---

## What's Done (Last Session)

- Scaffolded PROJECT.md and CURRENT.md (this session)
- Two companion sessions created: Batch Planner, Personal CFO

---

## Testing Strategy

**Automated**:
- `node --test test/*.test.mjs` (49+ tests)
- GitHub Actions on every push (`.github/workflows/test.yml`)

**Manual (browser)**:
- Open app, verify screener runs
- Settings tab: connect to test Google Sheet, verify Config sync
- Portfolio tab: log a trade, verify Transactions tab updates
- Risk tab: verify portfolio heat calculation

**Integration (end-to-end)**:
- Set up new test Google Sheet
- Run `migrateSchemaV2` manually
- Run GitHub Actions cron manually (`scripts/check-signals.mjs`)
- Verify Signals + Risk Status tabs populated
- Open browser app, verify data displayed correctly

---

## Branch & Push

**Branch**: `claude/tiktok-affiliate-manager-setup-5xpu6k`

---

**Session Discipline**: Report findings when task is complete, then close session.

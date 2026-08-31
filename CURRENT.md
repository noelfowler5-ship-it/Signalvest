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

**What's next** (Phase 2 completion):
- [ ] Verify `migrateSchemaV2` works end-to-end on a fresh Google Sheet (test sheet)
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

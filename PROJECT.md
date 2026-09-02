# Signalvest — Project Roadmap

## Overview

A free, self-hosted **personal investment decision & risk-management system** for Bursa Malaysia stocks.

**Not financial advice, not an execution system.** Signals are mechanical rules applied to public price history. Nothing here places orders — you execute manually with your broker (Moomoo), then reconcile what you actually did.

**Architecture**: Static site (GitHub Pages) + GitHub Actions cron job (daily scheduled scans) + Google Sheet as private source of truth + optional Telegram bot advisor (Make.com + Gemini).

```
Market data → Signal → Decision Score → Position Size → Risk Check → Human Approval → Moomoo → Reconciliation
```

---

## Tech Stack

**Front End** (`index.html` + `lib/*.js`)
- Vanilla JS, inline CSS, no framework, no build step
- Browser-based screener (runs daily auto-scan, caches in localStorage)
- Tabs: Screener, Portfolio, Risk (Phase 2+), Settings
- CORS workaround chain for Yahoo Finance data (r.jina.ai → allorigins.win → direct fallback)

**Back End** (`scripts/*.mjs` + GitHub Actions)
- Node.js scripts (not browser-constrained)
- `check-signals.mjs`: daily cron job, checks all ~67 tickers, posts to Sheets
- `backtest.mjs`: manual CLI for historical backtesting (not scheduled)
- Uses `lib/*.js` (ES modules shared with browser)

**Data Storage**
- **Google Sheets** (real source of truth, private, user-owned)
  - `Transactions`: buy/sell/dividend ledger (includes Phase 2: Type, Fee, Currency, Strategy, Signal Score, Setup/Emotion/Thesis/Invalidation/Rule)
  - `Holdings`: current positions (avg cost, qty)
  - `Config`: risk limits + decision weights (synced to app's Settings tab)
  - `Corporate Actions`: splits/bonuses/rights/mergers (manual log)
  - `Audit Log`: append-only write history (who changed what, when)
  - `Snapshots`: portfolio value over time (filled by scheduled Action, future: benchmarking/drawdown)
  - `Signals`: latest signal/score/entry/stop/target per ticker (overwritten daily)
  - `Risk Status`: current portfolio heat, daily/weekly/monthly loss-limit usage, paused reason

- **Google Apps Script** (deployed as Web App)
  - `doGet`/`doPost` actions for app ↔ Sheet communication
  - `writeSignals`: POST (overwrite Signals tab with latest run)
  - `writeRiskStatus`: POST (overwrite Risk Status row)
  - `context`: GET (bundle Signals + Risk Status + Holdings + Config, used by Telegram bot)
  - `setSharedSecret` / `setupSheet` / `migrateSchemaV2`: one-time setup (see Setup below)

- **Browser Storage** (secondary, quick reference)
  - `localStorage`: screener cache (results from today's auto-run)
  - `indexedDB`: none currently (localStorage is fine for this app's data volume)

**Deployment**
- GitHub Pages (branch `main`, folder `/root`)
- GitHub Actions (cron-triggered, node scripts with secrets)
- Optional: Make.com scenario + Telegram bot (sits on top, no changes to core)

---

## Signal & Decision Model

### Signal Rule (Technical)

Based on SMA20 vs SMA50 (trend) + RSI14 Wilder (momentum):
- **uptrend + RSI 35–68**: BUY
- **uptrend + RSI > 68**: HOLD (overbought, don't chase)
- **downtrend + RSI < 30**: HOLD (oversold, maybe a bounce, don't panic-sell)
- **downtrend** otherwise: AVOID
- **no clear trend**: HOLD

Liquidity filter: skip <50k shares/day average (last 20 sessions), unless already held.
Budget filter: skip if 100 shares costs more than available cash, unless already held.

### Decision Score (Phase 2+)

Scoring weights (all configurable via Settings tab):
- **Trend** (primary momentum signal): SMA slope, RSI position
- **Volume** (demand): volume > 20-day average?
- **Fundamentals** (never fabricated): only counted if user verified it; otherwise flagged "not verified"
- **Market Regime** (macro context): RISK_ON/NEUTRAL/RISK_OFF from KLCI + breadth
- **Risk:Reward**: ATR-based stop-loss vs target (based on swing highs/lows)
- **Position Sizing** (Kelly-like): fraction of portfolio heat budget
- **Strategy Version** (Phase 2+): which iteration of rules is this?

**Minimum threshold**: BUY candidates must score ≥80% of max (8/10 default) to be shown. No mediocre picks.

### Risk Management (Phase 2+)

**Portfolio Heat**: genuine capital at risk if every stop-loss hits (not notional position size).
- Sum across all holdings: (qty × stop-distance × current-price)
- Sectors concentration warning (which sector has largest exposure?)
- Compare to user's configured "comfort threshold" (Settings tab)

**Loss Limits** (daily/weekly/monthly):
- Track total realized loss year-to-date within each period
- Compare to user's configured limits
- If breached: `TRADING PAUSED` banner (informational only, doesn't block broker)
- `riskStatus.tradingPaused` flag sent to Telegram bot (bot checks it before discussing new positions)

### Position Sizing

Computed but never disclosed in GitHub Actions logs (public repo). Formula includes:
- Available cash
- Portfolio heat already deployed
- Stop-loss distance (ATR-based)
- Target profit (swing-high resistance)
- Risk:reward ratio configured

Browser app shows real share counts/RM figures (your private session). Telegram bot includes them if you want (private DM).

---

## Core Workflows

### 1. Daily Auto-Scan (GitHub Actions Cron)

Triggered by schedule (typically dawn Malaysian time):

```
scripts/check-signals.mjs
  → Fetch price/volume for ~67 tickers (Yahoo Finance, direct from Node)
  → Apply Signal rule + Decision score
  → Write Signals tab (overwrite)
  → Compute risk heat + loss-limit usage
  → Write Risk Status row (overwrite)
  → Send Telegram alert (if config set up)
    - market regime (RISK_ON/NEUTRAL/RISK_OFF)
    - new BUY candidates (if any)
    - risk warnings (if paused or heat high)
```

Result: Signals + Risk Status tabs always show "latest known state" (snapshot, not growing log).

### 2. Browser Screener (Real-Time, User-Initiated)

First open of the day: auto-runs (no manual tap needed). Caches result in localStorage.
Later opens: serves cached result. Tap "Run screener" anytime for live re-check.

Deliberate: don't hammer CORS proxies on every page open (free proxies = no uptime guarantee, risk rate-limit).

**Output**:
- Holdings (your current positions, with stop-loss guidance)
- BUY Candidates (top 3 that meet score threshold, with full decision card per candidate)
  - Plain-English positives/risks
  - Entry/stop/target prices
  - Risk:reward ratio
  - Position sizing (share qty recommendation)
  - Invalidation line (when does this thesis break?)
- Market Regime banner (current conditions, never a prediction)

### 3. Portfolio Logging

**Manual entry**: Portfolio tab → "Log a trade" (Buy/Sell, optional setup/emotion/thesis/rule detail)
**CSV import**: Moomoo CSV export → Import (reconciles against sheet)

Both write to `Transactions` tab. Import deduplicates: each fill gets stable ID (ticker + time + qty + price).

### 4. Reconciliation

After every CSV import, compare holdings (Moomoo CSV vs Sheets) per ticker:
- Quantity mismatch? Show diff
- Avg cost mismatch? Show diff
- Missing in one side? Flag for review

No auto-adjustment; you decide whether to adjust Sheet or re-import.

### 5. Historical Backtesting (Manual, CLI)

```
node scripts/backtest.mjs 1155.KL
node scripts/backtest.mjs 1155.KL --strategy=breakoutVolume --split=2025-01-01
```

Output: win rate, profit factor, expectancy, max drawdown.
With `--split`: in-sample vs out-of-sample separately (detects overfitting).
Full report saved to `data/backtests/`.

Anti-lookahead: a signal on bar i only ever fills at bar i+1's open (honest forward-testing).

### 6. Optional Telegram Bot Advisor (Make.com + Gemini)

**One-way (scheduled)**: GitHub Actions posts alerts on cron schedule.
**Two-way (conversational)**: Message the bot anytime with questions like "why Maybank?".

Make.com scenario: (1) Telegram trigger → (2) fetch context from Sheets → (3) send to Gemini + system prompt → (4) reply to Telegram.

System prompt tells Gemini to:
- Check `riskStatus.tradingPaused` first (if paused, say so before discussing any new position)
- Check portfolio heat % vs comfort threshold (warn if already at/above threshold)
- Explain only (never invent buy/sell opinion); stick to mechanical scores

Free tier: Make.com (1k ops/month) covers ~250 questions/month. Gemini free tier is plenty.

---

## Schema Phases

### Phase 1 (Original, Still Live)

Core screener + portfolio logging:
- Transactions: Date, Ticker, Side (Buy/Sell), Qty, Price, Fees
- Holdings: auto-derived from Transactions
- No decision scoring, no risk management, no journal

### Phase 2 (Current, Schema V2 Migration)

Additive only (never breaks Phase 1 data):

**Transactions** additions (columns H:Q):
- `Type` (Trade/Dividend/Deposit/Withdrawal) — backfilled from Side for existing rows
- `Fee (RM)` (explicit fee tracking)
- `Currency` (if trading USD/SGD instruments)
- `Strategy Version` (which iteration of rules was this trade based on?)
- `Signal Score` (screener score on entry date)
- `Setup` (technical setup: breakout/pullback/reversal/etc.)
- `Emotion` (journaling: fear/greed/discipline/etc.)
- `Thesis` (why this trade fits your thesis)
- `Invalidation` (when would you exit, regardless of loss/gain?)
- `Rule Followed` (which rule triggered this: SMA/RSI/regime/etc.?)

**New Tabs**:
- `Config`: risk limits (daily/weekly/monthly loss limits, heat comfort %, position size %), decision weights (trend/volume/fundamentals/regime/risk-reward weight)
- `Corporate Actions`: splits/bonus/rights/mergers (manual log, adjusts display qty/avg-cost)
- `Audit Log`: append-only (who changed what, when, what changed)
- `Snapshots`: portfolio value timeline (Date, Total Value, Cash, Holdings Value) — filled by scheduled Action, future: benchmarking/drawdown history
- `Signals`: latest ticker/signal/score/entry/stop/target per screened symbol (overwritten daily)
- `Risk Status`: today's portfolio heat %, sector concentration, loss-limit usage %, paused reason (overwritten daily)

**Migration Script**:
`migrateSchemaV2` (Apps Script function, run once):
- Adds all new columns/tabs
- Backfills `Type` from Side for existing Transactions rows
- Everything else blank until user fills in

---

## Code Organization

**Browser** (`index.html`)
- Inline `<script type="module">` importing from `lib/*.js`
- Custom CORS fetch chain: r.jina.ai → allorigins.win → direct

**Node** (`scripts/*.mjs`)
- Direct Yahoo Finance fetches (no CORS)
- Imports from `lib/*.js` (ES modules, same logic as browser)

**Shared Libraries** (`lib/*.js`)
- `indicators.js`: pure math (SMA/RSI14/ATR14/classify) — new, shared by decision/backtest
- `decision.js`: scoring + position-sizing logic (new, tested, used by browser + Node)
- `backtest.js`: historical backtester (new, manual CLI)
- `regime.js`: market-regime classification (new)
- **Original inline copies** in `index.html` + `check-signals.mjs`: unchanged (CORS-routing duplication from before shared libs existed; no refactor needed for small codebase)

**Tests** (`test/*.test.mjs`)
- 49+ tests: position-sizing (worked example), P/L math, portfolio heat, loss limits, decision scoring, backtest anti-lookahead, reconciliation, corporate actions, behavior analytics
- Run: `node --test test/*.test.mjs`
- Auto-runs on every push via `.github/workflows/test.yml`
- Browser UI (index.html wiring) verified with headless jsdom scratch harness (not committed, not part of auto CI)

---

## Critical Constraints & Conventions

1. **Public Repo, Private Data**: Repo is public (GitHub Pages requirement). Code + generic watchlist only; all real cash/holdings/config live in your private Google Sheet.

2. **No Real Figures in GitHub Actions Logs** (public): Alerts mention "portfolio heat at 65%", never "RM5,000 at risk." Share counts/RM totals only appear in browser app (your session) or Telegram (private DM).

3. **Universe Management** (`universe.json`): ~67 Bursa Malaysia main-market tickers + sectors. **Verify codes + sectors** — they're from general knowledge, not a live pull. Delistings/code changes must be manual. Wrong codes silently skip (try/catch), nothing breaks.

4. **Three Copies of Fetch Logic**:
   - `index.html`: inline, CORS-routed (browser)
   - `scripts/check-signals.mjs`: inline, direct fetch (Node)
   - `lib/indicators.js`: pure math only (new, used by decision/backtest — avoids redundant 4th copy)
   - Rationale: small codebase, simpler than adding build step for duplicate fetch logic

5. **Honest Limitations** (documented in README):
   - No earnings/dividend calendar (no reliable free source)
   - Cash can't be reconciled from CSV (CSV = fills only, not account statement)
   - Backtests have no survivorship-bias correction
   - Fundamentals never fetched (Yahoo locked that behind login); link to Yahoo page for you to check
   - Market regime/decision scores describe current conditions, never predictions

---

## Deployment & Setup

### Initial Setup
1. Create blank Google Sheet
2. Deploy Apps Script (`apps-script/Code.gs`) as Web App
3. Run `setSharedSecret` (set password), `setupSheet` (build tabs), `migrateSchemaV2` (add Phase 2)
4. Add GitHub repo secrets: `SHEET_ENDPOINT`, `SHEET_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
5. Enable GitHub Pages: branch `main`, folder `/root`

### Running
- **Screener**: open `https://<you>.github.io/Signalvest/` (auto-runs first open daily, cached after)
- **Scheduled scans**: GitHub Actions cron (daily, posts to Sheets + Telegram)
- **Backtesting**: `node scripts/backtest.mjs TICKER`
- **Tests**: `node --test test/*.test.mjs`

---

## Privacy Note on Logs & Alerts

This repo is public; GitHub Actions logs are public too.
- `scripts/check-signals.mjs` never logs/messages actual RM totals or share counts
- Telegram alerts: percentages only (except in conversational bot, which is private DM)
- Browser app: real figures shown (your private session)

---

**Session Discipline**: One task per session. Close when done. Work on designated branch only.

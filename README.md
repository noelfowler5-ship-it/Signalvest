# Signalvest

A free, self-hosted **personal investment decision & risk-management system**
for Bursa Malaysia. Static site (GitHub Pages) + a GitHub Actions cron job
that pings you on Telegram when something changes + a Google Sheet as the
private source of truth for your trades, risk config and net worth.

**Not financial advice, and not an execution system.** Signals are a
mechanical rule applied to public price history, scored transparently
against weights you control. Nothing here places, modifies or cancels a
real order — you always execute manually with your broker (Moomoo), then
import or log what you actually did.

```text
Market data → Signal → Decision → Position size → Risk check → Human approval → Moomoo → Reconciliation → Performance → Learning
```

## How it fits together

```
index.html (GitHub Pages)  ──┐
lib/*.js (shared logic)  ────┤──→ your Google Sheet (Apps Script Web App)
scripts/check-signals.mjs ───┤       Transactions · Holdings · Budget · Net Worth
   (GitHub Actions, on a cron)       Config · Corporate Actions · Audit Log · Snapshots
scripts/backtest.mjs ────────┘   (run manually, not scheduled)
   → Telegram when something changes
```

Nothing personal — your cash balance, holdings, trade history, or risk
settings — is ever committed to this repo. This repo is public (required
for free GitHub Pages), so it only contains the app's *code* and a generic
watchlist of Bursa tickers. All your real numbers live in the Google Sheet,
which only you can access.

## Setup

### 1. Google Sheet + Apps Script

1. Create a blank Google Sheet.
2. Extensions → Apps Script, delete the default code, paste in
   `apps-script/Code.gs`.
3. In the editor, open `setSharedSecret`, replace
   `REPLACE_WITH_A_LONG_RANDOM_STRING` with a real random string (a
   password generator is fine), then run it once. Approve the permission
   prompts — this is the manual "Authorize" step Google requires; nobody
   can do this but you.
4. Run `setupSheet` once. This builds four tabs — `Transactions`,
   `Holdings`, `Budget`, `Net Worth` — with headers and formulas only. Safe
   to re-run later: it never clears a tab that already has data in it.
5. On the `Budget` tab, set cell B1 to how much cash you currently have
   available to invest.
6. **New in this version — run `migrateSchemaV2` once.** It's additive
   only (never touches existing columns/rows/tabs) and adds:
   - 10 new columns on `Transactions`, appended at H:Q: **Type, Fee (RM),
     Currency, Strategy Version, Signal Score, Setup, Emotion, Thesis,
     Invalidation, Rule Followed.** Existing rows get `Type` backfilled
     from `Side`; everything else stays blank until you fill it in.
   - 4 new tabs: **Config** (risk limits + decision-score weights, seeded
     with sensible defaults — edit from the app's Settings tab, not by
     hand), **Corporate Actions** (manual split/bonus/rights/merger log),
     **Audit Log** (append-only, auto-filled by every write the app or
     Action makes), **Snapshots** (portfolio value over time, filled in by
     the scheduled Action — this is what benchmarking/drawdown history
     will eventually read from).

   Safe to skip if you only want the original screener/portfolio
   behavior — everything above is additive and the app degrades
   gracefully (Risk tab, decision scores, journal, etc. just show
   "run migrateSchemaV2" instead) if you never run it.
7. Deploy → New deployment → type **Web app** → execute as **Me** → who
   has access **Anyone**. Copy the `.../exec` URL it gives you.

### 2. GitHub repo secrets

In your repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `SHEET_ENDPOINT` | the Apps Script `/exec` URL from step 1.7 |
| `SHEET_SECRET` | the same random string from step 1.3 |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_CHAT_ID` | your chat ID (message your bot once, then check `https://api.telegram.org/bot<token>/getUpdates`) |

### 3. GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → branch `main`, folder
`/ (root)`. You'll get a URL like `https://<you>.github.io/Signalvest/`.

### 4. Connect the app to your Sheet

Open the Pages URL on your phone → Settings tab → paste the Web App URL and
secret from step 1.7/1.3 → Save. Also set your available cash there (it's
only stored in your phone's browser, separately from the Sheet — keep both
in sync by hand, or rely on the Sheet's `Budget` tab as the real source for
the scheduled Telegram checks).

## What's in the app

- **Screener**: your held positions + top 3 new BUY candidates that fit
  your budget. Each new candidate expands into a full decision card: score
  (out of your configured weights), entry/stop/target, risk:reward,
  position sizing, plain-English positives and risks, and an invalidation
  line — never a bare "BUY". **Approve/Watch/Reject** only records your
  decision (Audit Log) — it never places an order. A market-regime banner
  (RISK_ON/NEUTRAL/RISK_OFF, from real KLCI history + this run's breadth)
  sits above the table, always labelled as a description of current
  conditions, never a prediction.
- **Portfolio**: log a trade (Buy/Sell, with optional setup/emotion/
  thesis/rule-followed detail), import a Moomoo CSV, see holdings, ATR-based
  stop-loss guidance, a **reconciliation panel** that compares what the CSV
  says you hold against the Sheet after every import, realized-trade
  performance (win rate/expectancy/profit factor), and a manual corporate-
  actions log.
- **Risk** (new): portfolio heat (genuine capital at risk if every stop
  hit, with sector concentration) and daily/weekly/monthly loss-limit
  usage, with a **TRADING PAUSED** banner when a limit is breached —
  informational only, it doesn't block your broker.
- **Settings**: budget, pinned tickers, Sheet connection, risk limits +
  decision-score weights (synced to the Config tab), and a system-health
  readout (connection status, schema-migration status, data counts).

## Backtesting

Manual CLI, not a scheduled Action or a browser feature — deliberately, so
it can pull years of history without the browser's CORS-proxy chain:

```
node scripts/backtest.mjs 1155.KL
node scripts/backtest.mjs 1155.KL --strategy=breakoutVolume --split=2025-01-01
```

Prints win rate/profit factor/expectancy/drawdown, and — with `--split` —
runs in-sample vs out-of-sample separately with a plain warning if
out-of-sample expectancy collapses (a classic overfitting signature). Full
report saved to `data/backtests/`. See `lib/backtest.js`'s header comment
for the anti-lookahead rule (a signal on bar *i* only ever fills at bar
*i+1*'s open) and honest limitations (no survivorship-bias correction).

## Testing

```
node --test test/*.test.mjs
```

49+ tests over `lib/*.js` — position sizing against the spec's own worked
example, realized P/L math, portfolio heat, loss limits, decision scoring,
the backtester's anti-lookahead property, reconciliation, corporate-action
adjustments, behavior-analytics stats. Runs automatically on every push via
`.github/workflows/test.yml`. `index.html`'s UI wiring was verified with a
scratch headless-jsdom harness (not committed — jsdom can't execute inline
`<script type="module">`, so the script was imported as a real Node ES
module against a jsdom-built DOM with `fetch` mocked); it isn't part of the
repo's own test suite, so treat any future UI change as unverified until
you check it in a real browser.

## Logging trades

Two ways, both write to the same `Transactions` tab:

- **Manually**: Portfolio tab → Log a trade (Buy/Sell only — for
  dividends, deposits or withdrawals, add a row directly in the Sheet's
  Transactions tab using the `Type` column; the ledger/journal logic
  already understands those row types, the app's quick-entry form just
  doesn't have a dedicated widget for them yet).
- **From a Moomoo export**: Account → History → Export in the Moomoo app,
  then Portfolio tab → Import Moomoo CSV. Only filled orders are imported,
  and re-importing the same file never double-logs a fill (each fill gets
  a stable ID computed from ticker + fill time + qty + price). Every
  import now also reconciles the CSV's implied holdings against the
  Sheet's, per ticker.

True real-time auto-detection of fills isn't realistic here: Moomoo's
OpenAPI needs their desktop gateway (OpenD) running on a machine, which a
free cloud cron job can't reach. The CSV import is the practical middle
ground — no live polling infrastructure, but no manual retyping either.

## The stock universe

`universe.json` is a starting list of ~67 liquid Bursa Malaysia main-market
tickers across sectors, plus KGROUP, each tagged with a public sector
classification (used for portfolio-heat concentration warnings). **Verify
both the codes and sectors** — they're from general knowledge, not a live
listing pull, and Bursa codes/classifications do occasionally change.
KGROUP is deliberately left `"Unclassified"` rather than guessed. Wrong/
delisted codes just get silently skipped by the fetch (bad tickers are one
`try/catch` this app is built to shrug off), so nothing breaks — you just
won't see that ticker's signal. Edit the file freely to add/remove
candidates; it's the closest thing to "the whole exchange" the app can
screen without hitting a paid data API.

Screening logic (both the browser app and the Actions script use the same
rules, written twice on purpose — see "Why three copies" below):

- **Liquidity filter**: skip anything averaging under 50,000 shares/day
  over the last 20 sessions, unless you already hold it.
- **Budget filter**: skip anything where 100 shares (Bursa's board lot)
  costs more than your available cash, unless you already hold it.
- **Signal rule**: SMA20 vs SMA50 for trend, RSI14 (Wilder) for
  overbought/oversold —
  - uptrend + RSI 35–68 → **BUY**
  - uptrend + RSI > 68 → **HOLD** (overbought, don't chase)
  - downtrend + RSI < 30 → **HOLD** (oversold, maybe a bounce, don't panic-sell)
  - downtrend otherwise → **AVOID**
  - no clear trend → **HOLD**
- **Decision score**: on top of the signal, each BUY candidate is scored
  against configurable weights (trend/momentum/volume/fundamentals/market
  regime/risk-reward/position-sizing) — see `lib/decision.js`. Fundamentals
  are never fabricated: the score only counts that dimension if you've
  told it something via the fundamentals link, otherwise it's flagged
  "not verified" and excluded from the score.

## Why three copies of the fetch/indicator logic

`index.html` (browser) has to route around Yahoo Finance not sending a CORS
header, via a `r.jina.ai` → `allorigins.win` → direct fallback chain.
`scripts/check-signals.mjs` (Node, in GitHub Actions) has no such
restriction — CORS is a browser thing — so it fetches Yahoo directly.
`lib/indicators.js` is a THIRD, newer copy of just the pure math (sma/
rsi14/atr14/classify), used only by the newer decision-engine/backtest code
in `lib/decision.js`, `lib/backtest.js` and `lib/regime.js` — none of which
existed when the CORS-routing duplication decision was made. Given that
those three call sites have no CORS concern of their own (they're either
Node-side or take already-fetched data), duplicating a fourth time would
have been pure waste; `lib/indicators.js` exists so they share one copy
instead. The original two (index.html's inline copy, check-signals.mjs's
inline copy) are untouched, same spirit as before: simpler to reason about
than adding a build step for what's still a small project.

Everything else new — risk, decision scoring, market regime, journal,
reconciliation, corporate actions, backtesting — lives in `lib/*.js` as
real ES modules, imported directly by both `index.html`
(`<script type="module">`) and the Node scripts. There's exactly one copy
of each, and it's the one covered by `test/*.test.mjs`.

## Privacy note on Actions logs and Telegram messages

This repo is public, and GitHub Actions logs on a public repo are public
too. `scripts/check-signals.mjs` is written to never log or message an
actual RM cash total or share count — budget fit, portfolio risk and
loss-limit usage are always reported as a percentage or yes/no. This rule
now explicitly extends to the Telegram message body too (not just
`console.log`), as defense in depth in case the bot token or chat ever
leaks — even though Telegram itself is a private chat. Position sizing is
computed internally (needed to derive portfolio-risk %) but the resulting
share count and RM totals are never printed or messaged. None of this
applies to the browser app itself, which is your own private session — the
Risk tab and decision cards there do show real share counts and RM
figures, on purpose (that's the whole point of position sizing).

## Honest limitations

- **No earnings/dividend/corporate-event calendar with real dates.** No
  reliable free data source exists for this; rather than guess, the app
  simply doesn't show one. Corporate actions (splits/bonus/rights) are
  manually logged and adjust the *display* qty/avg-cost only — the
  Transactions ledger itself is never rewritten. Mergers/ticker-changes/
  delistings are flagged for your manual review, never auto-adjusted.
- **Cash can't be reconciled from a Moomoo CSV export** — it's a fill
  history, not an account statement. The reconciliation panel only
  compares quantities and average cost per ticker.
- **Backtests have no survivorship-bias correction** — a delisted ticker
  just isn't in `universe.json` today, which biases historical results
  slightly optimistic. Fees/slippage are flat-rate approximations, not a
  real order-book simulation.
- **Fundamentals are never fetched automatically** — Yahoo locked that
  data behind a login-only token years ago; the app links straight to
  Yahoo's own page for you to check yourself.
- **Market regime and decision scores describe current conditions, not
  predictions.** Nothing in this app should be read as "this stock will
  rise."

## Costs

Everything here is free-tier: GitHub Pages, GitHub Actions (cron jobs on a
public repo are unlimited on the free plan), Google Sheets/Apps Script, and
a Telegram bot. Nothing in this stack has a paid tier you could
accidentally trip into — the one thing to watch is if you ever make the
repo private, GitHub Pages and unlimited Actions minutes require a paid
plan for private repos.

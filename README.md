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
   - 5 new tabs: **Config** (risk limits + decision-score weights, seeded
     with sensible defaults — edit from the app's Settings tab, not by
     hand), **Corporate Actions** (manual split/bonus/rights/merger log),
     **Audit Log** (append-only, auto-filled by every write the app or
     Action makes), **Snapshots** (portfolio value over time, filled in by
     the scheduled Action — this is what benchmarking/drawdown history
     will eventually read from), **Signals** (every ticker's latest signal/
     score/entry/stop/target — overwritten on every scheduled scan; this is
     what the Telegram bot in "Ask Signalvest questions" below reads from).

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

## Ask Signalvest questions (Telegram + Make.com + Gemini)

The scheduled GitHub Action above is one-way: it messages you when
something changes, on its own schedule. This section adds a second,
**optional** path — texting Signalvest questions like *"why Maybank?"* or
*"what should I buy this week?"* and getting an answer back, any time.

**How it fits together** — three pieces, each doing one job:

```
You (Telegram)
     │  "why Maybank?"
     ▼
Make.com scenario           ← the only new piece; everything else already exists
     │  1. reads your Sheet's `context` endpoint (signals + holdings + cash + config)
     │  2. hands that + your question to Gemini, with a system prompt that
     │     forbids Gemini from inventing its own BUY/SELL opinion
     ▼
Gemini (explains only — never decides)
     │
     ▼
Telegram reply, back to you
```

Signalvest's scan/score logic (`lib/decision.js`, tested by `test/*.test.mjs`)
is unchanged and stays the source of truth. Make.com and Gemini are pure
plumbing on top — if you never set this up, the scheduled alerts keep
working exactly as before.

### What the Sheet now provides for this

Two new `doGet`/`doPost` actions in `apps-script/Code.gs` (added by
`migrateSchemaV2`, see above):

- **`writeSignals`** (POST) — `scripts/check-signals.mjs` calls this at the
  end of every scheduled run, overwriting the `Signals` tab with that run's
  full results (ticker, signal, trend, RSI, price, and — for BUY candidates
  you don't already hold — score/entry/stop/target/R:R/positives/risks).
  It's a snapshot of "latest known state," not a growing log.
- **`writeRiskStatus`** (POST) — same script, same run, overwriting the
  single `Risk Status` row: whether you're currently loss-limit-paused (and
  why), portfolio heat %, largest sector concentration, and any holding
  with no stop set. This is the same money-management data the scheduled
  alerts already compute (Phase 1's position sizing/heat/loss-limit work) —
  now made queryable on demand instead of only pushed as a one-off message.
- **`context`** (GET) — one call that bundles `Signals` + `Risk Status` +
  `Holdings` + cash available + your `Config` (risk limits, strategy
  weights) into a single JSON response, so the Make.com scenario only needs
  one HTTP request per question instead of five.

All three need `migrateSchemaV2` to have been run at least once (for the
`Signals` and `Risk Status` tabs to exist) — safe to re-run if you're not
sure.

**Why this matters for the bot specifically**: without `Risk Status` in the
bundle, the Telegram advisor could describe a BUY signal's score/entry/stop
perfectly correctly while having no idea you'd already hit your daily loss
limit, or that your portfolio is already above your heat comfort threshold
— it would be technically right about the stock and wrong about whether
you should be trading at all right now. The system prompt in step 3 below
tells Gemini to check `riskStatus.tradingPaused` first, every time, before
discussing any new position.

### Setting up the Make.com scenario

You'll need: your Make.com account (already have it), a Telegram bot token
(same one from the GitHub Actions setup, or a new bot via @BotFather if you
want to keep them separate), and a Gemini API key from
[aistudio.google.com](https://aistudio.google.com) (free tier). **Paste the
Gemini key into Make's own connection screen in step 3 below — never into
a chat with an AI assistant, a support ticket, or anywhere else.**

1. **New scenario** → search for and add a **Telegram Bot** module,
   trigger type "Watch Updates". Click "Add" next to Connection, paste your
   bot token there (Make stores it encrypted, not in the scenario itself).
   This module fires every time you message the bot.

2. **Add an HTTP module** ("Make a request"). URL:
   `https://script.google.com/.../exec?secret=YOUR_SECRET&action=context`
   (your deployed Apps Script `/exec` URL — same one from Settings — with
   your shared secret appended). Method: GET. This is the one call that
   fetches signals + holdings + cash + config in one shot.

3. **Add a Google Gemini module** ("Create a Completion" or similar).
   Connection: click "Add", paste your Gemini API key there. Prompt —
   combine three things into the message you send Gemini:
   - A system instruction: *"You are Signalvest's advisor and money-
     management gatekeeper. You explain the mechanical scores and signals
     you're given below in plain language. You NEVER invent your own
     buy/sell opinion — if the data doesn't support an answer, say so.
     Before discussing ANY new position, check riskStatus.tradingPaused
     in the data first: if true, tell the user they've hit a loss limit
     (state pausedReason) and that no new positions should be opened
     until it lifts — say this even if they didn't ask about risk, and
     even if a stock has a strong BUY score. Separately, if
     riskStatus.portfolioHeatPct is at or above
     riskStatus.heatComfortThresholdPct, mention that their portfolio is
     already at or above their comfort threshold for capital at risk
     before suggesting they add a new position. Keep replies under 150
     words unless a pause or heat warning needs more."*
   - The JSON from step 2's HTTP response (map the HTTP module's Body
     output into the prompt) — this now includes `riskStatus` alongside
     `signals`, so the check above always has real data to look at.
   - The Telegram message text from step 1 (map the Telegram module's
     Text output in) — this is the actual question.

4. **Add a second Telegram Bot module** ("Send a Message"). Chat ID: map
   in the Chat ID from step 1's trigger (so it replies to whoever asked).
   Text: map in Gemini's response text from step 3.

5. Turn the scenario **ON** (top-left toggle), then test it by messaging
   your bot "why Maybank?" (or whatever's currently in your `Signals` tab).

That's the whole build — 4 modules, no code. If a reply looks wrong,
check the HTTP module's output first (Make.com's history view shows every
module's input/output per run) — most issues are the Apps Script URL,
secret, or a `Signals` tab that hasn't been populated yet (run
`scripts/check-signals.mjs` once, or wait for its next scheduled run).

**Cost**: Make's free tier (1,000 operations/month) comfortably covers a
few conversations a week — this scenario uses ~4 operations per question.
Gemini's free tier is enough too, since it only ever sees the pre-filtered
data your engine already computed, not the full stock universe.

**On RM figures in replies**: unlike the scheduled Action's Telegram
messages (which never state RM totals or share counts, because GitHub
Actions logs on this public repo are public too), this conversational bot
*can* include real RM figures if you want — it's a private Telegram DM you
initiate, same as the browser app being your own private session. If you'd
rather it stay as redacted as the scheduled alerts, add that instruction to
the Gemini system prompt in step 3.

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

# Signalvest

A free, self-hosted Bursa Malaysia signal + portfolio tracker. Static site
(GitHub Pages) + a GitHub Actions cron job that pings you on Telegram when a
signal changes + a Google Sheet as the private source of truth for your
trades and net worth.

**Not financial advice.** Signals are a mechanical SMA/RSI rule applied to
public price history — nothing here is personalized advice, and nothing
here places, modifies or cancels real orders. Always double-check with your
own broker before acting.

## How it fits together

```
index.html (GitHub Pages)  ──┐
                              ├─→ your Google Sheet (Apps Script Web App)
scripts/check-signals.mjs ───┘        holds: transactions, holdings, budget, net worth
   (GitHub Actions, on a cron)
   → Telegram when a signal changes
```

Nothing personal — your cash balance, holdings, or trade history — is ever
committed to this repo. This repo is public (required for free GitHub
Pages), so it only contains the app's *code* and a generic watchlist of
Bursa tickers. All your real numbers live in the Google Sheet, which only
you can access.

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
   `Holdings`, `Budget`, `Net Worth` — with headers and formulas only.
5. On the `Budget` tab, set cell B1 to how much cash you currently have
   available to invest.
6. Deploy → New deployment → type **Web app** → execute as **Me** → who
   has access **Anyone**. Copy the `.../exec` URL it gives you.

### 2. GitHub repo secrets

In your repo → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `SHEET_ENDPOINT` | the Apps Script `/exec` URL from step 1.6 |
| `SHEET_SECRET` | the same random string from step 1.3 |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `TELEGRAM_CHAT_ID` | your chat ID (message your bot once, then check `https://api.telegram.org/bot<token>/getUpdates`) |

### 3. GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → branch `main`, folder
`/ (root)`. You'll get a URL like `https://<you>.github.io/Signalvest/`.

### 4. Connect the app to your Sheet

Open the Pages URL on your phone → Settings tab → paste the Web App URL and
secret from step 1.6/1.3 → Save. Also set your available cash there (it's
only stored in your phone's browser, separately from the Sheet — keep both
in sync by hand, or rely on the Sheet's `Budget` tab as the real source for
the scheduled Telegram checks).

## Logging trades

Two ways, both write to the same `Transactions` tab:

- **Manually**: Portfolio tab → Log a trade.
- **From a Moomoo export**: Account → History → Export in the Moomoo app,
  then Portfolio tab → Import Moomoo CSV. Only filled orders are imported,
  and re-importing the same file never double-logs a fill (each fill gets
  a stable ID computed from ticker + fill time + qty + price).

True real-time auto-detection of fills isn't realistic here: Moomoo's
OpenAPI needs their desktop gateway (OpenD) running on a machine, which a
free cloud cron job can't reach. The CSV import is the practical middle
ground — no live polling infrastructure, but no manual retyping either.

## The stock universe

`universe.json` is a starting list of ~60 liquid Bursa Malaysia main-market
tickers across sectors, plus KGROUP. **Verify the codes** — they're from
general knowledge, not a live listing pull, and Bursa codes do occasionally
change. Wrong/delisted codes just get silently skipped by the fetch (bad
tickers are one `try/catch` this app is built to shrug off), so nothing
breaks — you just won't see that ticker's signal. Edit the file freely to
add/remove candidates; it's the closest thing to "the whole exchange" the
app can screen without hitting a paid data API.

Screening logic (both the browser app and the Actions script use the same
rules, written twice on purpose — see "Why two copies" below):

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

## Why two copies of the fetch/indicator logic

`index.html` (browser) has to route around Yahoo Finance not sending a CORS
header, via a `r.jina.ai` → `allorigins.win` → direct fallback chain.
`scripts/check-signals.mjs` (Node, in GitHub Actions) has no such
restriction — CORS is a browser thing — so it fetches Yahoo directly. Given
that difference, and that this is a small project, each file is kept fully
self-contained rather than sharing a module — same spirit as duplicating
small helpers across the Netlify functions in an earlier project of mine,
just simpler to reason about than adding a build step for two ~150-line
files.

## Privacy note on Actions logs

This repo is public, and GitHub Actions logs on a public repo are public
too. `scripts/check-signals.mjs` is written to never log or message an
actual RM amount — budget fit is always reported as a plain yes/no, and the
Telegram message never includes your cash balance or holding sizes.

## Costs

Everything here is free-tier: GitHub Pages, GitHub Actions (cron jobs on a
public repo are unlimited on the free plan), Google Sheets/Apps Script, and
a Telegram bot. Nothing in this stack has a paid tier you could
accidentally trip into — the one thing to watch is if you ever make the
repo private, GitHub Pages and unlimited Actions minutes require a paid
plan for private repos.

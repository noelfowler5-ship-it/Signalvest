#!/usr/bin/env node
/**
 * Runs in GitHub Actions on a schedule. Recomputes signals for the bundled
 * universe (+ whatever you're currently holding, per your private Sheet)
 * and messages Telegram when a ticker's signal changes.
 *
 * IMPORTANT — this repo is public, and Actions logs on a public repo are
 * public too. Never console.log real RM amounts, holdings quantities or
 * anything else personal here. Budget-fit is only ever reported as a
 * yes/no boolean, never as the underlying cash figure.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SHEET_ENDPOINT,   // Apps Script Web App /exec URL
  SHEET_SECRET
} = process.env;

const STATE_PATH = path.join(process.cwd(), "data", "last-signals.json");
const COOLDOWN_DAYS = 30; // matches index.html — flag churn instead of nudging a fresh trade right after one

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function fetchHistory(ticker) {
  // Node has no CORS restriction, so no proxy chain is needed server-side
  // (unlike the browser app). A couple of retries covers transient failures.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`;
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const data = await fetchJSON(url);
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error("no result for " + ticker);
      const q = result.indicators?.quote?.[0] || {};
      const closes = q.close || [];
      const volumes = q.volume || [];
      const highs = q.high || [];
      const lows = q.low || [];
      const clean = [];
      for (let j = 0; j < closes.length; j++) {
        if (closes[j] != null) {
          clean.push({
            close: closes[j],
            volume: volumes[j] || 0,
            high: highs[j] != null ? highs[j] : closes[j],
            low: lows[j] != null ? lows[j] : closes[j]
          });
        }
      }
      return clean;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi14(closes) {
  const period = 14;
  if (closes.length < period + 1) return null;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i];
    if (c > 0) avgGain += c; else avgLoss += -c;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0, loss = c < 0 ? -c : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function classify(closes) {
  const s20 = sma(closes, 20), s50 = sma(closes, 50), r = rsi14(closes);
  if (s20 == null || s50 == null || r == null) return null;
  let trend = "flat";
  if (s20 > s50) trend = "up"; else if (s20 < s50) trend = "down";
  let signal = "HOLD";
  if (trend === "up" && r >= 35 && r <= 68) signal = "BUY";
  else if (trend === "up" && r > 68) signal = "HOLD";
  else if (trend === "down" && r < 30) signal = "HOLD";
  else if (trend === "down") signal = "AVOID";
  return { trend, rsi: r, signal };
}

async function getHoldings() {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return [];
  try {
    const data = await fetchJSON(`${SHEET_ENDPOINT}?secret=${encodeURIComponent(SHEET_SECRET)}&action=holdings`);
    return data.holdings || [];
  } catch {
    console.log("could not reach Sheet for holdings — continuing with bundled universe only");
    return [];
  }
}

function atr14(highs, lows, closes) {
  const period = 14;
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

// Same rule as index.html: 2xATR hard stop below entry, 3xATR Chandelier trailing
// stop once you're in enough profit for it to be above the hard stop. Advisory
// only — this script never places or modifies an order.
function computeStopInfo(hist, avgCost) {
  const closes = hist.map(h => h.close), highs = hist.map(h => h.high), lows = hist.map(h => h.low);
  const atr = atr14(highs, lows, closes);
  if (atr == null) return null;
  const currentPrice = closes[closes.length - 1];
  const lookback = Math.min(22, highs.length);
  const highestHigh = Math.max(...highs.slice(-lookback));
  const hardStop = avgCost - 2 * atr;
  const chandelier = highestHigh - 3 * atr;
  const operative = Math.max(hardStop, chandelier);
  let state;
  if (currentPrice <= operative) state = "breached";
  else if (currentPrice <= operative * 1.03) state = "near";
  else if (chandelier > hardStop) state = "trailing";
  else state = "initial";
  return { atr, currentPrice, hardStop, chandelier, operative, state };
}

async function getCashAvailable() {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return null;
  try {
    const data = await fetchJSON(`${SHEET_ENDPOINT}?secret=${encodeURIComponent(SHEET_SECRET)}&action=budget`);
    return typeof data.cashAvailable === "number" ? data.cashAvailable : null;
  } catch {
    return null;
  }
}

async function getRecentTrades() {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return {};
  try {
    const data = await fetchJSON(`${SHEET_ENDPOINT}?secret=${encodeURIComponent(SHEET_SECRET)}&action=recentTrades`);
    return data.recentTrades || {};
  } catch {
    return {};
  }
}

async function loadState() {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, "utf8"));
    return { signals: s.signals || {}, stops: s.stops || {} };
  } catch {
    return { signals: {}, stops: {} };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured — skipping notification");
    return;
  }
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" })
  });
}

async function main() {
  const universe = JSON.parse(await readFile(path.join(process.cwd(), "universe.json"), "utf8"));
  const holdings = await getHoldings();
  const cash = await getCashAvailable(); // used only for a yes/no fit check, never logged or messaged as a number
  const recentTrades = await getRecentTrades(); // ticker -> {date, side}, for the cooldown note below

  const heldSet = new Set(holdings.map(h => h.ticker.toUpperCase()));
  const avgCostByTicker = new Map(holdings.map(h => [h.ticker.toUpperCase(), Number(h.avgCost)]));
  for (const h of holdings) {
    if (!universe.find(u => u.code.toUpperCase() === h.ticker.toUpperCase())) universe.push({ code: h.ticker, name: h.ticker });
  }

  const prevState = await loadState();
  const nextSignals = {};
  const nextStops = {};
  const changes = [];
  const stopAlerts = [];

  for (const stock of universe) {
    let hist;
    try {
      hist = await fetchHistory(stock.code);
    } catch {
      console.log(`skip ${stock.code}: fetch failed`); // ticker code only, no personal data
      continue;
    }
    const closes = hist.map(h => h.close);
    const avgVol20 = hist.slice(-20).reduce((a, h) => a + h.volume, 0) / Math.min(20, hist.length);
    const cls = classify(closes);
    if (!cls) continue;

    const isHeld = heldSet.has(stock.code.toUpperCase());
    const liquid = avgVol20 >= 50000;
    if (!isHeld && !liquid) continue;

    const price = closes[closes.length - 1];
    const fitsBudget = cash == null ? null : price * 100 <= cash;
    if (!isHeld && cash != null && fitsBudget === false) continue;

    nextSignals[stock.code] = cls.signal;
    const prevSignal = prevState.signals[stock.code];
    if (prevSignal !== cls.signal) {
      const fitLine = fitsBudget == null ? "" : `\nFits your current budget: ${fitsBudget ? "yes" : "no"}`;
      const rt = recentTrades[stock.code.toUpperCase()];
      let cooldownLine = "";
      if (rt) {
        const days = Math.floor((Date.now() - new Date(rt.date).getTime()) / 86400000);
        if (days < COOLDOWN_DAYS) cooldownLine = `\n⚠️ You ${rt.side.toLowerCase()}ed this ${days}d ago — mind fee drag before trading again`;
      }
      changes.push(
        `*${stock.code}* (${stock.name})${isHeld ? " — held" : ""}\n` +
        `${prevSignal ? prevSignal + " → " : ""}*${cls.signal}* · trend ${cls.trend} · RSI ${cls.rsi.toFixed(1)} · RM${price.toFixed(3)}${fitLine}${cooldownLine}`
      );
    }

    // Stop-loss / trailing-stop: only meaningful for positions you actually hold.
    if (isHeld) {
      const avgCost = avgCostByTicker.get(stock.code.toUpperCase());
      const info = avgCost != null ? computeStopInfo(hist, avgCost) : null;
      if (info) {
        nextStops[stock.code] = info.state;
        const prevStopState = prevState.stops[stock.code];
        if (prevStopState !== info.state) {
          const labels = {
            breached: `🔴 stop level breached — RM${info.operative.toFixed(3)}. This is where a disciplined exit would trigger.`,
            near: `🟡 within 3% of your stop level (RM${info.operative.toFixed(3)}). Watch closely.`,
            trailing: `🟢 up enough to switch to a trailing stop — new stop RM${info.operative.toFixed(3)} (was hard stop RM${info.hardStop.toFixed(3)}).`,
            initial: `ℹ️ hard stop-loss suggested at RM${info.hardStop.toFixed(3)} (2×ATR below your average cost).`
          };
          stopAlerts.push(`*${stock.code}* (${stock.name})\n${labels[info.state]}`);
        }
      }
    }
  }

  const sections = [];
  if (changes.length) sections.push(`*Signal changes*\n\n${changes.join("\n\n")}`);
  if (stopAlerts.length) sections.push(`*Stop-loss / trailing-stop*\n\n${stopAlerts.join("\n\n")}`);

  if (sections.length) {
    await sendTelegram(`*Signalvest update*\n\n${sections.join("\n\n")}\n\n_Not financial advice — you place any exit yourself._`);
    console.log(`sent ${changes.length} signal change(s), ${stopAlerts.length} stop alert(s)`);
  } else {
    console.log("no signal or stop changes this run");
  }

  await saveState({ signals: nextSignals, stops: nextStops });
}

main().catch(err => {
  console.error("check-signals failed:", err.message);
  process.exit(1);
});

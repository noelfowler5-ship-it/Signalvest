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
      const closes = result.indicators?.quote?.[0]?.close || [];
      const volumes = result.indicators?.quote?.[0]?.volume || [];
      const clean = [];
      for (let j = 0; j < closes.length; j++) {
        if (closes[j] != null) clean.push({ close: closes[j], volume: volumes[j] || 0 });
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

async function getHeldTickers() {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return [];
  try {
    const data = await fetchJSON(`${SHEET_ENDPOINT}?secret=${encodeURIComponent(SHEET_SECRET)}&action=holdings`);
    return (data.holdings || []).map(h => h.ticker);
  } catch {
    console.log("could not reach Sheet for holdings — continuing with bundled universe only");
    return [];
  }
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
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return {};
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
  const held = await getHeldTickers();
  const cash = await getCashAvailable(); // used only for a yes/no fit check, never logged or messaged as a number
  const recentTrades = await getRecentTrades(); // ticker -> {date, side}, for the cooldown note below

  const heldSet = new Set(held.map(t => t.toUpperCase()));
  for (const t of held) {
    if (!universe.find(u => u.code.toUpperCase() === t.toUpperCase())) universe.push({ code: t, name: t });
  }

  const prevState = await loadState();
  const nextState = {};
  const changes = [];

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

    nextState[stock.code] = cls.signal;
    const prevSignal = prevState[stock.code];
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
  }

  if (changes.length) {
    await sendTelegram(`*Signalvest update*\n\n${changes.join("\n\n")}\n\n_Not financial advice._`);
    console.log(`sent ${changes.length} signal change(s)`);
  } else {
    console.log("no signal changes this run");
  }

  await saveState(nextState);
}

main().catch(err => {
  console.error("check-signals failed:", err.message);
  process.exit(1);
});

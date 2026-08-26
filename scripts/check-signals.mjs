#!/usr/bin/env node
/**
 * Runs in GitHub Actions on a schedule. Recomputes signals for the bundled
 * universe (+ whatever you're currently holding, per your private Sheet),
 * scores new candidates through the decision engine, checks portfolio-level
 * risk (heat, loss limits), classifies the market regime, and messages
 * Telegram when something actually changes.
 *
 * IMPORTANT — this repo is public, and Actions logs on a public repo are
 * public too. Never console.log real RM amounts, holdings quantities or
 * anything else personal here — and the SAME rule applies to the Telegram
 * message body, even though that goes to a private chat: defense in depth,
 * in case the bot token or chat ever leaks. Budget-fit, portfolio risk and
 * loss-limit usage are always reported as a percentage or yes/no, never as
 * the underlying RM figure. Position sizing is computed internally (it's
 * needed to derive portfolio-risk %) but the resulting share count and RM
 * totals are never printed or messaged.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { reduceLedger } from "../lib/ledger.js";
import { computePositionSize, computePortfolioHeat, evaluateLossLimits } from "../lib/risk.js";
import { scoreCandidate, computeEntryStopTarget, buildDecisionCard } from "../lib/decision.js";
import { classifyRegime } from "../lib/regime.js";
import { cloneStrategy, DEFAULT_STRATEGY } from "../lib/strategy.js";

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SHEET_ENDPOINT,   // Apps Script Web App /exec URL
  SHEET_SECRET
} = process.env;

const STATE_PATH = path.join(process.cwd(), "data", "last-signals.json");
const COOLDOWN_DAYS = 30; // matches index.html — flag churn instead of nudging a fresh trade right after one
const PORTFOLIO_HEAT_LIMIT_PCT = 6; // alert when total capital-at-risk crosses this

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
  return { trend, rsi: r, signal, sma20: s20, sma50: s50 };
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

async function getConfig() {
  const defaults = {
    dailyLossLimit: 150, weeklyLossLimit: 300, monthlyLossLimit: 600, maxRiskPct: 1,
    trendWeight: 2, momentumWeight: 1, volumeWeight: 1, fundamentalsWeight: 2,
    marketRegimeWeight: 1, riskRewardWeight: 2, positionSizingWeight: 1, strategyVersion: "1.0"
  };
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return defaults;
  try {
    const data = await fetchJSON(`${SHEET_ENDPOINT}?secret=${encodeURIComponent(SHEET_SECRET)}&action=getConfig`);
    return { ...defaults, ...(data.config || {}) };
  } catch {
    return defaults; // Config tab not migrated yet, or Sheet unreachable — fall back quietly
  }
}

async function getTransactions() {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return [];
  try {
    const data = await fetchJSON(`${SHEET_ENDPOINT}?secret=${encodeURIComponent(SHEET_SECRET)}&action=transactions`);
    return data.transactions || [];
  } catch {
    return []; // transactions action not available yet (pre-migration), or Sheet unreachable
  }
}

async function postSnapshot(portfolioValue, cash, investedCapital) {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return;
  try {
    const today = new Date();
    const params = new URLSearchParams({
      secret: SHEET_SECRET, action: "snapshot",
      date: today.toISOString().slice(0, 10), time: today.toISOString().slice(11, 16),
      portfolioValue: String(portfolioValue), cash: String(cash), investedCapital: String(investedCapital),
      source: "check-signals"
    });
    await fetch(`${SHEET_ENDPOINT}?${params.toString()}`);
  } catch {
    // best-effort — a missed snapshot just leaves a gap in the benchmarking history
  }
}

// Overwrites the Sheet's Signals tab with this run's full results — feeds
// the Telegram/Gemini advisor bot (via Make.com) so it can answer "why
// Maybank?" on demand instead of only what happened to change this run.
// RM figures go straight into the private Sheet only, same as postSnapshot —
// never through Telegram or console.log from this script.
async function postSignals(signals) {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return;
  try {
    await fetch(SHEET_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SHEET_SECRET, action: "writeSignals", signals, generatedAt: new Date().toISOString() })
    });
  } catch {
    // best-effort — a missed write just leaves the bot's context stale until the next run
  }
}

// Overwrites the Sheet's Risk Status row — the money-management state (loss-
// limit pause, portfolio heat) the Telegram/Gemini bot checks before ever
// discussing a new BUY, same data the scheduled alerts already compute, just
// made queryable on demand. RM figures never leave this call — everything
// here is a percentage or yes/no, same privacy rule as the rest of this file.
async function postRiskStatus(riskStatus) {
  if (!SHEET_ENDPOINT || !SHEET_SECRET) return;
  try {
    await fetch(SHEET_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SHEET_SECRET, action: "writeRiskStatus", riskStatus, generatedAt: new Date().toISOString() })
    });
  } catch {
    // best-effort — a missed write just leaves the bot's context stale until the next run
  }
}

async function loadState() {
  try {
    const s = JSON.parse(await readFile(STATE_PATH, "utf8"));
    return { signals: s.signals || {}, stops: s.stops || {}, regime: s.regime || null, heatBreach: !!s.heatBreach, paused: !!s.paused };
  } catch {
    return { signals: {}, stops: {}, regime: null, heatBreach: false, paused: false };
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

function sectorFor(universe, code) {
  const u = universe.find(x => x.code.toUpperCase() === code.toUpperCase());
  return u?.sector || "Unclassified";
}

async function main() {
  const universe = JSON.parse(await readFile(path.join(process.cwd(), "universe.json"), "utf8"));
  const holdings = await getHoldings();
  const cash = await getCashAvailable(); // used only for a yes/no fit check + internal risk math, never logged/messaged as RM
  const recentTrades = await getRecentTrades(); // ticker -> {date, side}, for the cooldown note below
  const configRaw = await getConfig();
  const strategy = cloneStrategy(DEFAULT_STRATEGY, {
    version: String(configRaw.strategyVersion || DEFAULT_STRATEGY.version),
    weights: {
      trend: Number(configRaw.trendWeight), momentum: Number(configRaw.momentumWeight),
      volume: Number(configRaw.volumeWeight), fundamentals: Number(configRaw.fundamentalsWeight),
      marketRegime: Number(configRaw.marketRegimeWeight), riskReward: Number(configRaw.riskRewardWeight),
      positionSizing: Number(configRaw.positionSizingWeight)
    }
  });
  const maxRiskPct = Number(configRaw.maxRiskPct) || 1;

  const rawTransactions = await getTransactions();
  const { realizedTrades } = reduceLedger(rawTransactions);
  const lossLimits = evaluateLossLimits({
    realizedTrades,
    limits: { daily: Number(configRaw.dailyLossLimit), weekly: Number(configRaw.weeklyLossLimit), monthly: Number(configRaw.monthlyLossLimit) }
  });

  const heldSet = new Set(holdings.map(h => h.ticker.toUpperCase()));
  const avgCostByTicker = new Map(holdings.map(h => [h.ticker.toUpperCase(), Number(h.avgCost)]));
  const qtyByTicker = new Map(holdings.map(h => [h.ticker.toUpperCase(), Number(h.qty)]));
  for (const h of holdings) {
    if (!universe.find(u => u.code.toUpperCase() === h.ticker.toUpperCase())) universe.push({ code: h.ticker, name: h.ticker, sector: "Unclassified" });
  }

  const prevState = await loadState();
  const nextSignals = {};
  const nextStops = {};
  const changes = [];
  const stopAlerts = [];
  const heatHoldings = []; // for computePortfolioHeat, accumulated as we go
  const signalRows = []; // every scanned/held ticker's latest state, for the Signals tab (bot context)
  let upCount = 0, classifiedCount = 0;

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

    classifiedCount++;
    if (cls.trend === "up") upCount++;

    const isHeld = heldSet.has(stock.code.toUpperCase());
    const liquid = avgVol20 >= 50000;

    const price = closes[closes.length - 1];

    if (isHeld) {
      const avgCost = avgCostByTicker.get(stock.code.toUpperCase());
      const qty = qtyByTicker.get(stock.code.toUpperCase()) || 0;
      const info = avgCost != null ? computeStopInfo(hist, avgCost) : null;
      heatHoldings.push({
        ticker: stock.code, qty, avgCost, currentPrice: price,
        stopPrice: info ? info.operative : null, sector: sectorFor(universe, stock.code)
      });
    }

    if (!isHeld && !liquid) continue;

    const fitsBudget = cash == null ? null : price * 100 <= cash;
    if (!isHeld && cash != null && fitsBudget === false) continue;

    nextSignals[stock.code] = cls.signal;

    // Full decision card for a non-held BUY candidate — computed every run
    // (not just when the signal changes) so the Signals tab always reflects
    // the current score/entry/stop/target, for the Telegram/Gemini bot.
    let card = null, sizing = null;
    if (!isHeld && cls.signal === "BUY") {
      const base = scoreCandidate({
        hist, cls, avgVol20,
        regime: prevState.regime || "NEUTRAL", // best available at scoring time; the regime section below reports the current one
        fundamentals: null, // never fabricated — Node has no way to verify this
        strategy
      });
      const ets = computeEntryStopTarget({ currentPrice: price, highs: hist.map(h => h.high), lows: hist.map(h => h.low), closes });
      if (cash != null && ets) {
        const investedCapital = holdings.reduce((s, h) => s + (Number(h.qty) || 0) * (avgCostByTicker.get(h.ticker.toUpperCase()) || 0), 0);
        const portfolioValue = cash + investedCapital;
        sizing = computePositionSize({ portfolioValue, maxRiskPct, entry: price, stop: ets.stop, cash, target: ets.target });
      }
      if (ets) card = buildDecisionCard({ ticker: stock.code, name: stock.name, currentPrice: price, base, entryStopTarget: ets, positionSizing: sizing, strategy });
    }

    signalRows.push({
      ticker: stock.code, name: stock.name, signal: cls.signal, trend: cls.trend, rsi: cls.rsi, price, held: isHeld,
      score: card ? card.score : null,
      entryLow: card ? card.entry[0] : null, entryHigh: card ? card.entry[1] : null,
      stop: card ? card.stop : null, target: card ? card.target : null, rr: card ? card.rr : null,
      positives: card ? card.positives.slice(0, 3) : [], risks: card ? card.risks.slice(0, 2) : []
    });

    const prevSignal = prevState.signals[stock.code];
    if (prevSignal !== cls.signal) {
      const fitLine = fitsBudget == null ? "" : `\nFits your current budget: ${fitsBudget ? "yes" : "no"}`;
      const rt = recentTrades[stock.code.toUpperCase()];
      let cooldownLine = "";
      if (rt) {
        const days = Math.floor((Date.now() - new Date(rt.date).getTime()) / 86400000);
        if (days < COOLDOWN_DAYS) cooldownLine = `\n⚠️ You ${rt.side.toLowerCase()}ed this ${days}d ago — mind fee drag before trading again`;
      }

      // Decision-engine card lines for a fresh, non-held BUY signal — the
      // richer "signal card" format from the spec. Skipped for HOLD/AVOID
      // changes and for held tickers (those already get stop-level guidance
      // below). `card`/`sizing` were already computed above.
      let decisionLines = "";
      if (card) {
        const topPositives = card.positives.slice(0, 3).map(p => `✓ ${p}`).join("\n");
        const topRisks = card.risks.slice(0, 2).map(r => `⚠ ${r}`).join("\n");
        decisionLines =
          `\nScore: ${card.score.toFixed(0)}/${card.maxScore.toFixed(0)}` +
          `\nEntry: RM${card.entry[0].toFixed(3)}–${card.entry[1].toFixed(3)}` +
          `\nStop: RM${card.stop.toFixed(3)}` +
          `\nTarget: RM${card.target.toFixed(3)}` +
          `\nR:R: ${card.rr.toFixed(1)}` +
          (sizing && sizing.valid && sizing.portfolioRiskPct != null ? `\nPortfolio risk: ${sizing.portfolioRiskPct.toFixed(1)}%` : "") +
          (topPositives ? `\n${topPositives}` : "") +
          (topRisks ? `\n${topRisks}` : "") +
          `\n${card.invalidation}` +
          `\n_Not an execution order._`;
      }

      changes.push(
        `*${stock.code}* (${stock.name})${isHeld ? " — held" : ""}\n` +
        `${prevSignal ? prevSignal + " → " : ""}*${cls.signal}* · trend ${cls.trend} · RSI ${cls.rsi.toFixed(1)} · RM${price.toFixed(3)}${fitLine}${cooldownLine}${decisionLines}`
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

  // --- Market regime ---------------------------------------------------
  let regime = null;
  try {
    const klciHist = await fetchHistory("^KLSE");
    const breadthPct = classifiedCount > 0 ? (upCount / classifiedCount) * 100 : null;
    regime = classifyRegime({ klciCloses: klciHist.map(h => h.close), breadthPct });
  } catch {
    console.log("could not fetch KLCI history — skipping regime classification this run");
  }
  const regimeAlert = regime && regime.regime !== prevState.regime
    ? `*Market regime: ${regime.regime.replace("_", "-")}*\n${regime.reasons.slice(0, 2).join("\n")}\n_${regime.disclaimer}_`
    : null;

  // --- Portfolio heat ----------------------------------------------------
  let heatAlert = null;
  let heat = null;
  if (cash != null && heatHoldings.length) {
    heat = computePortfolioHeat({ holdings: heatHoldings, cash });
    const nowBreached = heat.portfolioHeatPct >= PORTFOLIO_HEAT_LIMIT_PCT;
    if (nowBreached !== prevState.heatBreach) {
      heatAlert = nowBreached
        ? `🔴 *Portfolio risk warning*\nPortfolio heat ${heat.portfolioHeatPct.toFixed(1)}% — above your ${PORTFOLIO_HEAT_LIMIT_PCT}% comfort threshold.` +
          (heat.largestSector ? `\nLargest sector: ${heat.largestSector.sector} (${heat.largestSector.pct.toFixed(0)}%)` : "") +
          (heat.unquantifiedRiskPositions.length ? `\n⚠ No stop set on: ${heat.unquantifiedRiskPositions.join(", ")}` : "")
        : `🟢 Portfolio heat back under ${PORTFOLIO_HEAT_LIMIT_PCT}% (${heat.portfolioHeatPct.toFixed(1)}%).`;
    }
    // Snapshot for benchmarking/drawdown history — RM figures go straight to
    // your private Sheet only, never through Telegram or console.log.
    await postSnapshot(heat.totalValue, cash, heat.investedCapital);
  }

  // --- Loss limits / trading pause ---------------------------------------
  const breachedWindows = ["daily", "weekly", "monthly"].filter(w => lossLimits[w].breached);
  let limitAlert = null;
  if (lossLimits.paused !== prevState.paused) {
    limitAlert = lossLimits.paused
      ? `🔴 *TRADING PAUSED*\n${breachedWindows.map(w => `${w} loss limit: ${lossLimits[w].pctUsed.toFixed(0)}% used`).join("\n")}\nThis is a behavioural check only — nothing here blocks your broker.`
      : `🟢 Loss-limit pause lifted — back within your daily/weekly/monthly limits.`;
  }

  await postSignals(signalRows);

  await postRiskStatus({
    tradingPaused: lossLimits.paused,
    pausedReason: breachedWindows.length ? `${breachedWindows.join(", ")} loss limit reached` : "",
    portfolioHeatPct: heat ? heat.portfolioHeatPct : null,
    heatComfortThresholdPct: PORTFOLIO_HEAT_LIMIT_PCT,
    largestSector: heat && heat.largestSector ? heat.largestSector.sector : null,
    largestSectorPct: heat && heat.largestSector ? heat.largestSector.pct : null,
    unquantifiedRiskPositions: heat ? heat.unquantifiedRiskPositions : [],
    dailyLossPctUsed: lossLimits.daily.pctUsed,
    weeklyLossPctUsed: lossLimits.weekly.pctUsed,
    monthlyLossPctUsed: lossLimits.monthly.pctUsed
  });

  const sections = [];
  if (regimeAlert) sections.push(regimeAlert);
  if (changes.length) sections.push(`*Signal changes*\n\n${changes.join("\n\n")}`);
  if (stopAlerts.length) sections.push(`*Stop-loss / trailing-stop*\n\n${stopAlerts.join("\n\n")}`);
  if (heatAlert) sections.push(heatAlert);
  if (limitAlert) sections.push(limitAlert);

  if (sections.length) {
    await sendTelegram(`*Signalvest update*\n\n${sections.join("\n\n")}\n\n_Not financial advice — you place any trade yourself, nothing here executes on Moomoo._`);
    console.log(`sent update: ${changes.length} signal change(s), ${stopAlerts.length} stop alert(s), regime alert ${!!regimeAlert}, heat alert ${!!heatAlert}, limit alert ${!!limitAlert}`);
  } else {
    console.log("no signal, stop, regime, heat or loss-limit changes this run");
  }

  await saveState({
    signals: nextSignals, stops: nextStops,
    regime: regime ? regime.regime : prevState.regime,
    heatBreach: heat ? heat.portfolioHeatPct >= PORTFOLIO_HEAT_LIMIT_PCT : prevState.heatBreach,
    paused: lossLimits.paused
  });
}

main().catch(err => {
  console.error("check-signals failed:", err.message);
  process.exit(1);
});

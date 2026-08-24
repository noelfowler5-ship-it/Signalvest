#!/usr/bin/env node
/**
 * Manual backtesting tool — run locally, not scheduled by GitHub Actions.
 *
 *   node scripts/backtest.mjs 1155.KL
 *   node scripts/backtest.mjs 1155.KL --strategy=breakoutVolume --split=2025-01-01
 *   node scripts/backtest.mjs 1155.KL --capital=10000 --risk=1 --fee=0.001 --slippage=0.001 --range=5y
 *
 * Fetches real daily OHLCV history from Yahoo Finance (Node has no CORS
 * restriction) and runs it through lib/backtest.js — see that file's header
 * comment for the anti-lookahead rule and the honest limitations (no
 * survivorship-bias correction, approximate results).
 *
 * NO FAKE DATA: if Yahoo doesn't return enough history for a ticker, this
 * prints an error and exits — it never fabricates bars to fill a strategy's
 * minimum lookback.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runBacktest, summarizeBacktest, splitInOutSample, smaRsiSignals, breakoutVolumeSignals } from "../lib/backtest.js";

const STRATEGIES = { smaRsi: smaRsiSignals, breakoutVolume: breakoutVolumeSignals };

function parseArgs(argv) {
  const ticker = argv[0];
  const opts = { strategy: "smaRsi", capital: 10000, fee: 0.001, slippage: 0.001, risk: 1, range: "5y", split: null };
  for (const a of argv.slice(1)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "strategy") opts.strategy = v;
    else if (k === "split") opts.split = v;
    else if (k === "range") opts.range = v;
    else opts[k] = Number(v);
  }
  return { ticker, opts };
}

async function fetchDailyBars(ticker, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=1d`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Yahoo Finance returned HTTP ${r.status} for ${ticker}`);
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No data returned for ${ticker} — check the ticker code (must include .KL for Bursa).`);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue; // real non-trading gaps, not fabricated
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i] ?? q.close[i], low: q.low[i] ?? q.close[i],
      close: q.close[i], volume: q.volume[i] || 0
    });
  }
  return bars;
}

function printSummary(label, s) {
  if (!s || !s.trades) { console.log(`${label}: no trades in this window`); return; }
  console.log(`\n${label}`);
  console.log(`  Trades:          ${s.trades}`);
  console.log(`  Win rate:        ${s.winRate.toFixed(1)}%`);
  console.log(`  Avg win / loss:  RM${s.avgWin.toFixed(2)} / RM${s.avgLoss.toFixed(2)}`);
  console.log(`  Profit factor:   ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞ (no losing trades)"}`);
  console.log(`  Expectancy:      RM${s.expectancy.toFixed(2)} per trade`);
  console.log(`  Total return:    ${s.totalReturnPct.toFixed(1)}%`);
  console.log(`  Max drawdown:    ${s.maxDrawdownPct.toFixed(1)}%`);
}

async function main() {
  const { ticker, opts } = parseArgs(process.argv.slice(2));
  if (!ticker) {
    console.error("Usage: node scripts/backtest.mjs TICKER.KL [--strategy=smaRsi|breakoutVolume] [--capital=10000] [--fee=0.001] [--slippage=0.001] [--risk=1] [--range=5y] [--split=YYYY-MM-DD]");
    process.exit(1);
  }
  const signalFn = STRATEGIES[opts.strategy];
  if (!signalFn) {
    console.error(`Unknown strategy "${opts.strategy}". Available: ${Object.keys(STRATEGIES).join(", ")}`);
    process.exit(1);
  }

  console.log(`Fetching ${opts.range} of daily history for ${ticker}...`);
  const bars = await fetchDailyBars(ticker, opts.range);
  if (bars.length < 60) {
    console.error(`Only ${bars.length} usable bars returned for ${ticker} — too little history for a meaningful backtest. Not fabricating data to fill the gap.`);
    process.exit(1);
  }
  console.log(`Got ${bars.length} bars (${bars[0].date} to ${bars[bars.length - 1].date}).`);

  const runOne = (barsSlice) => {
    const result = runBacktest({ bars: barsSlice, signalFn, initialCapital: opts.capital, feePct: opts.fee, slippagePct: opts.slippage, riskPct: opts.risk });
    if (result.error) throw new Error(result.error);
    return summarizeBacktest({ ...result, initialCapital: opts.capital });
  };

  const report = { ticker, strategy: opts.strategy, params: opts, generatedAt: new Date().toISOString() };

  if (opts.split) {
    const { inSample, outOfSample } = splitInOutSample(bars, opts.split);
    console.log(`\nSplit at ${opts.split}: ${inSample.length} in-sample bars, ${outOfSample.length} out-of-sample bars.`);
    if (inSample.length < 60 || outOfSample.length < 20) {
      console.error("Not enough bars on one side of the split for a meaningful comparison. Pick a split date with more history on both sides.");
      process.exit(1);
    }
    const inS = runOne(inSample);
    const outS = runOne(outOfSample);
    printSummary("IN-SAMPLE (tune here)", inS);
    printSummary("OUT-OF-SAMPLE (never tune against this)", outS);
    report.inSample = inS;
    report.outOfSample = outS;
    if (outS.trades > 0 && inS.trades > 0 && outS.expectancy < inS.expectancy * 0.3) {
      console.log("\n⚠ Out-of-sample expectancy is much weaker than in-sample — a classic overfitting signature. Treat the in-sample numbers with skepticism.");
    }
  } else {
    const whole = runOne(bars);
    printSummary(`WHOLE PERIOD (${bars[0].date} to ${bars[bars.length - 1].date})`, whole);
    report.wholePeriod = whole;
  }

  console.log("\nHonest limitations: no survivorship-bias correction (a delisted ticker just isn't in universe.json today), fees/slippage are flat-rate approximations, and past performance of a mechanical rule is not a guarantee of anything going forward.");

  const outDir = path.join(process.cwd(), "data", "backtests");
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ticker.replace(/[^A-Za-z0-9.-]/g, "_")}-${opts.strategy}-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nFull report saved to ${path.relative(process.cwd(), outPath)}`);
}

main().catch(err => {
  console.error("backtest failed:", err.message);
  process.exit(1);
});

/**
 * Bias-conscious backtest engine.
 *
 * Anti-lookahead rule: a signal computed from bars[0..i] can only ever fill
 * at bars[i+1].open — never at bar i's own close. Stops are checked against
 * the SAME day's low (a stop is a resting order, so same-day intraday fills
 * are legitimate) but a strategy-exit signal fills at the next day's open
 * just like an entry does.
 *
 * Costs: a flat feePct is charged on both entry and exit notional; slippage
 * is modeled as an adverse price shift (worse fill than the quoted open) on
 * both entry and exit.
 *
 * This does NOT correct for survivorship bias (delisted/renamed tickers
 * dropped from universe.json over time) — that would require point-in-time
 * index membership data this project doesn't have and won't fabricate.
 * Treat backtest results as approximate and biased slightly optimistic for
 * that reason.
 */

import { classifySeries } from "./indicators.mjs";

/** Default signal generator: the same SMA20/50 + RSI14 rule used live. */
export function smaRsiSignals(bars) {
  return classifySeries(bars);
}

/**
 * Breakout + volume: BUY when today's close breaks the prior 20-session
 * high on volume >= 1.5x the 20-session average; AVOID once price closes
 * back below the 20-session SMA. Computed per-index from bars[0..i] only.
 */
export function breakoutVolumeSignals(bars) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 20) { out.push(null); continue; }
    const window = bars.slice(Math.max(0, i - 20), i); // prior 20 sessions, excludes today
    const priorHigh = Math.max(...window.map(b => b.high));
    const avgVol = window.reduce((s, b) => s + b.volume, 0) / window.length;
    const closesUpToI = bars.slice(0, i + 1).map(b => b.close);
    const s20 = closesUpToI.length >= 20
      ? closesUpToI.slice(-20).reduce((a, b) => a + b, 0) / 20
      : null;
    const bar = bars[i];
    let signal = "HOLD";
    if (bar.close > priorHigh && bar.volume >= avgVol * 1.5) signal = "BUY";
    else if (s20 != null && bar.close < s20) signal = "AVOID";
    const highs = bars.slice(0, i + 1).map(b => b.high);
    const lows = bars.slice(0, i + 1).map(b => b.low);
    const atr = closesUpToI.length >= 15 ? atr14Local(highs, lows, closesUpToI) : null;
    out.push({ signal, atr, trend: signal === "BUY" ? "up" : "flat", rsi: null, sma20: s20, sma50: null });
  }
  return out;
}

function atr14Local(highs, lows, closes) {
  const period = 14;
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

/**
 * Runs one strategy (a signalFn(bars) -> per-bar {signal, atr}[] generator)
 * over one ticker's daily bars.
 *
 * @param {Array<{date,open,high,low,close,volume}>} bars - ascending, MUST include `open`
 * @param {(bars)=>Array} [signalFn] - defaults to smaRsiSignals
 * @param {Array<'RISK_ON'|'NEUTRAL'|'RISK_OFF'>} [regimeSeries] - optional, parallel to bars; blocks new entries while RISK_OFF
 */
export function runBacktest({ bars, signalFn = smaRsiSignals, regimeSeries = null, initialCapital = 10000, feePct = 0.001, slippagePct = 0.001, lotSize = 100, riskPct = 1 }) {
  if (!bars.length) return { error: "no bars supplied" };
  if (bars.some(b => b.open == null)) return { error: "bars must include `open` — needed to fill at the NEXT day's open, not the signal day's close" };

  const series = signalFn(bars);
  let cash = initialCapital;
  let position = null;
  const trades = [];
  const equityCurve = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const cls = series[i];
    const nextBar = bars[i + 1];
    const regimeBlocksEntry = regimeSeries && regimeSeries[i] === "RISK_OFF";

    if (position) {
      if (bar.low <= position.stop) {
        const fillPrice = Math.min(bar.open, position.stop);
        const execPrice = fillPrice * (1 - slippagePct);
        const proceeds = position.qty * execPrice * (1 - feePct);
        cash += proceeds;
        trades.push({
          entryDate: position.entryDate, exitDate: bar.date, qty: position.qty,
          entryPrice: position.entryPrice, exitPrice: execPrice,
          pl: proceeds - position.qty * position.entryPrice, reason: "stop"
        });
        position = null;
      } else if (cls && cls.signal === "AVOID" && nextBar) {
        const execPrice = nextBar.open * (1 - slippagePct);
        const proceeds = position.qty * execPrice * (1 - feePct);
        cash += proceeds;
        trades.push({
          entryDate: position.entryDate, exitDate: nextBar.date, qty: position.qty,
          entryPrice: position.entryPrice, exitPrice: execPrice,
          pl: proceeds - position.qty * position.entryPrice, reason: "signal"
        });
        position = null;
      }
    }

    if (!position && !regimeBlocksEntry && cls && cls.signal === "BUY" && nextBar) {
      const execPrice = nextBar.open * (1 + slippagePct);
      const maxRiskAmount = cash * (riskPct / 100);
      const stop = cls.atr != null ? execPrice - 2 * cls.atr : execPrice * 0.95;
      const riskPerShare = execPrice - stop;
      if (riskPerShare > 0) {
        const maxSharesByRisk = Math.floor(maxRiskAmount / riskPerShare / lotSize) * lotSize;
        // Account for the entry fee here too — otherwise a qty that looks affordable
        // before fees can fail the cost<=cash check below and silently skip the trade.
        const maxSharesByCash = Math.floor(cash / (execPrice * (1 + feePct)) / lotSize) * lotSize;
        const qty = Math.max(0, Math.min(maxSharesByRisk, maxSharesByCash));
        if (qty > 0) {
          const cost = qty * execPrice * (1 + feePct);
          if (cost <= cash) {
            cash -= cost;
            position = { qty, entryPrice: execPrice, entryDate: nextBar.date, stop };
          }
        }
      }
    }

    equityCurve.push({ date: bar.date, value: cash + (position ? position.qty * bar.close : 0) });
  }

  if (position) {
    const last = bars[bars.length - 1];
    const proceeds = position.qty * last.close * (1 - feePct);
    trades.push({
      entryDate: position.entryDate, exitDate: last.date, qty: position.qty,
      entryPrice: position.entryPrice, exitPrice: last.close,
      pl: proceeds - position.qty * position.entryPrice, reason: "open-at-end (marked to market, not a real exit)"
    });
  }

  return { trades, equityCurve, finalCash: cash, initialCapital };
}

export function summarizeBacktest({ trades, equityCurve, initialCapital }) {
  const n = trades.length;
  const wins = trades.filter(t => t.pl > 0);
  const losses = trades.filter(t => t.pl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pl, 0));
  const totalPL = trades.reduce((s, t) => s + t.pl, 0);
  const finalEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].value : initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  let peak = initialCapital, maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.value > peak) peak = pt.value;
    const dd = peak > 0 ? ((peak - pt.value) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades: n,
    winRate: n ? (wins.length / n) * 100 : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    expectancy: n ? totalPL / n : 0,
    totalPL, totalReturnPct, maxDrawdownPct: maxDD, finalEquity
  };
}

/** Splits bars at a date so a strategy tuned on one half can be checked, untouched, on the other. */
export function splitInOutSample(bars, splitDate) {
  const t = new Date(splitDate).getTime();
  return {
    inSample: bars.filter(b => new Date(b.date).getTime() < t),
    outOfSample: bars.filter(b => new Date(b.date).getTime() >= t)
  };
}

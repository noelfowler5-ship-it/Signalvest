/**
 * Market-regime classifier. Describes the CURRENT market condition from
 * real, fetched KLCI history — never a prediction of future direction.
 */

import { sma } from "./indicators.mjs";

export const REGIME_DISCLAIMER = "Describes current market condition, not a prediction of future direction.";

/**
 * @param {number[]} klciCloses - ascending KLCI daily closes
 * @param {number|null} breadthPct - optional 0-100, % of the screened universe currently in an uptrend
 */
export function classifyRegime({ klciCloses, breadthPct = null }) {
  const s20 = sma(klciCloses, 20);
  const s50 = sma(klciCloses, 50);
  const s200 = sma(klciCloses, 200);
  const reasons = [];
  let votes = 0, total = 0;

  if (s20 != null && s50 != null) {
    total++;
    if (s20 > s50) { votes++; reasons.push("KLCI SMA20 above SMA50 (short-term uptrend)"); }
    else reasons.push("KLCI SMA20 at/below SMA50 (short-term flat or down)");
  }
  if (s50 != null && s200 != null) {
    total++;
    if (s50 > s200) { votes++; reasons.push("KLCI SMA50 above SMA200 (long-term uptrend)"); }
    else reasons.push("KLCI SMA50 at/below SMA200 (long-term flat or down)");
  }
  if (breadthPct != null) {
    total++;
    if (breadthPct >= 55) { votes++; reasons.push(`${breadthPct.toFixed(0)}% of your screened universe is in an uptrend (broad)`); }
    else reasons.push(`${breadthPct.toFixed(0)}% of your screened universe is in an uptrend (narrow)`);
  }

  if (total === 0) {
    return { regime: "NEUTRAL", reasons: ["Not enough KLCI history to classify"], confidence: 0, disclaimer: REGIME_DISCLAIMER };
  }
  const confidence = votes / total;
  let regime = "NEUTRAL";
  if (confidence >= 0.66) regime = "RISK_ON";
  else if (confidence <= 0.33) regime = "RISK_OFF";

  return { regime, reasons, confidence, votes, total, disclaimer: REGIME_DISCLAIMER };
}

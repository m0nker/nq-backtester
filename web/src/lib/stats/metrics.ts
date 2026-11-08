// Session statistics, all derived from event-derived trades — nothing here
// touches price data or the clock.

import { etOffsetSec, tradingDateOf } from '../time/et';
import type { Trade } from '../trading/engine';

export interface SideStats {
  count: number;
  winRate: number; // 0..1
  netUsd: number;
}

export interface SessionStats {
  tradeCount: number;
  wins: number;
  losses: number;
  breakevens: number; // pnl exactly 0 (counted in tradeCount, not in wins/losses)
  winRate: number; // 0..1, wins / all trades
  netUsd: number;
  grossWinUsd: number;
  grossLossUsd: number; // positive magnitude
  profitFactor: number | null; // null when no losses
  avgWinUsd: number;
  avgLossUsd: number; // positive magnitude
  payoffRatio: number | null; // avg win / avg loss — realized $ reward:risk; null without both
  expectancyUsd: number; // avg P&L per trade
  largestWinUsd: number;
  largestLossUsd: number; // positive magnitude
  maxDrawdownUsd: number; // positive magnitude, on the trade-by-trade equity curve
  recoveryFactor: number | null; // net / max drawdown; null when no drawdown
  sharpePerTrade: number | null; // mean / stdev of per-trade $ (not annualized)
  kellyPct: number | null; // W - (1-W)/payoff, as 0..1; null without a payoff ratio
  maxConsecWins: number;
  maxConsecLosses: number;
  avgHoldSec: number;
  long: SideStats;
  short: SideStats;
  // R-multiples: only trades whose opening fill carried a bracket (riskPts set)
  rTrades: number;
  totalR: number;
  avgR: number; // expectancy in R
  avgWinR: number;
  avgLossR: number; // positive magnitude
  plannedRR: number | null; // avg |TP - entry| / risk over trades with a TP
  // per CME trading day (by exit)
  tradingDays: number;
  greenDays: number;
  bestDayUsd: number;
  worstDayUsd: number;
  avgDayUsd: number;
}

function sideStats(trades: Trade[]): SideStats {
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  return {
    count: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    netUsd: trades.reduce((s, t) => s + t.pnlUsd, 0),
  };
}

export function computeStats(trades: Trade[]): SessionStats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnlUsd, 0);
  const net = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const winRate = n ? wins.length / n : 0;
  const payoff = wins.length && losses.length ? avgWin / avgLoss : null;

  // equity walk in exit order: drawdown + streaks
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let runW = 0,
    runL = 0,
    maxW = 0,
    maxL = 0;
  for (const t of [...trades].sort((a, b) => a.exitTs - b.exitTs)) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (t.pnlUsd > 0) {
      runW++;
      runL = 0;
    } else if (t.pnlUsd < 0) {
      runL++;
      runW = 0;
    } else {
      runW = 0;
      runL = 0;
    }
    maxW = Math.max(maxW, runW);
    maxL = Math.max(maxL, runL);
  }

  const mean = n ? net / n : 0;
  const variance = n > 1 ? trades.reduce((s, t) => s + (t.pnlUsd - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);

  const rList = trades.filter((t) => t.riskPts && t.riskPts > 0);
  const rOf = (t: Trade) => t.pnlPts / t.riskPts!;
  const rWins = rList.filter((t) => t.pnlPts > 0);
  const rLosses = rList.filter((t) => t.pnlPts < 0);
  const totalR = rList.reduce((s, t) => s + rOf(t), 0);
  const planned = rList.filter((t) => t.tpPrice !== undefined);
  const plannedRR = planned.length
    ? planned.reduce((s, t) => s + Math.abs(t.tpPrice! - t.avgEntry) / t.riskPts!, 0) / planned.length
    : null;

  const byDay = new Map<string, number>();
  for (const t of trades) {
    const d = tradingDateOf(t.exitTs);
    byDay.set(d, (byDay.get(d) ?? 0) + t.pnlUsd);
  }
  const days = [...byDay.values()];

  return {
    tradeCount: n,
    wins: wins.length,
    losses: losses.length,
    breakevens: n - wins.length - losses.length,
    winRate,
    netUsd: net,
    grossWinUsd: grossWin,
    grossLossUsd: grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWinUsd: avgWin,
    avgLossUsd: avgLoss,
    payoffRatio: payoff,
    expectancyUsd: mean,
    largestWinUsd: wins.length ? Math.max(...wins.map((t) => t.pnlUsd)) : 0,
    largestLossUsd: losses.length ? -Math.min(...losses.map((t) => t.pnlUsd)) : 0,
    maxDrawdownUsd: maxDd,
    recoveryFactor: maxDd > 0 ? net / maxDd : null,
    sharpePerTrade: sd > 0 ? mean / sd : null,
    kellyPct: payoff !== null ? winRate - (1 - winRate) / payoff : null,
    maxConsecWins: maxW,
    maxConsecLosses: maxL,
    avgHoldSec: n ? trades.reduce((s, t) => s + (t.exitTs - t.entryTs), 0) / n : 0,
    long: sideStats(trades.filter((t) => t.side === 'buy')),
    short: sideStats(trades.filter((t) => t.side === 'sell')),
    rTrades: rList.length,
    totalR,
    avgR: rList.length ? totalR / rList.length : 0,
    avgWinR: rWins.length ? rWins.reduce((s, t) => s + rOf(t), 0) / rWins.length : 0,
    avgLossR: rLosses.length ? -rLosses.reduce((s, t) => s + rOf(t), 0) / rLosses.length : 0,
    plannedRR,
    tradingDays: days.length,
    greenDays: days.filter((v) => v > 0).length,
    bestDayUsd: days.length ? Math.max(...days) : 0,
    worstDayUsd: days.length ? Math.min(...days) : 0,
    avgDayUsd: days.length ? net / days.length : 0,
  };
}

// Equity curve points (cumulative realized $ over trade exits, oldest first).
export function equityPoints(trades: Trade[], startBalance = 0): { t: number; v: number }[] {
  const sorted = [...trades].sort((a, b) => a.exitTs - b.exitTs);
  let equity = startBalance;
  const out: { t: number; v: number }[] = [];
  for (const tr of sorted) {
    equity += tr.pnlUsd;
    // lightweight-charts needs strictly ascending times; nudge collisions
    const t = out.length && tr.exitTs <= out[out.length - 1].t ? out[out.length - 1].t + 1 : tr.exitTs;
    out.push({ t, v: equity });
  }
  return out;
}

function etHour(tsSec: number): number {
  return new Date((tsSec + etOffsetSec(tsSec)) * 1000).getUTCHours();
}

function etDow(tsSec: number): number {
  return new Date((tsSec + etOffsetSec(tsSec)) * 1000).getUTCDay(); // 0 = Sunday
}

// P&L bucketed by ENTRY hour-of-day (ET), 24 buckets.
export function pnlByHourET(trades: Trade[]): number[] {
  const out = new Array(24).fill(0);
  for (const t of trades) out[etHour(t.entryTs)] += t.pnlUsd;
  return out;
}

// P&L bucketed by ENTRY day-of-week (ET), Sunday..Saturday.
export function pnlByDowET(trades: Trade[]): number[] {
  const out = new Array(7).fill(0);
  for (const t of trades) out[etDow(t.entryTs)] += t.pnlUsd;
  return out;
}

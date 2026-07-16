// Session statistics, all derived from event-derived trades — nothing here
// touches price data or the clock.

import { etOffsetSec } from '../time/et';
import type { Trade } from '../trading/engine';

export interface SessionStats {
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number; // 0..1
  netUsd: number;
  grossWinUsd: number;
  grossLossUsd: number; // positive magnitude
  profitFactor: number | null; // null when no losses
  avgWinUsd: number;
  avgLossUsd: number; // positive magnitude
  expectancyUsd: number; // avg P&L per trade
  maxDrawdownUsd: number; // positive magnitude, on the trade-by-trade equity curve
}

export function computeStats(trades: Trade[]): SessionStats {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnlUsd, 0);
  const net = trades.reduce((s, t) => s + t.pnlUsd, 0);

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of [...trades].sort((a, b) => a.exitTs - b.exitTs)) {
    equity += t.pnlUsd;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }

  return {
    tradeCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    netUsd: net,
    grossWinUsd: grossWin,
    grossLossUsd: grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWinUsd: wins.length ? grossWin / wins.length : 0,
    avgLossUsd: losses.length ? grossLoss / losses.length : 0,
    expectancyUsd: trades.length ? net / trades.length : 0,
    maxDrawdownUsd: maxDd,
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

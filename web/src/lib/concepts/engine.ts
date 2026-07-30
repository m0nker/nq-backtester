// Candidate engine core — the pure half of the strategy bot. Implements the
// three core rules from STRATEGY_DEFINITIONS.md §3 over the FVG detector's
// output. No store access, no side effects: the bot store (botStore.ts)
// feeds it bars/gaps and owns events, prompting, and order placement.
//
// Terminology (user's): a tapped 5m–4h gap is the CONDITION FVG; the LTF gap
// whose inversion confirms entry is the trigger IFVG. V1 scans triggers on
// 1m only, but everything below takes the trigger-TF list as data so the
// future "highest-TF IFVG among 15s..5m" selection is a config change.

import { etOffsetSec, etWallToUtc, tradingDateOf } from '../time/et';
import { TF_SECONDS, isSessionTf, type Bar, type Timeframe } from '../types';
import type { FVG, FVGDir } from './fvg';

// FVGs never form on session TFs (computeFVGs returns [] for them), but the
// Timeframe type includes them — guard the seconds lookup.
const tfSec = (tf: Timeframe): number => (isSessionTf(tf) ? 0 : TF_SECONDS[tf]);

export type BiasDirection = 'long' | 'short';

export interface BiasEntry {
  id: string;
  direction: BiasDirection;
  until: number;
  setTs: number; // market time the user entered it
  deadAt: number | null; // DERIVED: open time of the first bar touching `until`
}

// Death by touch (locked): long dies when a bar's high reaches `until`,
// short when a bar's low reaches it. Only bars opened at/after the bias was
// set count — the bar the user was looking at when typing doesn't kill it.
// Each list entry lives and dies independently (locked).
export function updateBiasDeaths(biases: BiasEntry[], bars: Bar[]): void {
  for (const b of biases) {
    if (b.deadAt !== null) continue;
    for (const bar of bars) {
      if (bar.t < b.setTs) continue;
      if (b.direction === 'long' ? bar.h >= b.until : bar.l <= b.until) {
        b.deadAt = bar.t;
        break;
      }
    }
  }
}

export function biasAliveAt(b: BiasEntry, ts: number): boolean {
  return b.setTs <= ts && (b.deadAt === null || b.deadAt >= ts);
}

// First bar printing STRICTLY inside the zone (the rule-2 tap), at the
// caller's bar resolution (1m for exact arming times).
export function firstInsidePrint(bars: Bar[], top: number, bottom: number, fromTs: number): Bar | null {
  for (const bar of bars) {
    if (bar.t < fromTs) continue;
    if (bar.l < top && bar.h > bottom) return bar;
  }
  return null;
}

// Fill-watermark tap scan (locked 2026-07-30). Every gap carries a
// WATERMARK — the deepest price ever traded into it since formation, any
// session (a bearish gap fills upward from its bottom edge; bullish mirror).
// A print only ARMS if it goes strictly BEYOND the watermark as of just
// before that bar — i.e. into the unfilled remainder — AND lands at/after
// `armFromTs` (the session open). Every penetrating bar advances the
// watermark whether or not it arms, so a premarket push sets the level an
// in-session tap must beat. A fully filled gap has no remainder and can
// never arm again. Bars are scanned in time order; the caller persists the
// returned watermark for incremental scans.
export interface TapScan {
  armedBar: Bar | null;
  watermark: number;
}
// Fully mitigated (locked 2026-07-30): price has traded through the ENTIRE
// gap (watermark at the far edge). Terminal for condition use — it can never
// arm or re-arm, even without an inversion. (Triggers are unaffected: a full
// sweep before the inversion close is the normal IFVG sequence.)
export function isFullyMitigated(dir: FVGDir, watermark: number, top: number, bottom: number): boolean {
  return dir === 'bear' ? watermark >= top : watermark <= bottom;
}
export function scanForTap(opts: {
  bars: Bar[];
  dir: FVGDir;
  top: number;
  bottom: number;
  fromTs: number; // bars before this (pre-formation) count for nothing
  armFromTs: number; // arming requires bar.t >= this (session-tap rule)
  watermark?: number; // carry-over from a previous scan
  alreadyArmed?: boolean; // just advance the watermark, never arm
}): TapScan {
  const { dir, top, bottom } = opts;
  let w = opts.watermark ?? (dir === 'bear' ? bottom : top);
  let armedBar: Bar | null = null;
  for (const bar of opts.bars) {
    if (bar.t < opts.fromTs) continue;
    if (dir === 'bear') {
      // remainder is (w, top); a qualifying print exceeds w while trading
      // below top (a bar entirely above the gap never printed inside it).
      // A bar that traverses the FAR edge (bar.h >= top) FULLY MITIGATES the
      // gap (locked 2026-07-30) — it never arms, not even on its way through.
      const penetrates = w < top && bar.h > w && bar.l < top;
      if (penetrates && bar.h < top && !opts.alreadyArmed && armedBar === null && bar.t >= opts.armFromTs) {
        armedBar = bar;
      }
      if (bar.h > w && bar.l < top) w = Math.min(bar.h, top);
    } else {
      const penetrates = w > bottom && bar.l < w && bar.h > bottom;
      if (penetrates && bar.l > bottom && !opts.alreadyArmed && armedBar === null && bar.t >= opts.armFromTs) {
        armedBar = bar;
      }
      if (bar.l < w && bar.h > bottom) w = Math.max(bar.l, bottom);
    }
  }
  return { armedBar, watermark: w };
}

// Execution window: the rule-3 confirmation close must land inside it,
// inclusive of the end itself. Configurable per session (ET seconds-of-day);
// defaults to the locked 09:30–11:00.
export interface ExecutionWindow {
  startSec: number; // ET seconds-of-day
  endSec: number;
}
export const DEFAULT_WINDOW: ExecutionWindow = {
  startSec: 9 * 3600 + 30 * 60,
  endSec: 11 * 3600,
};
export function inExecutionWindow(ts: number, window: ExecutionWindow = DEFAULT_WINDOW): boolean {
  const sec = (ts + etOffsetSec(ts)) % 86_400;
  return sec >= window.startSec && sec <= window.endSec;
}

// 09:30 ET of ts's trading day — the session open. An evening timestamp
// belongs to the NEXT trading date (18:00 boundary), so its session open is
// still ahead: overnight taps can never arm.
export function sessionOpenOf(ts: number): number {
  const [y, mo, d] = tradingDateOf(ts).split('-').map(Number);
  return etWallToUtc(y, mo, d, 9, 30);
}

export const gapKey = (g: FVG): string => `${g.tf}:${g.formedAt}`;

// Price-zone overlap (strict: touching edges is not overlap).
export const overlaps = (a: { top: number; bottom: number }, b: { top: number; bottom: number }): boolean =>
  a.bottom < b.top && b.bottom < a.top;

// ---- bot position sizing (locked 2026-07-30) ----
// Contracts trade in 0.1 steps (MNQ simulation), minimum 0.1. Three modes:
// - contracts: a constant size;
// - percent: risk a % of the CURRENT account balance (user-specified);
// - usd: risk a fixed dollar amount.
// For percent/usd the ideal size = riskUsd / (stopPts * $per-point), rounded
// to the NEAREST 0.1 (e.g. $500 risk / 20-pt stop on NQ -> 1.25 -> 1.3).
export type RiskMode = 'contracts' | 'percent' | 'usd';
export interface RiskSettings {
  mode: RiskMode;
  contracts: number;
  percent: number;
  usd: number;
}
export const DEFAULT_RISK: RiskSettings = { mode: 'contracts', contracts: 1, percent: 1, usd: 500 };
export function sizeContracts(
  risk: RiskSettings,
  stopPts: number,
  balance: number,
  pointValue = 20,
): number {
  let ideal: number;
  if (risk.mode === 'contracts') ideal = risk.contracts;
  else {
    const riskUsd = risk.mode === 'percent' ? (balance * risk.percent) / 100 : risk.usd;
    ideal = stopPts > 0 ? riskUsd / (stopPts * pointValue) : 0;
  }
  if (!Number.isFinite(ideal) || ideal <= 0) return 0.1;
  return Math.max(0.1, Math.round(ideal * 10) / 10);
}

export interface ArmedCondition {
  gap: FVG;
  armedAt: number; // open time of the tapping 1m bar
}

export interface CandidateDraft {
  candidateId: string;
  direction: BiasDirection;
  confirmTs: number;
  condition: { tf: Timeframe; top: number; bottom: number; formedAt: number; armedAt: number; bT: number };
  otherConditions: Timeframe[];
  ifvg: { tf: Timeframe; top: number; bottom: number; formedAt: number; bT: number };
  stop: number;
  entryEst: number;
  biasId: string;
}

// Rule 1 + 2 + 3 assembly. `triggers` are trigger-TF gaps whose inversion
// close falls in the advance being processed; each yields at most one
// candidate. The condition FVG must be armed before the confirmation and
// still alive AT the confirmation (inversion or expiry of the condition gap
// before the trigger disqualifies it — both disarm, locked). The arming tap
// must also be IN-SESSION: at/after 09:30 ET of the confirmation's trading
// day (locked 2026-07-30 — premarket/overnight/prior-day taps don't arm).
export function matchTriggers(opts: {
  triggers: FVG[];
  conditions: ArmedCondition[];
  biases: BiasEntry[];
  bars1m: Bar[]; // visible 1m bars (for the swing-extreme stop + entry estimate)
  fired: ReadonlySet<string>;
  window?: ExecutionWindow; // defaults to 09:30–11:00 ET
  // Overlap hierarchy (locked 2026-07-30): the full trigger-TF gap pool (any
  // status). An inversion on TF X is SUPPRESSED when an overlapping,
  // same-direction, active gap on a SAME-OR-HIGHER trigger TF is in 'filled'
  // status (tapped, not yet inverted) at the confirmation — the execution
  // belongs to the highest timeframe of the overlap, so wait for it. Lower
  // TFs never block (a still-filled 4m can't veto a 5m close, which lands
  // first by bucket timing).
  blockers?: FVG[];
}): CandidateDraft[] {
  const out: CandidateDraft[] = [];
  for (const trig of opts.triggers) {
    if (trig.invertedAt === null) continue;
    const confirmTs = trig.invertedAt;
    // a bearish gap inverting bullishly triggers a LONG; mirror for shorts
    const direction: BiasDirection = trig.dir === 'bear' ? 'long' : 'short';
    const candidateId = `${trig.tf}:${trig.formedAt}:${direction}`;
    if (opts.fired.has(candidateId)) continue;
    if (!inExecutionWindow(confirmTs, opts.window)) continue;

    if (
      opts.blockers?.some(
        (b) =>
          !(b.tf === trig.tf && b.formedAt === trig.formedAt) && // not the trigger itself
          b.dir === trig.dir &&
          tfSec(b.tf) >= tfSec(trig.tf) && // same-or-higher TF (locked: same TF blocks too)
          overlaps(b, trig) &&
          b.formedAt <= confirmTs &&
          b.tappedAt !== null &&
          b.tappedAt <= confirmTs && // 'filled' at confirmation (unfilled never blocks)
          (b.invertedAt === null || b.invertedAt > confirmTs) &&
          (b.expiredAt === null || b.expiredAt > confirmTs),
      )
    ) {
      continue;
    }

    const bias = opts.biases.find((b) => b.direction === direction && biasAliveAt(b, confirmTs));
    if (!bias) continue;

    const wantDir = direction === 'long' ? 'bull' : 'bear';
    const sessionOpen = sessionOpenOf(confirmTs);
    const matched = opts.conditions.filter(
      ({ gap, armedAt }) =>
        gap.dir === wantDir &&
        armedAt >= sessionOpen &&
        armedAt <= confirmTs &&
        (gap.invertedAt === null || gap.invertedAt > confirmTs) &&
        (gap.expiredAt === null || gap.expiredAt > confirmTs),
    );
    if (matched.length === 0) continue;
    // primary condition = highest timeframe (matches "highest TF" instinct;
    // its tap anchors the retracement swing for the stop)
    const primary = matched.reduce((a, b) => (tfSec(b.gap.tf) > tfSec(a.gap.tf) ? b : a));

    // stop = retracement swing extreme (locked): lowest low (long) / highest
    // high (short) from the primary condition's tap bar through confirmation
    let stop = direction === 'long' ? Infinity : -Infinity;
    let entryEst: number | null = null;
    for (const bar of opts.bars1m) {
      if (bar.t + 60 <= confirmTs) entryEst = bar.c;
      if (bar.t < primary.armedAt || bar.t >= confirmTs) continue;
      stop = direction === 'long' ? Math.min(stop, bar.l) : Math.max(stop, bar.h);
    }
    if (!Number.isFinite(stop) || entryEst === null) continue;
    // degenerate geometry (stop on the wrong side of the estimated entry)
    if (direction === 'long' ? stop >= entryEst : stop <= entryEst) continue;

    out.push({
      candidateId,
      direction,
      confirmTs,
      condition: {
        tf: primary.gap.tf,
        top: primary.gap.top,
        bottom: primary.gap.bottom,
        formedAt: primary.gap.formedAt,
        armedAt: primary.armedAt,
        bT: primary.gap.bT,
      },
      otherConditions: matched.filter((m) => m !== primary).map((m) => m.gap.tf),
      ifvg: { tf: trig.tf, top: trig.top, bottom: trig.bottom, formedAt: trig.formedAt, bT: trig.bT },
      stop,
      entryEst,
      biasId: bias.id,
    });
  }
  return out;
}

// Mechanical draws on liquidity (DOL) — the condition side of the MECH MODEL
// bot, and a chart overlay concept. Pure module: callers feed bars/candles.
//
// Level catalog at any time:
//  - session H/L pairs from fixed ET windows, most recent COMPLETED window
//    per kind (may be yesterday's if today's hasn't closed yet):
//      asia 20:00–24:00 · london 02:00–05:00 · NY AM 09:30–11:00 · NY PM 13:00–16:00
//  - previous trading day H/L (full 18:00→17:00 day, from 1D candles)
//  - previous trading week H/L (from 1W candles)
//  - higher-timeframe swing H/L (5-bar fractals on 1h/4h) that aren't
//    already the previous day/week H/L
// A high is BUYSIDE liquidity, a low is SELLSIDE.
//
// Sweep logic (locked 2026-07-31): a print strictly beyond a level SWEEPS it
// — sweeping sellside (a low) arms LONGS, sweeping buyside (a high) arms
// SHORTS. Each level carries a watermark (deepest print beyond it, ever) so
// a re-arm needs a FRESH extreme beyond every prior raid. The armed state
// INVALIDATES when price trades farther than `invalidationPts` from the
// level in EITHER direction: beyond = the raid became a breakout; away = the
// reversal already ran without a trigger. Invalidation is not terminal — a
// deeper raid re-arms.

import { bucketEnd } from '../replay/aggregate';
import { etOffsetSec, etWallToUtc, tradingDayStartSec } from '../time/et';
import { TF_SECONDS, isSessionTf, type Bar, type Timeframe } from '../types';
import type { FVG } from './fvg';
import {
  inExecutionWindow,
  type BiasDirection,
  type CandidateDraft,
  type ExecutionWindow,
} from './engine';

export type DOLSide = 'buyside' | 'sellside';
export type DOLKind = 'asia' | 'london' | 'nyam' | 'nypm' | 'pd' | 'pw' | 'swing';

export interface DOLLevel {
  id: string; // stable identity across recomputes
  kind: DOLKind;
  side: DOLSide;
  price: number;
  formedAt: number; // when the level became knowable (window end / swing confirmation)
  label: string; // 'ASIA H', 'PDL', '1h SWG H', ...
  swingTf?: Timeframe;
}

export interface SweepState {
  wm: number; // deepest print beyond the level (== price while unswept)
  sweptAt: number | null; // 1m bar t of the arming sweep (null = not armed)
}

export const DEFAULT_DOL_INVALIDATION_PTS = 40;

// ET wall-clock session windows [start, end) in seconds-of-day.
const SESSION_WINDOWS: Record<'asia' | 'london' | 'nyam' | 'nypm', { start: number; end: number; label: string }> = {
  asia: { start: 20 * 3600, end: 24 * 3600, label: 'ASIA' },
  london: { start: 2 * 3600, end: 5 * 3600, label: 'LDN' },
  nyam: { start: 9 * 3600 + 30 * 60, end: 11 * 3600, label: 'NYAM' },
  nypm: { start: 13 * 3600, end: 16 * 3600, label: 'NYPM' },
};

const SWING_TFS: readonly Timeframe[] = ['1h', '4h'];
const SWING_LOOKBACK = 60; // candles per TF
const DEDUPE_EPS = 0.25; // one tick — swing equal to PDH/PWH is that level, not a new one

// Callers hand data access in, keeping this module pure and testable.
export interface LevelDataSource {
  barsInWindow: (afterTs: number, upTo: number) => Bar[]; // 1m bars closing in (afterTs, upTo]
  candles: (upTo: number, tf: Timeframe) => Bar[]; // clock-clipped candles
}

const etDateOf = (ts: number): { y: number; mo: number; d: number } => {
  const d = new Date((ts + etOffsetSec(ts)) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

const shiftDays = (p: { y: number; mo: number; d: number }, days: number) => {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d) + days * 86_400_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

// Most recent COMPLETED window of a session kind at `upTo` that has data,
// searching back up to 6 calendar days (weekends/holidays have no bars).
function sessionLevels(src: LevelDataSource, upTo: number, kind: 'asia' | 'london' | 'nyam' | 'nypm'): DOLLevel[] {
  const w = SESSION_WINDOWS[kind];
  const hhmm = (sec: number) => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60)] as const;
  let day = etDateOf(upTo);
  for (let back = 0; back < 6; back++) {
    // wall-clock conversion per bound (not midnight + offset: a DST Sunday
    // would shift every window that crosses 02:00)
    const start = etWallToUtc(day.y, day.mo, day.d, ...hhmm(w.start));
    const end = etWallToUtc(day.y, day.mo, day.d, ...hhmm(w.end));
    if (end <= upTo) {
      const bars = src.barsInWindow(start - 60, end);
      if (bars.length > 0) {
        let hi = -Infinity,
          lo = Infinity;
        for (const b of bars) {
          hi = Math.max(hi, b.h);
          lo = Math.min(lo, b.l);
        }
        const dateKey = `${day.y}-${String(day.mo).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
        return [
          { id: `${kind}:buyside:${dateKey}`, kind, side: 'buyside', price: hi, formedAt: end, label: `${w.label} H` },
          { id: `${kind}:sellside:${dateKey}`, kind, side: 'sellside', price: lo, formedAt: end, label: `${w.label} L` },
        ];
      }
    }
    day = shiftDays(day, -1);
  }
  return [];
}

// Previous full candle of a session-bucketed TF (1D → previous trading day,
// 1W → previous trading week). The series' LAST candle is the current
// (possibly partial) bucket; the one before it is the completed previous.
function prevBucketLevels(
  src: LevelDataSource,
  upTo: number,
  tf: '1D' | '1W',
  kind: 'pd' | 'pw',
  labelPrefix: string,
): DOLLevel[] {
  const candles = src.candles(upTo, tf);
  if (candles.length < 2) return [];
  const prev = candles[candles.length - 2];
  const formedAt = Math.min(bucketEnd(prev.t, tf), upTo);
  return [
    { id: `${kind}:buyside:${prev.t}`, kind, side: 'buyside', price: prev.h, formedAt, label: `${labelPrefix}H` },
    { id: `${kind}:sellside:${prev.t}`, kind, side: 'sellside', price: prev.l, formedAt, label: `${labelPrefix}L` },
  ];
}

// Confirmed 5-bar-fractal swings on the HTF candles: center strictly above
// its immediate neighbors and at least the outer pair (mirror for lows),
// confirmed once two full candles printed after the center.
function swingLevels(src: LevelDataSource, upTo: number, exclude: DOLLevel[]): DOLLevel[] {
  const out: DOLLevel[] = [];
  const isDupe = (price: number) =>
    exclude.some((l) => Math.abs(l.price - price) <= DEDUPE_EPS) ||
    out.some((l) => Math.abs(l.price - price) <= DEDUPE_EPS);
  for (const tf of SWING_TFS) {
    const candles = src.candles(upTo, tf).filter((c) => bucketEnd(c.t, tf) <= upTo);
    const from = Math.max(2, candles.length - SWING_LOOKBACK);
    for (let i = from; i < candles.length - 2; i++) {
      const c = candles[i];
      const formedAt = bucketEnd(candles[i + 2].t, tf);
      if (
        c.h > Math.max(candles[i - 1].h, candles[i + 1].h) &&
        c.h >= Math.max(candles[i - 2].h, candles[i + 2].h) &&
        !isDupe(c.h)
      ) {
        out.push({
          id: `swing:${tf}:buyside:${c.t}`,
          kind: 'swing',
          side: 'buyside',
          price: c.h,
          formedAt,
          label: `${tf} SWG H`,
          swingTf: tf,
        });
      }
      if (
        c.l < Math.min(candles[i - 1].l, candles[i + 1].l) &&
        c.l <= Math.min(candles[i - 2].l, candles[i + 2].l) &&
        !isDupe(c.l)
      ) {
        out.push({
          id: `swing:${tf}:sellside:${c.t}`,
          kind: 'swing',
          side: 'sellside',
          price: c.l,
          formedAt,
          label: `${tf} SWG L`,
          swingTf: tf,
        });
      }
    }
  }
  return out;
}

// The full DOL catalog at `upTo`. 4h swings are scanned before 1h so a level
// shared by both TFs keeps the higher-TF identity (dedupe keeps the first).
export function levelsAt(src: LevelDataSource, upTo: number): DOLLevel[] {
  const out: DOLLevel[] = [
    ...prevBucketLevels(src, upTo, '1W', 'pw', 'PW'),
    ...prevBucketLevels(src, upTo, '1D', 'pd', 'PD'),
    ...sessionLevels(src, upTo, 'asia'),
    ...sessionLevels(src, upTo, 'london'),
    ...sessionLevels(src, upTo, 'nyam'),
    ...sessionLevels(src, upTo, 'nypm'),
  ];
  out.push(...swingLevels(src, upTo, out));
  return out;
}

// Fold bars into a level's sweep state. A bar disarms BEFORE it can arm: a
// print outside the ±invalidationPts band around the level both kills an
// armed state and disqualifies that bar's own raid (it's already a breakout
// or the move ran). Watermark advances on every beyond-print regardless.
export function foldSweep(
  level: DOLLevel,
  state: SweepState,
  bars: Bar[],
  invalidationPts: number,
): SweepState {
  let { wm, sweptAt } = state;
  const buy = level.side === 'buyside';
  for (const bar of bars) {
    if (bar.t < level.formedAt) continue;
    const withinBand = bar.h <= level.price + invalidationPts && bar.l >= level.price - invalidationPts;
    const depth = buy ? bar.h : bar.l;
    const beyondWm = buy ? depth > wm : depth < wm;
    if (sweptAt !== null && !withinBand) sweptAt = null;
    if (sweptAt === null && beyondWm && withinBand) sweptAt = bar.t;
    if (beyondWm) wm = depth;
  }
  return { wm, sweptAt };
}

export const freshSweepState = (level: DOLLevel): SweepState => ({ wm: level.price, sweptAt: null });

// Rebuild all sweep states from loaded history (begin/resume/rewind).
export function rebuildSweeps(
  src: LevelDataSource,
  levels: DOLLevel[],
  upTo: number,
  invalidationPts: number,
): Record<string, SweepState> {
  const out: Record<string, SweepState> = {};
  for (const level of levels) {
    const bars = src.barsInWindow(level.formedAt - 60, upTo);
    out[level.id] = foldSweep(level, freshSweepState(level), bars, invalidationPts);
  }
  return out;
}

export interface ArmedSweep {
  level: DOLLevel;
  sweptAt: number;
}

// Rule-3 assembly for the mech model: an IFVG inversion confirms against an
// armed sweep of the ALIGNED side — sweeping sellside (a low) hunts longs,
// sweeping buyside (a high) hunts shorts. No bias input: the sweep IS the
// directional read. Trigger-side mechanics (execution window, filled-gap
// veto across same-or-higher trigger TFs, dedupe) match the FVG model.
export function matchSweepTriggers(opts: {
  triggers: FVG[];
  sweeps: ArmedSweep[];
  bars1m: Bar[];
  fired: ReadonlySet<string>;
  window?: ExecutionWindow;
  blockers?: FVG[];
}): CandidateDraft[] {
  const out: CandidateDraft[] = [];
  for (const trig of opts.triggers) {
    if (trig.invertedAt === null) continue;
    const confirmTs = trig.invertedAt;
    const direction: BiasDirection = trig.dir === 'bear' ? 'long' : 'short';
    const candidateId = `${trig.tf}:${trig.formedAt}:${direction}`;
    if (opts.fired.has(candidateId)) continue;
    if (!inExecutionWindow(confirmTs, opts.window)) continue;

    if (
      opts.blockers?.some(
        (b) =>
          !(b.tf === trig.tf && b.formedAt === trig.formedAt) &&
          b.dir === trig.dir &&
          tfRank(b.tf) >= tfRank(trig.tf) &&
          b.formedAt <= confirmTs &&
          b.tappedAt !== null &&
          b.tappedAt <= confirmTs &&
          (b.invertedAt === null || b.invertedAt > confirmTs) &&
          (b.expiredAt === null || b.expiredAt > confirmTs),
      )
    ) {
      continue;
    }

    const wantSide: DOLSide = direction === 'long' ? 'sellside' : 'buyside';
    const matched = opts.sweeps.filter((s) => s.level.side === wantSide && s.sweptAt <= confirmTs);
    if (matched.length === 0) continue;
    // primary = the most recent raid — the sweep this reversal is answering
    const primary = matched.reduce((a, b) => (b.sweptAt > a.sweptAt ? b : a));

    // stop = raid extreme: lowest low (long) / highest high (short) from the
    // sweep bar through confirmation — includes the sweep wick itself
    let stop = direction === 'long' ? Infinity : -Infinity;
    let entryEst: number | null = null;
    for (const bar of opts.bars1m) {
      if (bar.t + 60 <= confirmTs) entryEst = bar.c;
      if (bar.t < primary.sweptAt || bar.t >= confirmTs) continue;
      stop = direction === 'long' ? Math.min(stop, bar.l) : Math.max(stop, bar.h);
    }
    if (!Number.isFinite(stop) || entryEst === null) continue;
    if (direction === 'long' ? stop >= entryEst : stop <= entryEst) continue;

    out.push({
      candidateId,
      direction,
      confirmTs,
      otherConditions: [],
      dol: {
        kind: primary.level.kind,
        side: primary.level.side,
        price: primary.level.price,
        label: primary.level.label,
        sweptAt: primary.sweptAt,
      },
      ifvg: { tf: trig.tf, top: trig.top, bottom: trig.bottom, formedAt: trig.formedAt, bT: trig.bT },
      stop,
      entryEst,
    });
  }
  return out;
}

// trigger-TF ordering for the veto (session TFs never appear as triggers)
const tfRank = (tf: Timeframe): number => (isSessionTf(tf) ? 0 : TF_SECONDS[tf]);

// Overlay helper: has the level been swept since formation (any loaded bar
// printing beyond it)? Cheap current-day check for display styling only.
export function sweptForDisplay(level: DOLLevel, src: LevelDataSource, upTo: number): boolean {
  const from = Math.max(level.formedAt, tradingDayStartSec(upTo));
  return src
    .barsInWindow(from - 60, upTo)
    .some((b) => (level.side === 'buyside' ? b.h > level.price : b.l < level.price));
}

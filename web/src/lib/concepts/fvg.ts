// Fair value gap detection + lifecycle, per STRATEGY_DEFINITIONS.md §2.
//
// Pure: consumes a candle array that barSource has already clock-clipped, so
// no-lookahead is inherited. Formation and inversion are close-driven and
// therefore only ever read CLOSED candles (t + tfSec <= upTo); tap/fill are
// price events and also read the partially-formed last candle — its extremes
// so far are real prints.
//
// Candles are "consecutive" in SERIES order (what the chart shows) — halts
// and weekends don't break a 3-candle pattern, matching how the pattern is
// read off a chart.

import { TF_SECONDS, isSessionTf, type Bar, type Timeframe } from '../types';

export type FVGDir = 'bull' | 'bear';

export interface FVG {
  tf: Timeframe;
  dir: FVGDir;
  top: number; // zone boundaries: bull = [A.high, C.low], bear = [C.high, A.low]
  bottom: number;
  aT: number; // candle A open time
  bT: number; // candle B (displacement candle) open time — box left edge
  formedAt: number; // candle C's close time: the first instant the gap exists
  // ---- lifecycle (see doc §2.3) ----
  tappedAt: number | null; // open time of the first candle printing strictly inside
  fillPct: number; // deepest penetration 0..1; 1 = full wick-through (NOT terminal)
  invertedAt: number | null; // close time of the inverting candle (terminal)
  expiredAt: number | null; // open time of the candle that aged it out (terminal)
}

export const ceOf = (g: FVG): number => (g.top + g.bottom) / 2;

// Display/consideration status in the user's vocabulary (doc §2.3):
// unfilled = never tapped, filled = tapped at least once (any depth),
// inverted = closed through. Expired gaps are out of consideration entirely —
// check `expiredAt` before using the status.
export type FVGStatus = 'unfilled' | 'filled' | 'inverted';
export const statusOf = (g: FVG): FVGStatus =>
  g.invertedAt !== null ? 'inverted' : g.tappedAt !== null ? 'filled' : 'unfilled';

// Condition-FVG timeframes (rule-2 taps) and trigger (IFVG) timeframes
// (rule 3). 15s/30s trigger TFs only produce candles where 1s data exists.
// V1 runs the trigger scan on 1m only; the engine takes the TF list as
// config so the future highest-TF-IFVG selection is a list change.
export const CONDITION_TFS: readonly Timeframe[] = ['5m', '15m', '30m', '1h', '4h'];
export const TRIGGER_TFS_ALL: readonly Timeframe[] = ['15s', '30s', '1m', '2m', '3m', '4m', '5m'];
export const TRIGGER_TFS_V1: readonly Timeframe[] = ['1m'];

export interface FVGOptions {
  // Scan at most the last N candles. Gaps whose 3-candle pattern completed
  // before the window are not detected — a deliberate relevance/perf bound.
  lookbackCandles?: number;
  // A gap is only considered for this many of ITS OWN timeframe's candles
  // after formation; past that it expires (terminal, cannot invert anymore).
  maxAgeCandles?: number;
}

const DEFAULT_LOOKBACK = 1500;
// Locked decision (doc §2.3): a gap lives 25 candles of its own timeframe.
// Age of the candle at index i relative to a gap whose candle C sits at
// index cIdx is (i - cIdx); the gap is considered while age <= 25. The
// forming partial candle counts as a position like any other.
const DEFAULT_MAX_AGE = 25;

// Single forward pass. For each candle: (1) advance the lifecycle of every
// still-open gap, (2) then try to form a new gap ending at this candle — so a
// gap is never updated by its own candle C (whose low/high IS the boundary).
export function computeFVGs(
  candles: Bar[],
  tf: Timeframe,
  upTo: number,
  opts: FVGOptions = {},
): FVG[] {
  if (isSessionTf(tf)) return []; // session TFs are not FVG timeframes
  const tfSec = TF_SECONDS[tf];
  const start = Math.max(0, candles.length - (opts.lookbackCandles ?? DEFAULT_LOOKBACK));
  const maxAge = opts.maxAgeCandles ?? DEFAULT_MAX_AGE;
  const out: FVG[] = [];
  const open: { g: FVG; cIdx: number }[] = []; // formed, not yet inverted/expired

  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const closed = c.t + tfSec <= upTo;

    for (let j = open.length - 1; j >= 0; j--) {
      const { g, cIdx } = open[j];
      // Expiry first: an over-age candle's prints no longer count for anything.
      if (i - cIdx > maxAge) {
        g.expiredAt = c.t;
        open.splice(j, 1);
        continue;
      }
      // Tap = a print STRICTLY inside the zone (an exact boundary touch is
      // not a tap — locked decision). Candle extremes are exact here because
      // aggregation preserves highs/lows.
      if (c.l < g.top && c.h > g.bottom) {
        if (g.tappedAt === null) g.tappedAt = c.t;
        const depth =
          g.dir === 'bull'
            ? (g.top - Math.max(c.l, g.bottom)) / (g.top - g.bottom)
            : (Math.min(c.h, g.top) - g.bottom) / (g.top - g.bottom);
        if (depth > g.fillPct) g.fillPct = depth;
      }
      // Inversion = own-TF candle CLOSES strictly beyond the far edge.
      // Independent of the overlap test above: a candle can gap clean over
      // the zone (weekend open) and still invert it by closing beyond.
      if (closed && (g.dir === 'bull' ? c.c < g.bottom : c.c > g.top)) {
        g.invertedAt = c.t + tfSec;
        open.splice(j, 1);
      }
    }

    // New gap ending at candle i. Requires C to be CLOSED — a forming candle
    // can show a gap that vanishes by close. i-2 may reach before `start`:
    // fine, those candles exist, they just weren't scanned as C candidates.
    if (closed && i >= 2) {
      const a = candles[i - 2];
      let g: FVG | null = null;
      if (c.l > a.h) {
        g = {
          tf, dir: 'bull', top: c.l, bottom: a.h,
          aT: a.t, bT: candles[i - 1].t, formedAt: c.t + tfSec,
          tappedAt: null, fillPct: 0, invertedAt: null, expiredAt: null,
        };
      } else if (c.h < a.l) {
        g = {
          tf, dir: 'bear', top: a.l, bottom: c.h,
          aT: a.t, bT: candles[i - 1].t, formedAt: c.t + tfSec,
          tappedAt: null, fillPct: 0, invertedAt: null, expiredAt: null,
        };
      }
      if (g) {
        out.push(g);
        open.push({ g, cIdx: i });
      }
    }
  }
  return out;
}

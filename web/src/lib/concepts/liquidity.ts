// Mechanical draws on liquidity (DOL) — the condition side of the MECH MODEL
// and MECH 2 bots, and a chart overlay concept. Pure module: callers feed
// bars/candles. (added 2026-08-12: 'mech-2' runs the same code with Infinity
// timers and `armFromSessionOpen`, so distance is its only death — see
// botStore's rulesOf and matchSweepTriggers below.)
//
// Level catalog at any time (9 toggleable categories):
//  - session H/L pairs from fixed ET windows, most recent COMPLETED window
//    per kind (may be yesterday's if today's hasn't closed yet):
//      asia 20:00–24:00 · london 02:00–05:00 · NY AM 09:30–11:00 · NY PM 13:00–16:00
//  - previous trading day H/L (pd) and previous trading week H/L (pw)
//  - swing H/L on 1h / 4h / 1D that aren't already one of the above
// A high is BUYSIDE liquidity, a low is SELLSIDE.
//
// Sweep logic (revised 2026-08-12 — supersedes the 2026-08-01 "arms at most
// once, death is terminal" lock): a print strictly beyond a level SWEEPS it
// — sweeping sellside (a low) arms LONGS, sweeping buyside (a high) arms
// SHORTS. A QUALIFYING RAID is a print beyond the level's watermark whose
// raid extreme is still within `invalidationPts` of the level. The FIRST
// qualifying raid arms the level and starts the RESWEEP VALIDITY WINDOW
// (`resweepWindowSec`, user spec 2026-08-12): a later qualifying raid re-arms
// — `sweptAt` moves to that bar, the deadline restarts and any prior death is
// erased — ONLY while it lands within `resweepWindowSec` of that FIRST sweep.
// The window is anchored at the first raid, NOT the latest, so a chain of
// deeper raids cannot walk it forward indefinitely. Once it passes, the level
// is no longer a valid DOL for this cycle: deeper raids only deepen the
// watermark, and whatever arming is already standing just lives out its
// normal deaths.
// Three ways an armed sweep dies:
//  - TIMER, per trigger timeframe: the inversion must land within
//    `maxCandles` candles OF THAT TIMEFRAME after the sweep (6 candles = 90s
//    on 15s, 6m on 1m, 30m on 5m);
//  - MINUTE CAP: an absolute ceiling from the sweep that overrides the
//    per-TF timer wherever it is shorter (20 min cap + 6 candles => 5m gets
//    4 candles, while 3m is untouched since 6×3 < 20);
//  - DISTANCE: price trading farther than `invalidationPts` from the level
//    in either direction — beyond it (the raid became a breakout) or away
//    from it (the reversal ran without a trigger).
// A death stands only until the next qualifying raid. The one death that IS
// effectively permanent needs no extra code: a BREAKOUT pushes the watermark
// more than `invalidationPts` past the level, and any deeper raid is farther
// still, so nothing can qualify again.
// The level itself dies once even the SLOWEST enabled trigger TF is out of
// time; the precise per-TF deadline is enforced at match time.
//
// A resweep is not recorded in SweepState — callers detect it by comparing
// states across a fold (`prev.sweptAt !== null && state.sweptAt > prev.sweptAt`)
// so the state stays a pure function of the bars it has seen.

import { bucketEnd } from '../replay/aggregate';
import { etOffsetSec, etWallToUtc } from '../time/et';
import { TF_SECONDS, isSessionTf, type Bar, type Timeframe } from '../types';
import {
  gapKey,
  inExecutionWindow,
  sessionOpenOf,
  type BiasDirection,
  type CandidateDraft,
  type ExecutionWindow,
  type TriggerOutcome,
  type TriggerResult,
} from './engine';
import type { FVG } from './fvg';

export type DOLSide = 'buyside' | 'sellside';
export type DOLKind =
  | 'pd'
  | 'pw'
  | 'asia'
  | 'london'
  | 'nyam'
  | 'nypm'
  | 'swing1h'
  | 'swing4h'
  | 'swing1d';

export const DOL_KINDS: readonly { kind: DOLKind; label: string }[] = [
  { kind: 'pd', label: 'PDH/PDL' },
  { kind: 'pw', label: 'PWH/PWL' },
  { kind: 'asia', label: 'Asia' },
  { kind: 'london', label: 'London' },
  { kind: 'nyam', label: 'NY AM' },
  { kind: 'nypm', label: 'NY PM' },
  { kind: 'swing1h', label: '1h swing' },
  { kind: 'swing4h', label: '4h swing' },
  { kind: 'swing1d', label: '1D swing' },
];
export const ALL_DOL_KINDS: DOLKind[] = DOL_KINDS.map((k) => k.kind);
export const isDOLKind = (v: unknown): v is DOLKind => ALL_DOL_KINDS.includes(v as DOLKind);

export interface DOLLevel {
  id: string; // stable identity across recomputes
  kind: DOLKind;
  side: DOLSide;
  price: number;
  formedAt: number; // when the level became knowable (window end / swing confirmation)
  label: string; // 'ASIA H', 'PDL', '1h SWG H', ...
}

export interface SweepState {
  wm: number; // deepest print beyond the level (== price while unswept)
  sweptAt: number | null; // 1m bar t of the MOST RECENT arming sweep (null = never armed)
  deadAt: number | null; // invalidation time; cleared by the next qualifying raid
  // 1m bar t of the level's FIRST arming sweep — the resweep window's anchor
  // (added 2026-08-12). Never reset: once the level has been swept, that
  // moment is what dates the whole cycle, however many resweeps follow.
  firstSweptAt: number | null;
}

// How long an armed sweep stays tradeable, per the two timer rules.
export interface SweepRules {
  invalidationPts: number;
  maxCandles: number; // candles of the trigger TF allowed to produce the inversion
  maxMinutes: number; // absolute cap from the sweep; overrides the above
  slowestTriggerSec: number; // largest ENABLED trigger TF, for whole-level death
  // Seconds after the FIRST sweep during which a deeper qualifying raid may
  // still re-arm the level (added 2026-08-12). Independent of the timers —
  // mech-2 has none and still honours this.
  resweepWindowSec: number;
}

export const DEFAULT_DOL_INVALIDATION_PTS = 40;
export const DEFAULT_SWEEP_MAX_CANDLES = 6;
export const DEFAULT_SWEEP_MAX_MINUTES = 20;
export const DEFAULT_RESWEEP_WINDOW_MINUTES = 30;

// Seconds a trigger on `tf` has after the sweep (candle rule ∧ minute cap).
export function triggerWindowSec(rules: SweepRules, tfSec: number): number {
  return Math.min(rules.maxCandles * tfSec, rules.maxMinutes * 60);
}
// Seconds before the LEVEL itself is out of time for every enabled TF.
export function levelLifespanSec(rules: SweepRules): number {
  return triggerWindowSec(rules, rules.slowestTriggerSec);
}

// ET wall-clock session windows [start, end) in seconds-of-day.
const SESSION_WINDOWS: Record<'asia' | 'london' | 'nyam' | 'nypm', { start: number; end: number; label: string }> = {
  asia: { start: 20 * 3600, end: 24 * 3600, label: 'ASIA' },
  london: { start: 2 * 3600, end: 5 * 3600, label: 'LDN' },
  nyam: { start: 9 * 3600 + 30 * 60, end: 11 * 3600, label: 'NYAM' },
  nypm: { start: 13 * 3600, end: 16 * 3600, label: 'NYPM' },
};

// highest TF first: a level shared by two TFs keeps the higher-TF identity
const SWING_TFS: readonly { tf: Timeframe; kind: DOLKind }[] = [
  { tf: '1D', kind: 'swing1d' },
  { tf: '4h', kind: 'swing4h' },
  { tf: '1h', kind: 'swing1h' },
];
const SWING_LOOKBACK = 60; // candles per TF
const DEDUPE_EPS = 0.25; // one tick — a swing equal to PDH/PWH IS that level

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
  const formedAt = bucketEnd(prev.t, tf); // always <= upTo (a later bucket is open)
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
  for (const { tf, kind } of SWING_TFS) {
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
          id: `${kind}:buyside:${c.t}`,
          kind,
          side: 'buyside',
          price: c.h,
          formedAt,
          label: `${tf} SWG H`,
        });
      }
      if (
        c.l < Math.min(candles[i - 1].l, candles[i + 1].l) &&
        c.l <= Math.min(candles[i - 2].l, candles[i + 2].l) &&
        !isDupe(c.l)
      ) {
        out.push({
          id: `${kind}:sellside:${c.t}`,
          kind,
          side: 'sellside',
          price: c.l,
          formedAt,
          label: `${tf} SWG L`,
        });
      }
    }
  }
  return out;
}

// The full DOL catalog at `upTo`.
//
// CACHED PER REPLAY HOUR (perf — this runs on every clock advance and every
// overlay render, and each uncached call aggregates the full visible history
// four times over). Every level's formedAt is a session-window end or an
// 1h/4h/1D/1W bucket end, and all of those land on whole ET hours — so the
// catalog is genuinely constant within an hour bucket. `gen` is the data
// source's generation: new/trimmed chunks change what's visible.
let levelCache: { hour: number; gen: number; levels: DOLLevel[] } | null = null;

export function levelsAt(src: LevelDataSource, upTo: number, gen = 0): DOLLevel[] {
  const hour = Math.floor(upTo / 3600);
  if (levelCache && levelCache.hour === hour && levelCache.gen === gen) return levelCache.levels;
  const out: DOLLevel[] = [
    ...prevBucketLevels(src, upTo, '1W', 'pw', 'PW'),
    ...prevBucketLevels(src, upTo, '1D', 'pd', 'PD'),
    ...sessionLevels(src, upTo, 'asia'),
    ...sessionLevels(src, upTo, 'london'),
    ...sessionLevels(src, upTo, 'nyam'),
    ...sessionLevels(src, upTo, 'nypm'),
  ];
  out.push(...swingLevels(src, upTo, out));
  levelCache = { hour, gen, levels: out };
  return out;
}

// Fold bars into a level's sweep state. Every qualifying raid (re)arms it
// (revised 2026-08-12); invalidation (timer, minute cap, or distance) stands
// until the next one — `deadAt` records WHEN so a trigger that confirmed
// before the death still counts.
export function foldSweep(
  level: DOLLevel,
  state: SweepState,
  bars: Bar[],
  rules: SweepRules,
  now: number,
): SweepState {
  let { wm, sweptAt, deadAt, firstSweptAt } = state;
  const buy = level.side === 'buyside';
  const lifespan = levelLifespanSec(rules);
  for (const bar of bars) {
    if (bar.t < level.formedAt) continue;
    const depth = buy ? bar.h : bar.l; // how far this bar raided past the level
    const beyondWm = buy ? depth > wm : depth < wm;
    // The raid must be a SWEEP, not a breakout: judged on the raid extreme
    // alone. (Judging the bar's whole range would let a wide reversal candle
    // — exactly the shape this setup wants — invalidate its own sweep.)
    const raidIsSweep = Math.abs(depth - level.price) <= rules.invalidationPts;
    // Straying is measured only on bars AFTER the arming one, so the sweep
    // candle's own excursion can't kill the state it just created.
    if (sweptAt !== null && deadAt === null && bar.t > sweptAt) {
      if (bar.t + 60 > sweptAt + lifespan) deadAt = sweptAt + lifespan; // out of time
      else if (bar.h > level.price + rules.invalidationPts || bar.l < level.price - rules.invalidationPts) {
        deadAt = bar.t; // ran away from the level, or blew through it
      }
    }
    // A qualifying raid (re)arms — a deeper raid restarts the deadline and
    // revives a level the timer or distance rule had killed. Ordered after
    // the death checks so a bar that both strays and raids deeper ends the
    // advance ARMED: the fresh raid is the state the model trades.
    //
    // RESWEEP VALIDITY WINDOW (added 2026-08-12): only the FIRST raid arms
    // unconditionally. A later one re-arms only within `resweepWindowSec` of
    // that first sweep — past it the level is spent for this cycle and a
    // deeper raid changes nothing but the watermark (which MUST still
    // advance below, or a breakout could never retire the level).
    if (beyondWm && raidIsSweep) {
      if (firstSweptAt === null) {
        firstSweptAt = bar.t;
        sweptAt = bar.t;
        deadAt = null;
      } else if (bar.t <= firstSweptAt + rules.resweepWindowSec) {
        sweptAt = bar.t;
        deadAt = null;
      }
    }
    if (beyondWm) wm = depth;
  }
  if (sweptAt !== null && deadAt === null && now > sweptAt + lifespan) deadAt = sweptAt + lifespan;
  return { wm, sweptAt, deadAt, firstSweptAt };
}

export const freshSweepState = (level: DOLLevel): SweepState => ({
  wm: level.price,
  sweptAt: null,
  deadAt: null,
  firstSweptAt: null,
});

export const isArmed = (s: SweepState): boolean => s.sweptAt !== null && s.deadAt === null;

// Rebuild all sweep states from loaded history (begin/resume/rewind). One
// bar slice is shared by every level — foldSweep skips pre-formation bars.
export function rebuildSweeps(
  src: LevelDataSource,
  levels: DOLLevel[],
  upTo: number,
  rules: SweepRules,
): Record<string, SweepState> {
  const out: Record<string, SweepState> = {};
  if (levels.length === 0) return out;
  let earliest = Infinity;
  for (const l of levels) earliest = Math.min(earliest, l.formedAt);
  const bars = src.barsInWindow(earliest - 60, upTo);
  for (const level of levels) {
    out[level.id] = foldSweep(level, freshSweepState(level), bars, rules, upTo);
  }
  return out;
}

// Display-only: which levels price has traded beyond since they formed.
// ONE pass over the shared bar slice (suffix extremes + a binary search per
// level) — the per-level scan this replaces cost ~30 slices per render.
export function sweptSet(levels: DOLLevel[], src: LevelDataSource, upTo: number): Set<string> {
  const out = new Set<string>();
  if (levels.length === 0) return out;
  let earliest = Infinity;
  for (const l of levels) earliest = Math.min(earliest, l.formedAt);
  const bars = src.barsInWindow(earliest - 60, upTo);
  const n = bars.length;
  if (n === 0) return out;
  const sufHigh = new Float64Array(n + 1);
  const sufLow = new Float64Array(n + 1);
  sufHigh[n] = -Infinity;
  sufLow[n] = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    sufHigh[i] = Math.max(bars[i].h, sufHigh[i + 1]);
    sufLow[i] = Math.min(bars[i].l, sufLow[i + 1]);
  }
  for (const l of levels) {
    let lo = 0,
      hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t < l.formedAt) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= n) continue;
    if (l.side === 'buyside' ? sufHigh[lo] > l.price : sufLow[lo] < l.price) out.add(l.id);
  }
  return out;
}

export interface ArmedSweep {
  level: DOLLevel;
  sweptAt: number;
  deadAt: number | null;
}

// trigger-TF ordering for the veto (session TFs never appear as triggers)
const tfRank = (tf: Timeframe): number => (isSessionTf(tf) ? 0 : TF_SECONDS[tf]);

// The mech model's trigger scan set (user spec 2026-08-12: "check 5m, 4m, 3m,
// 2m, 1m"). Sub-minute inversions are not a rebalance trigger for this model,
// so they're excluded even when the session has them enabled for the FVG bot.
export const MECH_TRIGGER_TFS: readonly Timeframe[] = ['1m', '2m', '3m', '4m', '5m'];

// Rule-3 assembly for the mech model: an IFVG inversion confirms against an
// armed sweep of the ALIGNED side — sweeping sellside (a low) hunts longs,
// sweeping buyside (a high) hunts shorts. No bias input: the sweep IS the
// directional read. Trigger-side mechanics (execution window, filled-gap
// veto across same-or-higher trigger TFs, resweep-cleared blockers, dedupe)
// match the FVG model — that veto is what makes "the HIGHEST-TF IFVG in the
// leg triggers" mechanical (revised 2026-08-12).
export function matchSweepTriggers(opts: {
  triggers: FVG[];
  sweeps: ArmedSweep[];
  rules: SweepRules;
  bars1m: Bar[];
  fired: ReadonlySet<string>;
  window?: ExecutionWindow;
  blockers?: FVG[];
  // Blockers a RESWEEP retired (gapKey set) — same machinery as the FVG
  // model: a deeper raid stales the triggers that were in play, so the gaps
  // vetoing them stop vetoing until price drives deeper into them.
  clearedBlockers?: ReadonlySet<string>;
  // In-session arming (added 2026-08-12 for 'mech-2'): only a sweep at/after
  // 09:30 ET of the CONFIRMATION's trading day can back a candidate — the
  // exact analog of the FVG model's session-tap rule, and it composes with
  // the watermark the same way: an overnight raid deepens `wm`, so the
  // in-session raid that (re)arms has to beat it, just as a premarket push
  // sets the level an in-session tap must penetrate beyond.
  armFromSessionOpen?: boolean;
  // optional diagnostics sink — every considered inversion appends one entry
  diag?: TriggerOutcome[];
}): CandidateDraft[] {
  const out: CandidateDraft[] = [];
  for (const trig of opts.triggers) {
    if (trig.invertedAt === null) continue;
    const confirmTs = trig.invertedAt;
    const direction: BiasDirection = trig.dir === 'bear' ? 'long' : 'short';
    const candidateId = `${trig.tf}:${trig.formedAt}:${direction}`;
    const note = (result: TriggerResult, blockedBy?: Timeframe) => {
      opts.diag?.push({ tf: trig.tf, formedAt: trig.formedAt, direction, confirmTs, result, blockedBy });
    };
    if (opts.fired.has(candidateId)) {
      note('duplicate');
      continue;
    }
    if (!inExecutionWindow(confirmTs, opts.window)) {
      note('window');
      continue;
    }

    const blocker = opts.blockers?.find(
      (b) =>
        !(b.tf === trig.tf && b.formedAt === trig.formedAt) &&
        !opts.clearedBlockers?.has(gapKey(b)) &&
        b.dir === trig.dir &&
        tfRank(b.tf) >= tfRank(trig.tf) &&
        b.formedAt <= confirmTs &&
        b.tappedAt !== null &&
        b.tappedAt <= confirmTs &&
        (b.invertedAt === null || b.invertedAt > confirmTs) &&
        (b.expiredAt === null || b.expiredAt > confirmTs),
    );
    if (blocker) {
      note('vetoed', blocker.tf);
      continue;
    }

    // This TF's own deadline: `maxCandles` of ITS candles, capped by the
    // absolute minute ceiling. A sweep that died earlier still counts for an
    // inversion that confirmed before the death.
    const deadlineSec = triggerWindowSec(opts.rules, tfRank(trig.tf));
    const wantSide: DOLSide = direction === 'long' ? 'sellside' : 'buyside';
    // With Infinity timers (mech-2) the deadline test is vacuous and the
    // distance rule in foldSweep is the only thing that kills an arming.
    const armFrom = opts.armFromSessionOpen ? sessionOpenOf(confirmTs) : -Infinity;
    const matched = opts.sweeps.filter(
      (s) =>
        s.level.side === wantSide &&
        s.sweptAt >= armFrom &&
        s.sweptAt <= confirmTs &&
        confirmTs <= s.sweptAt + deadlineSec &&
        (s.deadAt === null || confirmTs <= s.deadAt),
    );
    if (matched.length === 0) {
      // A stale overnight sweep reads as "no armed sweep" BY DESIGN: under
      // `armFromSessionOpen` the raid exists but cannot back a candidate, and
      // the diag vocabulary has no separate reason for it.
      note('no-sweep');
      continue;
    }
    // primary = the most EXTREME matched draw (revised 2026-08-12, supersedes
    // "the most recent raid"): a leg that ran through LDN H into PDH is a raid
    // on PDH, so the deepest liquidity the move reached is the draw the
    // candidate anchors on — highest price for shorts (buyside), lowest for
    // longs (sellside). It also settles the sequential case: sweep the London
    // low, then take out PDL below it with no trigger in between, and PDL is
    // the condition. Selection runs over `matched` ONLY, so a level that is
    // dead or past its deadline can never win however extreme it is. Tied
    // prices are practically impossible; reduce's first-wins is the tiebreak.
    // `stop` below still measures from primary.sweptAt — the raid-extreme
    // window follows whichever draw was chosen.
    const primary = matched.reduce((a, b) =>
      (wantSide === 'buyside' ? b.level.price > a.level.price : b.level.price < a.level.price) ? b : a,
    );

    // stop = raid extreme: lowest low (long) / highest high (short) from the
    // sweep bar through confirmation — includes the sweep wick itself
    let stop = direction === 'long' ? Infinity : -Infinity;
    let entryEst: number | null = null;
    for (const bar of opts.bars1m) {
      if (bar.t + 60 <= confirmTs) entryEst = bar.c;
      if (bar.t < primary.sweptAt || bar.t >= confirmTs) continue;
      stop = direction === 'long' ? Math.min(stop, bar.l) : Math.max(stop, bar.h);
    }
    if (!Number.isFinite(stop) || entryEst === null) {
      note('geometry');
      continue;
    }
    if (direction === 'long' ? stop >= entryEst : stop <= entryEst) {
      note('geometry');
      continue;
    }
    note('candidate');

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

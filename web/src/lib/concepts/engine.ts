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
// Arming invalidation reference (locked 2026-07-30, from the user's
// illustration): the leg extreme the retrace departed from — for a bear
// condition, the LOWEST LOW printed from the gap's candle A through the
// arming tap (mirror: highest high for bull). Price trading STRICTLY beyond
// it ("taking the low") invalidates the armed state: the move the setup was
// meant to catch has already run without a trigger. A later fresh tap
// re-arms with a new reference.
export function armingRef(bars: Bar[], dir: FVGDir, fromTs: number, toTs: number): number {
  let ref = dir === 'bear' ? Infinity : -Infinity;
  for (const b of bars) {
    if (b.t < fromTs || b.t > toTs) continue;
    ref = dir === 'bear' ? Math.min(ref, b.l) : Math.max(ref, b.h);
  }
  if (!Number.isFinite(ref)) return dir === 'bear' ? -Infinity : Infinity; // no data: unbreachable
  return ref;
}
export function refBreached(dir: FVGDir, ref: number, bar: Bar): boolean {
  return dir === 'bear' ? bar.l < ref : bar.h > ref;
}

// RESWEEP reference (locked 2026-08-06): the extreme of the bar that ARMED
// the condition — the low of the tap for a bull condition (price dipped in),
// the high for a bear one. Price returning through it is a deeper raid on
// the same condition, which stales every trigger that was in play: see
// botStore's resweep handling. Fixed at arm time (user decision); a fresh
// arming tap installs a new one.
//
// Note this is a DIFFERENT level from armingRef above, and points the other
// way: armingRef is the leg extreme whose breach means the move already ran
// (bull: the high), while this is the raid extreme (bull: the low).
export function resweepRef(bar: Bar, dir: FVGDir): number {
  return dir === 'bull' ? bar.l : bar.h;
}
export function resweepBreached(dir: FVGDir, ref: number, bar: Bar): boolean {
  return dir === 'bull' ? bar.l < ref : bar.h > ref;
}

// Fully mitigated (locked 2026-07-30): price has traded through the ENTIRE
// gap (watermark at the far edge). Terminal for condition use — it can never
// arm or re-arm, even without an inversion. (Triggers are unaffected: a full
// sweep before the inversion close is the normal IFVG sequence.)
export function isFullyMitigated(dir: FVGDir, watermark: number, top: number, bottom: number): boolean {
  return dir === 'bear' ? watermark >= top : watermark <= bottom;
}

// Would a candle closing HERE invert this gap? A bull gap inverts on a close
// below its bottom, a bear gap on a close above its top.
//
// Locked 2026-08-06: a fully mitigated gap (wicked through, never closed
// through) is STILL a usable condition — what disqualifies it is price
// sitting on the inverting side when the trigger fires. So a bull condition
// 25000–25500 still works with price at 25600, as long as the confirming
// close is above 25000. Inside the zone counts; beyond the FAR edge does
// not. This is checked at the trigger, not at arming, because a higher-
// timeframe gap only registers a real inversion on its OWN candle close —
// intrabar, price can sit through the edge without the gap being marked.
export function wouldInvert(dir: FVGDir, price: number, top: number, bottom: number): boolean {
  return dir === 'bull' ? price < bottom : price > top;
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
// Returns 0 when the trade CANNOT be sized — a non-positive risk budget (a
// blown account) or a degenerate stop distance. Returning the 0.1 floor for
// those, as this used to, hid a wiped balance behind a stream of tiny
// trades instead of stopping. Callers must treat 0 as "do not trade".
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
    if (riskUsd <= 0 || stopPts <= 0) return 0;
    ideal = riskUsd / (stopPts * pointValue);
  }
  if (!Number.isFinite(ideal) || ideal <= 0) return 0;
  return Math.max(0.1, Math.round(ideal * 10) / 10);
}

export interface ArmedCondition {
  gap: FVG;
  armedAt: number; // open time of the tapping 1m bar
}

// ---- trigger diagnostics ----
// Why a detected inversion did or didn't become a candidate. Every `continue`
// in matchTriggers records one of these, so the UI can answer "there WAS a 1m
// IFVG — why didn't the bot take it?" without re-deriving the rules.
export type TriggerResult =
  | 'candidate'
  | 'duplicate' // already shown once (dedupe key)
  | 'window' // confirmation landed outside the execution window
  | 'vetoed' // a filled same-or-higher trigger TF gap owns this move
  | 'no-bias' // no live bias entry in that direction
  | 'no-condition' // no armed condition FVG aligned at the confirmation
  | 'no-sweep' // mech model: no armed sweep of the aligned side inside its deadline
  | 'no-target' // mech bots: no unfilled 5m/15m gap to target (see liquidity.ts pickTarget)
  | 'geometry'; // stop on the wrong side of the estimated entry

export interface TriggerOutcome {
  tf: Timeframe;
  formedAt: number;
  direction: BiasDirection;
  confirmTs: number;
  result: TriggerResult;
  blockedBy?: Timeframe; // set when result === 'vetoed'
}

// The filled-gap veto evaluated as a STANDING condition rather than at an
// inversion: "if a `dir` gap on `tf` inverted right now, which same-or-higher
// timeframe would suppress it?" This is what makes the veto visible BEFORE a
// trigger fires — the case the user kept hitting with 1m inversions.
export function standingVeto(
  tf: Timeframe,
  dir: FVGDir,
  pool: FVG[],
  at: number,
  clearedBlockers?: ReadonlySet<string>,
): Timeframe | null {
  // No self-exclusion here (unlike the per-inversion check): this asks about
  // a hypothetical future inversion, and a filled SAME-TF gap blocks too.
  const hit = pool.find(
    (b) =>
      !clearedBlockers?.has(gapKey(b)) &&
      b.dir === dir &&
      tfSec(b.tf) >= tfSec(tf) &&
      b.formedAt <= at &&
      b.tappedAt !== null &&
      b.tappedAt <= at &&
      (b.invertedAt === null || b.invertedAt > at) &&
      (b.expiredAt === null || b.expiredAt > at),
  );
  return hit ? hit.tf : null;
}

// ---- resweep-cleared blockers (pure bookkeeping, extracted 2026-08-12) ----
// How deep price has driven into a gap, as an absolute price: the highest
// high for a bear zone (it fills upward), the lowest low for a bull one.
// Used as the re-arm watermark for a resweep-cleared blocker — it must be
// penetrated FURTHER than this to start vetoing again. The caller decides
// which bars count (the gap's life, a pre-resweep slice, ...); with no bars
// the answer is the gap's near edge, i.e. "never penetrated".
export function penetrationOf(g: FVG, bars: Bar[]): number {
  let ext = g.dir === 'bear' ? -Infinity : Infinity;
  for (const b of bars) ext = g.dir === 'bear' ? Math.max(ext, b.h) : Math.min(ext, b.l);
  return Number.isFinite(ext) ? ext : g.dir === 'bear' ? g.bottom : g.top;
}
export function penetratedBeyond(g: FVG, mark: number, bars: Bar[]): boolean {
  return bars.some((b) => (g.dir === 'bear' ? b.h > mark : b.l < mark));
}

// The cleared-blockers map after one advance: gapKey -> the penetration mark
// a retired blocker must be driven beyond before it vetoes again.
//
// Ordering bug fixed 2026-08-12 (user-reported). This bookkeeping used to run
// "retire on resweep" LAST, unconditionally, so ONE candle that simultaneously
// reswept a draw AND tapped deeper into a standing blocker retired that
// blocker with a mark equal to the penetration INCLUDING its own fresh tap —
// the resweep-clear beat the tap and the trigger fired.
//
// New rule (user decision 2026-08-12): **a resweep retires only vetoes that
// were standing BEFORE it.** The mark is the penetration as of the moment the
// resweep bar opens, and any penetration deeper than that AT OR AFTER the
// resweep bar re-establishes the veto — including inside the same advance.
//
// `bars` must span the pool gaps' lives up to `now` (each gap is clipped to
// its own formation below). Passing the whole window rather than just the new
// bars does not change step (2): a stored mark is already the deepest
// penetration reached when the entry was written, so only later bars can beat
// it.
export function updateClearedBlockers(opts: {
  cleared: Record<string, number>;
  pool: FVG[];
  resweeps: { dir: FVGDir; at: number }[]; // one per resweep seen this advance
  bars: Bar[];
  now: number;
}): Record<string, number> {
  const bars = opts.bars.filter((b) => b.t <= opts.now);
  const lifeOf = (g: FVG) => bars.filter((b) => b.t >= g.formedAt - 60);
  const byKey = new Map(opts.pool.map((g) => [gapKey(g), g]));
  const next: Record<string, number> = {};

  for (const [key, mark] of Object.entries(opts.cleared)) {
    const g = byKey.get(key);
    if (!g) continue; // (1) the gap left the pool (expired / out of lookback)
    // (2) RE-ARM: price has now driven deeper than it had when retired
    if (penetratedBeyond(g, mark, lifeOf(g))) continue;
    next[key] = mark;
  }

  // A direction that reswept more than once this advance is dated by its
  // LATEST raid — that is the resweep whose "standing before" applies.
  const latest = new Map<FVGDir, number>();
  for (const r of opts.resweeps) {
    const cur = latest.get(r.dir);
    if (cur === undefined || r.at > cur) latest.set(r.dir, r.at);
  }

  for (const g of opts.pool) {
    const at = latest.get(g.dir);
    if (at === undefined) continue; // (3) direction wasn't reswept
    if (g.tappedAt === null || g.invertedAt !== null || g.expiredAt !== null) continue;
    const key = gapKey(g);
    if (next[key] !== undefined) continue; // already cleared: keep the older mark
    const life = lifeOf(g);
    const mark = penetrationOf(
      g,
      life.filter((b) => b.t < at),
    );
    // (4) a fresh tap at/after the resweep bar re-establishes the veto
    if (
      penetratedBeyond(
        g,
        mark,
        life.filter((b) => b.t >= at),
      )
    ) {
      continue;
    }
    next[key] = mark;
  }
  return next;
}

// A draft carries ONE condition shape: `condition` (armed FVG — the FVG
// strategy) or `dol` (swept draw on liquidity — the mech model).
export interface CandidateDraft {
  candidateId: string;
  direction: BiasDirection;
  confirmTs: number;
  condition?: { tf: Timeframe; top: number; bottom: number; formedAt: number; armedAt: number; bT: number };
  otherConditions: Timeframe[];
  dol?: { kind: string; side: 'buyside' | 'sellside'; price: number; label: string; sweptAt: number };
  ifvg: { tf: Timeframe; top: number; bottom: number; formedAt: number; bT: number };
  stop: number;
  entryEst: number;
  // MECH BOTS ONLY (added 2026-08-12): the unfilled 5m/15m gap this candidate
  // targets — `tp` is its near edge, an ABSOLUTE price, not an R multiple.
  // Absent on FVG-strategy drafts, which keep the 1R target.
  target?: { tf: Timeframe; top: number; bottom: number; formedAt: number; bT: number; tp: number };
  biasId?: string; // FVG strategy only — the mech model derives direction from the sweep
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
  // Filled-gap veto (locked 2026-07-30, tightened same day: NO overlap
  // required): the full trigger-TF gap pool (any status). An inversion on
  // TF X is SUPPRESSED when ANY same-direction, active gap on a
  // SAME-OR-HIGHER trigger TF is in 'filled' status (tapped, not yet
  // inverted) at the confirmation — the execution belongs to the highest
  // timeframe still in play, so wait for it. Lower TFs never block (a
  // still-filled 4m can't veto a 5m close, which lands first by bucket
  // timing).
  blockers?: FVG[];
  // Blockers a RESWEEP has retired (gapKey set). They stop vetoing until
  // price penetrates them deeper than they had been filled when cleared —
  // the caller owns that watermark and drops the key when it re-arms.
  clearedBlockers?: ReadonlySet<string>;
  // optional diagnostics sink — every considered inversion appends one entry
  diag?: TriggerOutcome[];
}): CandidateDraft[] {
  const out: CandidateDraft[] = [];
  for (const trig of opts.triggers) {
    if (trig.invertedAt === null) continue;
    const confirmTs = trig.invertedAt;
    // a bearish gap inverting bullishly triggers a LONG; mirror for shorts
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
        !(b.tf === trig.tf && b.formedAt === trig.formedAt) && // not the trigger itself
        !opts.clearedBlockers?.has(gapKey(b)) && // retired by a resweep
        b.dir === trig.dir &&
        tfSec(b.tf) >= tfSec(trig.tf) && // same-or-higher TF (locked: same TF blocks too)
        b.formedAt <= confirmTs &&
        b.tappedAt !== null &&
        b.tappedAt <= confirmTs && // 'filled' at confirmation (unfilled never blocks)
        (b.invertedAt === null || b.invertedAt > confirmTs) &&
        (b.expiredAt === null || b.expiredAt > confirmTs),
    );
    if (blocker) {
      note('vetoed', blocker.tf);
      continue;
    }

    const bias = opts.biases.find((b) => b.direction === direction && biasAliveAt(b, confirmTs));
    if (!bias) {
      note('no-bias');
      continue;
    }

    // price at the trigger = last 1m close before the confirmation
    let entryEst: number | null = null;
    for (const bar of opts.bars1m) {
      if (bar.t + 60 <= confirmTs) entryEst = bar.c;
    }
    if (entryEst === null) {
      note('geometry');
      continue;
    }

    const wantDir = direction === 'long' ? 'bull' : 'bear';
    const sessionOpen = sessionOpenOf(confirmTs);
    const price = entryEst;
    const matched = opts.conditions.filter(
      ({ gap, armedAt }) =>
        gap.dir === wantDir &&
        armedAt >= sessionOpen &&
        armedAt <= confirmTs &&
        (gap.invertedAt === null || gap.invertedAt > confirmTs) &&
        (gap.expiredAt === null || gap.expiredAt > confirmTs) &&
        // price must not be sitting on the gap's inverting side right now —
        // this is what lets a FULLY MITIGATED (never closed through) gap keep
        // working as a condition
        !wouldInvert(gap.dir, price, gap.top, gap.bottom),
    );
    if (matched.length === 0) {
      note('no-condition');
      continue;
    }
    // primary condition = highest timeframe (matches "highest TF" instinct;
    // its tap anchors the retracement swing for the stop)
    const primary = matched.reduce((a, b) => (tfSec(b.gap.tf) > tfSec(a.gap.tf) ? b : a));

    // stop = retracement swing extreme (locked): lowest low (long) / highest
    // high (short) from the primary condition's tap bar through confirmation
    let stop = direction === 'long' ? Infinity : -Infinity;
    for (const bar of opts.bars1m) {
      if (bar.t < primary.armedAt || bar.t >= confirmTs) continue;
      stop = direction === 'long' ? Math.min(stop, bar.l) : Math.max(stop, bar.h);
    }
    if (!Number.isFinite(stop)) {
      note('geometry');
      continue;
    }
    // degenerate geometry (stop on the wrong side of the estimated entry)
    if (direction === 'long' ? stop >= entryEst : stop <= entryEst) {
      note('geometry');
      continue;
    }
    note('candidate');

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

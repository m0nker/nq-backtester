'use client';

// Bot-mode session store: drives the candidate engine (engine.ts) off the
// replay clock, exactly like the trading store drives fills. Owns: the bias
// list (bias_set/bias_removed events; deaths DERIVED from bars), condition
// arming, candidate prompting/queueing, and — depending on the session's
// candidate action — order placement (market entry carrying an absolute-stop
// bracket: SL at the swing extreme, TP at 1R from the actual fill; the fill
// pipeline spawns the OCO legs the moment the entry fills).
//
// Subscription order matters: this module imports the trading store, so the
// trading store's clock subscription registers FIRST and fills are already
// simulated for an advance by the time onAdvance here reads events.

import { create } from 'zustand';
import { botOfConfig } from '../bots/registry';
import { getBarsInWindow, lastVisibleBar, sources } from '../data/barSource';
import { updateSessionConfig } from '../data/sessions';
import { appendEvent, getEvents, getSessionId } from '../events/eventLog';
import type { SessionEvent } from '../events/types';
import { TF_SECONDS, isSessionTf, type Timeframe } from '../types';
import { useReplay } from '../replay/clock';
import { etWallToUtc, tradingDateOf } from '../time/et';
import { deriveState } from '../trading/engine';
import { roundToTick } from '../trading/contractMath';
import { useTrading } from '../trading/store';
import {
  armingRef,
  resweepBreached,
  resweepRef,
  standingVeto,
  DEFAULT_RISK,
  DEFAULT_WINDOW,
  gapKey,
  isFullyMitigated,
  matchTriggers,
  penetrationOf,
  refBreached,
  scanForTap,
  sessionOpenOf,
  sizeContracts,
  updateBiasDeaths,
  updateClearedBlockers,
  type ArmedCondition,
  type BiasEntry,
  type BiasDirection,
  type CandidateDraft,
  type ExecutionWindow,
  type RiskSettings,
  type TriggerOutcome,
} from './engine';
import { CONDITION_TFS, TRIGGER_TFS_ALL, computeFVGs, type FVG } from './fvg';
import {
  ALL_DOL_KINDS,
  DEFAULT_DOL_INVALIDATION_PTS,
  DEFAULT_RESWEEP_WINDOW_MINUTES,
  DEFAULT_SWEEP_MAX_CANDLES,
  DEFAULT_SWEEP_MAX_MINUTES,
  DEFAULT_TARGET_GAP_MAX_AGE_MINUTES,
  MECH_TRIGGER_TFS,
  TARGET_TFS,
  foldSweep,
  freshSweepState,
  isArmed,
  isDOLKind,
  levelsAt,
  matchSweepTriggers,
  pickTarget,
  rebuildSweeps,
  type ArmedSweep,
  type DOLKind,
  type DOLLevel,
  type LevelDataSource,
  type SweepRules,
  type SweepState,
} from './liquidity';

// Data adapter for the DOL level/sweep computations (NQ is the traded chart).
const dolSrc: LevelDataSource = {
  barsInWindow: (afterTs, upTo) => getBarsInWindow(afterTs, upTo),
  candles: (upTo, tf) => sources.NQ.getVisibleCandles(upTo, tf),
};

const tfSecOf = (tf: Timeframe): number => (isSessionTf(tf) ? 0 : TF_SECONDS[tf]);

// The enabled DOL categories at `upTo` (level catalog is cached per hour).
const dolLevelsFor = (upTo: number, kinds: DOLKind[]): DOLLevel[] =>
  levelsAt(dolSrc, upTo, sources.NQ.generation()).filter((l) => kinds.includes(l.kind));

// The DOL-bot family (added 2026-08-12): both run the sweep engine instead of
// the FVG condition/arming engine, so every condition-side branch keys off
// this — never off 'mech-model' alone, which now means the timer-bearing
// variant specifically (see rulesOf / trigTfsOf / the draft sort).
const isDolBot = (botId: string): boolean => botId === 'mech-model' || botId === 'mech-2';

const rulesOf = (s: {
  botId: string;
  dolInvalidationPts: number;
  sweepMaxCandles: number;
  sweepMaxMinutes: number;
  resweepWindowMinutes: number;
  triggerTfs: Timeframe[];
}): SweepRules => ({
  invalidationPts: s.dolInvalidationPts,
  // MECH 2 HAS NO TIMER (user spec 2026-08-12). Infinity flows through
  // triggerWindowSec/levelLifespanSec, so the deadline never fires anywhere —
  // foldSweep's DISTANCE rule (price beyond ±invalidationPts of the level) is
  // the only thing that can kill an armed sweep, and only a deeper qualifying
  // raid re-arms it. The candle/minute settings simply don't apply to it.
  maxCandles: s.botId === 'mech-2' ? Number.POSITIVE_INFINITY : s.sweepMaxCandles,
  maxMinutes: s.botId === 'mech-2' ? Number.POSITIVE_INFINITY : s.sweepMaxMinutes,
  // whole-level death waits for the slowest enabled trigger TF
  slowestTriggerSec: s.triggerTfs.reduce((m, tf) => Math.max(m, tfSecOf(tf)), 0),
  // NOT exempted for mech-2 (added 2026-08-12): the resweep window says how
  // long the LEVEL stays a valid draw after it is first raided, which is a
  // statement about the liquidity — not a trigger deadline — so both DOL bots
  // honour it even though mech-2 has no timers.
  resweepWindowSec: s.resweepWindowMinutes * 60,
});

// Which trigger TFs the RUNNING bot actually scans. The mech model looks at
// 5m–1m only (user spec 2026-08-12), so its scan is the enabled set narrowed
// to MECH_TRIGGER_TFS — narrowed, not replaced, because the per-TF toggles
// stay meaningful. A session that enables only sub-minute TFs therefore gives
// the mech model nothing to scan, which is what those toggles asked for.
// 'mech-2' does NOT narrow: it copies the FVG bot's full enabled trigger list.
const trigTfsOf = (s: { botId: string; triggerTfs: Timeframe[] }): Timeframe[] =>
  s.botId === 'mech-model' ? s.triggerTfs.filter((tf) => MECH_TRIGGER_TFS.includes(tf)) : s.triggerTfs;

export type CandidateAction = 'prompt-trade' | 'label-only' | 'auto';

// Defaults for the candle-distance settings (all user-adjustable).
const DEFAULT_GAP_MAX_AGE = 25; // doc §2.3 locked default
const CONDITION_LOOKBACK = 40; // expiry + margin — active gaps only
const TRIGGER_LOOKBACK = 60;
// A lookback shorter than the expiry would silently cap it (the gap would
// drop out of the scan before it aged out), so floor it with margin.
const effLookback = (lookback: number, maxAge: number) => Math.max(lookback, maxAge + 10);

// Position-size guards. Size is proportional to 1/stopPts, so a stop that
// has collapsed toward zero by placement time produces an unbounded
// position — see placeTrade for the incident these defend against.
const DEFAULT_MIN_STOP_PTS = 5;
const DEFAULT_MAX_CONTRACTS = 10;

let nextBotId = 1;
const bid = () => `b${nextBotId++}-${Date.now().toString(36)}`;

let hopBusy = false; // a window-hop jump is in flight

const refreshTrading = () => useTrading.setState({ derived: deriveState(getEvents()) });

// Bot settings: kept in localStorage as the defaults for NEW sessions, and
// mirrored into the session's config JSONB (best-effort) so resume restores
// what this session actually ran with.
export interface BotSettings {
  action: CandidateAction;
  window: ExecutionWindow;
  risk: RiskSettings;
  hopWindows: boolean;
  onePosition: boolean; // don't look for candidates while a trade is on
  triggerTfs: Timeframe[]; // which IFVG timeframes the trigger scan considers
  // ---- mech bots (mech-model / mech-2) ----
  dolInvalidationPts: number; // armed sweep dies past this distance from the level
  sweepMaxCandles: number; // candles (of each trigger TF) allowed to invert (mech-model only)
  sweepMaxMinutes: number; // absolute ceiling from the sweep; overrides the above (mech-model only)
  resweepWindowMinutes: number; // resweeps re-arm only this long after the FIRST sweep
  targetGapMaxAgeMinutes: number; // a target 5m/15m gap must have formed this recently
  dolKinds: DOLKind[]; // which draw-on-liquidity categories can be traded
  // ---- candle-distance bounds (both bots) ----
  gapMaxAgeCandles: number; // a gap expires this many candles of ITS OWN tf after forming
  conditionLookbackCandles: number; // how far back the condition scan looks
  triggerLookbackCandles: number; // how far back the trigger scan looks
  // ---- position-size guards ----
  minStopPts: number; // no trade when the stop is closer than this to entry
  maxContracts: number; // hard ceiling on a bot position
}
const SETTINGS_KEY = 'bot-settings-v1';
const DEFAULT_SETTINGS: BotSettings = {
  action: 'prompt-trade',
  window: DEFAULT_WINDOW,
  risk: DEFAULT_RISK,
  hopWindows: false,
  onePosition: true,
  triggerTfs: [...TRIGGER_TFS_ALL],
  dolInvalidationPts: DEFAULT_DOL_INVALIDATION_PTS,
  sweepMaxCandles: DEFAULT_SWEEP_MAX_CANDLES,
  sweepMaxMinutes: DEFAULT_SWEEP_MAX_MINUTES,
  resweepWindowMinutes: DEFAULT_RESWEEP_WINDOW_MINUTES,
  targetGapMaxAgeMinutes: DEFAULT_TARGET_GAP_MAX_AGE_MINUTES,
  dolKinds: [...ALL_DOL_KINDS],
  gapMaxAgeCandles: DEFAULT_GAP_MAX_AGE,
  conditionLookbackCandles: CONDITION_LOOKBACK,
  triggerLookbackCandles: TRIGGER_LOOKBACK,
  minStopPts: DEFAULT_MIN_STOP_PTS,
  maxContracts: DEFAULT_MAX_CONTRACTS,
};
const validDolKinds = (v: unknown): DOLKind[] => {
  const list = Array.isArray(v) ? v.filter(isDOLKind) : [];
  return list.length > 0 ? list : [...ALL_DOL_KINDS];
};
const posNum = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
const validTriggerTfs = (v: unknown): Timeframe[] => {
  const list = Array.isArray(v) ? v.filter((tf): tf is Timeframe => TRIGGER_TFS_ALL.includes(tf as Timeframe)) : [];
  return list.length > 0 ? list : [...TRIGGER_TFS_ALL];
};
function loadSettings(): BotSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const p = JSON.parse(raw) as Partial<BotSettings>;
    return {
      action: p.action ?? DEFAULT_SETTINGS.action,
      window: { ...DEFAULT_WINDOW, ...p.window },
      risk: { ...DEFAULT_RISK, ...p.risk },
      hopWindows: p.hopWindows ?? false,
      onePosition: p.onePosition ?? true,
      triggerTfs: validTriggerTfs(p.triggerTfs),
      dolInvalidationPts: posNum(p.dolInvalidationPts, DEFAULT_DOL_INVALIDATION_PTS),
      sweepMaxCandles: posNum(p.sweepMaxCandles, DEFAULT_SWEEP_MAX_CANDLES),
      sweepMaxMinutes: posNum(p.sweepMaxMinutes, DEFAULT_SWEEP_MAX_MINUTES),
      resweepWindowMinutes: posNum(p.resweepWindowMinutes, DEFAULT_RESWEEP_WINDOW_MINUTES),
      targetGapMaxAgeMinutes: posNum(p.targetGapMaxAgeMinutes, DEFAULT_TARGET_GAP_MAX_AGE_MINUTES),
      dolKinds: validDolKinds(p.dolKinds),
      gapMaxAgeCandles: posNum(p.gapMaxAgeCandles, DEFAULT_GAP_MAX_AGE),
      conditionLookbackCandles: posNum(p.conditionLookbackCandles, CONDITION_LOOKBACK),
      triggerLookbackCandles: posNum(p.triggerLookbackCandles, TRIGGER_LOOKBACK),
      minStopPts: posNum(p.minStopPts, DEFAULT_MIN_STOP_PTS),
      maxContracts: posNum(p.maxContracts, DEFAULT_MAX_CONTRACTS),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
function persistSettings(s: BotSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // storage blocked — settings just won't carry to new sessions
  }
  const id = getSessionId();
  if (id) {
    void updateSessionConfig(id, {
      candidateAction: s.action,
      windowStartSec: s.window.startSec,
      windowEndSec: s.window.endSec,
      risk: s.risk,
      hopWindows: s.hopWindows,
      onePosition: s.onePosition,
      triggerTfs: s.triggerTfs,
      dolInvalidationPts: s.dolInvalidationPts,
      sweepMaxCandles: s.sweepMaxCandles,
      sweepMaxMinutes: s.sweepMaxMinutes,
      resweepWindowMinutes: s.resweepWindowMinutes,
      targetGapMaxAgeMinutes: s.targetGapMaxAgeMinutes,
      dolKinds: s.dolKinds,
      gapMaxAgeCandles: s.gapMaxAgeCandles,
      conditionLookbackCandles: s.conditionLookbackCandles,
      triggerLookbackCandles: s.triggerLookbackCandles,
      minStopPts: s.minStopPts,
      maxContracts: s.maxContracts,
    });
  }
}

const currentSettings = (s: {
  action: CandidateAction;
  window: ExecutionWindow;
  risk: RiskSettings;
  hopWindows: boolean;
  onePosition: boolean;
  triggerTfs: Timeframe[];
  dolInvalidationPts: number;
  sweepMaxCandles: number;
  sweepMaxMinutes: number;
  resweepWindowMinutes: number;
  targetGapMaxAgeMinutes: number;
  dolKinds: DOLKind[];
  gapMaxAgeCandles: number;
  conditionLookbackCandles: number;
  triggerLookbackCandles: number;
  minStopPts: number;
  maxContracts: number;
}): BotSettings => ({
  action: s.action,
  window: s.window,
  risk: s.risk,
  hopWindows: s.hopWindows,
  onePosition: s.onePosition,
  triggerTfs: s.triggerTfs,
  dolInvalidationPts: s.dolInvalidationPts,
  sweepMaxCandles: s.sweepMaxCandles,
  sweepMaxMinutes: s.sweepMaxMinutes,
  resweepWindowMinutes: s.resweepWindowMinutes,
  targetGapMaxAgeMinutes: s.targetGapMaxAgeMinutes,
  dolKinds: s.dolKinds,
  gapMaxAgeCandles: s.gapMaxAgeCandles,
  conditionLookbackCandles: s.conditionLookbackCandles,
  triggerLookbackCandles: s.triggerLookbackCandles,
  minStopPts: s.minStopPts,
  maxContracts: s.maxContracts,
});

// settings from a resumed session's config row, falling back to local defaults
function settingsFromConfig(config: Record<string, unknown> | undefined): BotSettings {
  const local = loadSettings();
  if (!config) return local;
  const ws = config.windowStartSec;
  const we = config.windowEndSec;
  return {
    action: (config.candidateAction as CandidateAction) ?? local.action,
    window:
      typeof ws === 'number' && typeof we === 'number' ? { startSec: ws, endSec: we } : local.window,
    risk: { ...local.risk, ...(config.risk as Partial<RiskSettings> | undefined) },
    hopWindows: typeof config.hopWindows === 'boolean' ? config.hopWindows : local.hopWindows,
    onePosition: typeof config.onePosition === 'boolean' ? config.onePosition : local.onePosition,
    triggerTfs: config.triggerTfs !== undefined ? validTriggerTfs(config.triggerTfs) : local.triggerTfs,
    dolInvalidationPts: posNum(config.dolInvalidationPts, local.dolInvalidationPts),
    sweepMaxCandles: posNum(config.sweepMaxCandles, local.sweepMaxCandles),
    sweepMaxMinutes: posNum(config.sweepMaxMinutes, local.sweepMaxMinutes),
    resweepWindowMinutes: posNum(config.resweepWindowMinutes, local.resweepWindowMinutes),
    targetGapMaxAgeMinutes: posNum(config.targetGapMaxAgeMinutes, local.targetGapMaxAgeMinutes),
    dolKinds: config.dolKinds !== undefined ? validDolKinds(config.dolKinds) : local.dolKinds,
    gapMaxAgeCandles: posNum(config.gapMaxAgeCandles, local.gapMaxAgeCandles),
    conditionLookbackCandles: posNum(config.conditionLookbackCandles, local.conditionLookbackCandles),
    triggerLookbackCandles: posNum(config.triggerLookbackCandles, local.triggerLookbackCandles),
    minStopPts: posNum(config.minStopPts, local.minStopPts),
    maxContracts: posNum(config.maxContracts, local.maxContracts),
  };
}

export interface ArmedState {
  t: number; // arming 1m bar open time
  ref: number; // leg extreme — breaching it INVALIDATES the arm
  swept: number; // the arming tap's own extreme — breaching it is a RESWEEP
  reswept: boolean; // the resweep already fired for this arming
}

// Data-bound wrapper over engine.penetrationOf: how deep price has driven
// into a gap over its whole life up to `upTo`. (The bookkeeping itself is the
// pure engine.updateClearedBlockers — extracted 2026-08-12.)
const penetrationAt = (g: FVG, upTo: number): number =>
  penetrationOf(g, getBarsInWindow(g.formedAt - 60, upTo));

// ---- live scope (what the bot is looking at RIGHT NOW) ----
// Rebuilt every advance so the UI can answer "there's a 1m IFVG on my screen,
// why isn't the bot taking it?" without the user re-deriving the rules.
export interface ScopeZone {
  tf: Timeframe;
  dir: 'bull' | 'bear';
  top: number;
  bottom: number;
  bT: number; // box left edge
  armedAt?: number; // conditions only
}
export interface ScopeTrigger {
  tf: Timeframe;
  // A same-or-higher TF gap that WOULD veto an inversion right now, per
  // direction. This is the standing veto — visible before anything fires.
  blockedLong: Timeframe | null;
  blockedShort: Timeframe | null;
  live: number; // active gaps on this TF currently in play (any status)
  cleared: number; // gaps on this TF a resweep retired (not vetoing)
  last: TriggerOutcome | null; // most recent inversion this TF produced
}
export interface ScopeSweep {
  label: string;
  price: number;
  side: 'buyside' | 'sellside';
  sweptAt: number;
}
// The closest valid unfilled 5m/15m target per side, for the scope panel
// (mech bots only — null for the FVG strategy, which targets 1R).
export interface ScopeTarget {
  tf: Timeframe;
  tp: number; // near edge = where the TP would sit
  ageMin: number; // minutes since the gap formed
}
export interface BotScope {
  at: number; // market time this snapshot describes
  dormant: 'position' | null; // one-position gate: not scanning at all
  conditions: ScopeZone[]; // armed condition FVGs (FVG strategy)
  sweeps: ScopeSweep[]; // armed draws on liquidity (mech bots)
  inPlay: ScopeZone[]; // trigger-TF gaps that could still invert into a setup
  triggers: ScopeTrigger[];
  targets: { long: ScopeTarget | null; short: ScopeTarget | null } | null;
}

interface BotState {
  active: boolean;
  botId: string; // which bot runs this session ('fvg-strategy' | 'mech-model' | 'mech-2')
  scope: BotScope | null;
  action: CandidateAction;
  biases: BiasEntry[];
  // gapKey -> armed state. t = arming 1m bar open time; ref = the leg extreme
  // whose breach ("taking the low") invalidates the arm; swept = the arming
  // TAP's own extreme, whose breach is a RESWEEP; reswept = that already
  // fired for this arming (edge-triggered, see onAdvance).
  armed: Record<string, ArmedState>;
  // gapKey of a trigger gap -> how deep price had penetrated it when a
  // resweep retired it. It stops vetoing until price goes deeper than this.
  clearedTriggers: Record<string, number>;
  watermarks: Record<string, number>; // gapKey -> deepest fill price since formation
  sweeps: Record<string, SweepState>; // mech bots: DOL levelId -> sweep state
  fired: Record<string, number>; // candidateId -> confirmTs (already shown)
  pending: CandidateDraft | null; // prompt currently on screen
  queue: CandidateDraft[];
  wasPlaying: boolean;
  armedCount: number; // HUD (armed condition FVGs / armed sweeps)
  window: ExecutionWindow; // execution window (bot setting)
  risk: RiskSettings; // bot position sizing (bot setting)
  hopWindows: boolean; // auto-jump between active windows when idle
  onePosition: boolean; // one trade at a time: dormant until the book is clean
  triggerTfs: Timeframe[]; // which IFVG timeframes the trigger scan considers
  dolInvalidationPts: number; // mech bots: sweep invalidation distance
  sweepMaxCandles: number; // mech-model: candles per trigger TF to invert
  sweepMaxMinutes: number; // mech-model: absolute minute ceiling from the sweep
  resweepWindowMinutes: number; // mech bots: how long resweeps stay valid after the first sweep
  targetGapMaxAgeMinutes: number; // mech bots: max age of the unfilled 5m/15m target gap
  dolKinds: DOLKind[]; // mech bots: tradeable draw-on-liquidity categories
  gapMaxAgeCandles: number; // gap expiry, in candles of its own timeframe
  conditionLookbackCandles: number;
  triggerLookbackCandles: number;
  minStopPts: number; // refuse a trade whose stop is closer than this
  maxContracts: number; // hard ceiling on a bot position

  begin: (botId?: string) => void; // settings come from localStorage defaults
  resume: (events: SessionEvent[], upTo: number, config?: Record<string, unknown>) => void;
  deactivate: () => void;
  setAction: (a: CandidateAction) => void;
  setWindow: (w: ExecutionWindow) => void;
  setRisk: (r: RiskSettings) => void;
  setHopWindows: (v: boolean) => void;
  setOnePosition: (v: boolean) => void;
  toggleTriggerTf: (tf: Timeframe) => void;
  setDolInvalidationPts: (v: number) => void;
  setSweepMaxCandles: (v: number) => void;
  setSweepMaxMinutes: (v: number) => void;
  setResweepWindowMinutes: (v: number) => void;
  setTargetGapMaxAgeMinutes: (v: number) => void;
  toggleDolKind: (k: DOLKind) => void;
  setScanBound: (k: 'gapMaxAgeCandles' | 'conditionLookbackCandles' | 'triggerLookbackCandles', v: number) => void;
  setSizeGuard: (k: 'minStopPts' | 'maxContracts', v: number) => void;
  addBias: (direction: BiasDirection, until: number) => void;
  removeBias: (biasId: string) => void;
  submitDecision: (decision: 'take' | 'marginal' | 'skip', notes: string) => void;
  nextDay: () => Promise<void>;
  onAdvance: (from: number, to: number) => void;
  onRewind: (from: number, to: number) => void;
}

// Candle-distance bounds for a scan (user-adjustable; see BotSettings).
export interface ScanBounds {
  maxAge: number;
  condLookback: number;
  trigLookback: number;
}
const DEFAULT_BOUNDS: ScanBounds = {
  maxAge: DEFAULT_GAP_MAX_AGE,
  condLookback: CONDITION_LOOKBACK,
  trigLookback: TRIGGER_LOOKBACK,
};
const boundsOf = (s: {
  gapMaxAgeCandles: number;
  conditionLookbackCandles: number;
  triggerLookbackCandles: number;
}): ScanBounds => ({
  maxAge: s.gapMaxAgeCandles,
  condLookback: s.conditionLookbackCandles,
  trigLookback: s.triggerLookbackCandles,
});

// Trigger-timeframe gap pool under the given bounds.
const triggerGapsAt = (upTo: number, tfs: Timeframe[], b: ScanBounds): FVG[] => {
  const look = effLookback(b.trigLookback, b.maxAge);
  const out: FVG[] = [];
  for (const tf of tfs) {
    out.push(
      ...computeFVGs(sources.NQ.getRecentCandles(upTo, tf, look + 5), tf, upTo, {
        lookbackCandles: look,
        maxAgeCandles: b.maxAge,
      }),
    );
  }
  return out;
};

// Condition-timeframe gap pool. `tfs` narrows it — the mech bots reuse this
// same clock-clipped, windowed machinery for the 5m/15m TARGET scan (added
// 2026-08-12) rather than growing a second gap pipeline.
const conditionGapsAt = (
  upTo: number,
  b: ScanBounds = DEFAULT_BOUNDS,
  tfs: readonly Timeframe[] = CONDITION_TFS,
): FVG[] => {
  const look = effLookback(b.condLookback, b.maxAge);
  const out: FVG[] = [];
  for (const tf of tfs) {
    out.push(
      ...computeFVGs(sources.NQ.getRecentCandles(upTo, tf, look + 5), tf, upTo, {
        lookbackCandles: look,
        maxAgeCandles: b.maxAge,
      }),
    );
  }
  return out;
};

// Arm from scratch (used at begin/resume/rewind; steps arm incrementally
// from new bars). Locked rules (2026-07-30):
// - session-tap: arming needs a bar at/after 09:30 ET of the current trading
//   day — at 09:29 nothing is armed;
// - fill-watermark: the arming print must penetrate deeper than the gap's
//   deepest prior fill (a premarket push sets the level to beat);
// - fully mitigated (whole zone traded through) = never a condition;
// - arming invalidation: taking the leg extreme (the pre-tap low for bear,
//   high for bull) disarms; a later fresh beyond-watermark tap re-arms with
//   a NEW reference (the user's two-cycle illustration). The rebuild walks
//   arm -> breach -> re-arm sequences historically.
const rebuildArming = (
  upTo: number,
  bounds: ScanBounds = DEFAULT_BOUNDS,
): { armed: Record<string, ArmedState>; watermarks: Record<string, number> } => {
  const armed: Record<string, ArmedState> = {};
  const watermarks: Record<string, number> = {};
  const sessionOpen = sessionOpenOf(upTo);
  for (const g of conditionGapsAt(upTo, bounds)) {
    const zone = { dir: g.dir, top: g.top, bottom: g.bottom };
    // life-wide watermark (also decides full mitigation, which is terminal)
    const fullWm = scanForTap({
      ...zone,
      bars: getBarsInWindow(g.formedAt - 60, upTo),
      fromTs: g.formedAt,
      armFromTs: sessionOpen,
      alreadyArmed: true,
    }).watermark;
    watermarks[gapKey(g)] = fullWm;
    if (g.invertedAt !== null || g.expiredAt !== null) continue;
    // NOTE: full mitigation is deliberately NOT a skip anymore (2026-08-06).
    // A gap wicked through but never closed through is still a condition;
    // what disqualifies it is price sitting on its inverting side when the
    // trigger fires, which matchTriggers checks. (It still can't ARM from
    // scratch once fully mitigated — the watermark sits at the far edge, so
    // no print can go beyond it.)

    let cursor = g.formedAt;
    let wm: number | undefined;
    for (;;) {
      const scan = scanForTap({
        ...zone,
        bars: getBarsInWindow(cursor - 60, upTo),
        fromTs: cursor,
        armFromTs: sessionOpen,
        watermark: wm,
      });
      if (!scan.armedBar) break;
      const t = scan.armedBar.t;
      const ref = armingRef(getBarsInWindow(g.aT - 60, t + 60), g.dir, g.aT, t);
      const breachBar = getBarsInWindow(t, upTo).find((b) => b.t > t && refBreached(g.dir, ref, b));
      if (!breachBar) {
        const swept = resweepRef(scan.armedBar, g.dir);
        // replay whether the resweep already fired during this arming
        const reswept = getBarsInWindow(t, upTo).some(
          (b) => b.t > t && resweepBreached(g.dir, swept, b),
        );
        armed[gapKey(g)] = { t, ref, swept, reswept };
        break;
      }
      // invalidated: resume the hunt after the breach, with the watermark as
      // of the breach (NOT life-wide — that would self-block the re-tap)
      cursor = breachBar.t + 60;
      wm = scanForTap({
        ...zone,
        bars: getBarsInWindow(g.formedAt - 60, breachBar.t + 60),
        fromTs: g.formedAt,
        armFromTs: sessionOpen,
        alreadyArmed: true,
      }).watermark;
    }
  }
  return { armed, watermarks };
};

// Rebuild the bias list from the event log, honoring rewind voiding the same
// way the trading reducer does: a time_rewound event voids prior bias
// actions with a later market time.
const biasesFromEvents = (events: SessionEvent[]): BiasEntry[] => {
  let list: BiasEntry[] = [];
  for (const ev of events) {
    if (ev.type === 'bias_set') {
      const p = ev.payload as { biasId: string; direction: BiasDirection; until: number };
      list.push({ id: p.biasId, direction: p.direction, until: p.until, setTs: ev.tsMarket, deadAt: null });
    } else if (ev.type === 'bias_removed') {
      const p = ev.payload as { biasId: string };
      list = list.filter((b) => b.id !== p.biasId);
    } else if (ev.type === 'time_rewound') {
      const p = ev.payload as { to: number };
      list = list.filter((b) => b.setTs <= p.to);
    }
  }
  return list;
};

const firedFromEvents = (events: SessionEvent[]): Record<string, number> => {
  let fired: Record<string, number> = {};
  for (const ev of events) {
    if (ev.type === 'candidate_shown') {
      const p = ev.payload as { candidateId: string; confirmTs: number };
      fired[p.candidateId] = p.confirmTs;
    } else if (ev.type === 'time_rewound') {
      const p = ev.payload as { to: number };
      fired = Object.fromEntries(Object.entries(fired).filter(([, ts]) => ts <= p.to));
    }
  }
  return fired;
};

// The closest valid target per side AT `to`, judged against the last visible
// close (the stand-in for the entry the panel can't know yet). Returns null
// for non-mech sessions — those keep the 1R target and have no TARGETS row.
const targetScopeAt = (
  to: number,
  maxAgeSec: number,
  bounds: ScanBounds,
): BotScope['targets'] => {
  const entry = lastVisibleBar(to)?.c;
  if (entry === undefined) return { long: null, short: null };
  const gaps = conditionGapsAt(to, bounds, TARGET_TFS);
  const pick = (direction: BiasDirection): ScopeTarget | null => {
    const t = pickTarget({ gaps, direction, entry, at: to, maxAgeSec });
    return t ? { tf: t.tf, tp: t.tp, ageMin: Math.max(0, Math.round((to - t.formedAt) / 60)) } : null;
  };
  return { long: pick('long'), short: pick('short') };
};

// Scope snapshot WITHOUT running a trigger match — used at begin/resume/
// rewind so the panel is populated the moment a session opens, instead of
// looking broken until the first advance. onAdvance builds the richer
// version (it also has the just-computed match diagnostics).
function snapshotScope(
  to: number,
  conditions: ArmedCondition[],
  sweeps: ScopeSweep[],
  triggerTfs: Timeframe[],
  dormant: 'position' | null,
  bounds: ScanBounds,
  targets: BotScope['targets'] = null,
): BotScope {
  const pool: FVG[] = dormant ? [] : triggerGapsAt(to, triggerTfs, bounds);
  return {
    at: to,
    dormant,
    sweeps,
    targets,
    conditions: conditions
      .filter(({ gap }) => gap.invertedAt === null && gap.expiredAt === null)
      .map(({ gap, armedAt }) => ({
        tf: gap.tf,
        dir: gap.dir,
        top: gap.top,
        bottom: gap.bottom,
        bT: gap.bT,
        armedAt,
      })),
    inPlay: pool
      .filter((g) => g.invertedAt === null && g.expiredAt === null && g.tappedAt !== null)
      .map((g) => ({ tf: g.tf, dir: g.dir, top: g.top, bottom: g.bottom, bT: g.bT })),
    triggers: triggerTfs.map((tf) => ({
      tf,
      blockedLong: dormant ? null : standingVeto(tf, 'bear', pool, to),
      blockedShort: dormant ? null : standingVeto(tf, 'bull', pool, to),
      live: pool.filter((g) => g.tf === tf && g.invertedAt === null && g.expiredAt === null).length,
      cleared: 0,
      last: null,
    })),
  };
}

// Rebuild the resweep-cleared blocker set (begin/resume/rewind). A condition
// whose resweep already fired historically must come back with its blockers
// still retired, or a resumed session would veto trades the live run took.
const clearedFromArming = (
  armed: Record<string, ArmedState>,
  condGaps: FVG[],
  triggerTfs: Timeframe[],
  upTo: number,
  bounds: ScanBounds,
): Record<string, number> => {
  const dirs = new Set<FVG['dir']>();
  for (const g of condGaps) {
    if (armed[gapKey(g)]?.reswept) dirs.add(g.dir === 'bull' ? 'bear' : 'bull');
  }
  const out: Record<string, number> = {};
  if (dirs.size === 0) return out;
  for (const g of triggerGapsAt(upTo, triggerTfs, bounds)) {
    if (!dirs.has(g.dir)) continue;
    if (g.tappedAt === null || g.invertedAt !== null || g.expiredAt !== null) continue;
    out[gapKey(g)] = penetrationAt(g, upTo);
  }
  return out;
};

// Armed condition list from an armed-map + the gaps it refers to.
const conditionsFrom = (
  armed: Record<string, { t: number; ref: number }>,
  gaps: FVG[],
): ArmedCondition[] => {
  const out: ArmedCondition[] = [];
  for (const g of gaps) {
    const at = armed[gapKey(g)];
    if (at !== undefined) out.push({ gap: g, armedAt: at.t });
  }
  return out;
};

export const useBot = create<BotState>((set, get) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // debug handle — stripped from production builds
    (window as unknown as Record<string, unknown>).__bot = { get: () => get() };
  }
  const now = () => useReplay.getState().currentTime ?? 0;

  const logCandidate = (draft: CandidateDraft) => {
    appendEvent('candidate_shown', draft.confirmTs, {
      candidateId: draft.candidateId,
      direction: draft.direction,
      confirmTs: draft.confirmTs,
      condition: draft.condition,
      otherConditions: draft.otherConditions,
      dol: draft.dol,
      // NOTE: draft.target is not logged — the candidate_shown payload shape
      // lives in events/types.ts, outside this change's scope.
      ifvg: draft.ifvg,
      stop: draft.stop,
      entryEst: draft.entryEst,
      biasId: draft.biasId,
    });
    set((s) => ({ fired: { ...s.fired, [draft.candidateId]: draft.confirmTs } }));
  };

  // Taking a trade UNARMS every same-direction armed condition (locked
  // 2026-07-30): a long execution clears all bullish armed FVGs — for the
  // mech model, all armed SELLSIDE sweeps (mirror for shorts). Watermarks
  // are untouched, so re-arming needs a fresh print beyond the prior extreme.
  const unarmAligned = (direction: BiasDirection) => {
    if (isDolBot(get().botId)) {
      // the raid has been traded — retire every armed sweep of that side.
      // Not terminal (revised 2026-08-12): like the FVG model's watermarks,
      // the level itself survives and a later deeper qualifying raid re-arms
      // it. What is spent is THIS raid.
      const wantSide = direction === 'long' ? 'sellside' : 'buyside';
      const t = now();
      set((st) => ({
        sweeps: Object.fromEntries(
          Object.entries(st.sweeps).map(([id, sw]) =>
            id.includes(`:${wantSide}:`) && isArmed(sw) ? [id, { ...sw, deadAt: t }] : [id, sw],
          ),
        ),
      }));
      return;
    }
    const wantDir = direction === 'long' ? 'bull' : 'bear';
    const drop = new Set(
      conditionGapsAt(now(), boundsOf(get()))
        .filter((g) => g.dir === wantDir)
        .map(gapKey),
    );
    set((st) => ({
      armed: Object.fromEntries(Object.entries(st.armed).filter(([k]) => !drop.has(k))),
    }));
  };

  // Returns false when the trade was NOT placed (degenerate stop / unsizeable).
  const placeTrade = (draft: CandidateDraft): boolean => {
    // size per the bot's risk setting; % risk uses CURRENT balance. Sizing
    // uses the freshest visible price (≈ the next-open fill), not the
    // candidate's 1m-close estimate — % / $ risk tracks the actual fill.
    const derived = useTrading.getState().derived;
    const balance = derived.startingBalance + derived.realizedUsd;
    const entryRef = lastVisibleBar(now())?.c ?? draft.entryEst;
    const s = get();
    // SIGNED distance from where we'd actually enter to the stop. Math.abs()
    // here was the 2026-08-11 blow-up: the trigger confirms on a candle
    // CLOSE and the entry goes in on the next bar, so price can already have
    // travelled to (or through) the swing stop by placement time. Size is
    // proportional to 1/stopPts, so a stop that has collapsed to a tick
    // produces a colossal position — one live session sized 88.6 contracts
    // off a 0.25-point stop, then lost 55 points when the stop gapped
    // through, for -$98,789 against a $436 risk budget.
    //
    // A negative distance means price is already past the stop: the setup's
    // premise is gone, so there is no trade to take.
    const dir = draft.direction === 'long' ? 1 : -1;
    const stopPts = (entryRef - draft.stop) * dir;
    if (stopPts < s.minStopPts) {
      console.warn(
        `bot: skipping ${draft.candidateId} — stop ${stopPts.toFixed(2)} pts from entry (min ${s.minStopPts})`,
      );
      return false;
    }
    const sized = sizeContracts(s.risk, stopPts, balance);
    if (sized <= 0) {
      console.warn(`bot: skipping ${draft.candidateId} — cannot size (balance ${balance.toFixed(0)})`);
      return false;
    }
    // Backstop: even a correct stop distance shouldn't be able to produce a
    // position this book can't survive if the stop gaps.
    const qty = Math.min(sized, s.maxContracts);
    // TP: 1R for the FVG bot; the TARGET GAP'S NEAR EDGE for a mech draft
    // that carries one (user spec 2026-08-12) — placed through the fully
    // absolute bracket form, so the TP sits AT the edge whatever the entry
    // fill does.
    if (draft.target && (draft.target.tp - entryRef) * dir <= 0) {
      console.warn(
        `bot: skipping ${draft.candidateId} — target ${draft.target.tp} is no longer beyond the entry`,
      );
      return false;
    }
    // absolute-stop bracket: the fill pipeline spawns the SL (swing extreme)
    // + TP OCO legs at the entry fill itself, so they're live for every
    // bar after it — the old post-advance leg placement left the stop blind
    // for a whole advance (the oversized-loss bug).
    appendEvent('order_placed', now(), {
      orderId: bid(),
      side: draft.direction === 'long' ? 'buy' : 'sell',
      type: 'market',
      qty,
      bracket: draft.target
        ? { stopPrice: roundToTick(draft.stop), tpPrice: roundToTick(draft.target.tp) }
        : { stopPrice: roundToTick(draft.stop), rr: 1 },
    });
    refreshTrading();
    unarmAligned(draft.direction);
    return true;
  };

  // DOL rule change (either mech bot): persist it, then re-derive every sweep
  // state from history under the new rules (arming/death both depend on them).
  const applyMechSetting = (
    patch: Partial<
      Pick<
        BotState,
        'dolInvalidationPts' | 'sweepMaxCandles' | 'sweepMaxMinutes' | 'resweepWindowMinutes' | 'dolKinds'
      >
    >,
  ) => {
    for (const v of Object.values(patch)) {
      if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) return;
    }
    set(patch);
    persistSettings(currentSettings(get()));
    const t = now();
    const s = get();
    if (t && s.active && isDolBot(s.botId)) {
      set({ sweeps: rebuildSweeps(dolSrc, dolLevelsFor(t, s.dolKinds), t, rulesOf(s)) });
    }
  };

  const promote = (drafts: CandidateDraft[]) => {
    // first draft becomes the on-screen prompt; the rest queue behind it
    const s = get();
    const queue = [...s.queue, ...drafts];
    if (s.pending || queue.length === 0) {
      set({ queue });
      return;
    }
    const [head, ...rest] = queue;
    const replay = useReplay.getState();
    const wasPlaying = replay.playing;
    replay.pause();
    logCandidate(head);
    set({ pending: head, queue: rest, wasPlaying });
  };

  return {
    active: false,
    botId: 'fvg-strategy',
    scope: null,
    action: 'prompt-trade',
    biases: [],
    armed: {},
    clearedTriggers: {},
    watermarks: {},
    sweeps: {},
    fired: {},
    pending: null,
    queue: [],
    wasPlaying: false,
    armedCount: 0,
    window: DEFAULT_WINDOW,
    risk: DEFAULT_RISK,
    hopWindows: false,
    onePosition: true,
    triggerTfs: [...TRIGGER_TFS_ALL],
    dolInvalidationPts: DEFAULT_DOL_INVALIDATION_PTS,
    sweepMaxCandles: DEFAULT_SWEEP_MAX_CANDLES,
    sweepMaxMinutes: DEFAULT_SWEEP_MAX_MINUTES,
    resweepWindowMinutes: DEFAULT_RESWEEP_WINDOW_MINUTES,
    targetGapMaxAgeMinutes: DEFAULT_TARGET_GAP_MAX_AGE_MINUTES,
    dolKinds: [...ALL_DOL_KINDS],
    gapMaxAgeCandles: DEFAULT_GAP_MAX_AGE,
    conditionLookbackCandles: CONDITION_LOOKBACK,
    triggerLookbackCandles: TRIGGER_LOOKBACK,
    minStopPts: DEFAULT_MIN_STOP_PTS,
    maxContracts: DEFAULT_MAX_CONTRACTS,

    begin: (botId = 'fvg-strategy') => {
      nextBotId = 1;
      const settings = loadSettings();
      persistSettings(settings); // stamp this session's config with what it runs
      const t = now();
      const dol = isDolBot(botId);
      const bounds = boundsOf(settings);
      const { armed, watermarks } =
        !dol && t ? rebuildArming(t, bounds) : { armed: {}, watermarks: {} };
      const sweeps =
        dol && t
          ? rebuildSweeps(dolSrc, dolLevelsFor(t, settings.dolKinds), t, rulesOf({ botId, ...settings }))
          : {};
      set({
        active: true,
        botId,
        action: settings.action,
        window: settings.window,
        risk: settings.risk,
        hopWindows: settings.hopWindows,
        onePosition: settings.onePosition,
        triggerTfs: settings.triggerTfs,
        dolInvalidationPts: settings.dolInvalidationPts,
        sweepMaxCandles: settings.sweepMaxCandles,
        sweepMaxMinutes: settings.sweepMaxMinutes,
        resweepWindowMinutes: settings.resweepWindowMinutes,
        targetGapMaxAgeMinutes: settings.targetGapMaxAgeMinutes,
        dolKinds: settings.dolKinds,
        gapMaxAgeCandles: settings.gapMaxAgeCandles,
        conditionLookbackCandles: settings.conditionLookbackCandles,
        triggerLookbackCandles: settings.triggerLookbackCandles,
        minStopPts: settings.minStopPts,
        maxContracts: settings.maxContracts,
        biases: [],
        armed,
        clearedTriggers:
          !dol && t
            ? clearedFromArming(armed, conditionGapsAt(t, bounds), settings.triggerTfs, t, bounds)
            : {},
        watermarks,
        sweeps,
        fired: {},
        pending: null,
        queue: [],
        armedCount: 0,
        scope: t
          ? snapshotScope(
              t,
              dol ? [] : conditionsFrom(armed, conditionGapsAt(t, bounds)),
              [],
              trigTfsOf({ botId, triggerTfs: settings.triggerTfs }),
              null,
              bounds,
              dol ? targetScopeAt(t, settings.targetGapMaxAgeMinutes * 60, bounds) : null,
            )
          : null,
      });
    },

    resume: (events, upTo, config) => {
      nextBotId = events.length + 1;
      const settings = settingsFromConfig(config);
      const botId = botOfConfig(config)?.id ?? 'fvg-strategy';
      const dol = isDolBot(botId);
      const biases = biasesFromEvents(events);
      updateBiasDeaths(biases, sources.NQ.getVisibleBars(upTo));
      const bounds = boundsOf(settings);
      const { armed, watermarks } = dol
        ? { armed: {}, watermarks: {} }
        : rebuildArming(upTo, bounds);
      const sweeps = dol
        ? rebuildSweeps(dolSrc, dolLevelsFor(upTo, settings.dolKinds), upTo, rulesOf({ botId, ...settings }))
        : {};
      set({
        active: true,
        botId,
        action: settings.action,
        window: settings.window,
        risk: settings.risk,
        hopWindows: settings.hopWindows,
        onePosition: settings.onePosition,
        triggerTfs: settings.triggerTfs,
        dolInvalidationPts: settings.dolInvalidationPts,
        sweepMaxCandles: settings.sweepMaxCandles,
        sweepMaxMinutes: settings.sweepMaxMinutes,
        resweepWindowMinutes: settings.resweepWindowMinutes,
        targetGapMaxAgeMinutes: settings.targetGapMaxAgeMinutes,
        dolKinds: settings.dolKinds,
        gapMaxAgeCandles: settings.gapMaxAgeCandles,
        conditionLookbackCandles: settings.conditionLookbackCandles,
        triggerLookbackCandles: settings.triggerLookbackCandles,
        minStopPts: settings.minStopPts,
        maxContracts: settings.maxContracts,
        biases,
        armed,
        clearedTriggers: dol
          ? {}
          : clearedFromArming(armed, conditionGapsAt(upTo, bounds), settings.triggerTfs, upTo, bounds),
        watermarks,
        sweeps,
        fired: firedFromEvents(events),
        pending: null,
        queue: [],
        armedCount: 0,
        scope: snapshotScope(
          upTo,
          dol ? [] : conditionsFrom(armed, conditionGapsAt(upTo, bounds)),
          dol
            ? Object.entries(sweeps)
                .filter(([, sw]) => isArmed(sw))
                .map(([id, sw]) => ({
                  label: id,
                  price: sw.wm,
                  side: id.includes(':buyside:') ? ('buyside' as const) : ('sellside' as const),
                  sweptAt: sw.sweptAt!,
                }))
            : [],
          trigTfsOf({ botId, triggerTfs: settings.triggerTfs }),
          null,
          bounds,
          dol ? targetScopeAt(upTo, settings.targetGapMaxAgeMinutes * 60, bounds) : null,
        ),
      });
    },

    deactivate: () => {
      set({ active: false, scope: null, biases: [], armed: {}, clearedTriggers: {}, watermarks: {}, sweeps: {}, fired: {}, pending: null, queue: [] });
    },

    setAction: (a) => {
      set({ action: a });
      persistSettings(currentSettings(get()));
    },
    setWindow: (w) => {
      if (w.endSec <= w.startSec) return; // ignore degenerate windows
      set({ window: w });
      persistSettings(currentSettings(get()));
    },
    setRisk: (r) => {
      set({ risk: r });
      persistSettings(currentSettings(get()));
    },
    setHopWindows: (v) => {
      set({ hopWindows: v });
      persistSettings(currentSettings(get()));
    },
    setOnePosition: (v) => {
      set({ onePosition: v });
      persistSettings(currentSettings(get()));
    },
    toggleTriggerTf: (tf) => {
      const cur = get().triggerTfs;
      const next = cur.includes(tf) ? cur.filter((t) => t !== tf) : [...cur, tf];
      if (next.length === 0) return; // at least one trigger TF stays on
      set({ triggerTfs: next });
      persistSettings(currentSettings(get()));
    },
    // Any rule change re-derives every sweep state from history: the arming
    // and death decisions all depend on these numbers, so the stored states
    // would otherwise describe rules that are no longer in force.
    setDolInvalidationPts: (v) => applyMechSetting({ dolInvalidationPts: v }),
    setSweepMaxCandles: (v) => applyMechSetting({ sweepMaxCandles: Math.round(v) }),
    setSweepMaxMinutes: (v) => applyMechSetting({ sweepMaxMinutes: v }),
    setResweepWindowMinutes: (v) => applyMechSetting({ resweepWindowMinutes: v }),
    // Target age only decides which gaps qualify at the NEXT trigger — no
    // sweep state depends on it, so no rebuild.
    setTargetGapMaxAgeMinutes: (v) => {
      if (!Number.isFinite(v) || v <= 0) return;
      set({ targetGapMaxAgeMinutes: v });
      persistSettings(currentSettings(get()));
    },
    toggleDolKind: (k) => {
      const cur = get().dolKinds;
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      if (next.length === 0) return; // at least one category stays on
      applyMechSetting({ dolKinds: next });
    },

    // Size guards only affect the NEXT order, so no rebuild needed.
    setSizeGuard: (k, v) => {
      if (!Number.isFinite(v) || v <= 0) return;
      set({ [k]: v } as Partial<BotState>);
      persistSettings(currentSettings(get()));
    },

    // Candle-distance bounds decide which gaps exist at all, so a change has
    // to re-derive arming from scratch.
    setScanBound: (k, v) => {
      const n = Math.round(v);
      if (!Number.isFinite(n) || n < 1) return;
      set({ [k]: n } as Partial<BotState>);
      persistSettings(currentSettings(get()));
      const t = now();
      const s = get();
      if (!t || !s.active || isDolBot(s.botId)) return; // no condition arming to rebuild
      const bounds = boundsOf(s);
      const { armed, watermarks } = rebuildArming(t, bounds);
      set({
        armed,
        watermarks,
        clearedTriggers: clearedFromArming(armed, conditionGapsAt(t, bounds), s.triggerTfs, t, bounds),
        scope: snapshotScope(t, conditionsFrom(armed, conditionGapsAt(t, bounds)), [], s.triggerTfs, null, bounds),
      });
    },

    addBias: (direction, until) => {
      const biasId = bid();
      appendEvent('bias_set', now(), { biasId, direction, until });
      set((s) => ({
        biases: [...s.biases, { id: biasId, direction, until, setTs: now(), deadAt: null }],
      }));
    },

    removeBias: (biasId) => {
      appendEvent('bias_removed', now(), { biasId });
      set((s) => ({ biases: s.biases.filter((b) => b.id !== biasId) }));
    },

    submitDecision: (decision, notes) => {
      const s = get();
      if (!s.pending) return;
      appendEvent('decision_made', now(), {
        candidateId: s.pending.candidateId,
        decision,
        notes: notes || undefined,
      });
      let queue = s.queue;
      if (decision === 'take') {
        // A refused trade (degenerate stop / unsizeable) still unarms — the
        // user's take is recorded either way; only the order is withheld.
        if (s.action === 'prompt-trade') {
          if (!placeTrade(s.pending)) unarmAligned(s.pending.direction);
        } else unarmAligned(s.pending.direction); // label-only: counterfactual take still unarms
        // same-direction queued candidates lost their armed conditions
        queue = queue.filter((d) => d.direction !== s.pending!.direction);
      }
      const [head, ...rest] = queue;
      if (head) {
        logCandidate(head);
        set({ pending: head, queue: rest });
      } else {
        set({ pending: null, queue: [] });
        if (s.wasPlaying) useReplay.getState().play();
      }
    },

    // Jump to the NEXT trading day's 09:25 ET. Candidates that would fire
    // inside the jumped-over span are logged but auto-skipped (prompt modes)
    // — press it once today's window is done.
    nextDay: async () => {
      const t = now();
      if (!t) return;
      const manifest = sources.NQ.getManifest();
      const today = tradingDateOf(t);
      const next = manifest.find((m) => m.trading_date > today);
      if (!next) return;
      const [y, mo, d] = next.trading_date.split('-').map(Number);
      await useReplay.getState().jumpTo(etWallToUtc(y, mo, d, 9, 25));
    },

    onAdvance: (from, to) => {
      const s = get();
      if (!s.active) return;
      const newBars = getBarsInWindow(from, to);
      const dol = isDolBot(s.botId);

      // 1. bias deaths (derived, no events; FVG model only uses them)
      const biases = s.biases.map((b) => ({ ...b }));
      updateBiasDeaths(biases, newBars);

      // 2. condition state, per bot.
      // FVG strategy: condition gaps + arming (incremental: new bars advance
      // each gap's fill watermark; arming needs an in-session print BEYOND
      // the watermark). An armed state is only valid while its tap is in the
      // CURRENT day's session — crossing into a new trading day stales every
      // prior tap, and a stale gap re-arms only on a fresh qualifying print.
      // Mech bots: fold new bars into each DOL level's sweep state (a level
      // first seen this advance — day roll, window close — scans from its
      // own formation).
      const sessionOpen = sessionOpenOf(to);
      const armed: Record<string, ArmedState> = {};
      // Resweeps seen on this advance, WITH the bar time each happened on
      // (2026-08-12): a resweep only retires the vetoes standing before it, so
      // the bookkeeping needs the moment, not just the direction.
      const resweeps: { dir: FVG['dir']; at: number }[] = [];
      const watermarks: Record<string, number> = {};
      const sweeps: Record<string, SweepState> = {};
      const conditions: ArmedCondition[] = [];
      const armedSweeps: ArmedSweep[] = [];
      if (dol) {
        const rules = rulesOf(s);
        for (const level of dolLevelsFor(to, s.dolKinds)) {
          const prev = s.sweeps[level.id];
          const state = prev
            ? foldSweep(level, prev, newBars, rules, to)
            : // first sight (session start, day roll, a window just closed):
              // scan the level's whole life rather than just this advance
              foldSweep(level, freshSweepState(level), getBarsInWindow(level.formedAt - 60, to), rules, to);
          sweeps[level.id] = state;
          // RESWEEP (revised 2026-08-12): the fold moved sweptAt forward, so a
          // deeper qualifying raid re-armed this level — the same event the
          // FVG model reads off the arming tap's extreme, and it stales the
          // triggers that were in play the same way. Sweeping SELLSIDE arms
          // longs, and longs come from BEAR gaps inverting, so bear blockers
          // are the ones this retires. A level first seen on this advance
          // (no prev) is not a resweep, however deep its history.
          if (
            prev !== undefined &&
            prev.sweptAt !== null &&
            state.sweptAt !== null &&
            state.sweptAt > prev.sweptAt
          ) {
            // the re-arm's new sweptAt IS the resweep bar
            resweeps.push({ dir: level.side === 'sellside' ? 'bear' : 'bull', at: state.sweptAt });
          }
          // A sweep that DIED inside this advance still counts for an
          // inversion that confirmed before the death, so it goes into the
          // pool too — matchSweepTriggers does the precise timing.
          if (state.sweptAt !== null) {
            armedSweeps.push({ level, sweptAt: state.sweptAt, deadAt: state.deadAt });
          }
        }
      } else {
        const condGaps = conditionGapsAt(to, boundsOf(s));
        for (const g of condGaps) {
          const key = gapKey(g);
          const prev = s.armed[key];
          const stillArmed = prev !== undefined && prev.t >= sessionOpen;
          const scan = scanForTap({
            bars: newBars,
            dir: g.dir,
            top: g.top,
            bottom: g.bottom,
            fromTs: g.formedAt,
            armFromTs: sessionOpen,
            watermark: s.watermarks[key],
            alreadyArmed: stillArmed || g.invertedAt !== null || g.expiredAt !== null,
          });
          watermarks[key] = scan.watermark;
          // Full mitigation no longer disarms (revised 2026-08-06): a wick
          // through the whole zone leaves it usable as a condition, and the
          // price-side test at the trigger decides. Re-arming from scratch is
          // still impossible once the watermark reaches the far edge.
          if (stillArmed) {
            // arming invalidation: ANY print (a wick counts) strictly beyond
            // the leg extreme the retrace departed from disarms — the move the
            // setup was hunting already ran without a trigger
            if (!newBars.some((b) => refBreached(g.dir, prev.ref, b))) {
              // RESWEEP: price drove back through the arming tap's own extreme
              // (bull: below the tap low). The retracement went deeper, so
              // every trigger that was in play is stale. Edge-triggered — one
              // per arming, else a fixed reference would re-clear on every bar
              // below it and nothing could ever re-arm.
              // the resweep bar is the FIRST new bar that breaches — its time
              // is what dates the cleared-blocker cut (2026-08-12)
              const hit = prev.reswept
                ? undefined
                : newBars.find((b) => resweepBreached(g.dir, prev.swept, b));
              if (hit) resweeps.push({ dir: g.dir === 'bull' ? 'bear' : 'bull', at: hit.t });
              armed[key] = hit ? { ...prev, reswept: true } : prev;
            }
          } else if (scan.armedBar) {
            const t = scan.armedBar.t;
            const ref = armingRef(getBarsInWindow(g.aT - 60, t + 60), g.dir, g.aT, t);
            // arm unless this same advance already took the reference extreme
            if (!newBars.some((b) => b.t > t && refBreached(g.dir, ref, b))) {
              const swept = resweepRef(scan.armedBar, g.dir);
              armed[key] = {
                t,
                ref,
                swept,
                reswept: newBars.some((b) => b.t > t && resweepBreached(g.dir, swept, b)),
              };
            }
          }
        }
        for (const g of condGaps) {
          const at = armed[gapKey(g)];
          if (at !== undefined) conditions.push({ gap: g, armedAt: at.t });
        }
      }

      // one-position gate (locked 2026-07-30): while a trade is on — open
      // position or ANY working order (an unfilled entry is a working order)
      // — the bot doesn't look for candidates at all. Also prevents the
      // cancel-out glitch (opposite entries netting flat, orphaning legs).
      const book = useTrading.getState().derived;
      const busy = book.position.qty !== 0 || book.workingOrders.length > 0;

      // 3. rule-3 triggers across ALL trigger TFs (15s–5m), with the overlap
      // hierarchy: the full pool is passed as blockers so a lower-TF
      // inversion defers to any overlapping same-or-higher filled gap.
      let drafts: CandidateDraft[] = [];
      const dormant: 'position' | null = s.onePosition && busy ? 'position' : null;
      const diag: TriggerOutcome[] = [];
      let pool: FVG[] = [];
      let clearedTriggers = s.clearedTriggers;
      if (!dormant) {
        const triggers: FVG[] = [];
        // only the enabled trigger TFs participate — as triggers AND as
        // overlap blockers (a disabled TF is not considered at all)
        pool = triggerGapsAt(to, trigTfsOf(s), boundsOf(s));
        for (const g of pool) {
          if (g.invertedAt !== null && g.invertedAt > from && g.invertedAt <= to) triggers.push(g);
        }
        // Resweep bookkeeping — pure, in engine.updateClearedBlockers (moved
        // there 2026-08-12 along with the ordering fix: a resweep now retires
        // only the vetoes standing BEFORE it, so a fresh tap on or after the
        // resweep bar re-establishes the veto inside the same advance).
        // The bar window has to span the pool gaps' lives, not just this
        // advance, because the marks are life-wide penetrations.
        let earliest = Infinity;
        for (const g of pool) earliest = Math.min(earliest, g.formedAt);
        clearedTriggers = updateClearedBlockers({
          cleared: clearedTriggers,
          pool,
          resweeps,
          bars: Number.isFinite(earliest) ? getBarsInWindow(earliest - 60, to) : [],
          now: to,
        });

        const common = {
          triggers,
          bars1m: sources.NQ.getVisibleBars(to),
          fired: new Set(Object.keys(s.fired)),
          window: s.window,
          blockers: pool,
        };
        const clearedBlockers = new Set(Object.keys(clearedTriggers));
        if (dol) {
          const swept = matchSweepTriggers({
            ...common,
            sweeps: armedSweeps,
            rules: rulesOf(s),
            clearedBlockers,
            // the unfilled 5m/15m target is a REQUIREMENT for both mech bots
            // (user spec 2026-08-12) — same clock-clipped, windowed gap
            // machinery the FVG bot's conditions come from
            targets: {
              gaps: conditionGapsAt(to, boundsOf(s), TARGET_TFS),
              maxAgeSec: s.targetGapMaxAgeMinutes * 60,
            },
            // mech-2 only (added 2026-08-12): the FVG bot's session-tap rule,
            // applied to the sweep — an overnight raid can't back a candidate
            armFromSessionOpen: s.botId === 'mech-2',
            diag,
          });
          drafts =
            s.botId === 'mech-model'
              ? // "the highest-TF IFVG in the leg triggers" (user spec
                // 2026-08-12): same confirmation close -> the bigger
                // timeframe's inversion is the one this model acts on
                swept.sort((a, b) => a.confirmTs - b.confirmTs || tfSecOf(b.ifvg.tf) - tfSecOf(a.ifvg.tf))
              : // mech-2 copies the FVG bot's ordering: confirmTs alone
                swept.sort((a, b) => a.confirmTs - b.confirmTs);
        } else {
          drafts = matchTriggers({ ...common, conditions, biases, diag, clearedBlockers }).sort(
            (a, b) => a.confirmTs - b.confirmTs,
          );
        }
      } else {
        pool = [];
      }

      const armedCount = dol
        ? Object.values(sweeps).filter(isArmed).length
        : conditions.filter(({ gap }) => gap.invertedAt === null && gap.expiredAt === null).length;

      // 3b. live scope snapshot for the UI. The standing veto is the payoff:
      // it shows which higher timeframe currently owns the move, so a 1m
      // inversion that will be suppressed is visible BEFORE it happens.
      const prevTriggers = s.scope?.triggers ?? [];
      const clearedSet = new Set(Object.keys(clearedTriggers));
      const scope: BotScope = {
        at: to,
        dormant,
        // mech bots only: the closest valid unfilled 5m/15m target per side
        targets: dol ? targetScopeAt(to, s.targetGapMaxAgeMinutes * 60, boundsOf(s)) : null,
        sweeps: armedSweeps.map((a) => ({
          label: a.level.label,
          price: a.level.price,
          side: a.level.side,
          sweptAt: a.sweptAt,
        })),
        conditions: conditions
          .filter(({ gap }) => gap.invertedAt === null && gap.expiredAt === null)
          .map(({ gap, armedAt }) => ({
            tf: gap.tf,
            dir: gap.dir,
            top: gap.top,
            bottom: gap.bottom,
            bT: gap.bT,
            armedAt,
          })),
        inPlay: pool
          .filter((g) => g.invertedAt === null && g.expiredAt === null && g.tappedAt !== null)
          .map((g) => ({ tf: g.tf, dir: g.dir, top: g.top, bottom: g.bottom, bT: g.bT })),
        triggers: trigTfsOf(s).map((tf) => {
          const last = diag.find((d) => d.tf === tf) ?? prevTriggers.find((p) => p.tf === tf)?.last ?? null;
          return {
            tf,
            // a LONG comes from a bear gap inverting, so a bear blocker vetoes it
            blockedLong: dormant ? null : standingVeto(tf, 'bear', pool, to, clearedSet),
            blockedShort: dormant ? null : standingVeto(tf, 'bull', pool, to, clearedSet),
            live: pool.filter((g) => g.tf === tf && g.invertedAt === null && g.expiredAt === null).length,
            cleared: pool.filter((g) => g.tf === tf && clearedSet.has(gapKey(g))).length,
            last,
          };
        }),
      };
      set({ biases, armed, clearedTriggers, watermarks, sweeps, armedCount, scope });

      const isJump = to - from > 3600;
      if (drafts.length > 0) {
        if (s.action === 'auto') {
          const traded = new Set<BiasDirection>();
          for (const d of drafts) {
            // an earlier trade this batch unarmed this direction's conditions
            if (traded.has(d.direction)) continue;
            logCandidate(d);
            // record what ACTUALLY happened: a refused trade is a skip, not
            // an 'auto' take with no order behind it
            if (placeTrade(d)) {
              appendEvent('decision_made', d.confirmTs, { candidateId: d.candidateId, decision: 'auto' });
              traded.add(d.direction);
            } else {
              appendEvent('decision_made', d.confirmTs, {
                candidateId: d.candidateId,
                decision: 'skip',
                notes: 'auto-skipped (stop too close to entry, or unsizeable)',
              });
            }
          }
        } else if (isJump) {
          for (const d of drafts) {
            logCandidate(d);
            appendEvent('decision_made', d.confirmTs, {
              candidateId: d.candidateId,
              decision: 'skip',
              notes: 'auto-skipped (day jump)',
            });
          }
        } else {
          promote(drafts);
        }
      }

      // 4. window hopping (opt-in): outside the active window with nothing
      // running -> jump to just before the next window open ("the next
      // 9:29"). A running trade / working orders / open prompt keeps the
      // clock going instead.
      if (get().hopWindows && !hopBusy) {
        const t = useTrading.getState().derived;
        const idle =
          t.position.qty === 0 && t.workingOrders.length === 0 && get().pending === null;
        if (idle) {
          const w = get().window;
          const hhmm = (sec: number) => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60)] as const;
          const landSec = Math.max(0, w.startSec - 60);
          const td = tradingDateOf(to);
          const [y, mo, d] = td.split('-').map(Number);
          const tdLand = etWallToUtc(y, mo, d, ...hhmm(landSec));
          const tdEnd = etWallToUtc(y, mo, d, ...hhmm(w.endSec));
          let target: number | null = null;
          if (to < tdLand) {
            target = tdLand; // evening/overnight/premarket of this trading day
          } else if (to > tdEnd) {
            const next = sources.NQ.getManifest().find((m) => m.trading_date > td);
            if (next) {
              const [ny, nmo, nd] = next.trading_date.split('-').map(Number);
              target = etWallToUtc(ny, nmo, nd, ...hhmm(landSec));
            }
          }
          if (target !== null && target > to) {
            hopBusy = true;
            const replay = useReplay.getState();
            const wasPlaying = replay.playing;
            void (async () => {
              try {
                await replay.jumpTo(target);
                if (wasPlaying) useReplay.getState().play();
              } finally {
                hopBusy = false;
              }
            })();
          }
        }
      }
    },

    onRewind: (_from, to) => {
      const s = get();
      if (!s.active) return;
      const dol = isDolBot(s.botId);
      const biases = s.biases
        .filter((b) => b.setTs <= to)
        .map((b) => ({ ...b, deadAt: b.deadAt !== null && b.deadAt > to ? null : b.deadAt }));
      const bounds = boundsOf(s);
      const { armed, watermarks } = dol ? { armed: {}, watermarks: {} } : rebuildArming(to, bounds);
      const sweeps = dol ? rebuildSweeps(dolSrc, dolLevelsFor(to, s.dolKinds), to, rulesOf(s)) : {};
      set({
        biases,
        armed,
        // Mech bots: cleared-blocker state is NOT reconstructed on rewind —
        // the resweeps that retired them aren't replayed, so blockers resume
        // standing (conservative: the bot vetoes rather than over-fires).
        clearedTriggers: dol
          ? {}
          : clearedFromArming(armed, conditionGapsAt(to, bounds), s.triggerTfs, to, bounds),
        watermarks,
        sweeps,
        scope: snapshotScope(
          to,
          dol ? [] : conditionsFrom(armed, conditionGapsAt(to, bounds)),
          [],
          trigTfsOf(s),
          null,
          bounds,
          dol ? targetScopeAt(to, s.targetGapMaxAgeMinutes * 60, bounds) : null,
        ),
        fired: Object.fromEntries(Object.entries(s.fired).filter(([, ts]) => ts <= to)),
        pending: s.pending && s.pending.confirmTs > to ? null : s.pending,
        queue: s.queue.filter((d) => d.confirmTs <= to),
      });
    },
  };
});

// Clock wiring — registered after the trading store's subscription (import
// order), so fills for an advance exist before the engine reads them.
useReplay.subscribe((s, prev) => {
  const b = useBot.getState();
  if (!b.active) return;
  if (s.currentTime !== null && prev.currentTime !== null && s.currentTime !== prev.currentTime) {
    if (s.currentTime > prev.currentTime) b.onAdvance(prev.currentTime, s.currentTime);
    else b.onRewind(prev.currentTime, s.currentTime);
  }
});

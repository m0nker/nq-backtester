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
  DEFAULT_RISK,
  DEFAULT_WINDOW,
  gapKey,
  isFullyMitigated,
  matchTriggers,
  refBreached,
  scanForTap,
  sessionOpenOf,
  sizeContracts,
  updateBiasDeaths,
  type ArmedCondition,
  type BiasEntry,
  type BiasDirection,
  type CandidateDraft,
  type ExecutionWindow,
  type RiskSettings,
} from './engine';
import { CONDITION_TFS, TRIGGER_TFS_ALL, computeFVGs, type FVG } from './fvg';
import {
  ALL_DOL_KINDS,
  DEFAULT_DOL_INVALIDATION_PTS,
  DEFAULT_SWEEP_MAX_CANDLES,
  DEFAULT_SWEEP_MAX_MINUTES,
  foldSweep,
  freshSweepState,
  isArmed,
  isDOLKind,
  levelsAt,
  matchSweepTriggers,
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

const rulesOf = (s: {
  dolInvalidationPts: number;
  sweepMaxCandles: number;
  sweepMaxMinutes: number;
  triggerTfs: Timeframe[];
}): SweepRules => ({
  invalidationPts: s.dolInvalidationPts,
  maxCandles: s.sweepMaxCandles,
  maxMinutes: s.sweepMaxMinutes,
  // whole-level death waits for the slowest enabled trigger TF
  slowestTriggerSec: s.triggerTfs.reduce((m, tf) => Math.max(m, tfSecOf(tf)), 0),
});

export type CandidateAction = 'prompt-trade' | 'label-only' | 'auto';

const CONDITION_LOOKBACK = 40; // 25-candle expiry + margin — active gaps only
const TRIGGER_LOOKBACK = 60;

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
  // ---- mech model ----
  dolInvalidationPts: number; // armed sweep dies past this distance from the level
  sweepMaxCandles: number; // candles (of each trigger TF) allowed to invert
  sweepMaxMinutes: number; // absolute ceiling from the sweep; overrides the above
  dolKinds: DOLKind[]; // which draw-on-liquidity categories can be traded
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
  dolKinds: [...ALL_DOL_KINDS],
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
      dolKinds: validDolKinds(p.dolKinds),
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
      dolKinds: s.dolKinds,
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
  dolKinds: DOLKind[];
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
  dolKinds: s.dolKinds,
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
    dolKinds: config.dolKinds !== undefined ? validDolKinds(config.dolKinds) : local.dolKinds,
  };
}

interface BotState {
  active: boolean;
  botId: string; // which bot runs this session ('fvg-strategy' | 'mech-model')
  action: CandidateAction;
  biases: BiasEntry[];
  // gapKey -> armed state: t = arming 1m bar open time; ref = the leg
  // extreme whose breach ("taking the low") invalidates the arm
  armed: Record<string, { t: number; ref: number }>;
  watermarks: Record<string, number>; // gapKey -> deepest fill price since formation
  sweeps: Record<string, SweepState>; // mech model: DOL levelId -> sweep state
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
  dolInvalidationPts: number; // mech model: sweep invalidation distance
  sweepMaxCandles: number; // mech model: candles per trigger TF to invert
  sweepMaxMinutes: number; // mech model: absolute minute ceiling from the sweep
  dolKinds: DOLKind[]; // mech model: tradeable draw-on-liquidity categories

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
  toggleDolKind: (k: DOLKind) => void;
  addBias: (direction: BiasDirection, until: number) => void;
  removeBias: (biasId: string) => void;
  submitDecision: (decision: 'take' | 'marginal' | 'skip', notes: string) => void;
  nextDay: () => Promise<void>;
  onAdvance: (from: number, to: number) => void;
  onRewind: (from: number, to: number) => void;
}

const conditionGapsAt = (upTo: number): FVG[] => {
  const out: FVG[] = [];
  for (const tf of CONDITION_TFS) {
    out.push(
      ...computeFVGs(sources.NQ.getRecentCandles(upTo, tf, CONDITION_LOOKBACK + 5), tf, upTo, {
        lookbackCandles: CONDITION_LOOKBACK,
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
): { armed: Record<string, { t: number; ref: number }>; watermarks: Record<string, number> } => {
  const armed: Record<string, { t: number; ref: number }> = {};
  const watermarks: Record<string, number> = {};
  const sessionOpen = sessionOpenOf(upTo);
  for (const g of conditionGapsAt(upTo)) {
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
    if (isFullyMitigated(g.dir, fullWm, g.top, g.bottom)) continue;

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
        armed[gapKey(g)] = { t, ref };
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
    if (get().botId === 'mech-model') {
      // the raid has been traded — retire every armed sweep of that side.
      // Terminal, like any other invalidation: the level is spent, and only
      // a NEW level (e.g. the swing this leg leaves behind) can arm again.
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
      conditionGapsAt(now())
        .filter((g) => g.dir === wantDir)
        .map(gapKey),
    );
    set((st) => ({
      armed: Object.fromEntries(Object.entries(st.armed).filter(([k]) => !drop.has(k))),
    }));
  };

  const placeTrade = (draft: CandidateDraft) => {
    // size per the bot's risk setting; % risk uses CURRENT balance. Sizing
    // uses the freshest visible price (≈ the next-open fill), not the
    // candidate's 1m-close estimate — % / $ risk tracks the actual fill.
    const derived = useTrading.getState().derived;
    const balance = derived.startingBalance + derived.realizedUsd;
    const entryRef = lastVisibleBar(now())?.c ?? draft.entryEst;
    const stopPts = Math.abs(entryRef - draft.stop);
    const qty = sizeContracts(get().risk, stopPts, balance);
    // absolute-stop bracket: the fill pipeline spawns the SL (swing extreme)
    // + 1R-TP OCO legs at the entry fill itself, so they're live for every
    // bar after it — the old post-advance leg placement left the stop blind
    // for a whole advance (the oversized-loss bug).
    appendEvent('order_placed', now(), {
      orderId: bid(),
      side: draft.direction === 'long' ? 'buy' : 'sell',
      type: 'market',
      qty,
      bracket: { stopPrice: roundToTick(draft.stop), rr: 1 },
    });
    refreshTrading();
    unarmAligned(draft.direction);
  };

  // Mech-model rule change: persist it, then re-derive every sweep state
  // from history under the new rules (arming/death both depend on them).
  const applyMechSetting = (
    patch: Partial<Pick<BotState, 'dolInvalidationPts' | 'sweepMaxCandles' | 'sweepMaxMinutes' | 'dolKinds'>>,
  ) => {
    for (const v of Object.values(patch)) {
      if (typeof v === 'number' && (!Number.isFinite(v) || v <= 0)) return;
    }
    set(patch);
    persistSettings(currentSettings(get()));
    const t = now();
    const s = get();
    if (t && s.active && s.botId === 'mech-model') {
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
    action: 'prompt-trade',
    biases: [],
    armed: {},
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
    dolKinds: [...ALL_DOL_KINDS],

    begin: (botId = 'fvg-strategy') => {
      nextBotId = 1;
      const settings = loadSettings();
      persistSettings(settings); // stamp this session's config with what it runs
      const t = now();
      const mech = botId === 'mech-model';
      const { armed, watermarks } =
        !mech && t ? rebuildArming(t) : { armed: {}, watermarks: {} };
      const sweeps =
        mech && t
          ? rebuildSweeps(dolSrc, dolLevelsFor(t, settings.dolKinds), t, rulesOf(settings))
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
        dolKinds: settings.dolKinds,
        biases: [],
        armed,
        watermarks,
        sweeps,
        fired: {},
        pending: null,
        queue: [],
        armedCount: 0,
      });
    },

    resume: (events, upTo, config) => {
      nextBotId = events.length + 1;
      const settings = settingsFromConfig(config);
      const botId = botOfConfig(config)?.id ?? 'fvg-strategy';
      const mech = botId === 'mech-model';
      const biases = biasesFromEvents(events);
      updateBiasDeaths(biases, sources.NQ.getVisibleBars(upTo));
      const { armed, watermarks } = mech ? { armed: {}, watermarks: {} } : rebuildArming(upTo);
      const sweeps = mech
        ? rebuildSweeps(dolSrc, dolLevelsFor(upTo, settings.dolKinds), upTo, rulesOf(settings))
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
        dolKinds: settings.dolKinds,
        biases,
        armed,
        watermarks,
        sweeps,
        fired: firedFromEvents(events),
        pending: null,
        queue: [],
        armedCount: 0,
      });
    },

    deactivate: () => {
      set({ active: false, biases: [], armed: {}, watermarks: {}, sweeps: {}, fired: {}, pending: null, queue: [] });
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
    toggleDolKind: (k) => {
      const cur = get().dolKinds;
      const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      if (next.length === 0) return; // at least one category stays on
      applyMechSetting({ dolKinds: next });
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
        if (s.action === 'prompt-trade') placeTrade(s.pending);
        else unarmAligned(s.pending.direction); // label-only: counterfactual take still unarms
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
      const mech = s.botId === 'mech-model';

      // 1. bias deaths (derived, no events; FVG model only uses them)
      const biases = s.biases.map((b) => ({ ...b }));
      updateBiasDeaths(biases, newBars);

      // 2. condition state, per bot.
      // FVG strategy: condition gaps + arming (incremental: new bars advance
      // each gap's fill watermark; arming needs an in-session print BEYOND
      // the watermark). An armed state is only valid while its tap is in the
      // CURRENT day's session — crossing into a new trading day stales every
      // prior tap, and a stale gap re-arms only on a fresh qualifying print.
      // Mech model: fold new bars into each DOL level's sweep state (a level
      // first seen this advance — day roll, window close — scans from its
      // own formation).
      const sessionOpen = sessionOpenOf(to);
      const armed: Record<string, { t: number; ref: number }> = {};
      const watermarks: Record<string, number> = {};
      const sweeps: Record<string, SweepState> = {};
      const conditions: ArmedCondition[] = [];
      const armedSweeps: ArmedSweep[] = [];
      if (mech) {
        const rules = rulesOf(s);
        for (const level of dolLevelsFor(to, s.dolKinds)) {
          const prev = s.sweeps[level.id];
          const state = prev
            ? foldSweep(level, prev, newBars, rules, to)
            : // first sight (session start, day roll, a window just closed):
              // scan the level's whole life rather than just this advance
              foldSweep(level, freshSweepState(level), getBarsInWindow(level.formedAt - 60, to), rules, to);
          sweeps[level.id] = state;
          // A sweep that DIED inside this advance still counts for an
          // inversion that confirmed before the death, so it goes into the
          // pool too — matchSweepTriggers does the precise timing.
          if (state.sweptAt !== null) {
            armedSweeps.push({ level, sweptAt: state.sweptAt, deadAt: state.deadAt });
          }
        }
      } else {
        const condGaps = conditionGapsAt(to);
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
          // full mitigation is terminal for condition use: it DISARMS an armed
          // gap and blocks any future re-arm (locked 2026-07-30)
          if (isFullyMitigated(g.dir, scan.watermark, g.top, g.bottom)) continue;
          if (stillArmed) {
            // arming invalidation: ANY print (a wick counts) strictly beyond
            // the leg extreme the retrace departed from disarms — the move the
            // setup was hunting already ran without a trigger
            if (!newBars.some((b) => refBreached(g.dir, prev.ref, b))) armed[key] = prev;
          } else if (scan.armedBar) {
            const t = scan.armedBar.t;
            const ref = armingRef(getBarsInWindow(g.aT - 60, t + 60), g.dir, g.aT, t);
            // arm unless this same advance already took the reference extreme
            if (!newBars.some((b) => b.t > t && refBreached(g.dir, ref, b))) armed[key] = { t, ref };
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
      if (!(s.onePosition && busy)) {
        const triggers: FVG[] = [];
        const pool: FVG[] = [];
        // only the enabled trigger TFs participate — as triggers AND as
        // overlap blockers (a disabled TF is not considered at all)
        for (const tf of s.triggerTfs) {
          for (const g of computeFVGs(sources.NQ.getRecentCandles(to, tf, TRIGGER_LOOKBACK + 5), tf, to, {
            lookbackCandles: TRIGGER_LOOKBACK,
          })) {
            pool.push(g);
            if (g.invertedAt !== null && g.invertedAt > from && g.invertedAt <= to) triggers.push(g);
          }
        }
        const common = {
          triggers,
          bars1m: sources.NQ.getVisibleBars(to),
          fired: new Set(Object.keys(s.fired)),
          window: s.window,
          blockers: pool,
        };
        drafts = (
          mech
            ? matchSweepTriggers({ ...common, sweeps: armedSweeps, rules: rulesOf(s) })
            : matchTriggers({ ...common, conditions, biases })
        ).sort((a, b) => a.confirmTs - b.confirmTs);
      }

      const armedCount = mech
        ? Object.values(sweeps).filter(isArmed).length
        : conditions.filter(({ gap }) => gap.invertedAt === null && gap.expiredAt === null).length;
      set({ biases, armed, watermarks, sweeps, armedCount });

      const isJump = to - from > 3600;
      if (drafts.length > 0) {
        if (s.action === 'auto') {
          const traded = new Set<BiasDirection>();
          for (const d of drafts) {
            // an earlier trade this batch unarmed this direction's conditions
            if (traded.has(d.direction)) continue;
            logCandidate(d);
            appendEvent('decision_made', d.confirmTs, { candidateId: d.candidateId, decision: 'auto' });
            placeTrade(d);
            traded.add(d.direction);
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
      const mech = s.botId === 'mech-model';
      const biases = s.biases
        .filter((b) => b.setTs <= to)
        .map((b) => ({ ...b, deadAt: b.deadAt !== null && b.deadAt > to ? null : b.deadAt }));
      const { armed, watermarks } = mech ? { armed: {}, watermarks: {} } : rebuildArming(to);
      const sweeps = mech ? rebuildSweeps(dolSrc, dolLevelsFor(to, s.dolKinds), to, rulesOf(s)) : {};
      set({
        biases,
        armed,
        watermarks,
        sweeps,
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

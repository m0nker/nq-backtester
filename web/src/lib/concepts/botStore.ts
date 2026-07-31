'use client';

// Bot-mode session store: drives the candidate engine (engine.ts) off the
// replay clock, exactly like the trading store drives fills. Owns: the bias
// list (bias_set/bias_removed events; deaths DERIVED from bars), condition
// arming, candidate prompting/queueing, and — depending on the session's
// candidate action — order placement (market entry, then absolute SL at the
// swing extreme + 1R TP as an OCO pair once the entry fill is known).
//
// Subscription order matters: this module imports the trading store, so the
// trading store's clock subscription registers FIRST and fills are already
// simulated for an advance by the time onAdvance here reads events.

import { create } from 'zustand';
import { getBarsInWindow, sources } from '../data/barSource';
import { updateSessionConfig } from '../data/sessions';
import { appendEvent, getEvents, getSessionId } from '../events/eventLog';
import type { SessionEvent } from '../events/types';
import type { Timeframe } from '../types';
import { useReplay } from '../replay/clock';
import { etWallToUtc, tradingDateOf } from '../time/et';
import { deriveState } from '../trading/engine';
import { roundToTick } from '../trading/contractMath';
import { useTrading } from '../trading/store';
import {
  armingRef,
  biasAliveAt,
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

export type CandidateAction = 'prompt-trade' | 'label-only' | 'auto';

const CONDITION_LOOKBACK = 40; // 25-candle expiry + margin — active gaps only
const TRIGGER_LOOKBACK = 60;

let nextBotId = 1;
const bid = () => `b${nextBotId++}-${Date.now().toString(36)}`;

// entry orders awaiting their fill so the absolute-price OCO legs can go on
interface PendingEntry {
  orderId: string;
  direction: BiasDirection;
  stop: number;
  qty: number;
  placedTs: number;
}
let pendingEntries: PendingEntry[] = [];
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
}
const SETTINGS_KEY = 'bot-settings-v1';
const DEFAULT_SETTINGS: BotSettings = {
  action: 'prompt-trade',
  window: DEFAULT_WINDOW,
  risk: DEFAULT_RISK,
  hopWindows: false,
  onePosition: true,
  triggerTfs: [...TRIGGER_TFS_ALL],
};
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
}): BotSettings => ({
  action: s.action,
  window: s.window,
  risk: s.risk,
  hopWindows: s.hopWindows,
  onePosition: s.onePosition,
  triggerTfs: s.triggerTfs,
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
  };
}

interface BotState {
  active: boolean;
  action: CandidateAction;
  biases: BiasEntry[];
  // gapKey -> armed state: t = arming 1m bar open time; ref = the leg
  // extreme whose breach ("taking the low") invalidates the arm
  armed: Record<string, { t: number; ref: number }>;
  watermarks: Record<string, number>; // gapKey -> deepest fill price since formation
  fired: Record<string, number>; // candidateId -> confirmTs (already shown)
  pending: CandidateDraft | null; // prompt currently on screen
  queue: CandidateDraft[];
  wasPlaying: boolean;
  armedCount: number; // HUD
  window: ExecutionWindow; // execution window (bot setting)
  risk: RiskSettings; // bot position sizing (bot setting)
  hopWindows: boolean; // auto-jump between active windows when idle
  onePosition: boolean; // one trade at a time: dormant until the book is clean
  triggerTfs: Timeframe[]; // which IFVG timeframes the trigger scan considers

  begin: () => void; // settings come from localStorage defaults
  resume: (events: SessionEvent[], upTo: number, config?: Record<string, unknown>) => void;
  deactivate: () => void;
  setAction: (a: CandidateAction) => void;
  setWindow: (w: ExecutionWindow) => void;
  setRisk: (r: RiskSettings) => void;
  setHopWindows: (v: boolean) => void;
  setOnePosition: (v: boolean) => void;
  toggleTriggerTf: (tf: Timeframe) => void;
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
      ...computeFVGs(sources.NQ.getVisibleCandles(upTo, tf), tf, upTo, {
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
      ifvg: draft.ifvg,
      stop: draft.stop,
      entryEst: draft.entryEst,
      biasId: draft.biasId,
    });
    set((s) => ({ fired: { ...s.fired, [draft.candidateId]: draft.confirmTs } }));
  };

  // Taking a trade UNARMS every same-direction armed condition gap (locked
  // 2026-07-30): a long execution clears all bullish armed states, mirror
  // for shorts. Watermarks are untouched, so a gap can re-arm — but only on
  // a fresh in-session print BEYOND its watermark (user-confirmed).
  const unarmAligned = (direction: BiasDirection) => {
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
    // size per the bot's risk setting; % risk uses CURRENT balance
    const derived = useTrading.getState().derived;
    const balance = derived.startingBalance + derived.realizedUsd;
    const stopPts = Math.abs(draft.entryEst - draft.stop);
    const qty = sizeContracts(get().risk, stopPts, balance);
    const orderId = bid();
    appendEvent('order_placed', now(), {
      orderId,
      side: draft.direction === 'long' ? 'buy' : 'sell',
      type: 'market',
      qty,
    });
    pendingEntries.push({
      orderId,
      direction: draft.direction,
      stop: roundToTick(draft.stop),
      qty,
      placedTs: now(),
    });
    refreshTrading();
    unarmAligned(draft.direction);
  };

  // Once a tracked entry fill exists, wrap it: SL at the absolute swing
  // extreme, TP at fill + 1R (locked), OCO pair, reduce-only.
  const placeLegsForFills = () => {
    if (pendingEntries.length === 0) return;
    const events = getEvents();
    const remaining: PendingEntry[] = [];
    for (const pe of pendingEntries) {
      const fill = events.find(
        (ev) => ev.type === 'order_filled' && (ev.payload as { orderId: string }).orderId === pe.orderId,
      );
      if (!fill) {
        remaining.push(pe);
        continue;
      }
      const price = (fill.payload as { price: number }).price;
      const dir = pe.direction === 'long' ? 1 : -1;
      const risk = (price - pe.stop) * dir;
      if (risk <= 0) continue; // gapped through the stop — leave unprotected? no: flat stop at 1 tick is nonsense; skip legs, user manages
      const legSide = pe.direction === 'long' ? 'sell' : 'buy';
      const ocoId = `oco-${bid()}`;
      appendEvent('order_placed', fill.tsMarket, {
        orderId: bid(),
        side: legSide,
        type: 'stop',
        qty: pe.qty,
        stopPrice: pe.stop,
        ocoId,
        reduceOnly: true,
      });
      appendEvent('order_placed', fill.tsMarket, {
        orderId: bid(),
        side: legSide,
        type: 'limit',
        qty: pe.qty,
        limitPrice: roundToTick(price + dir * risk), // 1R
        ocoId,
        reduceOnly: true,
      });
      refreshTrading();
    }
    pendingEntries = remaining;
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
    action: 'prompt-trade',
    biases: [],
    armed: {},
    watermarks: {},
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

    begin: () => {
      pendingEntries = [];
      nextBotId = 1;
      const settings = loadSettings();
      persistSettings(settings); // stamp this session's config with what it runs
      const t = now();
      const { armed, watermarks } = t ? rebuildArming(t) : { armed: {}, watermarks: {} };
      set({
        active: true,
        action: settings.action,
        window: settings.window,
        risk: settings.risk,
        hopWindows: settings.hopWindows,
        onePosition: settings.onePosition,
        triggerTfs: settings.triggerTfs,
        biases: [],
        armed,
        watermarks,
        fired: {},
        pending: null,
        queue: [],
        armedCount: 0,
      });
    },

    resume: (events, upTo, config) => {
      pendingEntries = [];
      nextBotId = events.length + 1;
      const settings = settingsFromConfig(config);
      const biases = biasesFromEvents(events);
      updateBiasDeaths(biases, sources.NQ.getVisibleBars(upTo));
      const { armed, watermarks } = rebuildArming(upTo);
      set({
        active: true,
        action: settings.action,
        window: settings.window,
        risk: settings.risk,
        hopWindows: settings.hopWindows,
        onePosition: settings.onePosition,
        triggerTfs: settings.triggerTfs,
        biases,
        armed,
        watermarks,
        fired: firedFromEvents(events),
        pending: null,
        queue: [],
        armedCount: 0,
      });
    },

    deactivate: () => {
      pendingEntries = [];
      set({ active: false, biases: [], armed: {}, watermarks: {}, fired: {}, pending: null, queue: [] });
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

      // 1. bias deaths (derived, no events)
      const biases = s.biases.map((b) => ({ ...b }));
      updateBiasDeaths(biases, newBars);

      // 2. condition gaps + arming (incremental: new bars advance each gap's
      // fill watermark; arming needs an in-session print BEYOND the
      // watermark). An armed state is only valid while its tap is in the
      // CURRENT day's session — crossing into a new trading day stales every
      // prior tap, and a stale gap re-arms only on a fresh qualifying print.
      const sessionOpen = sessionOpenOf(to);
      const condGaps = conditionGapsAt(to);
      const armed: Record<string, { t: number; ref: number }> = {};
      const watermarks: Record<string, number> = {};
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
      const conditions: ArmedCondition[] = [];
      for (const g of condGaps) {
        const at = armed[gapKey(g)];
        if (at !== undefined) conditions.push({ gap: g, armedAt: at.t });
      }

      // one-position gate (locked 2026-07-30): while a trade is on — open
      // position, ANY working order, or an entry awaiting its fill — the bot
      // doesn't look for candidates at all. Also prevents the cancel-out
      // glitch (opposite entries netting flat and orphaning every leg).
      const book = useTrading.getState().derived;
      const busy =
        book.position.qty !== 0 || book.workingOrders.length > 0 || pendingEntries.length > 0;

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
          for (const g of computeFVGs(sources.NQ.getVisibleCandles(to, tf), tf, to, {
            lookbackCandles: TRIGGER_LOOKBACK,
          })) {
            pool.push(g);
            if (g.invertedAt !== null && g.invertedAt > from && g.invertedAt <= to) triggers.push(g);
          }
        }
        drafts = matchTriggers({
          triggers,
          conditions,
          biases,
          bars1m: sources.NQ.getVisibleBars(to),
          fired: new Set(Object.keys(s.fired)),
          window: s.window,
          blockers: pool,
        }).sort((a, b) => a.confirmTs - b.confirmTs);
      }

      const armedCount = conditions.filter(
        ({ gap }) => gap.invertedAt === null && gap.expiredAt === null,
      ).length;
      set({ biases, armed, watermarks, armedCount });

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

      // 4. wrap any filled bot entries with their SL/1R-TP legs
      placeLegsForFills();

      // 5. window hopping (opt-in): outside the active window with nothing
      // running -> jump to just before the next window open ("the next
      // 9:29"). A running trade / working legs / pending fill / open prompt
      // keeps the clock going instead.
      if (get().hopWindows && !hopBusy) {
        const t = useTrading.getState().derived;
        const idle =
          t.position.qty === 0 &&
          t.workingOrders.length === 0 &&
          pendingEntries.length === 0 &&
          get().pending === null;
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
      pendingEntries = pendingEntries.filter((pe) => pe.placedTs <= to);
      const biases = s.biases
        .filter((b) => b.setTs <= to)
        .map((b) => ({ ...b, deadAt: b.deadAt !== null && b.deadAt > to ? null : b.deadAt }));
      const { armed, watermarks } = rebuildArming(to);
      set({
        biases,
        armed,
        watermarks,
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

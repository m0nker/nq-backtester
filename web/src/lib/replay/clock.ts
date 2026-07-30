// The replay clock. `currentTime` (epoch seconds UTC) is the single source of
// truth for "now". All chart data flows: currentTime -> barSource (clipped)
// -> render. Nothing renders data the clock hasn't revealed.

'use client';

import { create } from 'zustand';
import {
  ensureLoadedAround,
  getBaseResolutionSec,
  hasDataAfter,
  nextHiddenBar,
  onBarsChanged,
  sources,
  type InstrumentId,
} from '../data/barSource';
import { bucketEnd, bucketStart } from './aggregate';
import type { Timeframe } from '../types';

// Base bars per second. The top speeds are best-effort: the interval floors
// at ~4-10ms and heavy handlers (fills + bot engine) just run back-to-back,
// so 100 means "as fast as this machine can" — advances stay one base bar
// each, keeping fill timing exact (unlike big-bucket stepping, which places
// bot entries only at the advance end).
export const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 200, 500] as const;

// 'view' = follow the NQ chart timeframe; '1s' = advance one raw 1-second
// bar (no 1s chart timeframe exists — this is a step size only, available
// where the day has 1s coverage; falls back to one 1m bar elsewhere).
export type StepSize = Timeframe | 'view' | '1s';

interface ReplayState {
  currentTime: number | null;
  startTs: number | null;
  endTs: number | null; // backtest range end; the clock never advances past it
  // Per-chart display timeframes (TradingView-style): the timeframe buttons
  // and typed switcher apply to the FOCUSED chart — the one last clicked.
  timeframes: Record<InstrumentId, Timeframe>;
  focused: InstrumentId;
  stepSize: StepSize;
  playing: boolean;
  speed: number;
  dataVersion: number; // bumped when new chunks load, so the chart re-reads
  loading: boolean;

  start: (ts: number, endTs?: number | null) => Promise<void>;
  jumpTo: (ts: number) => Promise<void>; // also serves as rewind
  stepForward: () => Promise<void>;
  stepBack: () => void;
  play: () => void;
  pause: () => void;
  setSpeed: (s: number) => void;
  setTimeframe: (tf: Timeframe, instrument?: InstrumentId) => void; // default: focused chart
  setFocused: (instrument: InstrumentId) => void;
  setStepSize: (s: StepSize) => void;
  reset: () => void;
}

let playTimer: ReturnType<typeof setInterval> | null = null;

function clearTimer() {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

export const useReplay = create<ReplayState>((set, get) => {
  if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // debug handle — stripped from production builds
    (window as unknown as Record<string, unknown>).__replay = { get: () => get() };
  }
  // Any newly loaded data (prefetch, backfill, hourly history) re-renders views.
  onBarsChanged(() => set((s) => ({ dataVersion: s.dataVersion + 1 })));

  const prefetch = (ts: number) => void ensureLoadedAround(ts, 0, 2);

  const stepTf = (): Timeframe | '1s' => {
    const { stepSize, timeframes } = get();
    // stepping drives the global clock via NQ (the traded instrument)
    return stepSize === 'view' ? timeframes.NQ : stepSize;
  };

  return {
    currentTime: null,
    startTs: null,
    endTs: null,
    timeframes: { NQ: '5m', ES: '5m' },
    focused: 'NQ',
    stepSize: 'view',
    playing: false,
    speed: 5,
    dataVersion: 0,
    loading: false,

    start: async (ts, endTs = null) => {
      clearTimer();
      set({ loading: true, playing: false });
      await ensureLoadedAround(ts); // default window, capped at MAX_BASE_BARS
      set({ currentTime: ts, startTs: ts, endTs, loading: false });
    },

    jumpTo: async (ts) => {
      const { endTs } = get();
      if (endTs !== null) ts = Math.min(ts, endTs);
      clearTimer();
      set({ playing: false, loading: true });
      await ensureLoadedAround(ts); // default window, capped at MAX_BASE_BARS
      set({ currentTime: ts, loading: false });
    },

    // Advance by one bar of the step timeframe: reveal base bars through the
    // end of the bucket the next hidden bar belongs to. Completes a partial
    // candle first; skips halts/weekends naturally (buckets follow the data).
    stepForward: async () => {
      const { currentTime, endTs } = get();
      if (currentTime === null || (endTs !== null && currentTime >= endTs)) return;
      const tf = stepTf();
      // '1s' has no bucket — it reveals exactly one base bar of the seconds
      // dataset (or one 1m bar where coverage is missing). probeTf picks the
      // right dataset via the existing sub-minute machinery.
      const probeTf: Timeframe = tf === '1s' ? '15s' : tf;
      // sub-minute steps consume the NQ seconds dataset where it exists
      let next = sources.NQ.nextHiddenBarFor(currentTime, probeTf);
      if (!next && hasDataAfter(currentTime)) {
        set({ loading: true });
        await ensureLoadedAround(currentTime, 0, 3);
        set({ loading: false });
        next = sources.NQ.nextHiddenBarFor(currentTime, probeTf);
      }
      if (!next) return; // end of dataset
      let target: number;
      if (tf === '1s') {
        target = next.t + sources.NQ.stepDurFor(probeTf, currentTime);
      } else {
        target = bucketEnd(next.t, tf);
        // Always make progress: old-era sessions have bars past the nominal
        // bucket end (17:00-17:59 ET), which would otherwise pin the clock.
        target = Math.max(target, next.t + sources.NQ.stepDurFor(tf, currentTime));
      }
      if (endTs !== null) target = Math.min(target, endTs);
      set({ currentTime: target });
      prefetch(target);
    },

    // Hide the latest (possibly partial) bucket of the step timeframe.
    stepBack: () => {
      const { currentTime } = get();
      if (currentTime === null) return;
      const tf = stepTf();
      const probeTf: Timeframe = tf === '1s' ? '15s' : tf;
      const lastVis = sources.NQ.lastVisibleBarFor(currentTime, probeTf);
      if (!lastVis) return;
      set({ currentTime: tf === '1s' ? lastVis.t : bucketStart(lastVis.t, tf) });
    },

    play: () => {
      const { playing } = get();
      if (playing) return;
      set({ playing: true });
      const tick = () => {
        const { currentTime, playing, endTs } = get();
        if (!playing || currentTime === null) return;
        if (endTs !== null && currentTime >= endTs) {
          get().pause(); // reached end of backtest range
          return;
        }
        const next = nextHiddenBar(currentTime);
        if (!next) {
          if (hasDataAfter(currentTime)) {
            prefetch(currentTime); // future ticks pick it up once loaded
          } else {
            get().pause(); // end of dataset
          }
          return;
        }
        let target = next.t + getBaseResolutionSec();
        // speeds past ~100 outrun the browser's timer floor — advance several
        // bars per tick instead. Caveat: an advance spanning N bars can fill
        // bot entries up to N bars late (same as bucket stepping).
        const batch = Math.max(1, Math.round(get().speed / 100));
        for (let i = 1; i < batch; i++) {
          const nb = nextHiddenBar(target);
          if (!nb) break;
          target = nb.t + getBaseResolutionSec();
        }
        if (endTs !== null) target = Math.min(target, endTs);
        set({ currentTime: target });
        prefetch(target);
      };
      playTimer = setInterval(tick, 1000 / get().speed);
    },

    pause: () => {
      clearTimer();
      set({ playing: false });
    },

    setSpeed: (s) => {
      set({ speed: s });
      if (get().playing) {
        clearTimer();
        set({ playing: false });
        get().play();
      }
    },

    setTimeframe: (tf, instrument) =>
      set((s) => ({ timeframes: { ...s.timeframes, [instrument ?? s.focused]: tf } })),
    setFocused: (instrument) => set({ focused: instrument }),
    setStepSize: (s) => set({ stepSize: s }),

    reset: () => {
      clearTimer();
      set({ currentTime: null, startTs: null, endTs: null, playing: false });
    },
  };
});

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
} from '../data/barSource';
import { bucketEnd, bucketStart } from './aggregate';
import type { Timeframe } from '../types';

export const SPEEDS = [1, 2, 5, 10, 20] as const; // base bars per second

export type StepSize = Timeframe | 'view'; // 'view' = follow the chart timeframe

interface ReplayState {
  currentTime: number | null;
  startTs: number | null;
  endTs: number | null; // backtest range end; the clock never advances past it
  timeframe: Timeframe;
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
  setTimeframe: (tf: Timeframe) => void;
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
  // Any newly loaded data (prefetch, backfill, hourly history) re-renders views.
  onBarsChanged(() => set((s) => ({ dataVersion: s.dataVersion + 1 })));

  const prefetch = (ts: number) => void ensureLoadedAround(ts, 0, 2);

  const stepTf = (): Timeframe => {
    const { stepSize, timeframe } = get();
    return stepSize === 'view' ? timeframe : stepSize;
  };

  return {
    currentTime: null,
    startTs: null,
    endTs: null,
    timeframe: '5m',
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
      // sub-minute steps consume the NQ seconds dataset where it exists
      let next = sources.NQ.nextHiddenBarFor(currentTime, tf);
      if (!next && hasDataAfter(currentTime)) {
        set({ loading: true });
        await ensureLoadedAround(currentTime, 0, 3);
        set({ loading: false });
        next = sources.NQ.nextHiddenBarFor(currentTime, tf);
      }
      if (!next) return; // end of dataset
      let target = bucketEnd(next.t, tf);
      // Always make progress: old-era sessions have bars past the nominal
      // bucket end (17:00-17:59 ET), which would otherwise pin the clock.
      target = Math.max(target, next.t + sources.NQ.stepDurFor(tf, currentTime));
      if (endTs !== null) target = Math.min(target, endTs);
      set({ currentTime: target });
      prefetch(target);
    },

    // Hide the latest (possibly partial) bucket of the step timeframe.
    stepBack: () => {
      const { currentTime } = get();
      if (currentTime === null) return;
      const tf = stepTf();
      const lastVis = sources.NQ.lastVisibleBarFor(currentTime, tf);
      if (!lastVis) return;
      set({ currentTime: bucketStart(lastVis.t, tf) });
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
        if (endTs !== null) target = Math.min(target, endTs);
        set({ currentTime: target });
        prefetch(next.t);
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

    setTimeframe: (tf) => set({ timeframe: tf }),
    setStepSize: (s) => set({ stepSize: s }),

    reset: () => {
      clearTimer();
      set({ currentTime: null, startTs: null, endTs: null, playing: false });
    },
  };
});

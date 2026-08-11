'use client';

// UI state for the concepts (perception) overlay: which timeframes' FVGs are
// rendered on the NQ chart, plus display options. Persisted to localStorage.
// Detection itself is pure (lib/concepts/fvg.ts) — this store is display-only
// and never feeds the event log.

import { create } from 'zustand';
import { FVG_STATUSES, type FVGStatus } from './fvg';
import type { Timeframe } from '../types';

const ALL_STATUSES: FVGStatus[] = FVG_STATUSES.map((s) => s.status);

export const FVG_TF_CHOICES: readonly Timeframe[] = [
  '15s', '30s', '1m', '2m', '3m', '4m', '5m', '15m', '30m', '1h', '4h',
];

const STORE_KEY = 'concepts-v1';

interface Persisted {
  enabled: Timeframe[];
  statuses: FVGStatus[]; // which gap statuses are drawn
  showCE: boolean;
  showLiquidity: boolean; // draw-on-liquidity level lines (lib/concepts/liquidity.ts)
}

const DEFAULTS: Persisted = {
  enabled: ['15m'],
  statuses: [...ALL_STATUSES],
  showCE: true,
  showLiquidity: true,
};

// Statuses replaced the old single `showInverted` flag. A settings blob
// written before that carries showInverted only: honor it so an existing
// user's hidden IFVGs stay hidden instead of silently reappearing.
function readStatuses(p: Partial<Persisted> & { showInverted?: boolean }): FVGStatus[] {
  if (Array.isArray(p.statuses)) {
    const list = p.statuses.filter((s): s is FVGStatus => ALL_STATUSES.includes(s as FVGStatus));
    return list.length > 0 ? list : [...ALL_STATUSES];
  }
  if (p.showInverted === false) return ALL_STATUSES.filter((s) => s !== 'inverted');
  return [...ALL_STATUSES];
}

function loadPersisted(): Persisted {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      enabled: (p.enabled ?? DEFAULTS.enabled).filter((tf): tf is Timeframe =>
        FVG_TF_CHOICES.includes(tf as Timeframe),
      ),
      statuses: readStatuses(p),
      showCE: p.showCE ?? DEFAULTS.showCE,
      showLiquidity: p.showLiquidity ?? DEFAULTS.showLiquidity,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(s: Persisted) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // storage blocked/full — settings just won't survive a reload
  }
}

interface ConceptsState extends Persisted {
  panelOpen: boolean;
  toggleTf: (tf: Timeframe) => void;
  toggleStatus: (s: FVGStatus) => void;
  setShowCE: (v: boolean) => void;
  setShowLiquidity: (v: boolean) => void;
  setPanelOpen: (v: boolean) => void;
}

export const useConcepts = create<ConceptsState>((set) => {
  // Persist from the MERGED state so a new setting can never be dropped by
  // an action that forgot to thread it through.
  const commit = (s: ConceptsState, patch: Partial<Persisted>): Partial<Persisted> => {
    save({
      enabled: patch.enabled ?? s.enabled,
      statuses: patch.statuses ?? s.statuses,
      showCE: patch.showCE ?? s.showCE,
      showLiquidity: patch.showLiquidity ?? s.showLiquidity,
    });
    return patch;
  };

  return {
    ...loadPersisted(),
    panelOpen: false,

    toggleTf: (tf) =>
      set((s) =>
        commit(s, {
          enabled: s.enabled.includes(tf) ? s.enabled.filter((t) => t !== tf) : [...s.enabled, tf],
        }),
      ),

    toggleStatus: (st) =>
      set((s) =>
        commit(s, {
          statuses: s.statuses.includes(st)
            ? s.statuses.filter((x) => x !== st)
            : [...s.statuses, st],
        }),
      ),

    setShowCE: (v) => set((s) => commit(s, { showCE: v })),
    setShowLiquidity: (v) => set((s) => commit(s, { showLiquidity: v })),
    setPanelOpen: (v) => set({ panelOpen: v }),
  };
});

'use client';

// UI state for the concepts (perception) overlay: which timeframes' FVGs are
// rendered on the NQ chart, plus display options. Persisted to localStorage.
// Detection itself is pure (lib/concepts/fvg.ts) — this store is display-only
// and never feeds the event log.

import { create } from 'zustand';
import type { Timeframe } from '../types';

export const FVG_TF_CHOICES: readonly Timeframe[] = [
  '15s', '30s', '1m', '2m', '3m', '4m', '5m', '15m', '30m', '1h', '4h',
];

const STORE_KEY = 'concepts-v1';

interface Persisted {
  enabled: Timeframe[];
  showInverted: boolean;
  showCE: boolean;
}

const DEFAULTS: Persisted = { enabled: ['15m'], showInverted: true, showCE: true };

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
      showInverted: p.showInverted ?? DEFAULTS.showInverted,
      showCE: p.showCE ?? DEFAULTS.showCE,
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
  setShowInverted: (v: boolean) => void;
  setShowCE: (v: boolean) => void;
  setPanelOpen: (v: boolean) => void;
}

export const useConcepts = create<ConceptsState>((set) => ({
  ...loadPersisted(),
  panelOpen: false,

  toggleTf: (tf) =>
    set((s) => {
      const enabled = s.enabled.includes(tf)
        ? s.enabled.filter((t) => t !== tf)
        : [...s.enabled, tf];
      save({ enabled, showInverted: s.showInverted, showCE: s.showCE });
      return { enabled };
    }),

  setShowInverted: (v) =>
    set((s) => {
      save({ enabled: s.enabled, showInverted: v, showCE: s.showCE });
      return { showInverted: v };
    }),

  setShowCE: (v) =>
    set((s) => {
      save({ enabled: s.enabled, showInverted: s.showInverted, showCE: v });
      return { showCE: v };
    }),

  setPanelOpen: (v) => set({ panelOpen: v }),
}));

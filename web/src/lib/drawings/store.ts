'use client';

// User drawings (trend lines + rectangles), TradingView-style. Anchors are
// (epoch-seconds UTC, price) pairs — NOT pixels and NOT bar indices — so a
// shape spans the same wall-clock/price region on every timeframe. Stored
// per instrument and persisted to localStorage.

import { create } from 'zustand';
import type { InstrumentId } from '../data/barSource';

export type Tool = 'none' | 'line' | 'rect';

interface DrawingBase {
  id: string;
  t1: number; // epoch seconds UTC
  p1: number;
  t2: number;
  p2: number;
}
export interface LineDrawing extends DrawingBase {
  kind: 'line';
  color: string;
  width: number; // px
}
export interface RectDrawing extends DrawingBase {
  kind: 'rect';
  stroke: string;
  strokeWidth: number;
  fill: string;
  fillOpacity: number; // 0..1
}
export type Drawing = LineDrawing | RectDrawing;

export interface StyleDefaults {
  lineColor: string;
  lineWidth: number;
  rectStroke: string;
  rectStrokeWidth: number;
  rectFill: string;
  rectFillOpacity: number;
}

const STORE_KEY = 'drawings-v1';

interface Persisted {
  drawings: Record<InstrumentId, Drawing[]>;
  defaults: StyleDefaults;
}

const FALLBACK_DEFAULTS: StyleDefaults = {
  lineColor: '#38bdf8',
  lineWidth: 2,
  rectStroke: '#f5b942',
  rectStrokeWidth: 1,
  rectFill: '#f5b942',
  rectFillOpacity: 0.15,
};

function loadPersisted(): Persisted {
  const empty: Persisted = { drawings: { NQ: [], ES: [] }, defaults: FALLBACK_DEFAULTS };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      drawings: { NQ: parsed.drawings?.NQ ?? [], ES: parsed.drawings?.ES ?? [] },
      defaults: { ...FALLBACK_DEFAULTS, ...parsed.defaults },
    };
  } catch {
    return empty;
  }
}

function save(drawings: Record<InstrumentId, Drawing[]>, defaults: StyleDefaults) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ drawings, defaults }));
  } catch {
    // storage blocked/full — drawings just won't survive a reload
  }
}

let nextDrawingId = 1;
export const drawingId = () => `d${nextDrawingId++}-${Date.now().toString(36)}`;

interface DrawingsState {
  drawings: Record<InstrumentId, Drawing[]>;
  tool: Tool;
  selected: { instrument: InstrumentId; id: string } | null;
  defaults: StyleDefaults;

  setTool: (t: Tool) => void;
  add: (instrument: InstrumentId, d: Drawing) => void;
  update: (instrument: InstrumentId, id: string, patch: Partial<Drawing>) => void;
  remove: (instrument: InstrumentId, id: string) => void;
  setSelected: (sel: { instrument: InstrumentId; id: string } | null) => void;
  setDefaults: (patch: Partial<StyleDefaults>) => void;
}

export const useDrawings = create<DrawingsState>((set, get) => {
  const persisted = loadPersisted();
  return {
    drawings: persisted.drawings,
    tool: 'none',
    selected: null,
    defaults: persisted.defaults,

    setTool: (t) => set({ tool: t, selected: null }),

    add: (instrument, d) =>
      set((s) => {
        const drawings = { ...s.drawings, [instrument]: [...s.drawings[instrument], d] };
        save(drawings, s.defaults);
        return { drawings, selected: { instrument, id: d.id } };
      }),

    update: (instrument, id, patch) =>
      set((s) => {
        const drawings = {
          ...s.drawings,
          [instrument]: s.drawings[instrument].map((d) =>
            d.id === id ? ({ ...d, ...patch } as Drawing) : d,
          ),
        };
        save(drawings, s.defaults);
        return { drawings };
      }),

    remove: (instrument, id) =>
      set((s) => {
        const drawings = {
          ...s.drawings,
          [instrument]: s.drawings[instrument].filter((d) => d.id !== id),
        };
        save(drawings, s.defaults);
        return {
          drawings,
          selected: s.selected?.id === id ? null : s.selected,
        };
      }),

    setSelected: (sel) => set({ selected: sel }),

    setDefaults: (patch) =>
      set((s) => {
        const defaults = { ...s.defaults, ...patch };
        save(get().drawings, defaults);
        return { defaults };
      }),
  };
});

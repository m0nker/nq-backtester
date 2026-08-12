'use client';

// UI state for the concepts (perception) overlay: which timeframes' FVGs are
// rendered on the NQ chart, plus display options. Persisted to localStorage.
// Detection itself is pure (lib/concepts/fvg.ts) — this store is display-only
// and never feeds the event log.

import { create } from 'zustand';
import { FVG_STATUSES, type FVGStatus } from './fvg';
import { ALL_DOL_KINDS, isDOLKind, type DOLKind } from './liquidity';
import {
  DEFAULT_SESSIONS_CFG,
  sanitizeSessionsCfg,
  type SessionKey,
  type SessionWindowCfg,
  type SessionsCfg,
} from './sessionBoxes';
import type { Timeframe } from '../types';

const ALL_STATUSES: FVGStatus[] = FVG_STATUSES.map((s) => s.status);

export const FVG_TF_CHOICES: readonly Timeframe[] = [
  '15s', '30s', '1m', '2m', '3m', '4m', '5m', '15m', '30m', '1h', '4h',
];

const STORE_KEY = 'concepts-v1';

// Which overlay's settings menu is open (one at a time, like TradingView's
// indicator dialogs).
export type OverlayPanel = 'fvg' | 'liq' | 'sess' | 'chart' | null;

// Chart-wide colors, editable in the CHART panel and saveable as named
// profiles. Consumed by ReplayChart (applyOptions on change, both charts).
export interface ChartColors {
  background: string;
  grid: string;
  gridOpacityPct: number;
  text: string;
  upBody: string;
  downBody: string;
  border: string; // candle borders (up + down)
  wick: string; // wicks (up + down)
  crosshair: string;
  priceLine: string; // dotted current-price line
}

// The user's TradingView scheme.
export const DEFAULT_CHART_COLORS: ChartColors = {
  background: '#9c9c9c',
  grid: '#f0f3fa',
  gridOpacityPct: 6,
  text: '#1e222d',
  upBody: '#b2b5be',
  downBody: '#434651',
  border: '#000000',
  wick: '#000000',
  crosshair: '#000000',
  priceLine: '#000000',
};

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeChartColors(raw: unknown): ChartColors {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<ChartColors>;
  const color = (v: unknown, dflt: string) => (typeof v === 'string' && COLOR_RE.test(v) ? v : dflt);
  const d = DEFAULT_CHART_COLORS;
  return {
    background: color(p.background, d.background),
    grid: color(p.grid, d.grid),
    gridOpacityPct:
      typeof p.gridOpacityPct === 'number' && Number.isFinite(p.gridOpacityPct)
        ? Math.min(100, Math.max(0, Math.round(p.gridOpacityPct)))
        : d.gridOpacityPct,
    text: color(p.text, d.text),
    upBody: color(p.upBody, d.upBody),
    downBody: color(p.downBody, d.downBody),
    border: color(p.border, d.border),
    wick: color(p.wick, d.wick),
    crosshair: color(p.crosshair, d.crosshair),
    priceLine: color(p.priceLine, d.priceLine),
  };
}

interface Persisted {
  enabled: Timeframe[];
  statuses: FVGStatus[]; // which gap statuses are drawn
  showCE: boolean;
  fvgBull: string; // FVG box colors + outline toggle (visibility on light canvases)
  fvgBear: string;
  fvgOutline: boolean;
  showLiquidity: boolean; // draw-on-liquidity level lines (lib/concepts/liquidity.ts)
  liqKinds: DOLKind[]; // which DOL categories the LIQ overlay draws (display-only)
  sessions: SessionsCfg; // killzone session boxes (lib/concepts/sessionBoxes.ts)
  chartColors: ChartColors;
  chartProfiles: Record<string, ChartColors>; // named saved color combos
  followTail: boolean; // pin the newest candle at a fixed x on every advance
  // Bot scope highlights: the zones the ENGINE is actually using, drawn
  // regardless of which indicator timeframes are toggled on.
  showBotConditions: boolean;
  showBotTriggers: boolean;
  // ...and which SIDE of the book to draw. A bull condition / bear trigger
  // gap belongs to the long side; their mirrors to the short side.
  showBotLong: boolean;
  showBotShort: boolean;
}

const DEFAULTS: Persisted = {
  enabled: ['15m'],
  statuses: [...ALL_STATUSES],
  showCE: true,
  fvgBull: '#26a69a',
  fvgBear: '#ef5350',
  fvgOutline: true,
  showLiquidity: true,
  liqKinds: [...ALL_DOL_KINDS],
  sessions: DEFAULT_SESSIONS_CFG,
  chartColors: DEFAULT_CHART_COLORS,
  chartProfiles: {},
  followTail: true,
  showBotConditions: true,
  showBotTriggers: false,
  showBotLong: true,
  showBotShort: true,
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
      fvgBull: typeof p.fvgBull === 'string' && COLOR_RE.test(p.fvgBull) ? p.fvgBull : DEFAULTS.fvgBull,
      fvgBear: typeof p.fvgBear === 'string' && COLOR_RE.test(p.fvgBear) ? p.fvgBear : DEFAULTS.fvgBear,
      fvgOutline: p.fvgOutline ?? DEFAULTS.fvgOutline,
      showLiquidity: p.showLiquidity ?? DEFAULTS.showLiquidity,
      // an explicitly-empty list is a valid choice (all kinds toggled off)
      liqKinds: Array.isArray(p.liqKinds) ? p.liqKinds.filter(isDOLKind) : [...ALL_DOL_KINDS],
      sessions: sanitizeSessionsCfg(p.sessions),
      chartColors: sanitizeChartColors(p.chartColors),
      chartProfiles:
        typeof p.chartProfiles === 'object' && p.chartProfiles !== null
          ? Object.fromEntries(
              Object.entries(p.chartProfiles)
                .slice(0, 30)
                .map(([name, c]) => [name.slice(0, 40), sanitizeChartColors(c)]),
            )
          : {},
      followTail: p.followTail ?? DEFAULTS.followTail,
      showBotConditions: p.showBotConditions ?? DEFAULTS.showBotConditions,
      showBotTriggers: p.showBotTriggers ?? DEFAULTS.showBotTriggers,
      showBotLong: p.showBotLong ?? DEFAULTS.showBotLong,
      showBotShort: p.showBotShort ?? DEFAULTS.showBotShort,
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
  openPanel: OverlayPanel;
  toggleTf: (tf: Timeframe) => void;
  toggleStatus: (s: FVGStatus) => void;
  setShowCE: (v: boolean) => void;
  updateFvgStyle: (patch: Partial<Pick<Persisted, 'fvgBull' | 'fvgBear' | 'fvgOutline'>>) => void;
  setShowLiquidity: (v: boolean) => void;
  updateChartColors: (patch: Partial<ChartColors>) => void;
  saveChartProfile: (name: string) => void;
  applyChartProfile: (name: string) => void;
  deleteChartProfile: (name: string) => void;
  setFollowTail: (v: boolean) => void;
  toggleLiqKind: (k: DOLKind) => void;
  updateSessions: (patch: Partial<Pick<SessionsCfg, 'show' | 'days' | 'showPD' | 'boxFillPct'>>) => void;
  updateSessionWindow: (key: SessionKey, patch: Partial<Omit<SessionWindowCfg, 'key' | 'label'>>) => void;
  setShowBotConditions: (v: boolean) => void;
  setShowBotTriggers: (v: boolean) => void;
  setShowBotLong: (v: boolean) => void;
  setShowBotShort: (v: boolean) => void;
  setOpenPanel: (v: OverlayPanel) => void;
}

export const useConcepts = create<ConceptsState>((set) => {
  // Persist from the MERGED state so a new setting can never be dropped by
  // an action that forgot to thread it through.
  const commit = (s: ConceptsState, patch: Partial<Persisted>): Partial<Persisted> => {
    save({
      enabled: patch.enabled ?? s.enabled,
      statuses: patch.statuses ?? s.statuses,
      showCE: patch.showCE ?? s.showCE,
      fvgBull: patch.fvgBull ?? s.fvgBull,
      fvgBear: patch.fvgBear ?? s.fvgBear,
      fvgOutline: patch.fvgOutline ?? s.fvgOutline,
      showLiquidity: patch.showLiquidity ?? s.showLiquidity,
      liqKinds: patch.liqKinds ?? s.liqKinds,
      sessions: patch.sessions ?? s.sessions,
      chartColors: patch.chartColors ?? s.chartColors,
      chartProfiles: patch.chartProfiles ?? s.chartProfiles,
      followTail: patch.followTail ?? s.followTail,
      showBotConditions: patch.showBotConditions ?? s.showBotConditions,
      showBotTriggers: patch.showBotTriggers ?? s.showBotTriggers,
      showBotLong: patch.showBotLong ?? s.showBotLong,
      showBotShort: patch.showBotShort ?? s.showBotShort,
    });
    return patch;
  };

  return {
    ...loadPersisted(),
    openPanel: null,

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
    updateFvgStyle: (patch) => set((s) => commit(s, patch)),
    setShowLiquidity: (v) => set((s) => commit(s, { showLiquidity: v })),

    updateChartColors: (patch) =>
      set((s) => commit(s, { chartColors: { ...s.chartColors, ...patch } })),
    saveChartProfile: (name) =>
      set((s) => {
        const trimmed = name.trim().slice(0, 40);
        if (!trimmed) return {};
        return commit(s, {
          chartProfiles: { ...s.chartProfiles, [trimmed]: { ...s.chartColors } },
        });
      }),
    applyChartProfile: (name) =>
      set((s) => (s.chartProfiles[name] ? commit(s, { chartColors: { ...s.chartProfiles[name] } }) : {})),
    deleteChartProfile: (name) =>
      set((s) => {
        const rest = { ...s.chartProfiles };
        delete rest[name];
        return commit(s, { chartProfiles: rest });
      }),
    setFollowTail: (v) => set((s) => commit(s, { followTail: v })),

    toggleLiqKind: (k) =>
      set((s) =>
        commit(s, {
          liqKinds: s.liqKinds.includes(k) ? s.liqKinds.filter((x) => x !== k) : [...s.liqKinds, k],
        }),
      ),

    updateSessions: (patch) => set((s) => commit(s, { sessions: { ...s.sessions, ...patch } })),

    updateSessionWindow: (key, patch) =>
      set((s) =>
        commit(s, {
          sessions: {
            ...s.sessions,
            windows: s.sessions.windows.map((w) => (w.key === key ? { ...w, ...patch } : w)),
          },
        }),
      ),

    setShowBotConditions: (v) => set((s) => commit(s, { showBotConditions: v })),
    setShowBotTriggers: (v) => set((s) => commit(s, { showBotTriggers: v })),
    setShowBotLong: (v) => set((s) => commit(s, { showBotLong: v })),
    setShowBotShort: (v) => set((s) => commit(s, { showBotShort: v })),
    setOpenPanel: (v) => set({ openPanel: v }),
  };
});

// Killzone session boxes — pure computation for the SessionLayer overlay.
// TradingView-style: each enabled session (Asia / London / NY AM / NY PM)
// draws a translucent box over its ET window spanning the session's H/L, and
// once the session completes, a horizontal line off each extreme that extends
// right until price trades strictly beyond it ("taken") or until now.
// Display-only — nothing here feeds the bot or the event log.
//
// Times are ET wall-clock "HH:MM" strings, editable in the settings panel the
// same way the TradingView indicator does it. An end at or before the start
// means the window crosses midnight (Asia 20:00–00:00).

import { bucketEnd } from '../replay/aggregate';
import { etOffsetSec, etWallToUtc } from '../time/et';
import type { Bar, Timeframe } from '../types';

export type SessionKey = 'asia' | 'london' | 'nyam' | 'nypm';

export interface SessionWindowCfg {
  key: SessionKey;
  label: string;
  enabled: boolean;
  start: string; // "HH:MM" ET
  end: string; // "HH:MM" ET; <= start crosses midnight
  color: string; // #rrggbb
  opacityPct: number; // TradingView color opacity — drives the box fill
}

export interface SessionsCfg {
  show: boolean;
  days: number; // most recent N occurrences of each session kind
  showPD: boolean; // previous trading day H/L lines
  boxFillPct: number; // extra transparency on box fills (100 = color opacity as-is)
  windows: SessionWindowCfg[];
}

// User's TradingView setup: colors as-is, boxes "rather transparent", the
// H/L line the same color at full opacity.
export const DEFAULT_SESSIONS_CFG: SessionsCfg = {
  show: true,
  days: 3,
  showPD: true,
  boxFillPct: 50,
  windows: [
    { key: 'asia', label: 'Asia', enabled: true, start: '20:00', end: '00:00', color: '#f57f17', opacityPct: 27 },
    { key: 'london', label: 'London', enabled: true, start: '02:00', end: '05:00', color: '#1848cc', opacityPct: 75 },
    { key: 'nyam', label: 'NY AM', enabled: true, start: '09:30', end: '11:00', color: '#97454b', opacityPct: 100 },
    { key: 'nypm', label: 'NY PM', enabled: true, start: '13:00', end: '16:00', color: '#388e3c', opacityPct: 100 },
  ],
};

const TIME_RE = /^\d{1,2}:\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt;

// Merge a persisted blob over the defaults, keyed per window so new fields
// (and new sessions) added later pick up their defaults instead of vanishing.
export function sanitizeSessionsCfg(raw: unknown): SessionsCfg {
  const d = DEFAULT_SESSIONS_CFG;
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<SessionsCfg>;
  const persisted = Array.isArray(p.windows) ? (p.windows as Partial<SessionWindowCfg>[]) : [];
  const windows = d.windows.map((dw) => {
    const pw = persisted.find((x) => x && x.key === dw.key);
    return {
      ...dw,
      enabled: typeof pw?.enabled === 'boolean' ? pw.enabled : dw.enabled,
      start: typeof pw?.start === 'string' && TIME_RE.test(pw.start) ? pw.start : dw.start,
      end: typeof pw?.end === 'string' && TIME_RE.test(pw.end) ? pw.end : dw.end,
      color: typeof pw?.color === 'string' && COLOR_RE.test(pw.color) ? pw.color : dw.color,
      opacityPct: clampInt(pw?.opacityPct, 0, 100, dw.opacityPct),
    };
  });
  return {
    show: typeof p.show === 'boolean' ? p.show : d.show,
    days: clampInt(p.days, 1, 10, d.days),
    showPD: typeof p.showPD === 'boolean' ? p.showPD : d.showPD,
    boxFillPct: clampInt(p.boxFillPct, 0, 100, d.boxFillPct),
    windows,
  };
}

export interface SessionBox {
  id: string;
  cfg: SessionWindowCfg;
  startTs: number;
  endTs: number; // scheduled end — may be past `upTo` while live
  hi: number;
  lo: number;
  live: boolean; // still forming; no H/L lines yet
  hiTakenAt: number | null; // completed boxes: first print strictly beyond
  loTakenAt: number | null;
}

export interface PDLevel {
  side: 'high' | 'low';
  price: number;
  anchorTs: number; // when the previous day actually printed the extreme — the line starts here
  formedAt: number; // day close — the level only counts as "previous day H/L" from here on
  takenAt: number | null;
}

export interface SessionOverlay {
  boxes: SessionBox[];
  pd: PDLevel[];
}

export interface SessionDataSource {
  barsInWindow: (afterTs: number, upTo: number) => Bar[]; // 1m bars closing in (afterTs, upTo]
  candles: (upTo: number, tf: Timeframe) => Bar[];
}

const hhmm = (s: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? [Math.min(23, +m[1]), Math.min(59, +m[2])] : [0, 0];
};

const etDateOf = (ts: number): { y: number; mo: number; d: number } => {
  const d = new Date((ts + etOffsetSec(ts)) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

const shiftDays = (p: { y: number; mo: number; d: number }, days: number) => {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d) + days * 86_400_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
};

export function computeSessionOverlay(
  src: SessionDataSource,
  upTo: number,
  cfg: SessionsCfg,
): SessionOverlay {
  const boxes: SessionBox[] = [];
  const want = Math.max(1, cfg.days);
  const maxBack = want + 6; // weekends/holidays yield empty windows — search past them

  for (const w of cfg.windows) {
    if (!w.enabled) continue;
    const [sh, sm] = hhmm(w.start);
    const [eh, em] = hhmm(w.end);
    const crossesMidnight = eh * 60 + em <= sh * 60 + sm;
    let found = 0;
    let day = etDateOf(upTo);
    for (let back = 0; back <= maxBack && found < want; back++, day = shiftDays(day, -1)) {
      // wall-clock conversion per bound so a DST Sunday can't skew the window
      const startTs = etWallToUtc(day.y, day.mo, day.d, sh, sm);
      const endDay = crossesMidnight ? shiftDays(day, 1) : day;
      const endTs = etWallToUtc(endDay.y, endDay.mo, endDay.d, eh, em);
      if (startTs >= upTo) continue; // hasn't opened yet today
      const live = endTs > upTo;
      const bars = src.barsInWindow(startTs - 60, Math.min(endTs, upTo));
      if (bars.length === 0) continue; // closed market day
      let hi = -Infinity;
      let lo = Infinity;
      for (const b of bars) {
        if (b.h > hi) hi = b.h;
        if (b.l < lo) lo = b.l;
      }
      boxes.push({
        id: `${w.key}:${day.y}-${day.mo}-${day.d}`,
        cfg: w,
        startTs,
        endTs,
        hi,
        lo,
        live,
        hiTakenAt: null,
        loTakenAt: null,
      });
      found++;
    }
  }

  const pd: PDLevel[] = [];
  if (cfg.showPD) {
    // last candle of the 1D series is the current (possibly partial) trading
    // day; the one before it is the completed previous day
    const daily = src.candles(upTo, '1D');
    if (daily.length >= 2) {
      const prev = daily[daily.length - 2];
      const formedAt = bucketEnd(prev.t, '1D');
      // anchor each line at the bar that actually printed the extreme (the
      // daily candle is aggregated from these same bars, so exact-match works)
      let hiAnchor = prev.t;
      let loAnchor = prev.t;
      let hiFound = false;
      let loFound = false;
      for (const b of src.barsInWindow(prev.t - 60, formedAt)) {
        if (!hiFound && b.h === prev.h) { hiAnchor = b.t; hiFound = true; }
        if (!loFound && b.l === prev.l) { loAnchor = b.t; loFound = true; }
        if (hiFound && loFound) break;
      }
      pd.push({ side: 'high', price: prev.h, anchorTs: hiAnchor, formedAt, takenAt: null });
      pd.push({ side: 'low', price: prev.l, anchorTs: loAnchor, formedAt, takenAt: null });
    }
  }

  // Take scan: ONE shared bar slice from the earliest line origin; per line a
  // binary search to its start plus a forward scan with early exit.
  let earliest = Infinity;
  for (const b of boxes) if (!b.live) earliest = Math.min(earliest, b.endTs);
  for (const l of pd) earliest = Math.min(earliest, l.formedAt);
  if (Number.isFinite(earliest) && earliest < upTo) {
    const bars = src.barsInWindow(earliest - 60, upTo);
    const takeAfter = (from: number, pred: (b: Bar) => boolean): number | null => {
      let lo2 = 0;
      let hi2 = bars.length;
      while (lo2 < hi2) {
        const mid = (lo2 + hi2) >> 1;
        if (bars[mid].t < from) lo2 = mid + 1;
        else hi2 = mid;
      }
      for (let i = lo2; i < bars.length; i++) if (pred(bars[i])) return bars[i].t;
      return null;
    };
    for (const b of boxes) {
      if (b.live) continue;
      b.hiTakenAt = takeAfter(b.endTs, (bar) => bar.h > b.hi);
      b.loTakenAt = takeAfter(b.endTs, (bar) => bar.l < b.lo);
    }
    for (const l of pd) {
      l.takenAt = takeAfter(
        l.formedAt,
        l.side === 'high' ? (bar) => bar.h > l.price : (bar) => bar.l < l.price,
      );
    }
  }

  return { boxes, pd };
}

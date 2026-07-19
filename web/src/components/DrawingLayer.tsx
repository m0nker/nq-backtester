'use client';

// TradingView-style drawing overlay: trend lines + rectangles on an SVG
// layer above the chart. Anchors live in (epoch time, price) space (see
// lib/drawings/store.ts) so shapes are timeframe-invariant; this component
// only converts anchors <-> pixels at render time.
//
// time <-> x goes through LWC's LOGICAL (bar index) space, interpolating
// between the chart's own candles — linear-in-time mapping would misplace
// shapes across weekend/halt gaps, which the chart compresses.
//
// Interactions: toolbar picks a tool; click-move-click places (Escape
// cancels); click selects; drag body/handles edits. Ctrl = magnet-snap to
// the nearest bar's OHLC; Shift (lines) = snap the moving end to 45° steps.

import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { InstrumentId } from '@/lib/data/barSource';
import {
  drawingId,
  useDrawings,
  type Drawing,
  type RectDrawing,
  type StyleDefaults,
} from '@/lib/drawings/store';
import type { Bar } from '@/lib/types';

export interface ChartGeo {
  candles: Bar[];
  tfSec: number; // seconds per bucket at the current timeframe (for extrapolation)
}

interface Props {
  instrument: InstrumentId;
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  geoRef: React.RefObject<ChartGeo | null>;
  overlayTick: number; // bumped by ReplayChart on any pan/zoom/scale/data change
}

type Handle = 'body' | { tKey: 't1' | 't2'; pKey: 'p1' | 'p2' };

function timeToLogical(candles: Bar[], t: number, tfSec: number): number {
  const n = candles.length;
  if (n === 0) return 0;
  if (n === 1 || t <= candles[0].t) return (t - candles[0].t) / tfSec;
  if (t >= candles[n - 1].t) return n - 1 + (t - candles[n - 1].t) / tfSec;
  let lo = 0,
    hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (candles[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const span = candles[lo + 1].t - candles[lo].t;
  return lo + (t - candles[lo].t) / span;
}

function logicalToTime(candles: Bar[], logical: number, tfSec: number): number {
  const n = candles.length;
  if (n === 0) return 0;
  if (n === 1 || logical <= 0) return (candles[0]?.t ?? 0) + logical * tfSec;
  if (logical >= n - 1) return candles[n - 1].t + (logical - (n - 1)) * tfSec;
  const i = Math.floor(logical);
  const span = candles[i + 1].t - candles[i].t;
  return candles[i].t + (logical - i) * span;
}

export default function DrawingLayer({ instrument, chartRef, seriesRef, geoRef, overlayTick }: Props) {
  void overlayTick; // re-render trigger; coordinates read fresh below
  const rootRef = useRef<HTMLDivElement>(null);
  const drawings = useDrawings((s) => s.drawings[instrument]);
  const tool = useDrawings((s) => s.tool);
  const selected = useDrawings((s) => s.selected);
  const defaults = useDrawings((s) => s.defaults);
  const [draft, setDraft] = useState<{ t1: number; p1: number; t2: number; p2: number } | null>(
    null,
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // tool switched off (Escape / other chart finished a shape) — drop drafts
  useEffect(() => {
    if (tool === 'none') setDraft(null);
  }, [tool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
      const st = useDrawings.getState();
      if (e.key === 'Escape' && st.tool !== 'none') st.setTool('none');
      if ((e.key === 'Delete' || e.key === 'Backspace') && st.selected?.instrument === instrument) {
        st.remove(instrument, st.selected.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [instrument]);

  // clicking anywhere outside the layer (chart background, controls) deselects;
  // shape/handle pointerdowns stopPropagation so they never reach here
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const st = useDrawings.getState();
      if (st.selected?.instrument !== instrument) return;
      if (rootRef.current?.contains(e.target as Node)) return;
      st.setSelected(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [instrument]);

  // ---- coordinate conversion ----

  const toXY = (t: number, p: number): { x: number; y: number } | null => {
    const chart = chartRef.current,
      series = seriesRef.current,
      geo = geoRef.current;
    if (!chart || !series || !geo || geo.candles.length === 0) return null;
    const x = chart
      .timeScale()
      .logicalToCoordinate(timeToLogical(geo.candles, t, geo.tfSec) as Logical);
    const y = series.priceToCoordinate(p);
    if (x === null || y === null) return null;
    return { x, y };
  };

  const fromXY = (x: number, y: number): { t: number; p: number } | null => {
    const chart = chartRef.current,
      series = seriesRef.current,
      geo = geoRef.current;
    if (!chart || !series || !geo || geo.candles.length === 0) return null;
    const logical = chart.timeScale().coordinateToLogical(x);
    const p = series.coordinateToPrice(y);
    if (logical === null || p === null) return null;
    return { t: logicalToTime(geo.candles, logical as number, geo.tfSec), p: p as number };
  };

  // Ctrl: magnet to the nearest bar's nearest OHLC value
  const magnetSnap = (t: number, p: number, ev: { ctrlKey: boolean; metaKey: boolean }) => {
    if (!ev.ctrlKey && !ev.metaKey) return { t, p };
    const geo = geoRef.current;
    if (!geo || geo.candles.length === 0) return { t, p };
    const i = Math.min(
      Math.max(Math.round(timeToLogical(geo.candles, t, geo.tfSec)), 0),
      geo.candles.length - 1,
    );
    const bar = geo.candles[i];
    let best = bar.o;
    for (const pr of [bar.h, bar.l, bar.c]) if (Math.abs(pr - p) < Math.abs(best - p)) best = pr;
    return { t: bar.t, p: best };
  };

  // Shift: keep the moving end at a 45°-multiple from the fixed end (screen space)
  const angleSnap = (fixed: { x: number; y: number }, moving: { x: number; y: number }) => {
    const dx = moving.x - fixed.x,
      dy = moving.y - fixed.y;
    const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const r = Math.hypot(dx, dy);
    return { x: fixed.x + r * Math.cos(snapped), y: fixed.y + r * Math.sin(snapped) };
  };

  const secondAnchor = (
    ev: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    rect: DOMRect,
    from: { t1: number; p1: number },
    isLine: boolean,
  ): { t: number; p: number } | null => {
    const raw = fromXY(ev.clientX - rect.left, ev.clientY - rect.top);
    if (!raw) return null;
    let pt = magnetSnap(raw.t, raw.p, ev);
    if (ev.shiftKey && isLine) {
      const fixedXY = toXY(from.t1, from.p1);
      const movXY = toXY(pt.t, pt.p);
      if (fixedXY && movXY) {
        const sn = angleSnap(fixedXY, movXY);
        const back = fromXY(sn.x, sn.y);
        if (back) pt = back;
      }
    }
    return pt;
  };

  // ---- placement (tool active) ----

  const onCaptureDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = rootRef.current!.getBoundingClientRect();
    const cur = draftRef.current;
    if (!cur) {
      const raw = fromXY(e.clientX - rect.left, e.clientY - rect.top);
      if (!raw) return;
      const pt = magnetSnap(raw.t, raw.p, e);
      setDraft({ t1: pt.t, p1: pt.p, t2: pt.t, p2: pt.p });
      return;
    }
    const end = secondAnchor(e, rect, cur, tool === 'line');
    if (!end) return;
    const st = useDrawings.getState();
    const base = { id: drawingId(), t1: cur.t1, p1: cur.p1, t2: end.t, p2: end.p };
    if (tool === 'line') {
      st.add(instrument, { ...base, kind: 'line', color: defaults.lineColor, width: defaults.lineWidth });
    } else {
      st.add(instrument, {
        ...base,
        kind: 'rect',
        stroke: defaults.rectStroke,
        strokeWidth: defaults.rectStrokeWidth,
        fill: defaults.rectFill,
        fillOpacity: defaults.rectFillOpacity,
      });
    }
    st.setTool('none'); // also clears drafts via the effect above
  };

  const onCaptureMove = (e: React.PointerEvent) => {
    const cur = draftRef.current;
    if (!cur) return;
    const rect = rootRef.current!.getBoundingClientRect();
    const end = secondAnchor(e, rect, cur, tool === 'line');
    if (end) setDraft({ ...cur, t2: end.t, p2: end.p });
  };

  // ---- edit drags (tool inactive) ----

  const startShapeDrag = (e: React.PointerEvent, d: Drawing, handle: Handle) => {
    if (useDrawings.getState().tool !== 'none') return;
    e.preventDefault();
    e.stopPropagation();
    useDrawings.getState().setSelected({ instrument, id: d.id });
    const rect = rootRef.current!.getBoundingClientRect();
    const orig = { t1: d.t1, p1: d.p1, t2: d.t2, p2: d.p2 };
    const start = fromXY(e.clientX - rect.left, e.clientY - rect.top);
    if (!start) return;
    const move = (ev: PointerEvent) => {
      const st = useDrawings.getState();
      if (handle === 'body') {
        const cur = fromXY(ev.clientX - rect.left, ev.clientY - rect.top);
        if (!cur) return;
        const dt = cur.t - start.t,
          dp = cur.p - start.p;
        st.update(instrument, d.id, {
          t1: orig.t1 + dt,
          t2: orig.t2 + dt,
          p1: orig.p1 + dp,
          p2: orig.p2 + dp,
        });
      } else {
        const fixed = {
          t1: handle.tKey === 't1' ? orig.t2 : orig.t1,
          p1: handle.pKey === 'p1' ? orig.p2 : orig.p1,
        };
        const pt = secondAnchor(ev, rect, fixed, d.kind === 'line');
        if (!pt) return;
        st.update(instrument, d.id, { [handle.tKey]: pt.t, [handle.pKey]: pt.p });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ---- render ----

  let paneW = 0,
    paneH = 0;
  try {
    const size = chartRef.current?.paneSize();
    paneW = size?.width ?? 0;
    paneH = size?.height ?? 0;
  } catch {
    // chart mid-teardown
  }

  const isSel = (d: Drawing) => selected?.instrument === instrument && selected.id === d.id;
  const selDrawing = drawings.find((d) => isSel(d)) ?? null;

  const handleDots = (d: Drawing, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dots: { x: number; y: number; h: Handle }[] =
      d.kind === 'line'
        ? [
            { x: a.x, y: a.y, h: { tKey: 't1', pKey: 'p1' } },
            { x: b.x, y: b.y, h: { tKey: 't2', pKey: 'p2' } },
          ]
        : [
            { x: a.x, y: a.y, h: { tKey: 't1', pKey: 'p1' } },
            { x: b.x, y: b.y, h: { tKey: 't2', pKey: 'p2' } },
            { x: a.x, y: b.y, h: { tKey: 't1', pKey: 'p2' } },
            { x: b.x, y: a.y, h: { tKey: 't2', pKey: 'p1' } },
          ];
    return dots.map((dot, i) => (
      <circle
        key={i}
        cx={dot.x}
        cy={dot.y}
        r={5}
        fill="#0d1119"
        stroke="#f5b942"
        strokeWidth={1.5}
        pointerEvents="all"
        style={{ cursor: 'grab' }}
        onPointerDown={(e) => startShapeDrag(e, d, dot.h)}
      />
    ));
  };

  const renderDrawing = (d: Drawing, preview = false) => {
    const a = toXY(d.t1, d.p1),
      b = toXY(d.t2, d.p2);
    if (!a || !b) return null;
    if (d.kind === 'line') {
      return (
        <g key={d.id}>
          {!preview && (
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="transparent"
              strokeWidth={12}
              pointerEvents="stroke"
              style={{ cursor: 'move' }}
              onPointerDown={(e) => startShapeDrag(e, d, 'body')}
            />
          )}
          <line
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={d.color}
            strokeWidth={d.width}
            strokeDasharray={preview ? '4 3' : undefined}
            pointerEvents="none"
          />
          {!preview && isSel(d) && handleDots(d, a, b)}
        </g>
      );
    }
    const x = Math.min(a.x, b.x),
      y = Math.min(a.y, b.y);
    return (
      <g key={d.id}>
        <rect
          x={x}
          y={y}
          width={Math.abs(b.x - a.x)}
          height={Math.abs(b.y - a.y)}
          fill={d.fill}
          fillOpacity={d.fillOpacity}
          stroke={d.stroke}
          strokeWidth={d.strokeWidth}
          strokeDasharray={preview ? '4 3' : undefined}
          pointerEvents={preview ? 'none' : 'all'}
          style={preview ? undefined : { cursor: 'move' }}
          onPointerDown={preview ? undefined : (e) => startShapeDrag(e, d, 'body')}
        />
        {!preview && isSel(d) && handleDots(d, a, b)}
      </g>
    );
  };

  const toolBtn = (active: boolean) =>
    `flex h-7 w-7 items-center justify-center rounded border text-sm ${
      active
        ? 'border-amber-400 bg-amber-500/25 text-amber-300'
        : 'border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800'
    }`;

  const setSel = (patch: Partial<Drawing>, defPatch: Partial<StyleDefaults>) => {
    if (!selDrawing) return;
    useDrawings.getState().update(instrument, selDrawing.id, patch);
    useDrawings.getState().setDefaults(defPatch); // remember last-used style
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[6]">
      {paneW > 0 && (
        <svg width={paneW} height={paneH} className="absolute left-0 top-0" style={{ pointerEvents: 'none' }}>
          {drawings.map((d) => renderDrawing(d))}
          {draft &&
            renderDrawing(
              tool === 'line'
                ? { id: '__draft', kind: 'line', ...draft, color: defaults.lineColor, width: defaults.lineWidth }
                : {
                    id: '__draft',
                    kind: 'rect',
                    ...draft,
                    stroke: defaults.rectStroke,
                    strokeWidth: defaults.rectStrokeWidth,
                    fill: defaults.rectFill,
                    fillOpacity: defaults.rectFillOpacity,
                  },
              true,
            )}
        </svg>
      )}

      {/* drawing capture surface while a tool is armed */}
      {tool !== 'none' && paneW > 0 && (
        <div
          className="pointer-events-auto absolute left-0 top-0 cursor-crosshair"
          style={{ width: paneW, height: paneH }}
          onPointerDown={onCaptureDown}
          onPointerMove={onCaptureMove}
        />
      )}

      {/* toolbar */}
      <div className="pointer-events-auto absolute left-2 top-9 z-20 flex flex-col gap-1">
        <button
          className={toolBtn(tool === 'line')}
          title="Trend line — click two points; Ctrl snaps to OHLC, Shift snaps angle; Esc cancels"
          onClick={() => useDrawings.getState().setTool(tool === 'line' ? 'none' : 'line')}
        >
          ╱
        </button>
        <button
          className={toolBtn(tool === 'rect')}
          title="Rectangle — click two corners; Ctrl snaps to OHLC; Esc cancels"
          onClick={() => useDrawings.getState().setTool(tool === 'rect' ? 'none' : 'rect')}
        >
          ▭
        </button>
      </div>

      {/* style editor for the selected drawing */}
      {selDrawing && tool === 'none' && (
        <div className="pointer-events-auto absolute left-11 top-9 z-20 flex items-center gap-2 rounded border border-slate-700 bg-[#0d1119]/95 px-2 py-1.5 text-xs text-slate-300">
          {selDrawing.kind === 'line' ? (
            <>
              <label className="flex items-center gap-1">
                color
                <input
                  type="color"
                  value={selDrawing.color}
                  onChange={(e) => setSel({ color: e.target.value }, { lineColor: e.target.value })}
                  className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0"
                />
              </label>
              <label className="flex items-center gap-1">
                px
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={selDrawing.width}
                  onChange={(e) => {
                    const w = Math.min(10, Math.max(1, +e.target.value || 1));
                    setSel({ width: w }, { lineWidth: w });
                  }}
                  className="w-12 rounded bg-slate-800 px-1 py-0.5"
                />
              </label>
            </>
          ) : (
            <>
              <label className="flex items-center gap-1">
                outline
                <input
                  type="color"
                  value={(selDrawing as RectDrawing).stroke}
                  onChange={(e) => setSel({ stroke: e.target.value }, { rectStroke: e.target.value })}
                  className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0"
                />
              </label>
              <label className="flex items-center gap-1">
                px
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={(selDrawing as RectDrawing).strokeWidth}
                  onChange={(e) => {
                    const w = Math.min(10, Math.max(0, +e.target.value || 0));
                    setSel({ strokeWidth: w }, { rectStrokeWidth: w });
                  }}
                  className="w-12 rounded bg-slate-800 px-1 py-0.5"
                />
              </label>
              <label className="flex items-center gap-1">
                fill
                <input
                  type="color"
                  value={(selDrawing as RectDrawing).fill}
                  onChange={(e) => setSel({ fill: e.target.value }, { rectFill: e.target.value })}
                  className="h-5 w-7 cursor-pointer border-0 bg-transparent p-0"
                />
              </label>
              <label className="flex items-center gap-1">
                opacity
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round((selDrawing as RectDrawing).fillOpacity * 100)}
                  onChange={(e) => {
                    const o = +e.target.value / 100;
                    setSel({ fillOpacity: o }, { rectFillOpacity: o });
                  }}
                  className="w-16"
                />
              </label>
            </>
          )}
          <button
            className="rounded px-1 text-slate-500 hover:bg-rose-900/50 hover:text-rose-300"
            title="Delete drawing (Del)"
            onClick={() => useDrawings.getState().remove(instrument, selDrawing.id)}
          >
            🗑
          </button>
        </div>
      )}
    </div>
  );
}

'use client';

// Renders the replay chart. Data path (the ONLY data path):
// currentTime -> barSource.getVisibleCandlesIncremental (clock-clipped) -> chart.
// A dev-mode assertion below double-checks no rendered candle extends past now.
//
// Trading overlay: working orders and the position render as draggable chips
// (drag to move the order / drag POS to spawn SL-or-TP, ✕ to cancel) plus
// axis price lines. Auto-scroll follows the newest candle only while the
// user is parked at the right edge; panning away disarms it.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import DrawingLayer, { type ChartGeo } from '@/components/DrawingLayer';
import FVGLayer from '@/components/FVGLayer';
import SessionLayer from '@/components/SessionLayer';
import { useConcepts, type ChartColors } from '@/lib/concepts/store';
import { isSubMinute, sources, type InstrumentId } from '@/lib/data/barSource';
import { useReplay } from '@/lib/replay/clock';
import { fmtPts, fmtUsd, ptsToUsd, roundToTick } from '@/lib/trading/contractMath';
import { useTrading } from '@/lib/trading/store';
import { fromChartTime, toChartTime } from '@/lib/time/et';
import { TF_SECONDS, TRADING_DAY_SEC, TRADING_WEEK_SEC, isSessionTf } from '@/lib/types';

interface Props {
  instrument: InstrumentId;
  tradingEnabled: boolean; // order chips/lines/click-to-place (NQ only)
  clickMode: 'none' | 'rewind' | 'price';
  onRewindClick: (ts: number) => void;
  onPriceClick: (price: number) => void;
}

interface DragState {
  kind: 'order' | 'pos' | 'schema';
  id: string; // order id | 'pos' | schema field ('entry' | 'sl' | 'tp')
  price: number;
  y: number;
}

const gridColor = (c: ChartColors): string => {
  const n = parseInt(c.grid.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${c.gridOpacityPct / 100})`;
};

export default function ReplayChart({ instrument, tradingEnabled, clickMode, onRewindClick, onPriceClick }: Props) {
  const source = sources[instrument];
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const backfillBusy = useRef(false);
  const overlayRaf = useRef(false);
  const needsFullPaint = useRef(true); // fresh chart instance must setData once
  const prevTimeRef = useRef<number | null>(null);
  const prevTfRef = useRef<string | null>(null);
  const geoRef = useRef<ChartGeo | null>(null); // drawing layer's time<->x basis
  const priceLineMap = useRef(new Map<string, IPriceLine>());
  const [overlayTick, setOverlayTick] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const chartColors = useConcepts((s) => s.chartColors);
  const followTail = useConcepts((s) => s.followTail);
  const currentTime = useReplay((s) => s.currentTime);
  const timeframe = useReplay((s) => s.timeframes[instrument]);
  const dataVersion = useReplay((s) => s.dataVersion);
  const workingOrders = useTrading((s) => s.derived.workingOrders);
  const position = useTrading((s) => s.derived.position);
  const cancelOrder = useTrading((s) => s.cancelOrder);
  const moveOrder = useTrading((s) => s.moveOrder);
  const placePositionLeg = useTrading((s) => s.placePositionLeg);
  const flatten = useTrading((s) => s.flatten);
  const schema = useTrading((s) => s.schema);
  const updateSchema = useTrading((s) => s.updateSchema);
  const cancelSchema = useTrading((s) => s.cancelSchema);
  const placeSchema = useTrading((s) => s.placeSchema);

  const clickRef = useRef({ clickMode, onRewindClick, onPriceClick });
  clickRef.current = { clickMode, onRewindClick, onPriceClick };

  // ALL overlay repositioning funnels through this rAF-coalesced bump — one
  // React render per frame, and never a setState in the same synchronous
  // chain as the store update that caused it. Calling setOverlayTick
  // directly from the data effect used to chain a nested update onto every
  // clock tick, which at high autoplay speeds tripped React's
  // maximum-update-depth guard.
  const bumpOverlay = useCallback(() => {
    if (overlayRaf.current) return;
    overlayRaf.current = true;
    requestAnimationFrame(() => {
      overlayRaf.current = false;
      setOverlayTick((t) => t + 1);
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current!;
    // Colors come from the CHART settings panel (concepts store, persisted,
    // profile-saveable). The chart canvas itself is TRANSPARENT: the wrapper
    // div carries the background color, which lets the session-box overlay
    // slot between the two (z-1) and draw UNDER the candles.
    const colors = useConcepts.getState().chartColors;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: colors.text,
      },
      grid: {
        vertLines: { color: gridColor(colors) },
        horzLines: { color: gridColor(colors) },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.crosshair, labelBackgroundColor: '#2a2e39' },
        horzLine: { color: colors.crosshair, labelBackgroundColor: '#2a2e39' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#232a3b',
        rightOffset: 6,
        // the camera never follows new candles; they drift right instead
        shiftVisibleRangeOnNewBar: false,
      },
      rightPriceScale: { borderColor: '#232a3b' },
      autoSize: true,
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.upBody,
      downColor: colors.downBody,
      borderVisible: true,
      borderUpColor: colors.border,
      borderDownColor: colors.border,
      wickUpColor: colors.wick,
      wickDownColor: colors.wick,
      priceLineColor: colors.priceLine, // dotted current-price line
    });

    chart.subscribeClick((param) => {
      const { clickMode: mode, onRewindClick: rewind, onPriceClick: priceClick } = clickRef.current;
      if (mode === 'rewind' && param.time !== undefined) {
        rewind(fromChartTime(param.time as number));
      } else if (mode === 'price' && param.point) {
        const price = candles.coordinateToPrice(param.point.y);
        if (price !== null) priceClick(price as number);
      }
    });

    // Pan-left backfill for low timeframes + overlay reposition on pan/zoom.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      bumpOverlay();
      if (!range || range.from > 20 || backfillBusy.current) return;
      const tf = useReplay.getState().timeframes[instrument];
      if (tf === '1h' || tf === '4h' || tf === '1D' || tf === '1W' || tf === '1M') return;
      backfillBusy.current = true;
      void source.loadOlderDays(isSubMinute(tf), isSubMinute(tf) ? 2 : 20).finally(() => {
        backfillBusy.current = false;
      });
    });

    // Price-scale drags/zooms change y-coordinates WITHOUT a logical-range
    // change, so nothing above fires and the chip/drawing overlay went stale
    // (chips detached from their price lines). Re-sync on any pointer drag
    // or wheel anywhere over the chart, including the axes.
    const onPointerDown = () => {
      window.addEventListener('pointermove', bumpOverlay);
      const end = () => {
        window.removeEventListener('pointermove', bumpOverlay);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        bumpOverlay();
      };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('wheel', bumpOverlay, { passive: true });
    el.addEventListener('dblclick', bumpOverlay); // axis double-click = reset scale

    chartRef.current = chart;
    candlesRef.current = candles;
    needsFullPaint.current = true;
    if (process.env.NODE_ENV !== 'production') {
      // debug handle — stripped from production builds
      const w = window as unknown as { __charts?: Record<string, unknown> };
      w.__charts = { ...w.__charts, [instrument]: chart };
    }
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('wheel', bumpOverlay);
      el.removeEventListener('dblclick', bumpOverlay);
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      priceLineMap.current.clear();
    };
  }, [instrument]);

  // Live recolor: the chart is created once per instrument; color edits in
  // the CHART panel (or a profile apply) restyle it in place.
  useEffect(() => {
    const chart = chartRef.current;
    const series = candlesRef.current;
    if (!chart || !series) return;
    chart.applyOptions({
      layout: { textColor: chartColors.text },
      grid: {
        vertLines: { color: gridColor(chartColors) },
        horzLines: { color: gridColor(chartColors) },
      },
      crosshair: {
        vertLine: { color: chartColors.crosshair },
        horzLine: { color: chartColors.crosshair },
      },
    });
    series.applyOptions({
      upColor: chartColors.upBody,
      downColor: chartColors.downBody,
      borderUpColor: chartColors.border,
      borderDownColor: chartColors.border,
      wickUpColor: chartColors.wick,
      wickDownColor: chartColors.wick,
      priceLineColor: chartColors.priceLine,
    });
  }, [chartColors]);

  useEffect(() => {
    if (currentTime === null || !candlesRef.current) return;

    const frame = source.getVisibleCandlesIncremental(currentTime, timeframe);
    const candles = frame.candles;
    geoRef.current = {
      candles,
      tfSec: isSessionTf(timeframe)
        ? timeframe === '1D'
          ? TRADING_DAY_SEC
          : timeframe === '1W'
            ? TRADING_WEEK_SEC
            : 30 * 86_400
        : TF_SECONDS[timeframe],
    };
    // A freshly mounted chart has rendered nothing, whatever the shared
    // candle cache thinks — force one full paint.
    const dirtyFrom = needsFullPaint.current ? 0 : frame.dirtyFrom;

    if (process.env.NODE_ENV !== 'production' && candles.length) {
      // A candle may be partially formed, but its bucket must have STARTED.
      const last = candles[candles.length - 1];
      if (last.t > currentTime) {
        throw new Error(`LOOKAHEAD VIOLATION: candle bucket ${last.t} starts after now ${currentTime}`);
      }
    }

    const toCandle = (b: (typeof candles)[number]) => ({
      time: toChartTime(b.t) as UTCTimestamp,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    });

    if (dirtyFrom === 0) {
      candlesRef.current.setData(candles.map(toCandle));
    } else {
      // steps only touch the tail: update() is O(changed), not O(series)
      for (let i = dirtyFrom; i < candles.length; i++) {
        candlesRef.current.update(toCandle(candles[i]));
      }
    }

    // recenter on fresh chart, rewind, or timeframe switch (jump to recent
    // action — the preserved logical range would land in ancient history);
    // forward motion never scrolls. This must be scrollToPosition(6, false):
    // - scrollToRealTime() ANIMATES, and a setData from a mid-flight chunk
    //   load cancels the animation partway (viewport stranded in history);
    // - setVisibleLogicalRange() in the same batch as setData is resolved
    //   against the OLD series' index space (data commits lazily) and lands
    //   in the wrong place. scrollToPosition stores a base-RELATIVE offset
    //   ("6 bars right of the last bar"), correct whenever the data commits.
    const rewound = prevTimeRef.current !== null && currentTime < prevTimeRef.current;
    const tfSwitched = prevTfRef.current !== timeframe;
    // followTail: keep the newest candle pinned 6 bars from the right edge on
    // EVERY advance — the user's "price always at a fixed spot" mode for fast
    // playback and day jumps (toggle button next to ⇥).
    if (needsFullPaint.current || rewound || tfSwitched || followTail) {
      // scrollToPosition(_, false) queues a base-RELATIVE right-offset
      // invalidation that LWC applies IN ORDER after the setData above —
      // correct whatever the new dataset's index space is. Never use
      // scrollToRealTime here: it ANIMATES rightOffset toward +6, and an
      // interrupted animation leaves a big negative offset that strands the
      // viewport in old history — persistently, since every later dataset
      // swap keeps the stuck base-relative offset.
      chartRef.current!.timeScale().scrollToPosition(6, false);
    }
    needsFullPaint.current = false;
    prevTimeRef.current = currentTime;
    prevTfRef.current = timeframe;
    bumpOverlay(); // rAF-deferred: never a nested update on the clock tick
  }, [currentTime, timeframe, dataVersion, followTail, bumpOverlay]);

  // Axis price lines for orders + position (traded instrument only).
  useEffect(() => {
    const series = candlesRef.current;
    if (!series || !tradingEnabled) return;
    for (const line of priceLineMap.current.values()) series.removePriceLine(line);
    priceLineMap.current.clear();

    for (const o of workingOrders) {
      const price = o.limitPrice ?? o.stopPrice;
      if (price === undefined) continue; // pending market order has no level
      const isSl = o.reduceOnly && o.type === 'stop';
      const isTp = o.reduceOnly && o.type === 'limit';
      priceLineMap.current.set(
        o.id,
        series.createPriceLine({
          price,
          color: isSl ? '#ef5350' : isTp ? '#26a69a' : o.side === 'buy' ? '#4caf9d' : '#e57373',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: isSl ? `SL ${o.qty}` : isTp ? `TP ${o.qty}` : `${o.side === 'buy' ? 'B' : 'S'} ${o.type} ${o.qty}`,
        }),
      );
    }
    if (position.qty !== 0) {
      priceLineMap.current.set(
        'pos',
        series.createPriceLine({
          price: position.avgPrice,
          color: '#f5b942',
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: true,
          title: `POS ${position.qty > 0 ? '+' : ''}${position.qty}`,
        }),
      );
    }
    // draft (schema) bracket lines — dotted, nothing placed yet
    if (schema) {
      const lines = [
        ['entry', schema.entry, '#38bdf8', `draft ${schema.side === 'buy' ? 'B' : 'S'} ${schema.qty}`],
        ['sl', schema.sl, '#ef5350', 'draft SL'],
        ['tp', schema.tp, '#26a69a', 'draft TP'],
      ] as const;
      for (const [field, price, color, title] of lines) {
        priceLineMap.current.set(
          `schema-${field}`,
          series.createPriceLine({
            price,
            color,
            lineWidth: 1,
            lineStyle: 1,
            axisLabelVisible: true,
            title,
          }),
        );
      }
    }
    bumpOverlay();
  }, [workingOrders, position, tradingEnabled, schema, bumpOverlay]);

  // ---- draggable chip overlay ----

  const startDrag = (
    e: React.PointerEvent,
    kind: 'order' | 'pos' | 'schema',
    id: string,
    price: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const state: DragState = { kind, id, price, y: 0 };
    dragRef.current = state;
    setDrag(state);

    const move = (ev: PointerEvent) => {
      const series = candlesRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!series || !rect || !dragRef.current) return;
      const y = ev.clientY - rect.top;
      const raw = series.coordinateToPrice(y);
      if (raw === null) return;
      // schema lines preview at the EXACT dragged price; rounding happens
      // on placement (like every other order)
      const p = kind === 'schema' ? (raw as number) : roundToTick(raw as number);
      dragRef.current = { ...dragRef.current, price: p, y };
      setDrag(dragRef.current);
      if (kind === 'order') priceLineMap.current.get(id)?.applyOptions({ price: p });
      if (kind === 'schema') priceLineMap.current.get(`schema-${id}`)?.applyOptions({ price: p });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const final = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!final) return;
      if (kind === 'order') moveOrder(id, final.price);
      else if (kind === 'pos') placePositionLeg(final.price);
      else updateSchema(id as 'entry' | 'sl' | 'tp', final.price);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // chip geometry (recomputed on overlayTick / order / position changes)
  void overlayTick;
  const series = candlesRef.current;
  const chips: {
    key: string;
    y: number;
    label: string;
    cls: string;
    kind: 'order' | 'pos' | 'schema';
    dragId: string;
    price: number;
    onCancel?: () => void;
    onPlace?: () => void;
  }[] = [];
  if (series && tradingEnabled) {
    for (const o of workingOrders) {
      const price = o.limitPrice ?? o.stopPrice;
      if (price === undefined) continue;
      if (drag?.kind === 'order' && drag.id === o.id) continue; // ghost rendered instead
      const y = series.priceToCoordinate(price);
      if (y === null) continue;
      const isSl = o.reduceOnly && o.type === 'stop';
      const isTp = o.reduceOnly && o.type === 'limit';
      chips.push({
        key: o.id,
        y,
        label: isSl ? `SL ${o.qty}` : isTp ? `TP ${o.qty}` : `${o.side === 'buy' ? 'B' : 'S'} ${o.type} ${o.qty}`,
        cls: isSl
          ? 'bg-rose-950/90 text-rose-300 border-rose-700'
          : isTp
            ? 'bg-emerald-950/90 text-emerald-300 border-emerald-700'
            : o.side === 'buy'
              ? 'bg-emerald-900/90 text-emerald-200 border-emerald-700'
              : 'bg-rose-900/90 text-rose-200 border-rose-700',
        kind: 'order',
        dragId: o.id,
        price,
        onCancel: () => cancelOrder(o.id),
      });
    }
    if (position.qty !== 0) {
      const y = series.priceToCoordinate(position.avgPrice);
      if (y !== null) {
        chips.push({
          key: 'pos',
          y,
          label: `POS ${position.qty > 0 ? '+' : ''}${position.qty}`,
          cls: 'bg-amber-950/90 text-amber-300 border-amber-600',
          kind: 'pos',
          dragId: 'pos',
          price: position.avgPrice,
          onCancel: flatten,
        });
      }
    }
    // draft (schema) bracket chips: dashed styling, Place lives on the entry
    if (schema) {
      const dir = schema.side === 'buy' ? 1 : -1;
      const fields = [
        {
          field: 'entry',
          price: schema.entry,
          label: `${schema.side === 'buy' ? 'BUY' : 'SELL'} ${schema.qty} ${schema.entryDragged ? '@ ' + roundToTick(schema.entry).toFixed(2) : 'mkt'}`,
          cls: 'border-dashed bg-sky-950/90 text-sky-300 border-sky-500',
        },
        {
          field: 'sl',
          price: schema.sl,
          label: `SL ${fmtPts((schema.sl - schema.entry) * dir)}`,
          cls: 'border-dashed bg-rose-950/90 text-rose-300 border-rose-500',
        },
        {
          field: 'tp',
          price: schema.tp,
          label: `TP ${fmtPts((schema.tp - schema.entry) * dir)}`,
          cls: 'border-dashed bg-emerald-950/90 text-emerald-300 border-emerald-500',
        },
      ] as const;
      for (const f of fields) {
        if (drag?.kind === 'schema' && drag.id === f.field) continue; // ghost rendered instead
        const y = series.priceToCoordinate(f.price);
        if (y === null) continue;
        chips.push({
          key: `schema-${f.field}`,
          y,
          label: f.label,
          cls: f.cls,
          kind: 'schema',
          dragId: f.field,
          price: f.price,
          onCancel: f.field === 'entry' ? cancelSchema : undefined,
          onPlace: f.field === 'entry' ? placeSchema : undefined,
        });
      }
    }
  }

  // ghost label while dragging
  let ghost: { y: number; text: string } | null = null;
  if (drag && drag.y > 0) {
    if (drag.kind === 'order') {
      ghost = { y: drag.y, text: `→ ${drag.price.toFixed(2)}` };
    } else if (drag.kind === 'pos') {
      const last = currentTime !== null ? sources.NQ.lastVisibleBar(currentTime)?.c : undefined;
      const isTp =
        last !== undefined && (position.qty > 0 ? drag.price > last : drag.price < last);
      ghost = { y: drag.y, text: `${isTp ? 'TP' : 'SL'} ${Math.abs(position.qty)} @ ${drag.price.toFixed(2)}` };
    } else if (schema) {
      // live projected P&L vs the draft entry while dragging SL/TP
      const dir = schema.side === 'buy' ? 1 : -1;
      if (drag.id === 'entry') {
        ghost = { y: drag.y, text: `entry → ${drag.price.toFixed(2)}` };
      } else {
        const pts = (drag.price - schema.entry) * dir;
        const label = drag.id === 'tp' ? 'TP' : 'SL';
        ghost = {
          y: drag.y,
          text: `${label} ${drag.price.toFixed(2)} · ${fmtPts(pts)} · ${fmtUsd(ptsToUsd(pts, schema.qty))}`,
        };
      }
    }
  }

  return (
    // wrapper carries the canvas color; the chart itself is transparent so
    // the session overlay (z-1) draws under the candles (chart div z-2)
    <div className="relative h-full w-full" style={{ background: chartColors.background }}>
      <SessionLayer
        instrument={instrument}
        chartRef={chartRef}
        seriesRef={candlesRef}
        geoRef={geoRef}
        overlayTick={overlayTick}
      />
      <div
        ref={containerRef}
        className={`relative z-[2] h-full w-full ${clickMode !== 'none' ? 'cursor-crosshair' : ''}`}
      />
      <FVGLayer
        instrument={instrument}
        chartRef={chartRef}
        seriesRef={candlesRef}
        geoRef={geoRef}
        overlayTick={overlayTick}
      />
      <DrawingLayer
        instrument={instrument}
        chartRef={chartRef}
        seriesRef={candlesRef}
        geoRef={geoRef}
        overlayTick={overlayTick}
      />
      <div className="pointer-events-none absolute inset-0 z-10 select-none">
        {chips.map((c) => (
          <div
            key={c.key}
            className={`pointer-events-auto absolute flex items-center overflow-hidden rounded border font-mono text-[11px] ${c.cls}`}
            style={{ top: c.y - 11, right: 72 }}
          >
            <span
              className="cursor-ns-resize px-1.5 py-0.5"
              title={c.kind === 'pos' ? 'Drag to place SL/TP for the position' : 'Drag to move'}
              onPointerDown={(e) => startDrag(e, c.kind, c.dragId, c.price)}
            >
              {c.label}
            </span>
            {c.onPlace && (
              <button
                className="border-l border-current/30 bg-sky-600/40 px-1.5 py-0.5 font-semibold hover:bg-sky-500/50"
                title="Place this bracket order"
                onClick={c.onPlace}
              >
                Place
              </button>
            )}
            {c.onCancel && (
              <button
                className="border-l border-current/30 px-1 py-0.5 opacity-60 hover:opacity-100"
                title={c.kind === 'pos' ? 'Flatten position' : c.kind === 'schema' ? 'Discard draft' : 'Cancel order'}
                onClick={c.onCancel}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {ghost && (
          <div
            className="absolute rounded border border-slate-500 bg-slate-800/95 px-1.5 py-0.5 font-mono text-[11px] text-slate-100"
            style={{ top: ghost.y - 11, right: 72 }}
          >
            {ghost.text}
          </div>
        )}
        <div className="pointer-events-auto absolute bottom-16 right-20 flex gap-1">
          <button
            className={`rounded border px-2 py-1 text-sm ${
              followTail
                ? 'border-amber-500 bg-amber-950/80 text-amber-300'
                : 'border-slate-700 bg-slate-900/90 text-slate-300 hover:bg-slate-800'
            }`}
            title="Follow price — keep the newest candle pinned at a fixed spot on every advance (fast playback / day jumps never leave the chart behind)"
            onClick={() => useConcepts.getState().setFollowTail(!followTail)}
          >
            follow
          </button>
          <button
            className="rounded border border-slate-700 bg-slate-900/90 px-2 py-1 text-sm text-slate-300 hover:bg-slate-800"
            title="Recenter on the current candle"
            onClick={() => chartRef.current?.timeScale().scrollToPosition(6, false)}
          >
            ⇥
          </button>
        </div>
      </div>
    </div>
  );
}

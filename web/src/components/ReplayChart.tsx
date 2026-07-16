'use client';

// Renders the replay chart. Data path (the ONLY data path):
// currentTime -> barSource.getVisibleCandlesIncremental (clock-clipped) -> chart.
// A dev-mode assertion below double-checks no rendered candle extends past now.
//
// Trading overlay: working orders and the position render as draggable chips
// (drag to move the order / drag POS to spawn SL-or-TP, ✕ to cancel) plus
// axis price lines. Auto-scroll follows the newest candle only while the
// user is parked at the right edge; panning away disarms it.

import { useEffect, useRef, useState } from 'react';
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
import { isSubMinute, sources, type InstrumentId } from '@/lib/data/barSource';
import { useReplay } from '@/lib/replay/clock';
import { roundToTick } from '@/lib/trading/contractMath';
import { useTrading } from '@/lib/trading/store';
import { fromChartTime, toChartTime } from '@/lib/time/et';

interface Props {
  instrument: InstrumentId;
  tradingEnabled: boolean; // order chips/lines/click-to-place (NQ only)
  clickMode: 'none' | 'rewind' | 'price';
  onRewindClick: (ts: number) => void;
  onPriceClick: (price: number) => void;
}

interface DragState {
  kind: 'order' | 'pos';
  id: string;
  price: number;
  y: number;
}

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
  const priceLineMap = useRef(new Map<string, IPriceLine>());
  const [overlayTick, setOverlayTick] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const currentTime = useReplay((s) => s.currentTime);
  const timeframe = useReplay((s) => s.timeframe);
  const dataVersion = useReplay((s) => s.dataVersion);
  const workingOrders = useTrading((s) => s.derived.workingOrders);
  const position = useTrading((s) => s.derived.position);
  const cancelOrder = useTrading((s) => s.cancelOrder);
  const moveOrder = useTrading((s) => s.moveOrder);
  const placePositionLeg = useTrading((s) => s.placePositionLeg);
  const flatten = useTrading((s) => s.flatten);

  const clickRef = useRef({ clickMode, onRewindClick, onPriceClick });
  clickRef.current = { clickMode, onRewindClick, onPriceClick };

  useEffect(() => {
    const el = containerRef.current!;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0b0e14' },
        textColor: '#8b93a7',
      },
      grid: {
        vertLines: { color: '#161b26' },
        horzLines: { color: '#161b26' },
      },
      crosshair: { mode: CrosshairMode.Normal },
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
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
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

    // Overlay repositioning coalesces to one React render per frame — a 1h
    // step on the 1m chart fires 60 range-change callbacks otherwise.
    const bumpOverlay = () => {
      if (overlayRaf.current) return;
      overlayRaf.current = true;
      requestAnimationFrame(() => {
        overlayRaf.current = false;
        setOverlayTick((t) => t + 1);
      });
    };

    // Pan-left backfill for low timeframes + overlay reposition on pan/zoom.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      bumpOverlay();
      if (!range || range.from > 20 || backfillBusy.current) return;
      const tf = useReplay.getState().timeframe;
      if (tf === '1h' || tf === '4h' || tf === '1D' || tf === '1W' || tf === '1M') return;
      backfillBusy.current = true;
      void source.loadOlderDays(isSubMinute(tf), isSubMinute(tf) ? 2 : 20).finally(() => {
        backfillBusy.current = false;
      });
    });

    chartRef.current = chart;
    candlesRef.current = candles;
    needsFullPaint.current = true;
    return () => {
      chart.remove();
      chartRef.current = null;
      candlesRef.current = null;
      priceLineMap.current.clear();
    };
  }, []);

  useEffect(() => {
    if (currentTime === null || !candlesRef.current) return;

    const frame = source.getVisibleCandlesIncremental(currentTime, timeframe);
    const candles = frame.candles;
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
    // forward motion never scrolls.
    const rewound = prevTimeRef.current !== null && currentTime < prevTimeRef.current;
    const tfSwitched = prevTfRef.current !== timeframe;
    if (needsFullPaint.current || rewound || tfSwitched) {
      chartRef.current!.timeScale().scrollToRealTime();
    }
    needsFullPaint.current = false;
    prevTimeRef.current = currentTime;
    prevTfRef.current = timeframe;
    setOverlayTick((t) => t + 1);
  }, [currentTime, timeframe, dataVersion]);

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
    setOverlayTick((t) => t + 1);
  }, [workingOrders, position, tradingEnabled]);

  // ---- draggable chip overlay ----

  const startDrag = (e: React.PointerEvent, kind: 'order' | 'pos', id: string, price: number) => {
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
      const p = roundToTick(raw as number);
      dragRef.current = { ...dragRef.current, price: p, y };
      setDrag(dragRef.current);
      if (kind === 'order') priceLineMap.current.get(id)?.applyOptions({ price: p });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const final = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!final) return;
      if (kind === 'order') moveOrder(id, final.price);
      else placePositionLeg(final.price);
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
    kind: 'order' | 'pos';
    price: number;
    onCancel: () => void;
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
          price: position.avgPrice,
          onCancel: flatten,
        });
      }
    }
  }

  // ghost label while dragging
  let ghost: { y: number; text: string } | null = null;
  if (drag && drag.y > 0) {
    if (drag.kind === 'order') {
      ghost = { y: drag.y, text: `→ ${drag.price.toFixed(2)}` };
    } else {
      const last = currentTime !== null ? sources.NQ.lastVisibleBar(currentTime)?.c : undefined;
      const isTp =
        last !== undefined && (position.qty > 0 ? drag.price > last : drag.price < last);
      ghost = { y: drag.y, text: `${isTp ? 'TP' : 'SL'} ${Math.abs(position.qty)} @ ${drag.price.toFixed(2)}` };
    }
  }

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className={`h-full w-full ${clickMode !== 'none' ? 'cursor-crosshair' : ''}`}
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
              onPointerDown={(e) => startDrag(e, c.kind, c.key, c.price)}
            >
              {c.label}
            </span>
            <button
              className="border-l border-current/30 px-1 py-0.5 opacity-60 hover:opacity-100"
              title={c.kind === 'pos' ? 'Flatten position' : 'Cancel order'}
              onClick={c.onCancel}
            >
              ✕
            </button>
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
        <button
          className="pointer-events-auto absolute bottom-16 right-20 rounded border border-slate-700 bg-slate-900/90 px-2 py-1 text-sm text-slate-300 hover:bg-slate-800"
          title="Recenter on the current candle"
          onClick={() => chartRef.current?.timeScale().scrollToRealTime()}
        >
          ⇥
        </button>
      </div>
    </div>
  );
}

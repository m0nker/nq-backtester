'use client';

// Dynamic trade viewer: a REAL chart re-rendered from stored price data
// around the trade window — not a screenshot. Reuses the same aggregation
// code as the main chart, supports timeframe switching and configurable
// context, and never shows data past the replay clock.

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { getBaseResolutionSec, getHistoricalBars } from '@/lib/data/barSource';
import { useReplay } from '@/lib/replay/clock';
import { aggregate, bucketStart } from '@/lib/replay/aggregate';
import { fmtPts, fmtUsd } from '@/lib/trading/contractMath';
import type { Trade } from '@/lib/trading/engine';
import { formatET, toChartTime } from '@/lib/time/et';
import { availableTimeframes, type Bar, type Timeframe } from '@/lib/types';

const CTX_CHOICES = [1, 2, 4, 8] as const; // hours of context each side

export default function TradeViewer({ trade, onClose }: { trade: Trade; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const [tf, setTf] = useState<Timeframe>('1m');
  const [ctxHours, setCtxHours] = useState<number>(2);
  const [bars, setBars] = useState<Bar[] | null>(null);

  // load base bars for the window (clipped to the replay clock)
  useEffect(() => {
    const guard = useReplay.getState().currentTime ?? trade.exitTs;
    let stale = false;
    setBars(null);
    getHistoricalBars(trade.entryTs - ctxHours * 3600, trade.exitTs + ctxHours * 3600, guard).then(
      (b) => {
        if (!stale) setBars(b);
      },
    );
    return () => {
      stale = true;
    };
  }, [trade, ctxHours]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: '#0b0e14' }, textColor: '#8b93a7' },
      grid: { vertLines: { color: '#161b26' }, horzLines: { color: '#161b26' } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232a3b' },
      rightPriceScale: { borderColor: '#232a3b' },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
      linesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !bars) return;
    const candles = aggregate(bars, tf, getBaseResolutionSec());
    series.setData(
      candles.map((b) => ({
        time: toChartTime(b.t) as UTCTimestamp,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
      })),
    );

    const dir = trade.side === 'buy';
    const markers: SeriesMarker<Time>[] = [
      {
        time: toChartTime(bucketStart(trade.entryTs, tf)) as UTCTimestamp,
        position: dir ? 'belowBar' : 'aboveBar',
        color: dir ? '#26a69a' : '#ef5350',
        shape: dir ? 'arrowUp' : 'arrowDown',
        text: `entry ${trade.avgEntry.toFixed(2)}`,
      },
      {
        time: toChartTime(bucketStart(trade.exitTs, tf)) as UTCTimestamp,
        position: dir ? 'aboveBar' : 'belowBar',
        color: '#f5b942',
        shape: dir ? 'arrowDown' : 'arrowUp',
        text: `exit ${trade.avgExit.toFixed(2)}`,
      },
    ];
    markersRef.current?.setMarkers(markers);

    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];
    const mkLine = (price: number, color: string, title: string, style = 2) =>
      linesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }),
      );
    mkLine(trade.avgEntry, '#f5b942', 'entry', 0);
    mkLine(trade.avgExit, '#8b93a7', 'exit', 0);
    if (trade.slPrice !== undefined) mkLine(trade.slPrice, '#ef5350', 'SL');
    if (trade.tpPrice !== undefined) mkLine(trade.tpPrice, '#26a69a', 'TP');

    chartRef.current?.timeScale().fitContent();
  }, [bars, tf, trade]);

  const r = trade.riskPts ? trade.pnlPts / trade.riskPts : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <div
        className="flex h-[80vh] w-[85vw] flex-col rounded-xl border border-slate-700 bg-[#0d1119] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-4 text-sm">
          <span className={`font-semibold ${trade.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
            {trade.side === 'buy' ? 'LONG' : 'SHORT'} {trade.qty}
          </span>
          <span className="text-slate-400">
            {formatET(trade.entryTs)} → {formatET(trade.exitTs)}
          </span>
          <span className={trade.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
            {fmtUsd(trade.pnlUsd)} ({fmtPts(trade.pnlPts)}{r !== null ? ` · ${r.toFixed(2)}R` : ''})
          </span>
          {trade.ambiguous && (
            <span className="rounded bg-amber-950 px-1.5 text-xs text-amber-400" title="SL and TP touched the same bar; SL honored">
              ambiguous bar
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            {availableTimeframes(getBaseResolutionSec())
              .filter((t) => t !== '1D' && t !== '1W' && t !== '1M')
              .map((t) => (
                <button
                  key={t}
                  onClick={() => setTf(t)}
                  className={`rounded px-2 py-1 text-xs ${t === tf ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:bg-slate-800'}`}
                >
                  {t}
                </button>
              ))}
            <select
              className="ml-2 rounded bg-slate-800 px-2 py-1 text-xs text-slate-200"
              value={ctxHours}
              onChange={(e) => setCtxHours(+e.target.value)}
              title="Context around the trade"
            >
              {CTX_CHOICES.map((h) => (
                <option key={h} value={h}>
                  ±{h}h
                </option>
              ))}
            </select>
            <button className="ml-2 rounded bg-slate-800 px-2.5 py-1 text-sm hover:bg-slate-700" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <div ref={containerRef} className="h-full w-full" />
          {!bars && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
              loading trade window…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

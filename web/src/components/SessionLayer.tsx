'use client';

// Killzone session overlay: translucent boxes over each session's ET window
// spanning its H/L, with a horizontal line off each completed session extreme
// that extends until price takes it (or to "now" while it rests), plus
// previous-day H/L lines. Pure display (pointer-events: none) — computation
// lives in lib/concepts/sessionBoxes.ts, settings in the SESS panel
// (FVGLayer's control strip), shared across charts via the concepts store.

import { useMemo } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { timeToLogical, type ChartGeo } from '@/components/DrawingLayer';
import { sources, type InstrumentId } from '@/lib/data/barSource';
import {
  computeSessionOverlay,
  type SessionDataSource,
  type SessionOverlay,
} from '@/lib/concepts/sessionBoxes';
import { useConcepts } from '@/lib/concepts/store';
import { useReplay } from '@/lib/replay/clock';

interface Props {
  instrument: InstrumentId;
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  geoRef: React.RefObject<ChartGeo | null>;
  overlayTick: number; // bumped by ReplayChart on any pan/zoom/scale/data change
}

const PD_COLOR = '#000000';

export default function SessionLayer({ instrument, chartRef, seriesRef, geoRef, overlayTick }: Props) {
  void overlayTick; // re-render trigger; coordinates read fresh below
  const currentTime = useReplay((s) => s.currentTime);
  const dataVersion = useReplay((s) => s.dataVersion);
  const cfg = useConcepts((s) => s.sessions);

  const overlay = useMemo<SessionOverlay>(() => {
    void dataVersion;
    if (currentTime === null || !cfg.show) return { boxes: [], pd: [] };
    const src: SessionDataSource = {
      barsInWindow: (a, b) => sources[instrument].getBarsInWindow(a, b),
      candles: (upTo, tf) => sources[instrument].getVisibleCandles(upTo, tf),
    };
    return computeSessionOverlay(src, currentTime, cfg);
  }, [currentTime, dataVersion, instrument, cfg]);

  let paneW = 0,
    paneH = 0;
  try {
    const size = chartRef.current?.paneSize();
    paneW = size?.width ?? 0;
    paneH = size?.height ?? 0;
  } catch {
    // chart mid-teardown
  }

  const series = seriesRef.current;
  const geo = geoRef.current;

  // Same fractional-logical workaround as DrawingLayer: derive the linear
  // transform from two integer probes (LWC returns 0 for non-integer logicals).
  let x0: number | null = null,
    dx = 0;
  const chart = chartRef.current;
  if (chart) {
    const ts = chart.timeScale();
    const a = ts.logicalToCoordinate(0 as Logical);
    const b = ts.logicalToCoordinate(1 as Logical);
    if (a !== null && b !== null && b !== a) {
      x0 = a as number;
      dx = (b as number) - (a as number);
    }
  }
  const toX = (t: number): number | null =>
    x0 === null || !geo || geo.candles.length === 0
      ? null
      : x0 + dx * timeToLogical(geo.candles, t, geo.tfSec);

  const nodes: React.ReactNode[] = [];
  if (series && geo && x0 !== null && paneW > 0 && currentTime !== null) {
    const boxAlpha = (pct: number) => (pct / 100) * (cfg.boxFillPct / 100);
    const xNow = toX(currentTime);

    for (const b of overlay.boxes) {
      const xL = toX(b.startTs);
      const xR = toX(Math.min(b.endTs, currentTime));
      if (xL === null || xR === null) continue;
      const yTop = series.priceToCoordinate(b.hi);
      const yBot = series.priceToCoordinate(b.lo);
      if (yTop === null || yBot === null) continue;
      const y = Math.min(yTop as number, yBot as number);
      const h = Math.abs((yBot as number) - (yTop as number));

      // box (only if any of it is on screen)
      if (xR >= 0 && xL <= paneW && y <= paneH && y + h >= 0) {
        const x = Math.max(xL, -8);
        nodes.push(
          <rect
            key={`box-${b.id}`}
            x={x}
            y={y}
            width={Math.max(Math.min(xR, paneW + 8) - x, 1)}
            height={Math.max(h, 1)}
            fill={b.cfg.color}
            fillOpacity={boxAlpha(b.cfg.opacityPct)}
          />,
        );
      }

      // H/L lines: session color at full opacity, from the box's LEFT edge
      // (spanning the session itself) until the level is taken — or to "now"
      // while it still rests
      if (!b.live) {
        const lines = [
          { key: 'hi', price: b.hi, yPx: yTop as number, takenAt: b.hiTakenAt },
          { key: 'lo', price: b.lo, yPx: yBot as number, takenAt: b.loTakenAt },
        ];
        for (const l of lines) {
          const xEnd = l.takenAt !== null ? toX(l.takenAt) : xNow;
          if (xEnd === null || xEnd <= xL) continue;
          if (l.yPx < -2 || l.yPx > paneH + 2) continue;
          if (xEnd < 0 || xL > paneW) continue;
          nodes.push(
            <line
              key={`ln-${b.id}-${l.key}`}
              x1={Math.max(xL, -8)}
              y1={l.yPx}
              x2={Math.min(xEnd, paneW + 8)}
              y2={l.yPx}
              stroke={b.cfg.color}
              strokeWidth={1}
            />,
          );
        }
      }
    }

    // previous-day H/L: black, from the bar that printed the extreme,
    // extending until taken
    for (const l of overlay.pd) {
      const yC = series.priceToCoordinate(l.price);
      if (yC === null) continue;
      const y = yC as number;
      if (y < -2 || y > paneH + 2) continue;
      const xL = toX(l.anchorTs);
      const xEnd = l.takenAt !== null ? toX(l.takenAt) : xNow;
      if (xL === null || xEnd === null || xEnd <= xL) continue;
      if (xEnd < 0 || xL > paneW) continue;
      nodes.push(
        <line
          key={`pd-${l.side}`}
          x1={Math.max(xL, -8)}
          y1={y}
          x2={Math.min(xEnd, paneW + 8)}
          y2={y}
          stroke={PD_COLOR}
          strokeOpacity={0.85}
          strokeWidth={1}
        />,
      );
    }
  }

  return (
    // z-[1] — UNDER the chart canvas (the chart background is transparent and
    // its container sits at z-[2]), so boxes never tint the candles
    <div className="pointer-events-none absolute inset-0 z-[1]">
      {paneW > 0 && nodes.length > 0 && (
        <svg width={paneW} height={paneH} className="absolute left-0 top-0" style={{ pointerEvents: 'none' }}>
          {nodes}
        </svg>
      )}
    </div>
  );
}

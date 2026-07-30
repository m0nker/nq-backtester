'use client';

// Fair-value-gap overlay: renders the perception engine's detected FVGs as
// translucent boxes on the chart, per STRATEGY_DEFINITIONS.md. Display-only
// (pointer-events: none except the toggle panel) — validation surface for
// "does the engine see what I see", nothing here feeds trading.
//
// Boxes live in (time, price) space and reuse the DrawingLayer's
// logical-space mapping, so they compress across halts exactly like candles.
// An active gap's box extends from its displacement candle to "now"; an
// inverted gap's box stops at the inversion close and flips to the IFVG
// color (dashed) — its polarity is now the opposite direction.

import { useMemo } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { timeToLogical, type ChartGeo } from '@/components/DrawingLayer';
import { sources, type InstrumentId } from '@/lib/data/barSource';
import { useBot } from '@/lib/concepts/botStore';
import { computeFVGs, statusOf, type FVG } from '@/lib/concepts/fvg';
import { FVG_TF_CHOICES, useConcepts } from '@/lib/concepts/store';
import { useReplay } from '@/lib/replay/clock';

interface Props {
  instrument: InstrumentId;
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  geoRef: React.RefObject<ChartGeo | null>;
  overlayTick: number; // bumped by ReplayChart on any pan/zoom/scale/data change
}

const BULL = '#26a69a';
const BEAR = '#ef5350';

export default function FVGLayer({ instrument, chartRef, seriesRef, geoRef, overlayTick }: Props) {
  void overlayTick; // re-render trigger; coordinates read fresh below
  const currentTime = useReplay((s) => s.currentTime);
  const dataVersion = useReplay((s) => s.dataVersion);
  const enabled = useConcepts((s) => s.enabled);
  const showInverted = useConcepts((s) => s.showInverted);
  const showCE = useConcepts((s) => s.showCE);
  const panelOpen = useConcepts((s) => s.panelOpen);
  const pendingCandidate = useBot((s) => s.pending);

  // Detection is keyed to the replay clock, not to pan/zoom: overlayTick
  // re-renders only re-map boxes to pixels.
  const gaps = useMemo<FVG[]>(() => {
    void dataVersion; // new chunks / trims change the candle set
    if (currentTime === null || enabled.length === 0) return [];
    const src = sources[instrument];
    const out: FVG[] = [];
    for (const tf of enabled) {
      out.push(...computeFVGs(src.getVisibleCandles(currentTime, tf), tf, currentTime));
    }
    return out;
  }, [currentTime, dataVersion, enabled, instrument]);

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

  const boxes: React.ReactNode[] = [];
  if (series && geo && x0 !== null && paneW > 0 && currentTime !== null) {
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      if (g.expiredAt !== null) continue; // aged out — no longer considered
      const status = statusOf(g);
      const inverted = status === 'inverted';
      if (inverted && !showInverted) continue;
      const xL = toX(g.bT);
      const xR = toX(inverted ? g.invertedAt! : currentTime);
      if (xL === null || xR === null || xR < 0 || xL > paneW) continue;
      const yTop = series.priceToCoordinate(g.top);
      const yBot = series.priceToCoordinate(g.bottom);
      if (yTop === null || yBot === null) continue;
      const y = Math.min(yTop as number, yBot as number);
      const h = Math.abs((yBot as number) - (yTop as number));
      if (y > paneH || y + h < 0) continue;
      const x = Math.max(xL, -8);
      const w = Math.max(Math.min(xR, paneW + 8) - x, 1);
      // an inverted gap's expected polarity flips — color follows the IFVG
      const color = inverted ? (g.dir === 'bull' ? BEAR : BULL) : g.dir === 'bull' ? BULL : BEAR;
      boxes.push(
        <g key={`${g.tf}-${g.formedAt}-${i}`}>
          <rect
            x={x}
            y={y}
            width={w}
            height={Math.max(h, 1)}
            fill={color}
            // unfilled (never tapped) gaps pop; filled (tapped) gaps recede
            fillOpacity={status === 'unfilled' ? 0.12 : 0.05}
            stroke={color}
            strokeOpacity={status === 'unfilled' ? 0.5 : status === 'filled' ? 0.3 : 0.45}
            strokeWidth={1}
            strokeDasharray={inverted ? '3 3' : undefined}
          />
          {showCE && h >= 8 && (
            <line
              x1={x}
              y1={(yTop as number) / 2 + (yBot as number) / 2}
              x2={x + w}
              y2={(yTop as number) / 2 + (yBot as number) / 2}
              stroke={color}
              strokeOpacity={0.35}
              strokeWidth={1}
              strokeDasharray="2 4"
            />
          )}
          {h >= 10 && w >= 26 && (
            <text
              x={x + 3}
              y={y + Math.min(h - 2, 10)}
              fill={color}
              fillOpacity={0.75}
              fontSize={9}
              fontFamily="monospace"
            >
              {g.tf}
              {inverted ? ' IFVG' : status === 'filled' ? ' filled' : ''}
            </text>
          )}
        </g>,
      );
    }

    // Pending-candidate highlight: while the prompt is up, the exact
    // condition FVG (amber) and trigger IFVG (sky) get loud outlines —
    // rendered regardless of which indicator TFs are toggled on.
    if (pendingCandidate) {
      const marks = [
        { z: pendingCandidate.condition, color: '#f5b942', label: `COND ${pendingCandidate.condition.tf}` },
        { z: pendingCandidate.ifvg, color: '#38bdf8', label: `IFVG ${pendingCandidate.ifvg.tf}` },
      ];
      for (const m of marks) {
        const xL = toX(m.z.bT);
        const xR = toX(currentTime);
        if (xL === null || xR === null) continue;
        const yTop = series.priceToCoordinate(m.z.top);
        const yBot = series.priceToCoordinate(m.z.bottom);
        if (yTop === null || yBot === null) continue;
        const y = Math.min(yTop as number, yBot as number);
        const h = Math.abs((yBot as number) - (yTop as number));
        const x = Math.max(xL, -8);
        const w = Math.max(Math.min(xR, paneW + 8) - x, 2);
        boxes.push(
          <g key={`cand-${m.label}`}>
            <rect
              x={x}
              y={y}
              width={w}
              height={Math.max(h, 2)}
              fill={m.color}
              fillOpacity={0.12}
              stroke={m.color}
              strokeOpacity={0.95}
              strokeWidth={2}
            />
            <text
              x={x + 4}
              y={Math.max(y - 4, 10)}
              fill={m.color}
              fontSize={10}
              fontWeight={700}
              fontFamily="monospace"
            >
              {m.label}
            </text>
          </g>,
        );
      }
    }
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-[5]">
      {paneW > 0 && boxes.length > 0 && (
        <svg width={paneW} height={paneH} className="absolute left-0 top-0" style={{ pointerEvents: 'none' }}>
          {boxes}
        </svg>
      )}

      {/* toggle panel */}
      <div className="pointer-events-auto absolute bottom-16 left-2 z-20 flex items-end gap-1">
        <button
          className={`flex h-7 items-center justify-center rounded border px-1.5 font-mono text-[11px] ${
            enabled.length > 0
              ? 'border-teal-500 bg-teal-950/80 text-teal-300'
              : 'border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800'
          }`}
          title="Fair value gap overlay — pick timeframes"
          onClick={() => useConcepts.getState().setPanelOpen(!panelOpen)}
        >
          FVG{enabled.length > 0 ? ` ${enabled.length}` : ''}
        </button>
        {panelOpen && (
          <div className="flex flex-wrap items-center gap-1 rounded border border-slate-700 bg-[#0d1119]/95 p-1.5">
            {FVG_TF_CHOICES.map((tf) => (
              <button
                key={tf}
                className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                  enabled.includes(tf)
                    ? 'border-teal-500 bg-teal-900/60 text-teal-200'
                    : 'border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800'
                }`}
                onClick={() => useConcepts.getState().toggleTf(tf)}
              >
                {tf}
              </button>
            ))}
            <span className="mx-0.5 h-4 w-px bg-slate-700" />
            <button
              className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                showInverted
                  ? 'border-slate-500 bg-slate-800 text-slate-200'
                  : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
              }`}
              title="Show inverted gaps (IFVGs) — dashed, color flipped to their new polarity"
              onClick={() => useConcepts.getState().setShowInverted(!showInverted)}
            >
              IFVG
            </button>
            <button
              className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                showCE
                  ? 'border-slate-500 bg-slate-800 text-slate-200'
                  : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
              }`}
              title="Show consequent encroachment (gap midpoint)"
              onClick={() => useConcepts.getState().setShowCE(!showCE)}
            >
              CE
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

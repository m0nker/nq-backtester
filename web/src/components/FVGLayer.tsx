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

import { useMemo, useState } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { timeToLogical, type ChartGeo } from '@/components/DrawingLayer';
import { sources, type InstrumentId } from '@/lib/data/barSource';
import { useBot } from '@/lib/concepts/botStore';
import { FVG_STATUSES, computeFVGs, statusOf, type FVG, type FVGStatus } from '@/lib/concepts/fvg';
import { DOL_KINDS, levelsAt, sweptSet, type DOLLevel, type LevelDataSource } from '@/lib/concepts/liquidity';
import { FVG_TF_CHOICES, useConcepts, type ChartColors } from '@/lib/concepts/store';
import { useReplay } from '@/lib/replay/clock';
import { TF_SECONDS, isSessionTf, type Timeframe } from '@/lib/types';

interface Props {
  instrument: InstrumentId;
  chartRef: React.RefObject<IChartApi | null>;
  seriesRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  geoRef: React.RefObject<ChartGeo | null>;
  overlayTick: number; // bumped by ReplayChart on any pan/zoom/scale/data change
}

const BULL = '#26a69a';
const BEAR = '#ef5350';
const OVERLAY_LOOKBACK = 1500; // matches the detector's own default bound

const STATUS_SUFFIX: Record<FVGStatus, string> = {
  unmitigated: '',
  filled: ' filled',
  'fully-mitigated': ' full mit',
  inverted: ' IFVG',
};
const STROKE_OPACITY: Record<FVGStatus, number> = {
  unmitigated: 0.5,
  filled: 0.3,
  'fully-mitigated': 0.22,
  inverted: 0.45,
};

// How far past the last candle a live gap's box reaches, in CHART bars.
// Roughly one of the gap's own candles, floored by timeframe rank so the
// ordering never collapses when the chart timeframe is large (every 4h gap
// still out-reaches every 1m gap on a 4h chart) and capped so a 4h zone on a
// 15s chart doesn't shoot off into empty space.
const extendBars = (tf: Timeframe, chartTfSec: number): number => {
  const rank = FVG_TF_CHOICES.indexOf(tf);
  // gaps never form on session timeframes, but the type admits them
  const tfSec = isSessionTf(tf) ? 0 : TF_SECONDS[tf];
  const ownCandle = chartTfSec > 0 ? tfSec / chartTfSec : 1;
  return Math.min(30, Math.max(1 + Math.max(rank, 0) * 0.6, ownCandle));
};

export default function FVGLayer({ instrument, chartRef, seriesRef, geoRef, overlayTick }: Props) {
  void overlayTick; // re-render trigger; coordinates read fresh below
  // NQ is the primary (traded) chart: it hosts the control strip and the
  // NQ-priced overlays (DOL levels, bot scope, candidates). Other charts get
  // the FVG boxes only, detected on their own data.
  const primary = instrument === 'NQ';
  const currentTime = useReplay((s) => s.currentTime);
  const dataVersion = useReplay((s) => s.dataVersion);
  const enabled = useConcepts((s) => s.enabled);
  const statuses = useConcepts((s) => s.statuses);
  const showCE = useConcepts((s) => s.showCE);
  const fvgBull = useConcepts((s) => s.fvgBull);
  const fvgBear = useConcepts((s) => s.fvgBear);
  const fvgOutline = useConcepts((s) => s.fvgOutline);
  const chartColors = useConcepts((s) => s.chartColors);
  const chartProfiles = useConcepts((s) => s.chartProfiles);
  const showLiquidity = useConcepts((s) => s.showLiquidity);
  const liqKinds = useConcepts((s) => s.liqKinds);
  const sessionsCfg = useConcepts((s) => s.sessions);
  const openPanel = useConcepts((s) => s.openPanel);
  const pendingCandidate = useBot((s) => s.pending);
  const botActive = useBot((s) => s.active);
  const botScope = useBot((s) => s.scope);
  const showBotConditions = useConcepts((s) => s.showBotConditions);
  const showBotTriggers = useConcepts((s) => s.showBotTriggers);
  const showBotLong = useConcepts((s) => s.showBotLong);
  const showBotShort = useConcepts((s) => s.showBotShort);

  // Detection is keyed to the replay clock, not to pan/zoom: overlayTick
  // re-renders only re-map boxes to pixels.
  const gaps = useMemo<FVG[]>(() => {
    void dataVersion; // new chunks / trims change the candle set
    if (currentTime === null || enabled.length === 0) return [];
    const src = sources[instrument];
    const out: FVG[] = [];
    for (const tf of enabled) {
      // windowed: the detector's own default lookback is the real bound, so
      // folding the whole visible series (250k 1s bars on 15s/30s) is waste
      out.push(...computeFVGs(src.getRecentCandles(currentTime, tf, OVERLAY_LOOKBACK + 5), tf, currentTime, {
        lookbackCandles: OVERLAY_LOOKBACK,
      }));
    }
    return out;
  }, [currentTime, dataVersion, enabled, instrument]);

  // Draw-on-liquidity levels (mech concepts). Only the categories toggled on
  // in the LIQ panel are drawn (display-only — the bot's own DOL config is
  // separate). levelsAt is cached per replay hour and the swept flags come
  // from ONE pass over the bars — both matter here because this recomputes on
  // every clock tick, autoplay included.
  const dolLevels = useMemo<{ level: DOLLevel; swept: boolean }[]>(() => {
    void dataVersion;
    // primary only: levelsAt's per-hour cache is keyed (hour, gen) without an
    // instrument, so feeding it a second chart would cross-contaminate it
    if (currentTime === null || !showLiquidity || !primary) return [];
    const src: LevelDataSource = {
      barsInWindow: (a, b) => sources[instrument].getBarsInWindow(a, b),
      candles: (upTo, tf) => sources[instrument].getVisibleCandles(upTo, tf),
    };
    const levels = levelsAt(src, currentTime, sources[instrument].generation()).filter((l) =>
      liqKinds.includes(l.kind),
    );
    const swept = sweptSet(levels, src, currentTime);
    return levels.map((level) => ({ level, swept: swept.has(level.id) }));
  }, [currentTime, dataVersion, showLiquidity, primary, instrument, liqKinds]);

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
      if (!statuses.includes(status)) continue;
      const inverted = status === 'inverted';
      const xL = toX(g.bT);
      // Live gaps run to "now" plus a timeframe-scaled tail past the last
      // candle, so a 4h zone visibly outranks a 1m one. An inverted gap is
      // history: its box still stops at the inversion close.
      const xR = inverted
        ? toX(g.invertedAt!)
        : (toX(currentTime) ?? 0) + extendBars(g.tf, geo.tfSec) * dx;
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
      const color = inverted ? (g.dir === 'bull' ? fvgBear : fvgBull) : g.dir === 'bull' ? fvgBull : fvgBear;
      const label = `${g.tf}${STATUS_SUFFIX[status]}`;
      // Right-anchored, vertically centred: the old top-left corner sat under
      // the candles and was unreadable. Clamped inside the pane so a box
      // running off the right edge keeps its label on screen.
      const labelX = Math.min(x + w - 4, paneW - 4);
      boxes.push(
        <g key={`${g.tf}-${g.formedAt}-${i}`}>
          <rect
            x={x}
            y={y}
            width={w}
            height={Math.max(h, 1)}
            fill={color}
            // untouched gaps pop; anything price has been into recedes
            fillOpacity={status === 'unmitigated' ? 0.12 : 0.05}
            stroke={fvgOutline ? color : 'none'}
            strokeOpacity={STROKE_OPACITY[status]}
            strokeWidth={1}
            strokeDasharray={inverted ? '3 3' : status === 'fully-mitigated' ? '1 3' : undefined}
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
          {h >= 10 && w >= 26 && labelX > 20 && (
            <text
              x={labelX}
              y={y + h / 2 + 3}
              textAnchor="end"
              fill={color}
              fillOpacity={0.85}
              fontSize={9}
              fontFamily="monospace"
            >
              {label}
            </text>
          )}
        </g>,
      );
    }

    // Draw-on-liquidity level lines: from level formation to now. Unswept
    // levels are solid (resting liquidity); swept ones dashed and dimmer.
    for (let i = 0; i < dolLevels.length; i++) {
      const { level, swept } = dolLevels[i];
      const yC = series.priceToCoordinate(level.price);
      if (yC === null) continue;
      const y = yC as number;
      if (y < -2 || y > paneH + 2) continue;
      const xL = Math.max(toX(level.formedAt) ?? 0, 0);
      if (xL > paneW) continue;
      const color = level.side === 'buyside' ? BEAR : BULL;
      boxes.push(
        <g key={`dol-${level.id}`}>
          <line
            x1={xL}
            y1={y}
            x2={paneW}
            y2={y}
            stroke={color}
            strokeOpacity={swept ? 0.3 : 0.65}
            strokeWidth={1}
            strokeDasharray={swept ? '4 4' : undefined}
          />
          <text
            x={paneW - 4}
            y={y - 3}
            textAnchor="end"
            fill={color}
            fillOpacity={swept ? 0.45 : 0.8}
            fontSize={9}
            fontFamily="monospace"
          >
            {level.label}
            {swept ? ' ⨯' : ''}
          </text>
        </g>,
      );
    }

    // BOT SCOPE: the zones the engine is actually using right now, drawn
    // regardless of which indicator timeframes are toggled on. Armed
    // conditions are gold (what it's waiting on); trigger-TF gaps still in
    // play are sky (what could fire, or what is vetoing a lower timeframe).
    if (primary && botActive && botScope) {
      // Side of the book a zone belongs to: a BULL condition arms longs, and
      // longs come from a BEAR trigger gap inverting — so the two roles map
      // to the same side from opposite polarities.
      const sideOk = (dir: 'bull' | 'bear', role: 'cond' | 'trig') => {
        const long = role === 'cond' ? dir === 'bull' : dir === 'bear';
        return long ? showBotLong : showBotShort;
      };
      const marks: { zone: (typeof botScope.conditions)[number]; color: string; tag: string }[] = [];
      if (showBotConditions) {
        for (const z of botScope.conditions) {
          if (!sideOk(z.dir, 'cond')) continue;
          marks.push({ zone: z, color: '#f5b942', tag: z.dir === 'bull' ? 'ARMED ▲' : 'ARMED ▼' });
        }
      }
      if (showBotTriggers) {
        for (const z of botScope.inPlay) {
          if (!sideOk(z.dir, 'trig')) continue;
          marks.push({ zone: z, color: '#38bdf8', tag: z.dir === 'bear' ? 'IN PLAY ▲' : 'IN PLAY ▼' });
        }
      }
      for (let i = 0; i < marks.length; i++) {
        const { zone, color, tag } = marks[i];
        const xL = toX(zone.bT);
        const xRRaw = (toX(currentTime) ?? 0) + extendBars(zone.tf, geo.tfSec) * dx;
        if (xL === null || xRRaw < 0 || xL > paneW) continue;
        const yTop = series.priceToCoordinate(zone.top);
        const yBot = series.priceToCoordinate(zone.bottom);
        if (yTop === null || yBot === null) continue;
        const y = Math.min(yTop as number, yBot as number);
        const h = Math.abs((yBot as number) - (yTop as number));
        if (y > paneH || y + h < 0) continue;
        const x = Math.max(xL, -8);
        const w = Math.max(Math.min(xRRaw, paneW + 8) - x, 2);
        const labelX = Math.min(x + w - 4, paneW - 4);
        boxes.push(
          <g key={`scope-${tag}-${zone.tf}-${zone.bT}-${i}`.replace(/\s/g, '')}>
            <rect
              x={x}
              y={y}
              width={w}
              height={Math.max(h, 2)}
              fill={color}
              fillOpacity={0.1}
              stroke={color}
              strokeOpacity={0.9}
              strokeWidth={2}
            />
            {h >= 10 && labelX > 30 && (
              <text
                x={labelX}
                y={y + h / 2 + 3}
                textAnchor="end"
                fill={color}
                fontSize={9}
                fontWeight={700}
                fontFamily="monospace"
              >
                {tag} {zone.tf}
              </text>
            )}
          </g>,
        );
      }
    }

    // Pending-candidate highlight: while the prompt is up, the exact
    // condition (FVG zone — amber — or swept DOL level line) and trigger
    // IFVG (sky) get loud outlines — regardless of indicator toggles.
    if (primary && pendingCandidate) {
      if (pendingCandidate.dol) {
        const d = pendingCandidate.dol;
        const yC = series.priceToCoordinate(d.price);
        if (yC !== null) {
          const y = yC as number;
          boxes.push(
            <g key="cand-dol">
              <line x1={0} y1={y} x2={paneW} y2={y} stroke="#f5b942" strokeOpacity={0.95} strokeWidth={2} />
              <text
                x={paneW - 4}
                y={Math.max(y - 6, 10)}
                textAnchor="end"
                fill="#f5b942"
                fontSize={10}
                fontWeight={700}
                fontFamily="monospace"
              >
                DOL {d.label} swept
              </text>
            </g>,
          );
        }
      }
      const marks = [
        ...(pendingCandidate.condition
          ? [{ z: pendingCandidate.condition, color: '#f5b942', label: `COND ${pendingCandidate.condition.tf}` }]
          : []),
        { z: pendingCandidate.ifvg, color: '#38bdf8', label: `IFVG ${pendingCandidate.ifvg.tf}` },
        // the unfilled 5m/15m gap the mech bots rebalance into (2026-08-12)
        ...(pendingCandidate.target
          ? [{ z: pendingCandidate.target, color: '#34d399', label: `TARGET ${pendingCandidate.target.tf}` }]
          : []),
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

      {/* control strip (primary chart only): one settings panel open at a
          time, TradingView-style — settings apply to every chart */}
      {primary && (
      <div className="pointer-events-auto absolute bottom-16 left-2 z-20 flex items-end gap-1">
        <button
          className={`flex h-7 items-center justify-center rounded border px-1.5 font-mono text-[11px] ${
            enabled.length > 0
              ? 'border-teal-500 bg-teal-950/80 text-teal-300'
              : 'border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800'
          }`}
          title="Fair value gap overlay — pick timeframes"
          onClick={() => useConcepts.getState().setOpenPanel(openPanel === 'fvg' ? null : 'fvg')}
        >
          FVG{enabled.length > 0 ? ` ${enabled.length}` : ''}
        </button>
        <button
          className={`flex h-7 items-center justify-center rounded border px-1.5 font-mono text-[11px] ${
            showLiquidity
              ? 'border-teal-500 bg-teal-950/80 text-teal-300'
              : 'border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800'
          }`}
          title="Draws on liquidity — session H/L, previous day/week H/L, HTF swings. Solid = resting, dashed ⨯ = swept. Click for settings."
          onClick={() => useConcepts.getState().setOpenPanel(openPanel === 'liq' ? null : 'liq')}
        >
          LIQ
        </button>
        <button
          className={`flex h-7 items-center justify-center rounded border px-1.5 font-mono text-[11px] ${
            sessionsCfg.show
              ? 'border-teal-500 bg-teal-950/80 text-teal-300'
              : 'border-slate-700 bg-slate-900/90 text-slate-400 hover:bg-slate-800'
          }`}
          title="Killzone session boxes — Asia / London / NY AM / NY PM with H/L lines until taken, plus PDH/PDL. Click for settings."
          onClick={() => useConcepts.getState().setOpenPanel(openPanel === 'sess' ? null : 'sess')}
        >
          SESS
        </button>
        <button
          className="flex h-7 items-center justify-center rounded border border-slate-700 bg-slate-900/90 px-1.5 font-mono text-[11px] text-slate-400 hover:bg-slate-800"
          title="Chart colors — canvas, grid, candles, crosshair; save combos as profiles"
          onClick={() => useConcepts.getState().setOpenPanel(openPanel === 'chart' ? null : 'chart')}
        >
          CHART
        </button>
        {openPanel === 'liq' && (
          <div className="flex flex-wrap items-center gap-1 rounded border border-slate-700 bg-[#0d1119]/95 p-1.5">
            <button
              className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                showLiquidity
                  ? 'border-teal-500 bg-teal-900/60 text-teal-200'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800'
              }`}
              title="Master toggle for the liquidity-level overlay"
              onClick={() => useConcepts.getState().setShowLiquidity(!showLiquidity)}
            >
              {showLiquidity ? 'ON' : 'OFF'}
            </button>
            <span className="mx-0.5 h-4 w-px bg-slate-700" />
            {DOL_KINDS.map(({ kind, label }) => (
              <button
                key={kind}
                className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                  liqKinds.includes(kind)
                    ? 'border-slate-500 bg-slate-800 text-slate-200'
                    : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
                }`}
                onClick={() => useConcepts.getState().toggleLiqKind(kind)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {openPanel === 'sess' && (
          <div className="flex flex-col gap-1.5 rounded border border-slate-700 bg-[#0d1119]/95 p-2 font-mono text-[11px] text-slate-300">
            <div className="flex items-center gap-2">
              <button
                className={`rounded border px-1.5 py-0.5 ${
                  sessionsCfg.show
                    ? 'border-teal-500 bg-teal-900/60 text-teal-200'
                    : 'border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800'
                }`}
                title="Master toggle for the session-box overlay"
                onClick={() => useConcepts.getState().updateSessions({ show: !sessionsCfg.show })}
              >
                {sessionsCfg.show ? 'ON' : 'OFF'}
              </button>
              <label className="flex items-center gap-1" title="How many recent occurrences of each session to draw">
                days
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={sessionsCfg.days}
                  className="w-11 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 [color-scheme:dark]"
                  onChange={(e) =>
                    useConcepts.getState().updateSessions({ days: Math.min(10, Math.max(1, Math.round(+e.target.value || 1))) })
                  }
                />
              </label>
              <label className="flex items-center gap-1" title="Previous trading day high/low lines (black, extend until taken)">
                <input
                  type="checkbox"
                  checked={sessionsCfg.showPD}
                  onChange={(e) => useConcepts.getState().updateSessions({ showPD: e.target.checked })}
                />
                PDH/PDL
              </label>
              <label className="flex items-center gap-1" title="Box fill strength — scales every session's color opacity">
                fill
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={sessionsCfg.boxFillPct}
                  className="w-12 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 [color-scheme:dark]"
                  onChange={(e) =>
                    useConcepts.getState().updateSessions({ boxFillPct: Math.min(100, Math.max(0, Math.round(+e.target.value || 0))) })
                  }
                />
                %
              </label>
            </div>
            {sessionsCfg.windows.map((w) => (
              <div key={w.key} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={w.enabled}
                  onChange={(e) => useConcepts.getState().updateSessionWindow(w.key, { enabled: e.target.checked })}
                />
                <span className="w-14">{w.label}</span>
                <input
                  type="time"
                  value={w.start}
                  className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 [color-scheme:dark]"
                  onChange={(e) => e.target.value && useConcepts.getState().updateSessionWindow(w.key, { start: e.target.value })}
                />
                <span>–</span>
                <input
                  type="time"
                  value={w.end}
                  className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 [color-scheme:dark]"
                  onChange={(e) => e.target.value && useConcepts.getState().updateSessionWindow(w.key, { end: e.target.value })}
                />
                <input
                  type="color"
                  value={w.color}
                  title="Session color"
                  className="h-5 w-7 cursor-pointer rounded border border-slate-700 bg-slate-900"
                  onChange={(e) => useConcepts.getState().updateSessionWindow(w.key, { color: e.target.value })}
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={w.opacityPct}
                  title="Color opacity (box fill; H/L line always draws at 100%)"
                  className="w-12 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 [color-scheme:dark]"
                  onChange={(e) =>
                    useConcepts.getState().updateSessionWindow(w.key, {
                      opacityPct: Math.min(100, Math.max(0, Math.round(+e.target.value || 0))),
                    })
                  }
                />
                <span>%</span>
              </div>
            ))}
            <div className="text-[10px] text-slate-500">times are ET · lines extend until taken</div>
          </div>
        )}
        {openPanel === 'fvg' && (
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
            {/* per-status visibility */}
            {FVG_STATUSES.map(({ status, label, title }) => (
              <button
                key={status}
                className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                  statuses.includes(status)
                    ? 'border-slate-500 bg-slate-800 text-slate-200'
                    : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
                }`}
                title={title}
                onClick={() => useConcepts.getState().toggleStatus(status)}
              >
                {label}
              </button>
            ))}
            <span className="mx-0.5 h-4 w-px bg-slate-700" />
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
            <span className="mx-0.5 h-4 w-px bg-slate-700" />
            <label className="flex items-center gap-1 font-mono text-[11px] text-slate-400" title="Bullish gap color">
              bull
              <input
                type="color"
                value={fvgBull}
                className="h-5 w-7 cursor-pointer rounded border border-slate-700 bg-slate-900"
                onChange={(e) => useConcepts.getState().updateFvgStyle({ fvgBull: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-1 font-mono text-[11px] text-slate-400" title="Bearish gap color">
              bear
              <input
                type="color"
                value={fvgBear}
                className="h-5 w-7 cursor-pointer rounded border border-slate-700 bg-slate-900"
                onChange={(e) => useConcepts.getState().updateFvgStyle({ fvgBear: e.target.value })}
              />
            </label>
            <button
              className={`rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                fvgOutline
                  ? 'border-slate-500 bg-slate-800 text-slate-200'
                  : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
              }`}
              title="Draw the gap box outline"
              onClick={() => useConcepts.getState().updateFvgStyle({ fvgOutline: !fvgOutline })}
            >
              outline
            </button>
          </div>
        )}
        {openPanel === 'chart' && <ChartColorPanel colors={chartColors} profiles={chartProfiles} />}
      </div>
      )}
    </div>
  );
}

// CHART settings panel: per-element color pickers plus named profiles
// (save/apply/delete) persisted with the rest of the concepts settings.
const CHART_COLOR_FIELDS: readonly { key: keyof Omit<ChartColors, 'gridOpacityPct'>; label: string }[] = [
  { key: 'background', label: 'canvas' },
  { key: 'grid', label: 'grid' },
  { key: 'text', label: 'axis text' },
  { key: 'upBody', label: 'body up' },
  { key: 'downBody', label: 'body down' },
  { key: 'border', label: 'borders' },
  { key: 'wick', label: 'wick' },
  { key: 'crosshair', label: 'crosshair' },
  { key: 'priceLine', label: 'price line' },
];

function ChartColorPanel({
  colors,
  profiles,
}: {
  colors: ChartColors;
  profiles: Record<string, ChartColors>;
}) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const names = Object.keys(profiles);
  return (
    <div className="flex w-64 flex-col gap-1.5 rounded border border-slate-700 bg-[#0d1119]/95 p-2 font-mono text-[11px] text-slate-300">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {CHART_COLOR_FIELDS.map(({ key, label }) => (
          <label key={key} className="flex items-center justify-between gap-1.5">
            {label}
            <input
              type="color"
              value={colors[key]}
              className="h-5 w-7 cursor-pointer rounded border border-slate-700 bg-slate-900"
              onChange={(e) => useConcepts.getState().updateChartColors({ [key]: e.target.value })}
            />
          </label>
        ))}
        <label className="flex items-center justify-between gap-1.5" title="Grid line opacity">
          grid %
          <input
            type="number"
            min={0}
            max={100}
            value={colors.gridOpacityPct}
            className="w-12 rounded border border-slate-700 bg-slate-900 px-1 py-0.5 [color-scheme:dark]"
            onChange={(e) =>
              useConcepts.getState().updateChartColors({
                gridOpacityPct: Math.min(100, Math.max(0, Math.round(+e.target.value || 0))),
              })
            }
          />
        </label>
      </div>
      <div className="mt-1 flex items-center gap-1 border-t border-slate-800 pt-1.5">
        <select
          className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-1 py-0.5"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            if (e.target.value) useConcepts.getState().applyChartProfile(e.target.value);
          }}
          title="Apply a saved color profile"
        >
          <option value="">— profile —</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {selected && (
          <button
            className="rounded border border-rose-800 bg-rose-950/60 px-1.5 py-0.5 text-rose-300 hover:bg-rose-900/60"
            title={`Delete profile "${selected}"`}
            onClick={() => {
              useConcepts.getState().deleteChartProfile(selected);
              setSelected('');
            }}
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex items-center gap-1">
        <input
          type="text"
          placeholder="profile name"
          value={name}
          className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 [color-scheme:dark]"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              useConcepts.getState().saveChartProfile(name);
              setSelected(name.trim());
              setName('');
            }
          }}
        />
        <button
          className="rounded border border-teal-700 bg-teal-950/60 px-1.5 py-0.5 text-teal-300 hover:bg-teal-900/60 disabled:opacity-40"
          disabled={!name.trim()}
          title="Save the current colors under this name"
          onClick={() => {
            useConcepts.getState().saveChartProfile(name);
            setSelected(name.trim());
            setName('');
          }}
        >
          save
        </button>
      </div>
    </div>
  );
}

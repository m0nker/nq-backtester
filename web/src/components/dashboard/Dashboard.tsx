'use client';

// Per-session and all-sessions statistics: equity curve (from event-derived
// trades), win rate, profit factor, expectancy, max drawdown, and P&L by
// time-of-day / day-of-week. Everything derives from the event logs in
// Supabase via the same reducer the live session uses.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, LineSeries, createChart, type UTCTimestamp } from 'lightweight-charts';
import { loadSessionEvents, listSessions, type SessionRow } from '@/lib/data/sessions';
import { computeStats, equityPoints, pnlByDowET, pnlByHourET } from '@/lib/stats/metrics';
import { fmtUsd } from '@/lib/trading/contractMath';
import { deriveState, type Trade } from '@/lib/trading/engine';
import { formatET, toChartTime } from '@/lib/time/et';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (Math.abs(value) / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-10 text-slate-500">{label}</span>
      <div className="h-3 flex-1 rounded bg-slate-900">
        <div
          className={`h-3 rounded ${value >= 0 ? 'bg-emerald-500/60' : 'bg-rose-500/60'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`w-20 text-right font-mono ${value > 0 ? 'text-emerald-400' : value < 0 ? 'text-rose-400' : 'text-slate-500'}`}>
        {value !== 0 ? fmtUsd(value) : '—'}
      </span>
    </div>
  );
}

export default function Dashboard({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [selected, setSelected] = useState<'all' | string>('all');
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const eventCache = useRef(new Map<string, Trade[]>());
  const equityRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listSessions(true).then(setSessions).catch(() => setSessions([]));
  }, []);

  // derive trades for the selection (cached per session)
  useEffect(() => {
    if (!sessions) return;
    let stale = false;
    setTrades(null);
    const wanted = selected === 'all' ? sessions.map((s) => s.id) : [selected];
    void (async () => {
      const all: Trade[] = [];
      for (const id of wanted) {
        let t = eventCache.current.get(id);
        if (!t) {
          const events = await loadSessionEvents(id);
          t = deriveState(events).trades;
          eventCache.current.set(id, t);
        }
        all.push(...t);
      }
      if (!stale) setTrades(all.sort((a, b) => a.exitTs - b.exitTs));
    })();
    return () => {
      stale = true;
    };
  }, [sessions, selected]);

  const stats = useMemo(() => (trades ? computeStats(trades) : null), [trades]);

  // equity curve chart
  useEffect(() => {
    const el = equityRef.current;
    if (!el || !trades || trades.length === 0) return;
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: '#0d1119' }, textColor: '#8b93a7' },
      grid: { vertLines: { color: '#161b26' }, horzLines: { color: '#161b26' } },
      timeScale: { timeVisible: true, borderColor: '#232a3b' },
      rightPriceScale: { borderColor: '#232a3b' },
      autoSize: true,
    });
    const line = chart.addSeries(LineSeries, { color: '#f5b942', lineWidth: 2 });
    line.setData(
      equityPoints(trades).map((p) => ({ time: toChartTime(p.t) as UTCTimestamp, value: p.v })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [trades]);

  const byHour = useMemo(() => (trades ? pnlByHourET(trades) : []), [trades]);
  const byDow = useMemo(() => (trades ? pnlByDowET(trades) : []), [trades]);
  const hourMax = Math.max(1, ...byHour.map(Math.abs));
  const dowMax = Math.max(1, ...byDow.map(Math.abs));

  const stat = (label: string, value: string, cls = 'text-slate-200') => (
    <div className="rounded-lg border border-slate-800 bg-[#0d1119] p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`font-mono text-lg ${cls}`}>{value}</div>
    </div>
  );
  const pnlCls = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-200');

  return (
    <main className="min-h-screen bg-[#0b0e14] p-6 text-slate-200">
      <div className="mx-auto max-w-5xl">
        <div className="mb-4 flex items-center gap-3">
          <h1 className="text-lg font-semibold">Dashboard</h1>
          <select
            className="rounded bg-slate-800 px-2 py-1 text-sm"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="all">All sessions ({sessions?.length ?? '…'})</option>
            {sessions?.map((s) => (
              <option key={s.id} value={s.id}>
                {formatET(new Date(s.start_ts).getTime() / 1000)}
                {s.status === 'archived' ? ' (archived)' : ''}
              </option>
            ))}
          </select>
          <button className="ml-auto rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700" onClick={onClose}>
            ← Back
          </button>
        </div>

        {!trades || !stats ? (
          <p className="text-sm text-slate-500">Loading trades…</p>
        ) : stats.tradeCount === 0 ? (
          <p className="text-sm text-slate-500">No completed trades in this selection yet.</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-4 gap-3 lg:grid-cols-8">
              {stat('Net P&L', fmtUsd(stats.netUsd), pnlCls(stats.netUsd))}
              {stat('Trades', String(stats.tradeCount))}
              {stat('Win rate', `${(stats.winRate * 100).toFixed(1)}%`)}
              {stat('Profit factor', stats.profitFactor === null ? '∞' : stats.profitFactor.toFixed(2))}
              {stat('Avg win', fmtUsd(stats.avgWinUsd), 'text-emerald-400')}
              {stat('Avg loss', fmtUsd(-stats.avgLossUsd), 'text-rose-400')}
              {stat('Expectancy', fmtUsd(stats.expectancyUsd), pnlCls(stats.expectancyUsd))}
              {stat('Max drawdown', fmtUsd(-stats.maxDrawdownUsd), 'text-rose-400')}
            </div>

            <div className="mb-4 rounded-lg border border-slate-800 bg-[#0d1119] p-3">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
                Equity curve (realized, $)
              </div>
              <div ref={equityRef} className="h-64 w-full" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-slate-800 bg-[#0d1119] p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
                  P&L by entry hour (ET)
                </div>
                <div className="flex flex-col gap-1">
                  {byHour.map((v, h) =>
                    v !== 0 ? <BarRow key={h} label={`${String(h).padStart(2, '0')}:00`} value={v} max={hourMax} /> : null,
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#0d1119] p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
                  P&L by day of week (ET)
                </div>
                <div className="flex flex-col gap-1">
                  {byDow.map((v, d) => (
                    <BarRow key={d} label={DOW[d]} value={v} max={dowMax} />
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

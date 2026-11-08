'use client';

// Statistics over any combination of sessions: equity curve (from
// event-derived trades), performance / win-loss / R-multiple / daily stats,
// a per-session breakdown, and P&L by time-of-day / day-of-week. Everything
// derives from the event logs in Supabase via the same reducer the live
// session uses.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, LineSeries, createChart, type UTCTimestamp } from 'lightweight-charts';
import { botOfConfig } from '@/lib/bots/registry';
import { loadSessionEvents, listSessions, type SessionRow } from '@/lib/data/sessions';
import { computeStats, equityPoints, pnlByDowET, pnlByHourET, type SessionStats } from '@/lib/stats/metrics';
import { fmtUsd } from '@/lib/trading/contractMath';
import { deriveState, type Trade } from '@/lib/trading/engine';
import { formatET, toChartTime } from '@/lib/time/et';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Scope (active-only + picked sessions) survives reloads — a per-viewer
// convenience, so storage failures just fall back to "everything".
const SCOPE_KEY = 'dashboard-scope-v1';
interface Scope {
  activeOnly: boolean;
  picked: string[] | null; // null = every session in the pool
}
function loadScope(): Scope {
  if (typeof window === 'undefined') return { activeOnly: false, picked: null };
  try {
    const p = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? '{}') as Partial<Scope>;
    return {
      activeOnly: p.activeOnly === true,
      picked: Array.isArray(p.picked) ? p.picked.filter((x): x is string => typeof x === 'string') : null,
    };
  } catch {
    return { activeOnly: false, picked: null };
  }
}
function saveScope(s: Scope) {
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify(s));
  } catch {
    // storage blocked — scope just won't survive a reload
  }
}

const sessionName = (s: SessionRow): string => {
  const name = typeof s.config?.name === 'string' ? s.config.name : '';
  return name || formatET(new Date(s.start_ts).getTime() / 1000);
};

const fmtNum = (v: number | null, d = 2, inf = '∞') => (v === null ? inf : v.toFixed(d));
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
const fmtR = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
function fmtDur(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
const pnlCls = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-200');

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

function Stat({ label, value, cls = 'text-slate-200', title }: { label: string; value: string; cls?: string; title?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-[#0d1119] p-3" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`font-mono text-lg ${cls}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{title}</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{children}</div>
    </div>
  );
}

function StatsGrid({ s }: { s: SessionStats }) {
  const rCov = `${s.rTrades}/${s.tradeCount} trades had a bracket`;
  return (
    <>
      <Section title="Performance">
        <Stat label="Net P&L" value={fmtUsd(s.netUsd)} cls={pnlCls(s.netUsd)} />
        <Stat label="Trades" value={String(s.tradeCount)} />
        <Stat label="Win rate" value={fmtPct(s.winRate)} title="wins / all trades (breakevens count as non-wins)" />
        <Stat label="Profit factor" value={fmtNum(s.profitFactor)} title="gross win / gross loss" />
        <Stat label="Expectancy" value={fmtUsd(s.expectancyUsd)} cls={pnlCls(s.expectancyUsd)} title="average P&L per trade" />
        <Stat label="Max drawdown" value={fmtUsd(-s.maxDrawdownUsd)} cls="text-rose-400" title="peak-to-trough on the trade-by-trade equity curve" />
        <Stat label="Recovery factor" value={fmtNum(s.recoveryFactor, 2, '—')} title="net P&L / max drawdown" />
        <Stat label="Sharpe (per trade)" value={fmtNum(s.sharpePerTrade, 2, '—')} title="mean / stdev of per-trade P&L — not annualized" />
        <Stat label="Gross win" value={fmtUsd(s.grossWinUsd)} cls="text-emerald-400" />
        <Stat label="Gross loss" value={fmtUsd(-s.grossLossUsd)} cls="text-rose-400" />
        <Stat
          label="Kelly"
          value={s.kellyPct === null ? '—' : fmtPct(s.kellyPct)}
          title="W − (1−W)/payoff: the edge-optimal risk fraction implied by these results (negative = no edge)"
        />
        <Stat label="Avg hold" value={fmtDur(s.avgHoldSec)} />
      </Section>

      <Section title="Wins & losses">
        <Stat label="Avg win" value={fmtUsd(s.avgWinUsd)} cls="text-emerald-400" />
        <Stat label="Avg loss" value={fmtUsd(-s.avgLossUsd)} cls="text-rose-400" />
        <Stat label="Avg win / avg loss" value={fmtNum(s.payoffRatio, 2, '—')} title="realized $ reward:risk (payoff ratio)" />
        <Stat label="Largest win" value={fmtUsd(s.largestWinUsd)} cls="text-emerald-400" />
        <Stat label="Largest loss" value={fmtUsd(-s.largestLossUsd)} cls="text-rose-400" />
        <Stat label="W / L / BE" value={`${s.wins} / ${s.losses} / ${s.breakevens}`} />
        <Stat label="Max win streak" value={String(s.maxConsecWins)} />
        <Stat label="Max loss streak" value={String(s.maxConsecLosses)} />
        <Stat
          label="Longs"
          value={s.long.count ? `${s.long.count} · ${fmtPct(s.long.winRate)}` : '—'}
          title={`net ${fmtUsd(s.long.netUsd)}`}
        />
        <Stat label="Long net" value={fmtUsd(s.long.netUsd)} cls={pnlCls(s.long.netUsd)} />
        <Stat
          label="Shorts"
          value={s.short.count ? `${s.short.count} · ${fmtPct(s.short.winRate)}` : '—'}
          title={`net ${fmtUsd(s.short.netUsd)}`}
        />
        <Stat label="Short net" value={fmtUsd(s.short.netUsd)} cls={pnlCls(s.short.netUsd)} />
      </Section>

      <Section title={`R-multiples (${rCov})`}>
        {s.rTrades === 0 ? (
          <div className="col-span-full text-xs text-slate-500">
            No trades with a stop bracket on entry — R stats need a stop to define 1R.
          </div>
        ) : (
          <>
            <Stat label="Total R" value={fmtR(s.totalR)} cls={pnlCls(s.totalR)} />
            <Stat label="Expectancy (R)" value={fmtR(s.avgR)} cls={pnlCls(s.avgR)} title="average R per bracketed trade" />
            <Stat label="Avg win (R)" value={fmtR(s.avgWinR)} cls="text-emerald-400" />
            <Stat label="Avg loss (R)" value={fmtR(-s.avgLossR)} cls="text-rose-400" />
            <Stat
              label="Realized RR"
              value={s.avgLossR > 0 ? `${(s.avgWinR / s.avgLossR).toFixed(2)}` : '—'}
              title="avg win R / avg loss R"
            />
            <Stat label="Planned RR" value={fmtNum(s.plannedRR, 2, '—')} title="average |TP − entry| / risk on trades that had a target" />
          </>
        )}
      </Section>

      <Section title="Days (CME trading day of exit)">
        <Stat label="Trading days" value={String(s.tradingDays)} />
        <Stat label="Green days" value={s.tradingDays ? `${s.greenDays} · ${fmtPct(s.greenDays / s.tradingDays)}` : '—'} />
        <Stat label="Avg day" value={fmtUsd(s.avgDayUsd)} cls={pnlCls(s.avgDayUsd)} />
        <Stat label="Best day" value={fmtUsd(s.bestDayUsd)} cls={pnlCls(s.bestDayUsd)} />
        <Stat label="Worst day" value={fmtUsd(s.worstDayUsd)} cls={pnlCls(s.worstDayUsd)} />
        <Stat label="Trades / day" value={s.tradingDays ? (s.tradeCount / s.tradingDays).toFixed(1) : '—'} />
      </Section>
    </>
  );
}

export default function Dashboard({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [scope, setScopeState] = useState<Scope>(loadScope);
  const [pickerOpen, setPickerOpen] = useState(false);
  // derived trades per session id (events → reducer), filled lazily
  const [tradesById, setTradesById] = useState<Record<string, Trade[]>>({});
  const equityRef = useRef<HTMLDivElement>(null);

  const setScope = (next: Scope) => {
    setScopeState(next);
    saveScope(next);
  };

  useEffect(() => {
    // the start screen shows the newest 100; stats want every session
    listSessions(true, 1000).then(setSessions).catch(() => setSessions([]));
  }, []);

  // the sessions the picker offers, then the ones actually included
  const pool = useMemo(
    () => (sessions ?? []).filter((s) => !scope.activeOnly || s.status === 'active'),
    [sessions, scope.activeOnly],
  );
  const chosen = useMemo(() => {
    if (scope.picked === null) return pool;
    const set = new Set(scope.picked);
    return pool.filter((s) => set.has(s.id));
  }, [pool, scope.picked]);
  const chosenKey = chosen.map((s) => s.id).join(',');

  // load event logs for any chosen session not derived yet
  useEffect(() => {
    if (!sessions) return;
    const missing = chosen.filter((s) => !(s.id in tradesById)).map((s) => s.id);
    if (missing.length === 0) return;
    let stale = false;
    void (async () => {
      const got: Record<string, Trade[]> = {};
      await Promise.all(
        missing.map(async (id) => {
          try {
            got[id] = deriveState(await loadSessionEvents(id)).trades;
          } catch {
            got[id] = []; // unreadable log — count as no trades rather than hang
          }
        }),
      );
      if (!stale) setTradesById((prev) => ({ ...prev, ...got }));
    })();
    return () => {
      stale = true;
    };
    // chosenKey stands in for `chosen` (new array identity every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, chosenKey, tradesById]);

  const ready = sessions !== null && chosen.every((s) => s.id in tradesById);
  const trades = useMemo<Trade[] | null>(() => {
    if (!ready) return null;
    return chosen.flatMap((s) => tradesById[s.id]).sort((a, b) => a.exitTs - b.exitTs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, chosenKey, tradesById]);

  const stats = useMemo(() => (trades ? computeStats(trades) : null), [trades]);

  const perSession = useMemo(() => {
    if (!ready || chosen.length < 2) return [];
    return chosen
      .map((s) => ({ s, st: computeStats(tradesById[s.id]) }))
      .filter((r) => r.st.tradeCount > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, chosenKey, tradesById]);

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

  const isPicked = (id: string) => scope.picked === null || scope.picked.includes(id);
  const togglePick = (id: string) => {
    const base = scope.picked ?? pool.map((s) => s.id);
    setScope({ ...scope, picked: base.includes(id) ? base.filter((x) => x !== id) : [...base, id] });
  };

  const pickerLabel =
    scope.picked === null ? `All ${pool.length}` : `${chosen.length} of ${pool.length}`;

  return (
    <main className="min-h-screen bg-[#0b0e14] p-6 text-slate-200">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">Dashboard</h1>

          <div className="relative">
            <button
              className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm hover:bg-slate-700"
              onClick={() => setPickerOpen((v) => !v)}
            >
              Sessions: {sessions ? pickerLabel : '…'} ▾
            </button>
            {pickerOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setPickerOpen(false)} />
                <div className="absolute left-0 top-full z-20 mt-1 w-80 rounded-lg border border-slate-700 bg-[#0d1119] p-2 shadow-xl">
                  <div className="mb-2 flex items-center gap-1 text-xs">
                    <button
                      className="rounded bg-slate-800 px-2 py-0.5 hover:bg-slate-700"
                      onClick={() => setScope({ ...scope, picked: null })}
                    >
                      All
                    </button>
                    <button
                      className="rounded bg-slate-800 px-2 py-0.5 hover:bg-slate-700"
                      onClick={() => setScope({ ...scope, picked: [] })}
                    >
                      None
                    </button>
                    <span className="ml-auto text-slate-500">{chosen.length} selected</span>
                  </div>
                  <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
                    {pool.length === 0 && <div className="p-2 text-xs text-slate-500">No sessions.</div>}
                    {pool.map((s) => {
                      const bot = botOfConfig(s.config);
                      const n = tradesById[s.id]?.length;
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-slate-800 ${
                            s.status === 'archived' ? 'opacity-60' : ''
                          }`}
                        >
                          <input type="checkbox" checked={isPicked(s.id)} onChange={() => togglePick(s.id)} />
                          <span className="min-w-0 flex-1 truncate">{sessionName(s)}</span>
                          {bot && <span className="text-[10px] text-sky-400">{bot.name}</span>}
                          {s.status === 'archived' && <span className="text-[10px] text-slate-500">archived</span>}
                          {n !== undefined && <span className="w-8 text-right font-mono text-[10px] text-slate-500">{n}</span>}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          <label className="flex items-center gap-1.5 text-sm text-slate-400" title="Exclude archived sessions">
            <input
              type="checkbox"
              checked={scope.activeOnly}
              onChange={(e) => setScope({ ...scope, activeOnly: e.target.checked })}
            />
            active only
          </label>

          <button className="ml-auto rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700" onClick={onClose}>
            ← Back
          </button>
        </div>

        {sessions !== null && chosen.length === 0 ? (
          <p className="text-sm text-slate-500">No sessions selected.</p>
        ) : !trades || !stats ? (
          <p className="text-sm text-slate-500">Loading trades…</p>
        ) : stats.tradeCount === 0 ? (
          <p className="text-sm text-slate-500">No completed trades in this selection yet.</p>
        ) : (
          <>
            <StatsGrid s={stats} />

            <div className="mb-4 rounded-lg border border-slate-800 bg-[#0d1119] p-3">
              <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">
                Equity curve (realized, $)
              </div>
              <div ref={equityRef} className="h-64 w-full" />
            </div>

            {perSession.length > 1 && (
              <div className="mb-4 overflow-x-auto rounded-lg border border-slate-800 bg-[#0d1119] p-3">
                <div className="mb-2 text-[10px] uppercase tracking-wide text-slate-500">By session</div>
                <table className="w-full text-xs">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-1 font-normal">Session</th>
                      <th className="py-1 text-right font-normal">Trades</th>
                      <th className="py-1 text-right font-normal">Win %</th>
                      <th className="py-1 text-right font-normal">PF</th>
                      <th className="py-1 text-right font-normal">Exp.</th>
                      <th className="py-1 text-right font-normal">Avg R</th>
                      <th className="py-1 text-right font-normal">Max DD</th>
                      <th className="py-1 text-right font-normal">Net</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {perSession.map(({ s, st }) => (
                      <tr key={s.id} className="border-t border-slate-800/70">
                        <td className="max-w-[16rem] truncate py-1 font-sans">
                          {sessionName(s)}
                          {s.status === 'archived' && <span className="ml-1 text-[10px] text-slate-500">archived</span>}
                        </td>
                        <td className="py-1 text-right">{st.tradeCount}</td>
                        <td className="py-1 text-right">{fmtPct(st.winRate)}</td>
                        <td className="py-1 text-right">{fmtNum(st.profitFactor)}</td>
                        <td className={`py-1 text-right ${pnlCls(st.expectancyUsd)}`}>{fmtUsd(st.expectancyUsd)}</td>
                        <td className={`py-1 text-right ${pnlCls(st.avgR)}`}>{st.rTrades ? fmtR(st.avgR) : '—'}</td>
                        <td className="py-1 text-right text-rose-400">{fmtUsd(-st.maxDrawdownUsd)}</td>
                        <td className={`py-1 text-right ${pnlCls(st.netUsd)}`}>{fmtUsd(st.netUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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

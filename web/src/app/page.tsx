'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dashboard from '@/components/dashboard/Dashboard';
import ReplayChart from '@/components/ReplayChart';
import ReplayControls from '@/components/ReplayControls';
import SessionList from '@/components/sessions/SessionList';
import OrderPanel from '@/components/trading/OrderPanel';
import PositionBar from '@/components/trading/PositionBar';
import TradeLog from '@/components/trades/TradeLog';
import { initBarSource } from '@/lib/data/barSource';
import { listSessions, loadSessionEvents, resumeTimeOf, type SessionRow } from '@/lib/data/sessions';
import { useReplay } from '@/lib/replay/clock';
import { useTrading } from '@/lib/trading/store';
import { etWallToUtc } from '@/lib/time/et';
import type { DayMeta } from '@/lib/types';

export default function Home() {
  const [manifest, setManifest] = useState<DayMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('09:25');
  const [endDate, setEndDate] = useState('');
  const [balance, setBalance] = useState(50000);
  const [rewindMode, setRewindMode] = useState(false);
  const [showTrades, setShowTrades] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [resuming, setResuming] = useState(false);
  const [chartLayout, setChartLayout] = useState<'nq' | 'split' | 'es'>('split');
  const [leftPct, setLeftPct] = useState(55);
  const chartsRef = useRef<HTMLDivElement>(null);

  const startDividerDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    // Capture the pointer on the divider itself: once the cursor crosses the
    // chart canvases their handlers would otherwise swallow the moves (drag
    // used to die crossing into the ES pane). With capture, every subsequent
    // pointer event retargets to the divider until release.
    const el = e.currentTarget as HTMLElement;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // no active pointer (synthetic events) — listeners below still work
    }
    const move = (ev: PointerEvent) => {
      const rect = chartsRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(80, Math.max(20, pct)));
    };
    const done = (ev: PointerEvent) => {
      if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', done);
      el.removeEventListener('pointercancel', done);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', done);
    el.addEventListener('pointercancel', done);
  };

  const { currentTime, start, reset, loading } = useReplay();
  const trading = useTrading();
  const started = currentTime !== null;

  const refreshSessions = useCallback(() => {
    listSessions(true).then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    initBarSource()
      .then((m) => {
        setManifest(m);
        if (m.length) setDate(m[m.length - 1].trading_date);
      })
      .catch((e) => setError(String(e)));
    refreshSessions();
  }, [refreshSessions]);

  const resume = async (s: SessionRow) => {
    setResuming(true);
    try {
      const events = await loadSessionEvents(s.id);
      await trading.resume(s.id, events);
      const startTs = new Date(s.start_ts).getTime() / 1000;
      await start(resumeTimeOf(events, startTs), s.config?.endTs ?? null);
    } catch (e) {
      setError(String(e));
    } finally {
      setResuming(false);
    }
  };

  // esc cancels click-to-place
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') trading.setPendingClick(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trading]);

  const availableDates = useMemo(() => new Set(manifest?.map((d) => d.trading_date)), [manifest]);
  const dateKnown = availableDates.has(date);
  const endBeforeStart = endDate !== '' && endDate < date;

  const begin = () => {
    if (!date || !time || endBeforeStart) return;
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    let endTs: number | null = null;
    if (endDate) {
      const [ey, emo, ed] = endDate.split('-').map(Number);
      endTs = etWallToUtc(ey, emo, ed, 17);
    }
    const startTs = etWallToUtc(y, mo, d, h, mi);
    void trading.begin({ startTs, endTs, startingBalance: balance });
    void start(startTs, endTs);
  };

  const endSession = () => {
    void trading.end();
    reset();
    refreshSessions();
  };

  if (showDashboard) {
    return <Dashboard onClose={() => setShowDashboard(false)} />;
  }

  if (!started) {
    return (
      <main className="flex min-h-screen flex-1 items-center justify-center gap-6 bg-[#0b0e14] text-slate-200">
        <div className="w-96 rounded-xl border border-slate-800 bg-[#0d1119] p-8">
          <h1 className="mb-1 text-xl font-semibold">NQ Replay</h1>
          <p className="mb-6 text-sm text-slate-500">
            {manifest
              ? `${manifest.length} trading days available (${manifest[0]?.trading_date} → ${manifest[manifest.length - 1]?.trading_date})`
              : (error ?? 'Loading available days…')}
          </p>

          <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
            Trading day
          </label>
          <input
            type="date"
            className="mb-1 w-full rounded bg-slate-800 px-3 py-2"
            value={date}
            min={manifest?.[0]?.trading_date}
            max={manifest?.[manifest.length - 1]?.trading_date}
            onChange={(e) => setDate(e.target.value)}
          />
          {date && manifest && !dateKnown && (
            <p className="mb-2 text-xs text-amber-400">
              No data for this date (weekend/holiday) — pick another day.
            </p>
          )}

          <label className="mb-1 mt-3 block text-xs uppercase tracking-wide text-slate-500">
            Start time (ET)
          </label>
          <input
            type="time"
            className="mb-3 w-full rounded bg-slate-800 px-3 py-2"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />

          <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
            End date <span className="normal-case text-slate-600">(optional — replay stops here)</span>
          </label>
          <input
            type="date"
            className="mb-3 w-full rounded bg-slate-800 px-3 py-2"
            value={endDate}
            min={date || manifest?.[0]?.trading_date}
            max={manifest?.[manifest.length - 1]?.trading_date}
            onChange={(e) => setEndDate(e.target.value)}
          />
          {endBeforeStart && (
            <p className="mb-2 text-xs text-amber-400">End date is before the start date.</p>
          )}

          <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
            Starting balance ($)
          </label>
          <input
            type="number"
            min={0}
            step={1000}
            className="mb-5 w-full rounded bg-slate-800 px-3 py-2"
            value={balance}
            onChange={(e) => setBalance(+e.target.value)}
          />

          <button
            className="w-full rounded bg-amber-500 py-2 font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-40"
            disabled={!manifest || !dateKnown || loading || endBeforeStart || resuming}
            onClick={begin}
          >
            {loading || resuming ? 'Loading data…' : 'Start session'}
          </button>
          <button
            className="mt-2 w-full rounded bg-slate-800 py-2 text-sm text-slate-300 hover:bg-slate-700"
            onClick={() => setShowDashboard(true)}
          >
            Dashboard
          </button>
        </div>

        <SessionList sessions={sessions} onResume={(s) => void resume(s)} onChanged={refreshSessions} />
      </main>
    );
  }

  const clickMode = trading.pendingClick ? 'price' : rewindMode ? 'rewind' : 'none';

  return (
    <main className="flex h-screen flex-col bg-[#0b0e14] text-slate-200">
      <header className="flex items-center justify-between border-b border-slate-800 bg-[#0d1119] px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-wide">NQ Replay</h1>
          <span className="text-xs text-slate-500">
            bar replay · no lookahead
            {endDate && ` · range ${date} → ${endDate}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* chart layout: NQ only | split | ES only */}
          <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
            {(
              [
                ['nq', 'NQ'],
                ['split', 'NQ | ES'],
                ['es', 'ES'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                className={`px-2 py-1 ${chartLayout === mode ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-900 text-slate-400 hover:bg-slate-800'}`}
                onClick={() => setChartLayout(mode)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className={`rounded px-3 py-1 text-sm ${showTrades ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 hover:bg-slate-700'}`}
            onClick={() => setShowTrades(!showTrades)}
          >
            Trades ({trading.derived.trades.length})
          </button>
          <button
            className="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
            onClick={() => setShowDashboard(true)}
          >
            Dashboard
          </button>
          <button
            className="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700"
            onClick={endSession}
          >
            End session
          </button>
        </div>
      </header>

      <div ref={chartsRef} className="flex min-h-0 flex-1">
        {chartLayout !== 'es' && (
          <div
            className="relative min-h-0"
            style={{ width: chartLayout === 'split' ? `${leftPct}%` : '100%' }}
          >
            <span className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-slate-900/80 px-1.5 py-0.5 font-mono text-xs text-amber-300">
              NQ
            </span>
            <OrderPanel />
            <ReplayChart
              key="NQ"
              instrument="NQ"
              tradingEnabled
              clickMode={clickMode}
              onRewindClick={(ts) => {
                setRewindMode(false);
                void useReplay.getState().jumpTo(ts);
              }}
              onPriceClick={(price) => trading.placeAtPrice(price)}
            />
          </div>
        )}
        {chartLayout === 'split' && (
          <div
            className="z-10 w-1.5 shrink-0 cursor-col-resize bg-slate-800 hover:bg-amber-500/60"
            onPointerDown={startDividerDrag}
            title="Drag to resize"
          />
        )}
        {chartLayout !== 'nq' && (
          <div className="relative min-h-0 flex-1">
            <span className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-slate-900/80 px-1.5 py-0.5 font-mono text-xs text-sky-300">
              ES
            </span>
            <ReplayChart
              key="ES"
              instrument="ES"
              tradingEnabled={false}
              clickMode={rewindMode ? 'rewind' : 'none'}
              onRewindClick={(ts) => {
                setRewindMode(false);
                void useReplay.getState().jumpTo(ts);
              }}
              onPriceClick={() => {}}
            />
          </div>
        )}
      </div>

      {showTrades && <TradeLog onClose={() => setShowTrades(false)} />}
      <PositionBar />
      <ReplayControls rewindMode={rewindMode} setRewindMode={setRewindMode} />
    </main>
  );
}

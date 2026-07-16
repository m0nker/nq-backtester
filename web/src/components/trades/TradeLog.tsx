'use client';

// Session trade log: every completed round trip with P&L, R, duration, and
// MAE/MFE (computed from stored base bars). Click a row for the dynamic viewer.

import { useEffect, useState } from 'react';
import { getBaseResolutionSec, getHistoricalBars } from '@/lib/data/barSource';
import { useReplay } from '@/lib/replay/clock';
import { fmtUsd } from '@/lib/trading/contractMath';
import type { Trade } from '@/lib/trading/engine';
import { useTrading } from '@/lib/trading/store';
import { formatET } from '@/lib/time/et';
import TradeViewer from './TradeViewer';

interface Excursion {
  maePts: number; // adverse, expressed positive
  mfePts: number; // favorable, expressed positive
}

const tradeKey = (t: Trade) => `${t.entryTs}-${t.exitTs}-${t.side}`;

function fmtDuration(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

export default function TradeLog({ onClose }: { onClose: () => void }) {
  const trades = useTrading((s) => s.derived.trades);
  const [excursions, setExcursions] = useState<Record<string, Excursion>>({});
  const [viewing, setViewing] = useState<Trade | null>(null);

  // MAE/MFE from base bars between entry and exit (lazy, cached per trade)
  useEffect(() => {
    const guard = useReplay.getState().currentTime;
    if (guard === null) return;
    const missing = trades.filter((t) => !(tradeKey(t) in excursions));
    if (missing.length === 0) return;
    let stale = false;
    void (async () => {
      const add: Record<string, Excursion> = {};
      for (const t of missing) {
        const bars = await getHistoricalBars(t.entryTs, t.exitTs + getBaseResolutionSec(), guard);
        if (bars.length === 0) continue;
        const hi = Math.max(...bars.map((b) => b.h));
        const lo = Math.min(...bars.map((b) => b.l));
        add[tradeKey(t)] =
          t.side === 'buy'
            ? { maePts: Math.max(0, t.avgEntry - lo), mfePts: Math.max(0, hi - t.avgEntry) }
            : { maePts: Math.max(0, hi - t.avgEntry), mfePts: Math.max(0, t.avgEntry - lo) };
      }
      if (!stale && Object.keys(add).length) setExcursions((e) => ({ ...e, ...add }));
    })();
    return () => {
      stale = true;
    };
  }, [trades, excursions]);

  const td = 'px-2 py-1 whitespace-nowrap';
  const pnlCls = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-300');

  return (
    <div className="max-h-56 overflow-y-auto border-t border-slate-800 bg-[#0c0f17]">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs uppercase tracking-wide text-slate-500">
          Trades ({trades.length}) — click a row to review
        </span>
        <button className="text-xs text-slate-500 hover:text-slate-300" onClick={onClose}>
          close
        </button>
      </div>
      {trades.length === 0 ? (
        <p className="px-3 pb-3 text-sm text-slate-600">No completed trades yet.</p>
      ) : (
        <table className="w-full font-mono text-xs text-slate-300">
          <thead className="text-left text-slate-500">
            <tr>
              <th className={td}>#</th>
              <th className={td}>dir</th>
              <th className={td}>qty</th>
              <th className={td}>entry</th>
              <th className={td}>@</th>
              <th className={td}>exit</th>
              <th className={td}>@</th>
              <th className={td}>dur</th>
              <th className={td}>pts</th>
              <th className={td}>P&L</th>
              <th className={td}>R</th>
              <th className={td}>MAE</th>
              <th className={td}>MFE</th>
              <th className={td}></th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const ex = excursions[tradeKey(t)];
              const r = t.riskPts ? t.pnlPts / t.riskPts : null;
              return (
                <tr
                  key={tradeKey(t) + i}
                  className="cursor-pointer border-t border-slate-800/60 hover:bg-slate-800/40"
                  onClick={() => setViewing(t)}
                >
                  <td className={td}>{i + 1}</td>
                  <td className={`${td} ${t.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {t.side === 'buy' ? 'L' : 'S'}
                  </td>
                  <td className={td}>{t.qty}</td>
                  <td className={td}>{formatET(t.entryTs)}</td>
                  <td className={td}>{t.avgEntry.toFixed(2)}</td>
                  <td className={td}>{formatET(t.exitTs, false)}</td>
                  <td className={td}>{t.avgExit.toFixed(2)}</td>
                  <td className={td}>{fmtDuration(t.exitTs - t.entryTs)}</td>
                  <td className={`${td} ${pnlCls(t.pnlPts)}`}>{t.pnlPts.toFixed(2)}</td>
                  <td className={`${td} ${pnlCls(t.pnlUsd)}`}>{fmtUsd(t.pnlUsd)}</td>
                  <td className={td}>{r !== null ? r.toFixed(2) : '—'}</td>
                  <td className={`${td} text-rose-400/80`}>{ex ? `-${ex.maePts.toFixed(2)}` : '…'}</td>
                  <td className={`${td} text-emerald-400/80`}>{ex ? `+${ex.mfePts.toFixed(2)}` : '…'}</td>
                  <td className={td}>{t.ambiguous ? '⚠' : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {viewing && <TradeViewer trade={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

'use client';

import { lastVisibleBar } from '@/lib/data/barSource';
import { useReplay } from '@/lib/replay/clock';
import { fmtPts, fmtUsd, ptsToUsd } from '@/lib/trading/contractMath';
import { useTrading } from '@/lib/trading/store';

export default function PositionBar() {
  const derived = useTrading((s) => s.derived);
  const cancelOrder = useTrading((s) => s.cancelOrder);
  const flatten = useTrading((s) => s.flatten);
  const currentTime = useReplay((s) => s.currentTime);
  useReplay((s) => s.dataVersion); // re-render when new bars arrive

  const last = currentTime !== null ? lastVisibleBar(currentTime) : null;
  const pos = derived.position;
  const uPnlPts = pos.qty !== 0 && last ? (last.c - pos.avgPrice) * Math.sign(pos.qty) * Math.abs(pos.qty) : 0;
  const uPnlUsd = ptsToUsd(uPnlPts, 1);
  const balance = derived.startingBalance + derived.realizedUsd;

  const stat = (label: string, value: string, cls = 'text-slate-200') => (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className={`font-mono text-sm ${cls}`}>{value}</span>
    </div>
  );
  const pnlCls = (v: number) => (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-slate-200');

  return (
    <div className="flex items-center gap-6 border-t border-slate-800 bg-[#0d1119] px-4 py-1.5">
      {stat(
        'Position',
        pos.qty === 0 ? 'flat' : `${pos.qty > 0 ? '+' : ''}${pos.qty} @ ${pos.avgPrice.toFixed(2)}`,
        pos.qty > 0 ? 'text-emerald-400' : pos.qty < 0 ? 'text-rose-400' : 'text-slate-400',
      )}
      {stat('Unrealized', pos.qty !== 0 ? `${fmtUsd(uPnlUsd)} (${fmtPts(uPnlPts)})` : '—', pnlCls(uPnlUsd))}
      {stat('Realized', fmtUsd(derived.realizedUsd), pnlCls(derived.realizedUsd))}
      {stat('Balance', `$${balance.toFixed(2)}`)}
      {stat('Trades', String(derived.trades.length))}
      {derived.voidedCount > 0 && stat('Voided', String(derived.voidedCount), 'text-amber-400')}

      {pos.qty !== 0 && (
        <button
          className="rounded bg-slate-800 px-3 py-1 text-xs hover:bg-slate-700"
          onClick={flatten}
        >
          Flatten
        </button>
      )}

      {/* working orders */}
      <div className="ml-auto flex items-center gap-2 overflow-x-auto">
        {derived.workingOrders.map((o) => (
          <span
            key={o.id}
            className={`flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs ${
              o.side === 'buy' ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'
            }`}
          >
            {o.reduceOnly ? (o.type === 'stop' ? 'SL' : 'TP') : `${o.side} ${o.type}`} {o.qty} @{' '}
            {(o.limitPrice ?? o.stopPrice)?.toFixed(2)}
            <button
              className="ml-1 text-slate-500 hover:text-slate-200"
              onClick={() => cancelOrder(o.id)}
              title="Cancel"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

'use client';

import { useTrading } from '@/lib/trading/store';

// Floating order-entry card. Market fills at NEXT bar open (stated in the
// footer — fill assumptions live in lib/trading/fills.ts).
export default function OrderPanel() {
  const {
    qty,
    setQty,
    bracketEnabled,
    slPts,
    tpPts,
    setBracket,
    placeMarket,
    pendingClick,
    setPendingClick,
  } = useTrading();

  const chip = (active: boolean) =>
    `rounded px-2 py-1 text-xs ${active ? 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`;

  return (
    <div className="absolute right-3 top-3 z-10 w-56 rounded-lg border border-slate-800 bg-[#0d1119]/95 p-3 text-sm shadow-xl">
      <div className="mb-2 flex items-center gap-2">
        <label className="text-xs uppercase tracking-wide text-slate-500">Qty</label>
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(+e.target.value)}
          className="w-16 rounded bg-slate-800 px-2 py-1"
        />
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2">
        <button
          className="rounded bg-emerald-600 py-1.5 font-medium hover:bg-emerald-500"
          onClick={() => placeMarket('buy')}
        >
          Buy Mkt
        </button>
        <button
          className="rounded bg-rose-600 py-1.5 font-medium hover:bg-rose-500"
          onClick={() => placeMarket('sell')}
        >
          Sell Mkt
        </button>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1">
        {(
          [
            ['buy', 'limit', 'Buy Lmt'],
            ['sell', 'limit', 'Sell Lmt'],
            ['buy', 'stop', 'Buy Stp'],
            ['sell', 'stop', 'Sell Stp'],
          ] as const
        ).map(([side, type, label]) => {
          const active = pendingClick?.side === side && pendingClick?.type === type;
          return (
            <button
              key={label}
              className={chip(active)}
              onClick={() => setPendingClick(active ? null : { side, type })}
              title="Then click a price on the chart"
            >
              {label}
            </button>
          );
        })}
      </div>
      {pendingClick && (
        <p className="mb-2 text-xs text-amber-400">click the chart to set the price · esc to cancel</p>
      )}

      <div className="border-t border-slate-800 pt-2">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={bracketEnabled}
            onChange={(e) => setBracket(e.target.checked)}
          />
          Bracket (OCO SL/TP)
        </label>
        {bracketEnabled && (
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span className="text-rose-400">SL</span>
            <input
              type="number"
              min={1}
              step={0.25}
              value={slPts}
              onChange={(e) => setBracket(true, +e.target.value, undefined)}
              className="w-14 rounded bg-slate-800 px-1.5 py-0.5"
            />
            <span className="text-emerald-400">TP</span>
            <input
              type="number"
              min={1}
              step={0.25}
              value={tpPts}
              onChange={(e) => setBracket(true, undefined, +e.target.value)}
              className="w-14 rounded bg-slate-800 px-1.5 py-0.5"
            />
            <span className="text-slate-500">pts</span>
          </div>
        )}
      </div>

      <p className="mt-2 border-t border-slate-800 pt-1.5 text-[10px] leading-tight text-slate-600">
        market fills at next bar open · limit fills through level · stop on touch · SL first on ambiguous bars
      </p>
    </div>
  );
}

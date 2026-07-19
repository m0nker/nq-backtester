'use client';

import { useEffect, useRef, useState } from 'react';
import { useTrading } from '@/lib/trading/store';

const POS_KEY = 'orderPanelPos';

// Floating order-entry card. Market fills at NEXT bar open (stated in the
// footer — fill assumptions live in lib/trading/fills.ts). Draggable by the
// ⠿ grip; position persists across sessions.
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
    schema,
    startSchema,
  } = useTrading();

  // null = default docked position (top-right of the NQ pane)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // restore after mount (avoids SSR/localStorage hydration mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) setPos(JSON.parse(saved));
    } catch {
      // corrupted value — stay docked
    }
  }, []);

  const startPanelDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const rect = panelRef.current!.getBoundingClientRect();
    const dx = e.clientX - rect.x;
    const dy = e.clientY - rect.y;
    const move = (ev: PointerEvent) => {
      const w = rect.width;
      const next = {
        x: Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - w),
        y: Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40),
      };
      setPos(next);
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      setPos((p) => {
        try {
          if (p) localStorage.setItem(POS_KEY, JSON.stringify(p));
        } catch {
          // storage full/blocked — position just won't persist
        }
        return p;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };

  const chip = (active: boolean) =>
    `rounded px-2 py-1 text-xs ${active ? 'bg-amber-500/25 text-amber-300 ring-1 ring-amber-400' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`;

  return (
    <div
      ref={panelRef}
      className={`z-30 w-56 rounded-lg border border-slate-800 bg-[#0d1119]/95 p-3 text-sm shadow-xl ${pos ? 'fixed' : 'absolute right-3 top-3'}`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div
        className="-mx-3 -mt-3 mb-1 flex cursor-grab items-center justify-center rounded-t-lg py-0.5 text-slate-600 hover:bg-slate-800/60 hover:text-slate-400 active:cursor-grabbing"
        title="Drag to move this panel"
        onPointerDown={startPanelDrag}
      >
        <span className="text-[13px] leading-none">⠿</span>
      </div>
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

      {/* schema (draft) bracket: entry+SL+TP lines on the chart, placed only
          when the on-chart Place button is confirmed */}
      <div className="mb-2 grid grid-cols-2 gap-1">
        <button
          className={chip(schema?.side === 'buy')}
          onClick={() => startSchema('buy')}
          title="Draft a bracket on the chart: drag entry/SL/TP, then Place"
        >
          Buy Bracket
        </button>
        <button
          className={chip(schema?.side === 'sell')}
          onClick={() => startSchema('sell')}
          title="Draft a bracket on the chart: drag entry/SL/TP, then Place"
        >
          Sell Bracket
        </button>
      </div>
      {schema && (
        <p className="mb-2 text-xs text-sky-400">
          draft on chart — drag the lines, then hit Place on the entry chip
        </p>
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
        market fills at next bar open · limit fills through level · stop on touch · same-bar SL/TP sequenced by 1s data when available (else SL first)
      </p>
    </div>
  );
}

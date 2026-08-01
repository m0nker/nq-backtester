'use client';

// Candidate prompt: a FLOATING, draggable card (not a blocking modal) shown
// when the engine finds a setup — replay pauses, but the charts stay fully
// interactive so the trader can analyze before deciding. Drag by the ⠿ grip
// (position persists, like the order panel). Collects the v1 labeling form —
// take / marginal / hard skip + optional notes. In prompt-&-trade sessions,
// Take also places the bracket (market entry, swing-extreme stop, 1R target).

import { useEffect, useRef, useState } from 'react';
import { useBot } from '@/lib/concepts/botStore';
import { formatET } from '@/lib/time/et';
import { fmtUsd, ptsToUsd } from '@/lib/trading/contractMath';
import { useTrading } from '@/lib/trading/store';

const POS_KEY = 'candidatePanelPos';

export default function CandidateModal() {
  const pending = useBot((s) => s.pending);
  const queue = useBot((s) => s.queue);
  const action = useBot((s) => s.action);
  const submitDecision = useBot((s) => s.submitDecision);
  const qty = useTrading((s) => s.qty);
  const [notes, setNotes] = useState('');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // fresh notes field per candidate
  useEffect(() => setNotes(''), [pending?.candidateId]);

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
      setPos({
        x: Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - rect.width),
        y: Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40),
      });
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

  if (!pending) return null;

  const long = pending.direction === 'long';
  const risk = Math.abs(pending.entryEst - pending.stop);
  const targetEst = pending.entryEst + (long ? risk : -risk);
  const zone = (top: number, bottom: number) => `${bottom.toFixed(2)} – ${top.toFixed(2)}`;
  const submit = (decision: 'take' | 'marginal' | 'skip') => {
    submitDecision(decision, notes.trim());
    setNotes('');
  };

  return (
    <div
      ref={panelRef}
      className={`z-40 w-[22rem] rounded-xl border border-slate-600 bg-[#0d1119]/95 p-4 text-sm text-slate-200 shadow-2xl ${
        pos ? 'fixed' : 'fixed right-3 top-1/3'
      }`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="cursor-grab select-none text-slate-500 hover:text-slate-300"
          title="Drag to move — the chart stays usable while you decide"
          onPointerDown={startPanelDrag}
        >
          ⠿
        </span>
        <span className={`text-base font-bold ${long ? 'text-emerald-400' : 'text-rose-400'}`}>
          {long ? 'LONG' : 'SHORT'} candidate
        </span>
        <span className="ml-auto font-mono text-xs text-slate-500">{formatET(pending.confirmTs)}</span>
      </div>

      <div className="mb-3 space-y-1 font-mono text-xs">
        {pending.condition && (
          <>
            <div className="flex justify-between">
              <span className="text-slate-500">condition FVG</span>
              <span>
                {pending.condition.tf} {long ? 'bull' : 'bear'} {zone(pending.condition.top, pending.condition.bottom)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">tapped</span>
              <span>{formatET(pending.condition.armedAt, false)}</span>
            </div>
          </>
        )}
        {pending.dol && (
          <>
            <div className="flex justify-between">
              <span className="text-slate-500">draw on liquidity</span>
              <span>
                {pending.dol.label} {pending.dol.price.toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">{pending.dol.side} swept</span>
              <span>{formatET(pending.dol.sweptAt, false)}</span>
            </div>
          </>
        )}
        {pending.otherConditions.length > 0 && (
          <div className="flex justify-between">
            <span className="text-slate-500">also armed</span>
            <span>{pending.otherConditions.join(', ')}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-slate-500">trigger IFVG</span>
          <span>
            {pending.ifvg.tf} {zone(pending.ifvg.top, pending.ifvg.bottom)}
          </span>
        </div>
        <div className="mt-1.5 flex justify-between border-t border-slate-800 pt-1.5">
          <span className="text-slate-500">entry ≈</span>
          <span>{pending.entryEst.toFixed(2)} (mkt, next bar)</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">stop (swing {long ? 'low' : 'high'})</span>
          <span className="text-rose-300">{pending.stop.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">target (1R) ≈</span>
          <span className="text-emerald-300">{targetEst.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">risk</span>
          <span>
            {risk.toFixed(2)} pts · {fmtUsd(ptsToUsd(risk, qty))} ({qty}x)
          </span>
        </div>
      </div>

      <textarea
        className="mb-2 h-14 w-full resize-none rounded bg-slate-800 px-2 py-1.5 text-xs"
        placeholder="notes (optional) — anything the engine can't see"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      <div className="flex gap-1.5">
        <button
          className="flex-1 rounded bg-emerald-600 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-500"
          title={action === 'prompt-trade' ? 'Record take AND place the bracket' : 'Record take (label only — no trade)'}
          onClick={() => submit('take')}
        >
          Take{action === 'prompt-trade' ? '' : ' (label)'}
        </button>
        <button
          className="flex-1 rounded bg-amber-600/80 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-500"
          title="Borderline — would hesitate"
          onClick={() => submit('marginal')}
        >
          Marginal
        </button>
        <button
          className="flex-1 rounded bg-rose-700 py-1.5 text-xs font-semibold text-slate-100 hover:bg-rose-600"
          title="Clear skip"
          onClick={() => submit('skip')}
        >
          Hard skip
        </button>
      </div>
      {queue.length > 0 && (
        <p className="mt-1.5 text-center text-xs text-slate-500">
          {queue.length} more candidate{queue.length > 1 ? 's' : ''} queued
        </p>
      )}
    </div>
  );
}

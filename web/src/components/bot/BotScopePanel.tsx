'use client';

// "What is the bot looking at right now" — a floating, draggable readout of
// the live scope the engine rebuilds every advance.
//
// It exists to answer one recurring question: there IS a 1m IFVG on screen,
// so why didn't the bot take it? The per-timeframe rows carry the standing
// veto (which higher timeframe currently owns the move) plus the outcome of
// the last inversion each timeframe produced, so the reason is on screen
// before and after the fact instead of having to be re-derived.

import { useEffect, useRef, useState } from 'react';
import { useBot } from '@/lib/concepts/botStore';
import type { TriggerResult } from '@/lib/concepts/engine';
import { useConcepts } from '@/lib/concepts/store';
import { formatET } from '@/lib/time/et';

const POS_KEY = 'botScopePanelPos';

const RESULT_LABEL: Record<TriggerResult, string> = {
  candidate: 'fired',
  duplicate: 'already shown',
  window: 'outside window',
  vetoed: 'vetoed',
  'no-bias': 'no bias',
  'no-condition': 'no armed condition',
  geometry: 'bad stop geometry',
};
const RESULT_TONE: Record<TriggerResult, string> = {
  candidate: 'text-emerald-300',
  duplicate: 'text-slate-500',
  window: 'text-slate-500',
  vetoed: 'text-amber-300',
  'no-bias': 'text-rose-300',
  'no-condition': 'text-rose-300',
  geometry: 'text-slate-500',
};

export default function BotScopePanel({ onClose }: { onClose: () => void }) {
  const scope = useBot((s) => s.scope);
  const botId = useBot((s) => s.botId);
  const biases = useBot((s) => s.biases);
  const showCond = useConcepts((s) => s.showBotConditions);
  const showTrig = useConcepts((s) => s.showBotTriggers);
  const showLong = useConcepts((s) => s.showBotLong);
  const showShort = useConcepts((s) => s.showBotShort);

  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) setPos(JSON.parse(saved));
    } catch {
      // corrupted value — stay docked
    }
  }, []);

  const startDrag = (e: React.PointerEvent) => {
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
          // storage blocked — position just won't persist
        }
        return p;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  };

  const mech = botId === 'mech-model';
  const liveBias = biases.filter((b) => b.deadAt === null);

  return (
    <div
      ref={panelRef}
      className={`z-40 w-[21rem] rounded-xl border border-slate-600 bg-[#0d1119]/95 p-3 text-xs text-slate-200 shadow-2xl ${
        pos ? 'fixed' : 'fixed bottom-24 left-3'
      }`}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className="cursor-grab select-none text-slate-500 hover:text-slate-300"
          title="Drag to move"
          onPointerDown={startDrag}
        >
          ⠿
        </span>
        <span className="text-sm font-semibold tracking-wide">Bot scope</span>
        {scope?.dormant === 'position' ? (
          <span className="rounded border border-amber-700 bg-amber-950/70 px-1 text-[10px] uppercase text-amber-300">
            dormant · trade on
          </span>
        ) : (
          <span className="rounded border border-teal-700 bg-teal-950/70 px-1 text-[10px] uppercase text-teal-300">
            scanning
          </span>
        )}
        <button className="ml-auto text-slate-500 hover:text-slate-300" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* chart highlight toggles */}
      <div className="mb-2 flex items-center gap-1">
        <button
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            showCond
              ? 'border-amber-500 bg-amber-900/50 text-amber-200'
              : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
          }`}
          title="Outline the conditions the bot is currently armed on"
          onClick={() => useConcepts.getState().setShowBotConditions(!showCond)}
        >
          highlight conditions
        </button>
        <button
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            showTrig
              ? 'border-sky-500 bg-sky-900/50 text-sky-200'
              : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
          }`}
          title="Outline the trigger-timeframe gaps still in play (the ones that could invert into a setup)"
          onClick={() => useConcepts.getState().setShowBotTriggers(!showTrig)}
        >
          highlight triggers
        </button>
      </div>

      {/* which side of the book the highlights cover */}
      <div className="mb-2 flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">side</span>
        <button
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            showLong
              ? 'border-emerald-600 bg-emerald-900/50 text-emerald-200'
              : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
          }`}
          title="Draw the long-side zones: bull conditions and the bear trigger gaps that invert into longs"
          onClick={() => useConcepts.getState().setShowBotLong(!showLong)}
        >
          ▲ longs
        </button>
        <button
          className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
            showShort
              ? 'border-rose-600 bg-rose-900/50 text-rose-200'
              : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
          }`}
          title="Draw the short-side zones: bear conditions and the bull trigger gaps that invert into shorts"
          onClick={() => useConcepts.getState().setShowBotShort(!showShort)}
        >
          ▼ shorts
        </button>
      </div>

      {!scope ? (
        <p className="text-slate-500">Waiting for the first advance…</p>
      ) : (
        <>
          {/* what it needs before a trigger can count */}
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
            {mech ? 'Armed sweeps' : 'Armed conditions'}
          </div>
          {!mech && liveBias.length === 0 && (
            <p className="mb-1 text-rose-300">No live bias — every trigger will be rejected.</p>
          )}
          {mech ? (
            scope.sweeps.length === 0 ? (
              <p className="mb-2 text-slate-500">No swept level armed.</p>
            ) : (
              <div className="mb-2 flex flex-col gap-0.5 font-mono">
                {scope.sweeps.map((s, i) => (
                  <div key={`${s.label}-${i}`} className="flex items-center justify-between">
                    <span className={s.side === 'sellside' ? 'text-emerald-300' : 'text-rose-300'}>
                      {s.label}
                    </span>
                    <span className="text-slate-400">{s.price.toFixed(2)}</span>
                    <span className="text-slate-500">{formatET(s.sweptAt, false)}</span>
                  </div>
                ))}
              </div>
            )
          ) : scope.conditions.length === 0 ? (
            <p className="mb-2 text-slate-500">
              Nothing armed — a condition FVG must be tapped in-session first.
            </p>
          ) : (
            <div className="mb-2 flex flex-col gap-0.5 font-mono">
              {scope.conditions.map((c, i) => (
                <div key={`${c.tf}-${c.bT}-${i}`} className="flex items-center justify-between">
                  <span className={c.dir === 'bull' ? 'text-emerald-300' : 'text-rose-300'}>
                    {c.tf} {c.dir}
                  </span>
                  <span className="text-slate-400">
                    {c.bottom.toFixed(2)}–{c.top.toFixed(2)}
                  </span>
                  <span className="text-slate-500">
                    {c.armedAt !== undefined ? formatET(c.armedAt, false) : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* per-timeframe trigger scan */}
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
            IFVG trigger scan
          </div>
          <div className="flex flex-col gap-0.5 font-mono">
            {scope.triggers.map((t) => {
              const blocked = t.blockedLong ?? t.blockedShort;
              return (
                <div key={t.tf} className="flex items-baseline gap-1.5">
                  <span className="w-8 shrink-0 text-slate-300">{t.tf}</span>
                  <span className="w-10 shrink-0 text-slate-600">{t.live} live</span>
                  {blocked ? (
                    <span className="text-amber-300" title="A filled same-or-higher timeframe gap owns this move — an inversion here would be suppressed">
                      ⊘ {t.blockedLong && t.blockedShort
                        ? `blocked by ${t.blockedLong}/${t.blockedShort}`
                        : t.blockedLong
                          ? `longs blocked by ${t.blockedLong}`
                          : `shorts blocked by ${t.blockedShort}`}
                    </span>
                  ) : t.cleared > 0 ? (
                    <span className="text-teal-300" title="A resweep retired these blockers — they veto again only once price drives deeper into them than it already had">
                      ↺ {t.cleared} cleared
                    </span>
                  ) : (
                    <span className="text-slate-500">watching</span>
                  )}
                  {t.last && (
                    <span className={`ml-auto shrink-0 ${RESULT_TONE[t.last.result]}`} title={`last ${t.tf} inversion at ${formatET(t.last.confirmTs)}`}>
                      {RESULT_LABEL[t.last.result]}
                      {t.last.blockedBy ? ` (${t.last.blockedBy})` : ''}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] leading-snug text-slate-600">
            ⊘ = the standing overlap veto: a tapped-but-not-inverted gap on that timeframe or
            higher owns the move, so an inversion here is suppressed until it resolves. ↺ = a
            RESWEEP (price back through the arming tap&apos;s extreme) retired those blockers;
            they only veto again once price drives deeper into them than it already had.
          </p>
        </>
      )}
    </div>
  );
}

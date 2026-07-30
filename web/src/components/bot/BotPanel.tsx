'use client';

// Bot strip + settings popover. The strip stays minimal (status, bias chips,
// Next day); clicking BOT opens the settings panel: bias entry, active time
// window, candidate action, risk sizing, and window-hopping. Settings are
// live-editable mid-session; changes persist to localStorage (defaults for
// new sessions) and to the session's config row (survives resume).

import { useState } from 'react';
import { useBot, type CandidateAction } from '@/lib/concepts/botStore';
import type { RiskMode } from '@/lib/concepts/engine';
import { TRIGGER_TFS_ALL } from '@/lib/concepts/fvg';
import { useReplay } from '@/lib/replay/clock';

const fmtDaySec = (sec: number) =>
  `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
const toDaySec = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
};

const ACTION_LABELS: Record<CandidateAction, string> = {
  'prompt-trade': 'Prompt me — Take places the trade',
  'label-only': 'Prompt me — label only, no trades',
  auto: 'Auto-trade every candidate',
};

export default function BotPanel() {
  const active = useBot((s) => s.active);
  const action = useBot((s) => s.action);
  const win = useBot((s) => s.window); // named `win`: don't shadow globalThis.window
  const risk = useBot((s) => s.risk);
  const hopWindows = useBot((s) => s.hopWindows);
  const onePosition = useBot((s) => s.onePosition);
  const triggerTfs = useBot((s) => s.triggerTfs);
  const biases = useBot((s) => s.biases);
  const armedCount = useBot((s) => s.armedCount);
  const addBias = useBot((s) => s.addBias);
  const removeBias = useBot((s) => s.removeBias);
  const nextDay = useBot((s) => s.nextDay);
  const loading = useReplay((s) => s.loading);

  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<'long' | 'short'>('long');
  const [until, setUntil] = useState('');

  if (!active) return null;

  const liveCount = biases.filter((b) => b.deadAt === null).length;
  const add = () => {
    const p = parseFloat(until);
    if (!Number.isFinite(p) || p <= 0) return;
    addBias(dir, p);
    setUntil('');
  };
  const riskValue =
    risk.mode === 'contracts' ? risk.contracts : risk.mode === 'percent' ? risk.percent : risk.usd;
  const setRiskValue = (v: number) => {
    const st = useBot.getState();
    st.setRisk({
      ...st.risk,
      [st.risk.mode === 'contracts' ? 'contracts' : st.risk.mode === 'percent' ? 'percent' : 'usd']: v,
    });
  };
  const riskSummary =
    risk.mode === 'contracts'
      ? `${risk.contracts} ct`
      : risk.mode === 'percent'
        ? `${risk.percent}% risk`
        : `$${risk.usd} risk`;

  return (
    <div className="relative flex flex-wrap items-center gap-2 border-b border-slate-800 bg-[#0d1119] px-4 py-1.5 text-xs">
      <button
        className={`rounded border px-2 py-0.5 font-semibold uppercase tracking-wide ${
          open
            ? 'border-teal-400 bg-teal-500/25 text-teal-200'
            : 'border-teal-700 bg-teal-950/70 text-teal-300 hover:bg-teal-900/60'
        }`}
        title="Bot settings — bias, active time, candidate action, risk"
        onClick={() => setOpen(!open)}
      >
        Bot ▾
      </button>
      <span className="text-slate-500">
        {action === 'prompt-trade' ? 'prompt & trade' : action === 'label-only' ? 'label only' : 'auto-trade all'}
        {' · '}
        {fmtDaySec(win.startSec)}–{fmtDaySec(win.endSec)} ET
        {' · '}
        {riskSummary}
        {hopWindows ? ' · hop' : ''}
        {' · '}
        {liveCount ? `${liveCount} bias` : 'no bias — dormant'}
        {' · '}
        {armedCount} armed
      </span>

      <span className="mx-1 h-4 w-px bg-slate-700" />

      {biases.map((b) => (
        <span
          key={b.id}
          className={`flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono ${
            b.deadAt !== null
              ? 'border-slate-700 bg-slate-900 text-slate-500 line-through'
              : b.direction === 'long'
                ? 'border-emerald-700 bg-emerald-950/70 text-emerald-300'
                : 'border-rose-700 bg-rose-950/70 text-rose-300'
          }`}
          title={b.deadAt !== null ? 'Level touched — bias reset' : `Dies when ${b.until} is touched`}
        >
          {b.direction === 'long' ? '▲ bullish' : '▼ bearish'} until {b.until}
          {b.deadAt !== null && <span className="no-underline"> · hit</span>}
          <button className="opacity-60 hover:opacity-100" title="Remove bias" onClick={() => removeBias(b.id)}>
            ✕
          </button>
        </span>
      ))}

      <span className="flex-1" />

      <button
        className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        title="Jump to the next trading day's 09:25 ET"
        disabled={loading}
        onClick={() => void nextDay()}
      >
        Next day ⇥
      </button>

      {open && (
        <div className="absolute left-2 top-full z-50 mt-1 w-[21rem] rounded-lg border border-slate-700 bg-[#0d1119] p-3 shadow-2xl">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Bias</div>
          <div className="mb-3 flex items-center gap-1">
            <div className="flex overflow-hidden rounded border border-slate-700">
              <button
                className={`px-1.5 py-1 ${dir === 'long' ? 'bg-emerald-500/25 text-emerald-300' : 'bg-slate-900 text-slate-500 hover:bg-slate-800'}`}
                onClick={() => setDir('long')}
              >
                bullish
              </button>
              <button
                className={`px-1.5 py-1 ${dir === 'short' ? 'bg-rose-500/25 text-rose-300' : 'bg-slate-900 text-slate-500 hover:bg-slate-800'}`}
                onClick={() => setDir('short')}
              >
                bearish
              </button>
            </div>
            <span className="text-slate-500">until</span>
            <input
              type="number"
              step="0.25"
              placeholder="price"
              className="w-24 flex-1 rounded bg-slate-800 px-2 py-1 font-mono"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button
              className="rounded bg-teal-600/80 px-2 py-1 font-medium text-slate-950 hover:bg-teal-500 disabled:opacity-40"
              disabled={!until}
              onClick={add}
            >
              Add
            </button>
          </div>

          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Active time (ET)</div>
          <div className="mb-3 flex items-center gap-2">
            <input
              type="time"
              className="w-full rounded bg-slate-800 px-2 py-1"
              value={fmtDaySec(win.startSec)}
              onChange={(e) =>
                useBot.getState().setWindow({ startSec: toDaySec(e.target.value), endSec: win.endSec })
              }
            />
            <span className="text-slate-500">→</span>
            <input
              type="time"
              className="w-full rounded bg-slate-800 px-2 py-1"
              value={fmtDaySec(win.endSec)}
              onChange={(e) =>
                useBot.getState().setWindow({ startSec: win.startSec, endSec: toDaySec(e.target.value) })
              }
            />
          </div>

          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">When a candidate fires</div>
          <div className="mb-3 flex flex-col gap-1">
            {(Object.keys(ACTION_LABELS) as CandidateAction[]).map((a) => (
              <label key={a} className="flex cursor-pointer items-center gap-2 text-slate-300">
                <input
                  type="radio"
                  name="bot-action"
                  checked={action === a}
                  onChange={() => useBot.getState().setAction(a)}
                />
                {ACTION_LABELS[a]}
              </label>
            ))}
          </div>

          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
            IFVG trigger timeframes
          </div>
          <div className="mb-3 flex flex-wrap gap-1">
            {TRIGGER_TFS_ALL.map((tf) => (
              <button
                key={tf}
                className={`rounded border px-1.5 py-0.5 font-mono ${
                  triggerTfs.includes(tf)
                    ? 'border-teal-500 bg-teal-900/60 text-teal-200'
                    : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
                }`}
                title="Toggle this timeframe in the trigger scan (also removes it from the overlap hierarchy)"
                onClick={() => useBot.getState().toggleTriggerTf(tf)}
              >
                {tf}
              </button>
            ))}
          </div>

          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">Risk sizing</div>
          <div className="mb-3 flex items-center gap-2">
            <select
              className="flex-1 rounded bg-slate-800 px-2 py-1"
              value={risk.mode}
              onChange={(e) => useBot.getState().setRisk({ ...risk, mode: e.target.value as RiskMode })}
            >
              <option value="contracts">Constant contracts</option>
              <option value="percent">% of balance</option>
              <option value="usd">Fixed $ amount</option>
            </select>
            <input
              type="number"
              min={risk.mode === 'contracts' ? 0.1 : risk.mode === 'percent' ? 0.05 : 25}
              step={risk.mode === 'contracts' ? 0.1 : risk.mode === 'percent' ? 0.25 : 25}
              className="w-20 rounded bg-slate-800 px-2 py-1 font-mono"
              value={riskValue}
              onChange={(e) => setRiskValue(+e.target.value)}
            />
            <span className="w-4 text-slate-500">
              {risk.mode === 'contracts' ? 'ct' : risk.mode === 'percent' ? '%' : '$'}
            </span>
          </div>
          <p className="mb-3 text-[11px] leading-snug text-slate-600">
            %/$ modes size to the nearest 0.1 contract (0.1 NQ ≈ 1 MNQ, min 0.1) from the stop
            distance; % uses the current balance.
          </p>

          <label className="mb-1.5 flex cursor-pointer items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={onePosition}
              onChange={(e) => useBot.getState().setOnePosition(e.target.checked)}
            />
            1 position at a time
            <span className="text-slate-600">(dormant until flat with no working orders)</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={hopWindows}
              onChange={(e) => useBot.getState().setHopWindows(e.target.checked)}
            />
            Auto-jump between active windows
            <span className="text-slate-600">(skips ahead when idle outside the window)</span>
          </label>
        </div>
      )}
    </div>
  );
}

'use client';

// Bot strip + settings popover. The strip stays minimal (status, bias chips,
// Next day); clicking BOT opens the settings panel: bias entry, active time
// window, candidate action, risk sizing, and window-hopping. Settings are
// live-editable mid-session; changes persist to localStorage (defaults for
// new sessions) and to the session's config row (survives resume).

import { useState } from 'react';
import BotScopePanel from '@/components/bot/BotScopePanel';
import { useBot, type CandidateAction } from '@/lib/concepts/botStore';
import type { RiskMode } from '@/lib/concepts/engine';
import { TRIGGER_TFS_ALL } from '@/lib/concepts/fvg';
import { DOL_KINDS, MECH_TRIGGER_TFS } from '@/lib/concepts/liquidity';
import { TF_SECONDS, isSessionTf, type SessionTf, type Timeframe } from '@/lib/types';
import { useReplay } from '@/lib/replay/clock';

const fmtDaySec = (sec: number) =>
  `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;
const toDaySec = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
};

// 90 -> "1m30s", 360 -> "6m", 45 -> "45s"
const fmtDur = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m === 0 ? `${s}s` : s === 0 ? `${m}m` : `${m}m${s}s`;
};

// Hover-only help: the settings panel used to carry every explanation as a
// visible paragraph — now each lives behind an ⓘ next to its section.
const Info = ({ text }: { text: string }) => (
  <span
    title={text}
    className="ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-slate-600 font-serif text-[9px] italic text-slate-500 hover:border-slate-400 hover:text-slate-300"
  >
    i
  </span>
);

const ACTION_LABELS: Record<CandidateAction, string> = {
  'prompt-trade': 'Prompt me — Take places the trade',
  'label-only': 'Prompt me — label only, no trades',
  auto: 'Auto-trade every candidate',
};

export default function BotPanel() {
  const active = useBot((s) => s.active);
  const botId = useBot((s) => s.botId);
  const dolInvalidationPts = useBot((s) => s.dolInvalidationPts);
  const sweepMaxCandles = useBot((s) => s.sweepMaxCandles);
  const sweepMaxMinutes = useBot((s) => s.sweepMaxMinutes);
  const resweepWindowMinutes = useBot((s) => s.resweepWindowMinutes);
  const targetGapMaxAgeMinutes = useBot((s) => s.targetGapMaxAgeMinutes);
  const dolKinds = useBot((s) => s.dolKinds);
  const gapMaxAgeCandles = useBot((s) => s.gapMaxAgeCandles);
  const conditionLookbackCandles = useBot((s) => s.conditionLookbackCandles);
  const triggerLookbackCandles = useBot((s) => s.triggerLookbackCandles);
  const minStopPts = useBot((s) => s.minStopPts);
  const maxContracts = useBot((s) => s.maxContracts);
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
  const [scopeOpen, setScopeOpen] = useState(false);
  const [dir, setDir] = useState<'long' | 'short'>('long');
  const [until, setUntil] = useState('');

  if (!active) return null;

  // `dol` = the sweep-condition family (no bias, DOL settings); `mech` = the
  // timer-bearing mech model specifically — mech-2 has no deadline at all
  // (added 2026-08-12), so its inputs must not appear.
  const mech = botId === 'mech-model';
  const dol = mech || botId === 'mech-2';
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
        {mech ? 'Mech ▾' : dol ? 'Mech 2 ▾' : 'Bot ▾'}
      </button>
      <span className="text-slate-500">
        {action === 'prompt-trade' ? 'prompt & trade' : action === 'label-only' ? 'label only' : 'auto-trade all'}
        {' · '}
        {fmtDaySec(win.startSec)}–{fmtDaySec(win.endSec)} ET
        {' · '}
        {riskSummary}
        {hopWindows ? ' · hop' : ''}
        {' · '}
        {dol
          ? `±${dolInvalidationPts} pts · ${armedCount} swept`
          : (liveCount ? `${liveCount} bias` : 'no bias — dormant') + ` · ${armedCount} armed`}
      </span>

      <span className="mx-1 h-4 w-px bg-slate-700" />

      {!dol && biases.map((b) => (
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
        className={`rounded border px-2.5 py-1 ${
          scopeOpen
            ? 'border-teal-400 bg-teal-500/20 text-teal-200'
            : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
        }`}
        title="Live scope — armed conditions, per-timeframe IFVG scan, and why a trigger was or wasn't taken"
        onClick={() => setScopeOpen((v) => !v)}
      >
        Scope
      </button>

      <button
        className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-40"
        title="Jump to the next trading day's 09:25 ET"
        disabled={loading}
        onClick={() => void nextDay()}
      >
        Next day ⇥
      </button>

      {scopeOpen && <BotScopePanel onClose={() => setScopeOpen(false)} />}

      {open && (
        <div className="absolute left-2 top-full z-50 mt-1 w-[21rem] rounded-lg border border-slate-700 bg-[#0d1119] p-3 shadow-2xl">
          {dol && (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                Draws on liquidity — tradeable
              </div>
              <div className="mb-3 flex flex-wrap gap-1">
                {DOL_KINDS.map(({ kind, label }) => (
                  <button
                    key={kind}
                    className={`rounded border px-1.5 py-0.5 ${
                      dolKinds.includes(kind)
                        ? 'border-teal-500 bg-teal-900/60 text-teal-200'
                        : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
                    }`}
                    title="Toggle this category — the bot only sweeps/trades enabled ones, and the chart only draws them"
                    onClick={() => useBot.getState().toggleDolKind(kind)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
          {/* the deadline is mech-model ONLY — mech 2 has no timer at all */}
          {mech && (
            <>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                Sweep → inversion deadline
                <Info text="After a sweep, the IFVG must invert within that many candles of the trigger's own timeframe; the minute ceiling overrides it wherever it lands first (*). Missing the deadline kills that ARMING, not the level: a deeper re-sweep of the same level re-arms it (restarting the deadline) and stales the triggers that were in play. Only a breakout — price beyond the invalidation distance past the level — retires it for good." />
              </div>
              <div className="mb-1 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="w-16 rounded bg-slate-800 px-2 py-1 font-mono"
                  value={sweepMaxCandles}
                  onChange={(e) => useBot.getState().setSweepMaxCandles(+e.target.value)}
                />
                <span className="text-slate-500">candles, max</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="w-16 rounded bg-slate-800 px-2 py-1 font-mono"
                  value={sweepMaxMinutes}
                  onChange={(e) => useBot.getState().setSweepMaxMinutes(+e.target.value)}
                />
                <span className="text-slate-500">min</span>
              </div>
              <div className="mb-1 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px]">
                {/* preview only the TFs the mech scan actually runs (1m–5m) */}
                {triggerTfs
                  .filter((tf): tf is Exclude<Timeframe, SessionTf> => !isSessionTf(tf) && MECH_TRIGGER_TFS.includes(tf))
                  .sort((a, b) => TF_SECONDS[a] - TF_SECONDS[b])
                  .map((tf) => {
                    const raw = sweepMaxCandles * TF_SECONDS[tf];
                    const capped = raw > sweepMaxMinutes * 60;
                    return (
                      <span key={tf} className={capped ? 'text-amber-500/80' : 'text-slate-500'}>
                        {tf} {fmtDur(Math.min(raw, sweepMaxMinutes * 60))}
                        {capped ? '*' : ''}
                      </span>
                    );
                  })}
              </div>
            </>
          )}
          {dol && (
            <>
              <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-slate-500">
                Distance invalidation
                <Info text="Kills an armed sweep when price strays farther than this from the level — beyond it (breakout) or away from it (the reversal ran without a trigger). For Mech 2 it is the ONLY invalidation (that bot has no deadline). Direction comes from the sweep: sellside → longs, buyside → shorts (no bias needed)." />
              </div>
              <div className="mb-3 flex items-center gap-2">
                <input
                  type="number"
                  min={5}
                  step={5}
                  className="w-20 rounded bg-slate-800 px-2 py-1 font-mono"
                  value={dolInvalidationPts}
                  onChange={(e) => useBot.getState().setDolInvalidationPts(+e.target.value)}
                />
                <span className="text-slate-500">pts from the level</span>
              </div>
              {/* added 2026-08-12: the level's own shelf life as a draw */}
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                Resweep window
                <Info text="After a level's FIRST sweep, deeper re-sweeps re-arm it only within this window — the countdown is anchored at that first raid, not the latest one. Once it passes the level is spent: further raids only deepen its watermark, and nothing re-arms it. (A breakout — price beyond the invalidation distance past the level — already retires it regardless.)" />
              </div>
              <div className="mb-3 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={5}
                  className="w-20 rounded bg-slate-800 px-2 py-1 font-mono"
                  value={resweepWindowMinutes}
                  onChange={(e) => useBot.getState().setResweepWindowMinutes(+e.target.value)}
                />
                <span className="text-slate-500">min after first sweep</span>
              </div>
              {/* added 2026-08-12: the unfilled 5m/15m gap the trade targets */}
              <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                Target gap max age
                <Info text="Both mech bots REQUIRE a target: an UNFILLED (never tapped — any mitigation disqualifies it) 5m or 15m FVG of the opposite polarity — longs need a bearish one, shorts a bullish one. The take-profit is that gap's near edge (bottom for longs, top for shorts), choosing whichever valid edge across 5m and 15m sits CLOSEST to the entry and on the profit side. The gap must have FORMED within this many minutes of the confirmation; if nothing qualifies there is no candidate at all (diagnostic: 'no unfilled 5m/15m target')." />
              </div>
              <div className="mb-3 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={5}
                  className="w-20 rounded bg-slate-800 px-2 py-1 font-mono"
                  value={targetGapMaxAgeMinutes}
                  onChange={(e) => useBot.getState().setTargetGapMaxAgeMinutes(+e.target.value)}
                />
                <span className="text-slate-500">min since the gap formed</span>
              </div>
            </>
          )}
          {!dol && (<>
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
          </>)}

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

          <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
            Candle distances
            <Info text="A gap stops being considered once it is this many of its OWN timeframe's candles old — 25 on 5m is ~2h, on 4h is ~4 days. The lookbacks bound how far back each scan searches and are floored at the expiry + 10, so a short lookback can never silently cut the expiry short." />
          </div>
          <div className="mb-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={1}
              className="w-14 rounded bg-slate-800 px-2 py-1 font-mono"
              value={gapMaxAgeCandles}
              onChange={(e) => useBot.getState().setScanBound('gapMaxAgeCandles', +e.target.value)}
            />
            <span className="flex-1 text-slate-500">gap expiry (own-TF candles)</span>
          </div>
          <div className="mb-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={5}
              className="w-14 rounded bg-slate-800 px-2 py-1 font-mono"
              value={conditionLookbackCandles}
              onChange={(e) =>
                useBot.getState().setScanBound('conditionLookbackCandles', +e.target.value)
              }
            />
            <span className="flex-1 text-slate-500">condition scan lookback</span>
          </div>
          <div className="mb-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={5}
              className="w-14 rounded bg-slate-800 px-2 py-1 font-mono"
              value={triggerLookbackCandles}
              onChange={(e) =>
                useBot.getState().setScanBound('triggerLookbackCandles', +e.target.value)
              }
            />
            <span className="flex-1 text-slate-500">trigger scan lookback</span>
          </div>

          <div className="mb-1 mt-2 text-[10px] uppercase tracking-wide text-slate-500">
            Risk sizing
            <Info text="%/$ modes size to the nearest 0.1 contract (0.1 NQ ≈ 1 MNQ, min 0.1) from the stop distance; % uses the current balance." />
          </div>
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

          <div className="mb-1 flex items-center gap-2">
            <input
              type="number"
              min={0.25}
              step={1}
              className="w-14 rounded bg-slate-800 px-2 py-1 font-mono"
              value={minStopPts}
              onChange={(e) => useBot.getState().setSizeGuard('minStopPts', +e.target.value)}
            />
            <span className="flex-1 text-slate-500">min stop (pts)</span>
            <input
              type="number"
              min={0.1}
              step={1}
              className="w-14 rounded bg-slate-800 px-2 py-1 font-mono"
              value={maxContracts}
              onChange={(e) => useBot.getState().setSizeGuard('maxContracts', +e.target.value)}
            />
            <span className="flex-1 text-slate-500">
              max contracts
              <Info text="Size is proportional to 1/stop-distance, so a stop that price has already reached by entry time would otherwise produce an enormous position. Candidates whose stop is nearer than the minimum are skipped outright, and the contract ceiling is a last-resort backstop." />
            </span>
          </div>

          <label className="mb-1.5 mt-2 flex cursor-pointer items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={onePosition}
              onChange={(e) => useBot.getState().setOnePosition(e.target.checked)}
            />
            1 position at a time
            <Info text="Dormant until flat with no working orders" />
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={hopWindows}
              onChange={(e) => useBot.getState().setHopWindows(e.target.checked)}
            />
            Auto-jump between active windows
            <Info text="Skips ahead when idle outside the window" />
          </label>
        </div>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBaseResolutionSec, getManifest, isSubMinute, secondsAvailableAt } from '@/lib/data/barSource';
import { SPEEDS, useReplay, type StepSize } from '@/lib/replay/clock';
import { etWallToUtc, formatET, tradingDateOf } from '@/lib/time/et';
import { TIMEFRAMES, availableTimeframes, type Timeframe } from '@/lib/types';

interface Props {
  rewindMode: boolean;
  setRewindMode: (v: boolean) => void;
}

// TradingView-style typed switching: "1"->1m, "15"->15m, "60"/"1h"->1h,
// "240"/"4h"->4h, "d"->1D, "w"->1W, "M"/"1M"->1M (capital M = month,
// lowercase m = minutes), "30s"->30s (with second-level data). Enter commits,
// Escape cancels.
function parseTypedTf(raw: string): Timeframe | null {
  if (raw === 'm' || raw === 'M' || /^1M$/.test(raw)) return '1M';
  if (/M$/.test(raw)) return null; // capital M is month-only; "15M" is invalid
  const s = raw.toLowerCase();
  if (s === 'd' || s === '1d') return '1D';
  if (s === 'w' || s === '1w') return '1W';
  if (s.endsWith('s')) {
    const tf = `${parseInt(s, 10)}s` as Timeframe;
    return (TIMEFRAMES as readonly string[]).includes(tf) ? tf : null;
  }
  if (s.endsWith('h')) {
    const n = parseInt(s, 10);
    return n === 1 ? '1h' : n === 4 ? '4h' : null;
  }
  const n = parseInt(s.replace(/m$/, ''), 10);
  if (Number.isNaN(n)) return null;
  if (n === 60) return '1h';
  if (n === 240) return '4h';
  const tf = `${n}m` as Timeframe;
  return (TIMEFRAMES as readonly string[]).includes(tf) ? tf : null;
}

export default function ReplayControls({ rewindMode, setRewindMode }: Props) {
  const {
    currentTime,
    endTs,
    timeframe,
    stepSize,
    playing,
    speed,
    loading,
    stepForward,
    stepBack,
    play,
    pause,
    setSpeed,
    setTimeframe,
    setStepSize,
    jumpTo,
  } = useReplay();

  const [jumpValue, setJumpValue] = useState('');
  const [tfBuffer, setTfBuffer] = useState('');
  const [tfInvalid, setTfInvalid] = useState(false);
  const bufferTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const togglePlay = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  // latest buffer, readable inside the stable keydown closure
  const tfBufferRef = useRef(tfBuffer);
  tfBufferRef.current = tfBuffer;

  useEffect(() => {
    const clearBuffer = () => {
      setTfBuffer('');
      setTfInvalid(false);
    };
    const armTimeout = () => {
      if (bufferTimeout.current) clearTimeout(bufferTimeout.current);
      bufferTimeout.current = setTimeout(clearBuffer, 2500);
    };

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;

      // typed timeframe buffer
      if (/^[0-9hHdDwWmMsS]$/.test(e.key)) {
        e.preventDefault();
        setTfInvalid(false);
        setTfBuffer((b) => b + e.key);
        armTimeout();
        return;
      }
      if (e.key === 'Enter') {
        const buffer = tfBufferRef.current;
        if (buffer) {
          e.preventDefault();
          const tf = parseTypedTf(buffer);
          const now = useReplay.getState().currentTime;
          const ok =
            tf !== null &&
            (availableTimeframes(getBaseResolutionSec()).includes(tf) ||
              (isSubMinute(tf) && now !== null && secondsAvailableAt(now)));
          if (tf && ok) {
            setTimeframe(tf);
            clearBuffer();
          } else {
            setTfInvalid(true);
            armTimeout();
          }
        }
        return;
      }
      if (e.key === 'Escape') {
        clearBuffer();
        return;
      }
      if (e.key === 'Backspace') {
        setTfBuffer((b) => b.slice(0, -1));
        return;
      }

      // transport
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        void stepForward();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        stepBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, stepForward, stepBack, setTimeframe]);

  // Jump to the NEXT trading day's 09:25 ET (the premarket decision point).
  const goToNextDay = () => {
    if (currentTime === null) return;
    const today = tradingDateOf(currentTime);
    const next = getManifest().find((d) => d.trading_date > today);
    if (!next) return;
    const [y, mo, d] = next.trading_date.split('-').map(Number);
    void jumpTo(etWallToUtc(y, mo, d, 9, 25));
  };

  const doJump = () => {
    if (!jumpValue) return;
    // datetime-local value is an ET wall time by convention of this UI
    const [d, tm] = jumpValue.split('T');
    const [y, mo, day] = d.split('-').map(Number);
    const [h, mi] = tm.split(':').map(Number);
    void jumpTo(etWallToUtc(y, mo, day, h, mi));
  };

  const atRangeEnd = endTs !== null && currentTime !== null && currentTime >= endTs;

  // 15s/30s are offered only where BOTH NQ and ES have seconds coverage.
  const subOk = currentTime !== null && secondsAvailableAt(currentTime);
  const tfChoices: Timeframe[] = [
    ...(subOk ? (['15s', '30s'] as Timeframe[]) : []),
    ...availableTimeframes(getBaseResolutionSec()),
  ];

  // walking into a period without seconds coverage falls back to 1m
  useEffect(() => {
    if (currentTime === null) return;
    if (isSubMinute(timeframe) && !subOk) setTimeframe('1m');
    if (stepSize !== 'view' && isSubMinute(stepSize) && !subOk) setStepSize('view');
  }, [currentTime, timeframe, stepSize, subOk, setTimeframe, setStepSize]);

  const btn =
    'rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-40';

  return (
    <>
      {/* typed-timeframe overlay */}
      {tfBuffer && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
          <div
            className={`rounded-lg border px-8 py-4 font-mono text-4xl ${
              tfInvalid
                ? 'border-red-500/60 bg-red-950/80 text-red-300'
                : 'border-slate-600 bg-slate-900/90 text-slate-100'
            }`}
          >
            {tfBuffer}
            <span className="ml-3 text-base text-slate-500">
              {tfInvalid ? 'invalid timeframe' : '↵ to switch timeframe'}
            </span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-800 bg-[#0d1119] px-4 py-2">
        {/* clock (seconds shown when the cursor sits inside a minute) */}
        <div className="w-48 font-mono text-sm text-amber-300">
          {currentTime !== null
            ? currentTime % 60 !== 0
              ? formatET(currentTime).replace(' ET', `:${String(currentTime % 60).padStart(2, '0')} ET`)
              : formatET(currentTime)
            : '—'}
          {loading && <span className="ml-2 animate-pulse text-slate-500">…</span>}
          {atRangeEnd && <span className="ml-2 text-red-400">■ range end</span>}
        </div>

        {/* transport */}
        <div className="flex items-center gap-1">
          <button className={btn} onClick={stepBack} title="Step back (←)">
            ◀
          </button>
          <button className={btn} onClick={togglePlay} disabled={atRangeEnd} title="Play/Pause (space)">
            {playing ? '❚❚' : '▶'}
          </button>
          <button className={btn} onClick={() => void stepForward()} disabled={atRangeEnd} title="Step forward (→)">
            ▶▮
          </button>
          <button className={btn} onClick={goToNextDay} disabled={atRangeEnd} title="Jump to next trading day, 09:25 ET">
            day ⏭
          </button>
          <label className="ml-2 text-xs text-slate-500">step</label>
          <select
            className="rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-200"
            value={stepSize}
            onChange={(e) => setStepSize(e.target.value as StepSize)}
            title="Step size: advance by one bar of this timeframe (independent of the chart timeframe)"
          >
            <option value="view">chart tf</option>
            {tfChoices.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
          <label className="ml-2 text-xs text-slate-500">speed</label>
          <select
            className="rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-200"
            value={speed}
            onChange={(e) => setSpeed(+e.target.value)}
            title="Autoplay speed (base bars/sec)"
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s} bar/s
              </option>
            ))}
          </select>
        </div>

        {/* timeframes */}
        <div className="flex items-center gap-1">
          {tfChoices.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`rounded px-2 py-1.5 text-sm ${
                tf === timeframe
                  ? 'bg-amber-500/20 text-amber-300'
                  : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        {/* rewind + jump */}
        <div className="ml-auto flex items-center gap-2">
          <button
            className={`${btn} ${rewindMode ? 'ring-1 ring-amber-400' : ''}`}
            onClick={() => setRewindMode(!rewindMode)}
            title="Toggle: click a point on the chart to rewind there"
          >
            ⏪ click-rewind {rewindMode ? 'on' : 'off'}
          </button>
          <input
            type="datetime-local"
            className="rounded bg-slate-800 px-2 py-1 text-sm text-slate-200"
            value={jumpValue}
            onChange={(e) => setJumpValue(e.target.value)}
          />
          <button className={btn} onClick={doJump}>
            Jump (ET)
          </button>
        </div>
      </div>
    </>
  );
}

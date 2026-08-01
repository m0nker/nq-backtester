'use client';

// "Add session" popup: name, day/time range, balance, and the bot menu.
// Owns all form state; the page owns actually starting the session.

import { useEffect, useMemo, useState } from 'react';
import { BOTS } from '@/lib/bots/registry';
import type { DayMeta } from '@/lib/types';

export interface NewSessionOpts {
  name: string;
  date: string;
  time: string;
  endDate: string;
  balance: number;
  botId: string | null; // null = manual session
}

interface Props {
  manifest: DayMeta[] | null;
  busy: boolean;
  onClose: () => void;
  onCreate: (opts: NewSessionOpts) => void;
}

export default function NewSessionModal({ manifest, busy, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(() => manifest?.[manifest.length - 1]?.trading_date ?? '');
  const [time, setTime] = useState('09:25');
  const [endDate, setEndDate] = useState('');
  const [balance, setBalance] = useState(50000);
  const [botId, setBotId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const availableDates = useMemo(() => new Set(manifest?.map((d) => d.trading_date)), [manifest]);
  const dateKnown = availableDates.has(date);
  const endBeforeStart = endDate !== '' && endDate < date;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-full w-[26rem] overflow-y-auto rounded-xl border border-slate-700 bg-[#0d1119] p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New session</h2>
          <button className="text-slate-500 hover:text-slate-300" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">
          Name <span className="normal-case text-slate-600">(optional)</span>
        </label>
        <input
          type="text"
          placeholder="e.g. FVG week of Mar 3"
          maxLength={80}
          className="mb-3 w-full rounded bg-slate-800 px-3 py-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

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
          className="mb-4 w-full rounded bg-slate-800 px-3 py-2"
          value={balance}
          onChange={(e) => setBalance(+e.target.value)}
        />

        <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Bot</label>
        <div className="mb-4 flex flex-col gap-1.5">
          <button
            className={`rounded border px-3 py-2 text-left text-sm ${
              botId === null
                ? 'border-amber-500/60 bg-amber-500/10 text-amber-200'
                : 'border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
            }`}
            onClick={() => setBotId(null)}
          >
            <div className="font-medium">None — manual trading</div>
            <div className="text-xs text-slate-500">You place every order yourself.</div>
          </button>
          {BOTS.map((b) => (
            <button
              key={b.id}
              className={`rounded border px-3 py-2 text-left text-sm ${
                botId === b.id
                  ? 'border-teal-500/60 bg-teal-500/10 text-teal-200'
                  : 'border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
              onClick={() => setBotId(b.id)}
            >
              <div className="font-medium">{b.name}</div>
              <div className="text-xs text-slate-500">{b.description}</div>
            </button>
          ))}
        </div>

        <button
          className="w-full rounded bg-amber-500 py-2 font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-40"
          disabled={!manifest || !dateKnown || !time || busy || endBeforeStart}
          onClick={() => onCreate({ name: name.trim(), date, time, endDate, balance, botId })}
        >
          {busy ? 'Loading data…' : 'Start session'}
        </button>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { botOfConfig } from '@/lib/bots/registry';
import { setSessionStatus, type SessionRow } from '@/lib/data/sessions';
import { formatET } from '@/lib/time/et';

interface Props {
  sessions: SessionRow[] | null;
  onResume: (s: SessionRow) => void;
  onChanged: () => void;
}

export default function SessionList({ sessions, onResume, onChanged }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const visible = sessions?.filter((s) => showArchived || s.status === 'active');

  const toggleArchive = async (s: SessionRow) => {
    setBusy(s.id);
    try {
      await setSessionStatus(s.id, s.status === 'archived' ? 'active' : 'archived');
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full rounded-xl border border-slate-800 bg-[#0d1119] p-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Sessions</h2>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          show archived
        </label>
      </div>

      {!sessions ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : !visible || visible.length === 0 ? (
        <p className="text-sm text-slate-600">No sessions yet — add one below.</p>
      ) : (
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {visible.map((s) => {
            const bot = botOfConfig(s.config);
            const name = typeof s.config?.name === 'string' ? s.config.name : '';
            const startLabel = formatET(new Date(s.start_ts).getTime() / 1000);
            return (
            <div
              key={s.id}
              className={`flex items-center gap-2 rounded border border-slate-800 px-3 py-2 text-sm ${s.status === 'archived' ? 'opacity-50' : ''}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-slate-200">
                  <span className={`truncate ${name ? '' : 'font-mono'}`}>
                    {name || startLabel}
                  </span>
                  {bot && (
                    <span
                      className="shrink-0 rounded border border-teal-700 bg-teal-950/70 px-1 text-[10px] uppercase text-teal-300"
                      title={bot.description}
                    >
                      {bot.name}
                    </span>
                  )}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {name && <span className="font-mono">{startLabel} · </span>}
                  ${Number(s.starting_balance).toLocaleString()} · created{' '}
                  {new Date(s.created_at).toLocaleDateString()}
                  {s.status === 'archived' && ' · archived'}
                </div>
              </div>
              {s.status === 'active' && (
                <button
                  className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-300 hover:bg-amber-500/25"
                  onClick={() => onResume(s)}
                >
                  Resume
                </button>
              )}
              <button
                className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 disabled:opacity-40"
                disabled={busy === s.id}
                onClick={() => void toggleArchive(s)}
              >
                {s.status === 'archived' ? 'Unarchive' : 'Archive'}
              </button>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

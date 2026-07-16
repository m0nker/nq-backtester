// Append-only session event log. In-memory array is the working truth for the
// reducer; rows sync to Supabase in batches in the background. Consecutive
// time_advanced events coalesce (autoplay ticks 5-20/sec — one event per
// contiguous advance is enough; the order/fill events carry their own
// ts_market).

import { supabase } from '../supabase';
import type { EventPayloads, EventType, SessionEvent } from './types';

let sessionId: string | null = null;
let events: SessionEvent[] = [];
let unsyncedFrom = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function getEvents(): SessionEvent[] {
  return events;
}

export function getSessionId(): string | null {
  return sessionId;
}

export async function startSession(opts: {
  startTs: number;
  endTs: number | null;
  startingBalance: number;
  config?: Record<string, unknown>;
}): Promise<void> {
  await endSession();
  events = [];
  unsyncedFrom = 0;
  sessionId = null;

  const { data, error } = await supabase
    .from('sessions')
    .insert({
      instrument_id: 'NQ',
      base_resolution: '1m',
      start_ts: new Date(opts.startTs * 1000).toISOString(),
      starting_balance: opts.startingBalance,
      config: { endTs: opts.endTs, fillModelVersion: 1, commissionPerSide: 0, ...opts.config },
    })
    .select('id')
    .single();
  if (error) {
    // Offline/misconfigured: session still works locally, just unsynced.
    console.warn('session insert failed; running unsynced:', error.message);
  } else {
    sessionId = data.id;
  }

  appendEvent('session_started', opts.startTs, {
    startTs: opts.startTs,
    endTs: opts.endTs,
    startingBalance: opts.startingBalance,
    config: opts.config ?? {},
  });
  flushTimer ??= setInterval(() => void flush(), 3000);
}

// Rehydrate a saved session: the loaded events become the in-memory log
// (already synced — nothing re-uploads), and new events append after them.
export async function resumeSession(id: string, loaded: SessionEvent[]): Promise<void> {
  await endSession();
  sessionId = id;
  events = loaded;
  unsyncedFrom = loaded.length;
  flushTimer ??= setInterval(() => void flush(), 3000);
}

export async function endSession(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flush();
  sessionId = null;
}

export function appendEvent<T extends EventType>(
  type: T,
  tsMarket: number,
  payload: EventPayloads[T],
): SessionEvent<T> {
  // coalesce contiguous clock advances that nothing else interleaves
  if (type === 'time_advanced' && events.length > 0) {
    const last = events[events.length - 1];
    if (last.type === 'time_advanced' && events.length - 1 >= unsyncedFrom) {
      const lp = last.payload as EventPayloads['time_advanced'];
      const np = payload as EventPayloads['time_advanced'];
      if (lp.to === np.from && lp.mode === np.mode) {
        lp.to = np.to;
        last.tsMarket = tsMarket;
        return last as SessionEvent<T>;
      }
    }
  }
  const ev: SessionEvent<T> = {
    seq: events.length + 1,
    type,
    tsMarket,
    tsWall: new Date().toISOString(),
    payload,
  };
  events.push(ev);
  return ev;
}

async function flush(): Promise<void> {
  if (!sessionId || unsyncedFrom >= events.length) return;
  const batch = events.slice(unsyncedFrom, unsyncedFrom + 500);
  const rows = batch.map((e) => ({
    session_id: sessionId,
    seq: e.seq,
    event_type: e.type,
    ts_market: new Date(e.tsMarket * 1000).toISOString(),
    ts_wall: e.tsWall,
    payload: e.payload,
  }));
  const { error } = await supabase.from('events').insert(rows);
  if (error) {
    console.warn('event sync failed (will retry):', error.message);
    return;
  }
  unsyncedFrom += batch.length;
  if (unsyncedFrom < events.length) void flush();
}

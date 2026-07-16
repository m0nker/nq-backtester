// Session persistence: list/archive sessions and load their event logs for
// resume + dashboard. Events map 1:1 to the in-memory SessionEvent shape.

import { supabase } from '../supabase';
import type { SessionEvent, EventType } from '../events/types';

export interface SessionRow {
  id: string;
  instrument_id: string;
  start_ts: string;
  starting_balance: number;
  config: { endTs?: number | null } & Record<string, unknown>;
  status: string;
  created_at: string;
}

export async function listSessions(includeArchived = false): Promise<SessionRow[]> {
  let q = supabase
    .from('sessions')
    .select('id, instrument_id, start_ts, starting_balance, config, status, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (!includeArchived) q = q.eq('status', 'active');
  const { data, error } = await q;
  if (error) throw new Error(`session list failed: ${error.message}`);
  return data as SessionRow[];
}

export async function setSessionStatus(id: string, status: 'active' | 'archived'): Promise<void> {
  const { error } = await supabase.from('sessions').update({ status }).eq('id', id);
  if (error) throw new Error(`session update failed: ${error.message}`);
}

export async function loadSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('events')
      .select('seq, event_type, ts_market, ts_wall, payload')
      .eq('session_id', sessionId)
      .order('seq')
      .range(from, from + page - 1);
    if (error) throw new Error(`event load failed: ${error.message}`);
    for (const r of data) {
      out.push({
        seq: r.seq,
        type: r.event_type as EventType,
        tsMarket: new Date(r.ts_market).getTime() / 1000,
        tsWall: r.ts_wall,
        payload: r.payload,
      } as SessionEvent);
    }
    if (!data || data.length < page) break;
  }
  return out;
}

// Where a resumed session's clock should stand: the latest market time any
// event observed (falls back to the session's configured start).
export function resumeTimeOf(events: SessionEvent[], fallback: number): number {
  let t = fallback;
  for (const ev of events) if (ev.tsMarket > t) t = ev.tsMarket;
  return t;
}

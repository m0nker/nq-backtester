import { supabase } from '../supabase';
import type { DayMeta } from '../types';

// Sorted list of available trading days for an instrument/resolution.
// Cached per (instrument, resolution) — NQ/1m, NQ/1s, ES/1m, ES/1s differ!
const cache = new Map<string, DayMeta[]>();

export async function loadManifest(instrument = 'NQ', resolution = '1m'): Promise<DayMeta[]> {
  const key = `${instrument}/${resolution}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const days: DayMeta[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from('dataset_days')
      .select('trading_date, storage_path, bar_count, first_ts, last_ts, checksum')
      .eq('instrument_id', instrument)
      .eq('resolution', resolution)
      .order('trading_date')
      .range(from, from + page - 1);
    if (error) throw new Error(`manifest load failed: ${error.message}`);
    days.push(...(data as DayMeta[]));
    if (!data || data.length < page) break;
  }
  cache.set(key, days);
  return days;
}

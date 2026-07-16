// Day-chunk fetch + cache. Chunks are gzipped columnar JSON in the public
// `chunks` Storage bucket. Cache hierarchy: in-memory LRU -> IndexedDB -> network.
//
// NOTE: this module holds FULL trading days, including bars "in the future"
// relative to the replay clock. That is unavoidable at day-chunk granularity
// and is safe because nothing outside barSource.ts can reach this module —
// all reads go through the clock-guarded barSource API.

import { openDB, type IDBPDatabase } from 'idb';
import { SUPABASE_URL } from '../supabase';
import type { Bar } from '../types';

interface ChunkFile {
  instrument: string;
  tradingDate: string;
  resolution: string;
  schemaVersion: number;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

const MEM_LRU_MAX = 60; // days held in memory (~1400 bars each)

const mem = new Map<string, Bar[]>(); // Map preserves insertion order -> LRU

let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  dbPromise ??= openDB('nq-backtester', 1, {
    upgrade(d) {
      d.createObjectStore('chunks');
    },
  });
  return dbPromise;
}

function toBars(f: ChunkFile): Bar[] {
  const out: Bar[] = new Array(f.t.length);
  for (let i = 0; i < f.t.length; i++) {
    out[i] = { t: f.t[i], o: f.o[i], h: f.h[i], l: f.l[i], c: f.c[i], v: f.v[i] };
  }
  return out;
}

async function fetchChunk(storagePath: string): Promise<ChunkFile> {
  // no-cache: revalidate at the CDN (cheap 304 normally) so re-ingested
  // chunks aren't served stale for the cache TTL
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/public/chunks/${storagePath}`, {
    cache: 'no-cache',
  });
  if (!res.ok) throw new Error(`chunk fetch ${storagePath}: ${res.status}`);
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).json();
}

// Cache entries are keyed by path AND content checksum (from dataset_days),
// so a re-ingested day is a cache miss instead of stale data.
export async function getDayBars(storagePath: string, checksum?: string | null): Promise<Bar[]> {
  const key = `${storagePath}@${checksum ?? ''}`;
  const hit = mem.get(key);
  if (hit) {
    // refresh LRU position
    mem.delete(key);
    mem.set(key, hit);
    return hit;
  }

  let file = (await (await db()).get('chunks', key)) as ChunkFile | undefined;
  if (!file) {
    file = await fetchChunk(storagePath);
    await (await db()).put('chunks', file, key);
  }

  const bars = toBars(file);
  mem.set(key, bars);
  while (mem.size > MEM_LRU_MAX) {
    const oldest = mem.keys().next().value as string;
    mem.delete(oldest);
  }
  return bars;
}

// Phase 2 data pipeline: Supabase 1m day-chunks -> price-normalized, packed
// BarCodec-v1 month buffers under roblox/data-out/, ready for the Open Cloud
// DataStore upload (tools/uploadData.ts).
//
// Run: `npx tsx roblox/tools/prepareData.ts [--months 2025-04,2025-05,2025-06]
//       [--sample-days 3]` with cwd = repo root.
//
// `--hist-only` rebuilds ONLY the deep 1h history from the month buffers already
// on disk — no Supabase round trip, no credentials needed, months and
// SampleData/Codec fixtures left untouched.
//
// roblox/src/shared/Data/BarCodec.luau is the SINGLE source of truth for the
// byte layout; pack()/unpack() here mirror it field for field and the generated
// tests/fixtures/Codec.json pins the two implementations byte-for-byte. Change
// one without the other and parity breaks by construction.
//
// Prices are rebased by ONE dataset-wide constant (licensing hygiene,
// PORT_PLAN) — an undisclosed shift that destroys the absolute price identity
// while preserving every bar's shape and every price relationship, including
// across month boundaries. Timestamps and volume are untouched.
//
// The shift is derived from the earliest day actually packed, so a --months
// subset produces a DIFFERENT shift than a full run: only full runs are
// canonical (see DATA.md).
//
// The deep 1h history (META_PLAN §4) is folded from the SAME normalized bars the
// months are packed from, so it carries the same dataset-wide shift for free and
// splices onto live minute data without a seam.
//
// Nothing here is a replay-clock read: this is an offline preprocessing tool
// operating on whole trading days, the same as scripts/ingest.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { aggregate } from '../../web/src/lib/replay/aggregate';
import { roundToTick } from '../../web/src/lib/trading/contractMath';
import type { Bar } from '../../web/src/lib/types';

const INSTRUMENT = 'NQ';
const RESOLUTION = '1m';
const TICK_SIZE = 0.25;
const BASE_SEC = 60;

// The dataset's earliest open is rebased to this price. Arbitrary and
// undisclosed on purpose — see the licensing-hygiene row in PORT_PLAN.
const NORMALIZED_OPEN = 20_000;

// Script.Source caps at 200k chars; SampleData.luau is Rojo-mapped to a
// ModuleScript, so the base64 payload plus wrapper must stay under this.
const MAX_SAMPLE_CHARS = 190_000;

// The deep-history timeframe. 1h is the finest resolution the whole dataset fits
// into one DataStore value at; everything coarser (4h/1D/1W/1M) is aggregated
// from it client-side, and nothing finer can be recovered from it.
const HIST_TF = '1h' as const;
const HIST_KEY = 'hist:1h';

// DataStore value hard limit, in characters of the base64 the key holds.
const MAX_VALUE_CHARS = 4_194_304;
// META_PLAN §4.1's split trigger. Below this the series is ONE key; at or above
// it the year-boundary split (`hist:1h:1`, `hist:1h:2`, …) has to be built —
// deliberately unimplemented while the real series sits ~20% under the trigger,
// because untested split code is worse than an assert that names the design.
const HIST_SPLIT_CHARS = 3_800_000;

const FETCH_CONCURRENCY = 6;
const FETCH_ATTEMPTS = 3;
const PAGE = 1000;

// --------------------------------------------------------------- BarCodec v1

const MAGIC = 0x4b42514e;
const VERSION = 1;
const HEADER_SIZE = 20;
const BAR_SIZE = 24;

// Mirrors BarCodec.luau's `math.floor(p / tickSize + 0.5)` literally rather
// than using Math.round — the two must agree on every value including halves.
function ticks(price: number, tickSize: number): number {
  return Math.floor(price / tickSize + 0.5);
}

function pack(bars: Bar[], tickSize: number): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE + BAR_SIZE * bars.length);
  buf.writeUInt32LE(MAGIC, 0);
  buf.writeUInt8(VERSION, 4);
  // bytes 5..7 reserved, left zero
  buf.writeUInt32LE(bars.length, 8);
  buf.writeDoubleLE(tickSize, 12);
  let off = HEADER_SIZE;
  for (const b of bars) {
    buf.writeUInt32LE(b.t, off);
    buf.writeInt32LE(ticks(b.o, tickSize), off + 4);
    buf.writeInt32LE(ticks(b.h, tickSize), off + 8);
    buf.writeInt32LE(ticks(b.l, tickSize), off + 12);
    buf.writeInt32LE(ticks(b.c, tickSize), off + 16);
    buf.writeUInt32LE(b.v, off + 20);
    off += BAR_SIZE;
  }
  return buf;
}

function unpack(buf: Buffer): Bar[] {
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error('BarCodec: bad magic');
  if (buf.readUInt8(4) !== VERSION) throw new Error('BarCodec: unsupported version');
  const n = buf.readUInt32LE(8);
  const tickSize = buf.readDoubleLE(12);
  if (buf.length < HEADER_SIZE + BAR_SIZE * n) throw new Error('BarCodec: truncated');
  const out: Bar[] = new Array(n);
  let off = HEADER_SIZE;
  for (let i = 0; i < n; i++) {
    out[i] = {
      t: buf.readUInt32LE(off),
      o: buf.readInt32LE(off + 4) * tickSize,
      h: buf.readInt32LE(off + 8) * tickSize,
      l: buf.readInt32LE(off + 12) * tickSize,
      c: buf.readInt32LE(off + 16) * tickSize,
      v: buf.readUInt32LE(off + 20),
    };
    off += BAR_SIZE;
  }
  return out;
}

// Zero tolerance: the packed month must decode back to exactly what went in,
// or the tick-count representation is lossy somewhere and every downstream
// price in the game is wrong.
function assertRoundTrip(label: string, bars: Bar[], buf: Buffer): void {
  const back = unpack(buf);
  if (back.length !== bars.length) {
    throw new Error(`${label}: round-trip bar count ${back.length} != ${bars.length}`);
  }
  for (let i = 0; i < bars.length; i++) {
    const a = bars[i];
    const b = back[i];
    if (a.t !== b.t || a.o !== b.o || a.h !== b.h || a.l !== b.l || a.c !== b.c || a.v !== b.v) {
      throw new Error(
        `${label}: round-trip mismatch at ${i}\n  in : ${JSON.stringify(a)}\n  out: ${JSON.stringify(b)}`,
      );
    }
  }
}

// ------------------------------------------------------------------ plumbing

interface DayRow {
  trading_date: string;
  storage_path: string;
  bar_count: number;
  first_ts: string;
  last_ts: string;
  checksum: string | null;
}

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

interface DayOut {
  date: string;
  firstTs: number;
  lastTs: number;
  barCount: number;
}

interface MonthOut {
  month: string;
  key: string;
  byteSize: number;
  days: DayOut[];
}

// META_PLAN §4.1: the whole 1h series in one DataStore key. Optional because a
// manifest written before §4 landed has no `hist` and must still load.
interface HistOut {
  key: string;
  file: string;
  barCount: number;
  byteSize: number;
  firstTs: number;
  lastTs: number;
}

interface OutManifest {
  tickSize: number;
  baseSec: number;
  months: MonthOut[];
  hist?: HistOut;
}

const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'roblox', 'tools', 'prepareData.ts'))) {
  throw new Error(`run from the repo root (cwd is ${ROOT})`);
}
const OUT_DIR = join(ROOT, 'roblox', 'data-out');
const MONTH_DIR = join(OUT_DIR, 'm');
const HIST_DIR = join(OUT_DIR, 'hist');
const MANIFEST_PATH = join(OUT_DIR, 'manifest.json');
const SAMPLE_PATH = join(ROOT, 'roblox', 'src', 'server', 'Data', 'SampleData.luau');
const CODEC_FIXTURE_PATH = join(ROOT, 'roblox', 'tests', 'fixtures', 'Codec.json');

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const monthsArg = argValue('--months');
const onlyMonths = monthsArg ? new Set(monthsArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const sampleDaysWanted = Math.max(1, Number(argValue('--sample-days') ?? 3));
const histOnly = process.argv.includes('--hist-only');
if (histOnly && onlyMonths) {
  throw new Error('--hist-only rebuilds the history from every packed month; --months does not apply');
}

// web/.env.local is the one place these credentials live; parsed by hand so the
// tool stays dependency-free (it runs via npx tsx, not through Next).
function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// Resolved on first fetch, not at import: --hist-only reads the packed months
// off disk and must run on a machine with no Supabase credentials at all.
let supabase: { url: string; headers: Record<string, string> } | null = null;

function supabaseEnv(): { url: string; headers: Record<string, string> } {
  if (supabase) return supabase;
  const envPath = join(ROOT, 'web', '.env.local');
  if (!existsSync(envPath)) throw new Error(`missing ${envPath} (NEXT_PUBLIC_SUPABASE_URL / _KEY)`);
  const env = loadEnvFile(envPath);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_KEY;
  if (!url || !key) {
    throw new Error('web/.env.local must define NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_KEY');
  }
  supabase = { url, headers: { apikey: key, Authorization: `Bearer ${key}` } };
  return supabase;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string, init: RequestInit, what: string): Promise<Response> {
  let last = '';
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      last = `${res.status} ${res.statusText}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(400 * 2 ** (attempt - 1));
  }
  throw new Error(`${what}: ${last}`);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------ manifest

// Same where-clauses as web/src/lib/data/manifest.ts (instrument_id, resolution,
// ordered by trading_date, paged 1000) — the Roblox port must ship the same set
// of days the web app sees.
async function loadDayManifest(): Promise<DayRow[]> {
  const { url, headers } = supabaseEnv();
  const select = 'trading_date,storage_path,bar_count,first_ts,last_ts,checksum';
  const base =
    `${url}/rest/v1/dataset_days?select=${select}` +
    `&instrument_id=eq.${INSTRUMENT}&resolution=eq.${RESOLUTION}&order=trading_date.asc`;
  const days: DayRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetchRetry(
      base,
      { headers: { ...headers, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' } },
      `manifest page ${from}`,
    );
    const rows = (await res.json()) as DayRow[];
    days.push(...rows);
    if (rows.length < PAGE) break;
  }
  return days;
}

async function fetchDayBars(day: DayRow): Promise<Bar[]> {
  const res = await fetchRetry(
    `${supabaseEnv().url}/storage/v1/object/public/chunks/${day.storage_path}`,
    { cache: 'no-cache' },
    `chunk ${day.storage_path}`,
  );
  const file = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')) as ChunkFile;
  const n = file.t.length;
  if (file.o.length !== n || file.h.length !== n || file.l.length !== n || file.c.length !== n || file.v.length !== n) {
    throw new Error(`chunk ${day.storage_path}: ragged columnar arrays`);
  }
  const bars: Bar[] = new Array(n);
  for (let i = 0; i < n; i++) {
    bars[i] = { t: file.t[i], o: file.o[i], h: file.h[i], l: file.l[i], c: file.c[i], v: file.v[i] };
  }
  return bars;
}

// -------------------------------------------------------------- data quality

const quality = {
  offGridPrices: 0,
  offGridDays: new Set<string>(),
  maxRawDevTicks: 0,
  maxRawDevWhere: '',
  outOfOrder: 0,
  duplicateTs: 0,
  nonIntegerVolume: 0,
  maxGapMin: 0,
  maxGapWhere: '',
  barCountMismatch: [] as string[],
};

function inspectRawDay(date: string, bars: Bar[], meta: DayRow): void {
  if (bars.length !== meta.bar_count) {
    quality.barCountMismatch.push(`${date}: chunk ${bars.length} vs manifest ${meta.bar_count}`);
  }
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    for (const [field, p] of [['o', b.o], ['h', b.h], ['l', b.l], ['c', b.c]] as const) {
      const dev = Math.abs(p / TICK_SIZE - Math.round(p / TICK_SIZE));
      if (dev > 0) {
        quality.offGridPrices++;
        quality.offGridDays.add(date);
        if (dev > quality.maxRawDevTicks) {
          quality.maxRawDevTicks = dev;
          quality.maxRawDevWhere = `${date} t=${b.t} ${field}=${p}`;
        }
      }
    }
    if (!Number.isInteger(b.v) || b.v < 0) quality.nonIntegerVolume++;
    if (i > 0) {
      const dt = b.t - bars[i - 1].t;
      if (dt === 0) quality.duplicateTs++;
      else if (dt < 0) quality.outOfOrder++;
      else if (dt / 60 > quality.maxGapMin) {
        quality.maxGapMin = dt / 60;
        quality.maxGapWhere = `${date} after t=${bars[i - 1].t}`;
      }
    }
  }
}

// ------------------------------------------------------------- normalization

// Off-grid tolerance, in ticks. Some source chunks carry float dust from the
// roll adjustment (observed max ~1.5e-11 ticks), so normalization snaps onto
// the tick grid — the packed form is integer tick counts regardless, and this
// makes the in-memory bars agree with it exactly. The bound is tight enough
// that a genuinely off-grid price (a real half-tick) still fails loudly.
const SNAP_TOLERANCE_TICKS = 1e-6;
let maxSnapTicks = 0;

// Post-shift extremes, to prove the whole dataset stays inside the i32 tick
// range the packed form uses.
let minLow = Infinity;
let maxHigh = -Infinity;

// ONE shift for the entire dataset, so that the earliest packed day opens on
// NORMALIZED_OPEN. Every price relationship survives — including across month
// boundaries, which a deep multi-year chart IS (META_PLAN §4) — while the
// absolute level identity is destroyed. Derived from the earliest packed day,
// hence only canonical on a full run.
function globalShiftFrom(firstOpen: number): number {
  return roundToTick(firstOpen - NORMALIZED_OPEN, TICK_SIZE);
}

function normalizeDays(days: Array<{ date: string; bars: Bar[] }>, shift: number): void {
  const snap = (date: string, t: number, field: string, raw: number): number => {
    const shifted = raw - shift;
    const onGrid = roundToTick(shifted, TICK_SIZE);
    const devTicks = Math.abs(shifted - onGrid) / TICK_SIZE;
    if (devTicks > SNAP_TOLERANCE_TICKS) {
      throw new Error(
        `${date} t=${t}: ${field}=${raw} is ${devTicks} ticks off the ${TICK_SIZE} grid (shift ${shift})`,
      );
    }
    if (devTicks > maxSnapTicks) maxSnapTicks = devTicks;
    return onGrid;
  };
  for (const day of days) {
    for (const b of day.bars) {
      b.o = snap(day.date, b.t, 'o', b.o);
      b.h = snap(day.date, b.t, 'h', b.h);
      b.l = snap(day.date, b.t, 'l', b.l);
      b.c = snap(day.date, b.t, 'c', b.c);
      if (b.l < minLow) minLow = b.l;
      if (b.h > maxHigh) maxHigh = b.h;
      if (!Number.isInteger(b.v) || b.v < 0 || b.v > 0xffffffff) {
        throw new Error(`${day.date} t=${b.t}: volume ${b.v} does not fit u32`);
      }
      if (!Number.isInteger(b.t) || b.t < 0 || b.t > 0xffffffff) {
        throw new Error(`${day.date}: timestamp ${b.t} does not fit u32`);
      }
    }
  }
}

// --------------------------------------------------------------- sample days

function isWeekday(date: string): boolean {
  // Plain civil-calendar weekday of a YYYY-MM-DD label — no timezone math.
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
}

// Latest run of `n` adjacent trading days in the month that are all weekdays.
// Adjacent in the manifest, not in the calendar — a Thu/Fri/Mon run is three
// consecutive trading days with no missing session between them.
function pickSampleRun<T extends { date: string }>(days: T[], n: number): T[] | null {
  for (let end = days.length; end >= n; end--) {
    const run = days.slice(end - n, end);
    if (run.every((d) => isWeekday(d.date))) return run;
  }
  return null;
}

// ------------------------------------------------------------------ codegen

function writeSampleData(run: Array<{ date: string; bars: Bar[] }>): { chars: number; bars: number } {
  const bars = run.flatMap((d) => d.bars);
  const buf = pack(bars, TICK_SIZE);
  assertRoundTrip('sample', bars, buf);
  const days = run.map((d) => ({
    date: d.date,
    firstTs: d.bars[0].t,
    lastTs: d.bars[d.bars.length - 1].t,
    barCount: d.bars.length,
  }));
  const dayLines = days
    .map((d) => `\t\t{ date = "${d.date}", firstTs = ${d.firstTs}, lastTs = ${d.lastTs}, barCount = ${d.barCount} },`)
    .join('\n');
  const src =
    '--!strict\n' +
    '-- GENERATED by tools/prepareData.ts — do not edit\n' +
    '-- BarCodec v1 chunk, base64 (DataStore/Script.Source values are text; the\n' +
    '-- server decodes with EncodingService). Offline fallback + Studio testing\n' +
    '-- data so the port runs without a DataStore round trip.\n' +
    `return {\n\tb64 = "${buf.toString('base64')}",\n\tdays = {\n${dayLines}\n\t},\n}\n`;
  if (src.length >= MAX_SAMPLE_CHARS) {
    throw new Error(
      `SampleData.luau is ${src.length} chars (cap ${MAX_SAMPLE_CHARS}) — rerun with fewer --sample-days`,
    );
  }
  mkdirSync(join(ROOT, 'roblox', 'src', 'server', 'Data'), { recursive: true });
  writeFileSync(SAMPLE_PATH, src, 'utf8');
  return { chars: src.length, bars: bars.length };
}

// Pins the TS packer to the Luau decoder byte-for-byte. Real bars alone cannot
// cover the representation edges — the global shift puts the dataset's earliest
// open at 20000 and the run reports the post-shift range, which stays positive
// and orders of magnitude inside i32 — hence the tail bars are constructed to
// exercise i32 sign, the u32 volume range and the u32 timestamp range.
function writeCodecFixture(realBars: Bar[]): number {
  const bars: Bar[] = [
    ...realBars.slice(0, 4),
    { t: 1_700_000_000, o: 0, h: 0.25, l: -0.25, c: 0, v: 0 },
    { t: 1_700_000_060, o: -1234.75, h: -1000, l: -2000.25, c: -1500.5, v: 7 },
    { t: 1_700_000_120, o: -536_870_912, h: 536_870_911.75, l: -536_870_912, c: 536_870_911.75, v: 4_294_967_295 },
    { t: 4_294_967_295, o: 19_999.75, h: 20_000.25, l: 19_999.5, c: 20_000, v: 0 },
  ];
  const buf = pack(bars, TICK_SIZE);
  assertRoundTrip('codec fixture', bars, buf);
  const json = JSON.stringify({
    tickSize: TICK_SIZE,
    bars: bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]),
    base64: buf.toString('base64'),
  });
  mkdirSync(join(ROOT, 'roblox', 'tests', 'fixtures'), { recursive: true });
  writeFileSync(CODEC_FIXTURE_PATH, json, 'utf8');
  return json.length;
}

// ------------------------------------------------------------- 1h deep history

// Buckets MUST be the game's buckets: `aggregate` anchors 1h to the 18:00 ET
// trading-day open, not to UTC hours. Hand-rolling the bucketing here would
// split the hour differently from the live minute data the history splices onto,
// and the seam would be a one-candle lie at every session start.
//
// Months are folded one at a time and only the OPEN bucket survives the
// boundary, so a full-history run never holds more than one month of 1m bars.
// Returns 1 when the boundary bucket actually straddled the two months.
function foldMonthHourly(acc: Bar[], monthBars: Bar[], label: string): number {
  const hours = aggregate(monthBars, HIST_TF, BASE_SEC);
  if (hours.length === 0) return 0;
  const open = acc[acc.length - 1];
  let from = 0;
  if (open !== undefined) {
    if (hours[0].t < open.t) {
      throw new Error(`${label}: 1h bucket ${hours[0].t} precedes the open bucket ${open.t} — months out of order`);
    }
    if (hours[0].t === open.t) {
      // A month's first trading date opens 18:00 ET the previous evening, which
      // is itself a bucket start, so this merge is not expected to fire. It
      // exists because a dropped straddle would corrupt exactly one candle per
      // month boundary and nothing downstream would ever notice.
      open.h = Math.max(open.h, hours[0].h);
      open.l = Math.min(open.l, hours[0].l);
      open.c = hours[0].c;
      open.v += hours[0].v;
      from = 1;
    }
  }
  for (let i = from; i < hours.length; i++) acc.push(hours[i]);
  return from;
}

function writeHourly(hourly: Bar[]): HistOut {
  if (hourly.length === 0) throw new Error('hourly history is empty');
  const buf = pack(hourly, TICK_SIZE);
  assertRoundTrip('hist:1h', hourly, buf);
  const b64Chars = Math.ceil(buf.length / 3) * 4;
  if (b64Chars >= HIST_SPLIT_CHARS) {
    throw new Error(
      `hist:1h is ${b64Chars} base64 chars, at/over the ${HIST_SPLIT_CHARS} split trigger ` +
        `(DataStore cap ${MAX_VALUE_CHARS}) — implement META_PLAN §4.1's year-boundary split ` +
        `into hist:1h:1, hist:1h:2, … and teach the server to concatenate keys until GetAsync returns nil`,
    );
  }
  mkdirSync(HIST_DIR, { recursive: true });
  writeFileSync(join(HIST_DIR, '1h.bin'), buf);
  return {
    key: HIST_KEY,
    file: '1h.bin',
    barCount: hourly.length,
    byteSize: buf.length,
    firstTs: hourly[0].t,
    lastTs: hourly[hourly.length - 1].t,
  };
}

function reportHourly(hist: HistOut, straddles: number): void {
  const b64Chars = Math.ceil(hist.byteSize / 3) * 4;
  const headroomBars = Math.floor(((MAX_VALUE_CHARS - b64Chars) * 3) / 4 / BAR_SIZE);
  console.log(
    `\nhist:1h: ${hist.barCount} bars, ${hist.byteSize} B (${(hist.byteSize / 1048576).toFixed(2)} MiB), ` +
      `${b64Chars} base64 chars = ${((b64Chars / MAX_VALUE_CHARS) * 100).toFixed(1)}% of the ${MAX_VALUE_CHARS} cap`,
  );
  console.log(
    `         headroom ${MAX_VALUE_CHARS - b64Chars} chars ≈ ${headroomBars} more bars; ` +
      `split trigger at ${HIST_SPLIT_CHARS} chars (not reached, split not implemented)`,
  );
  console.log(`         month-boundary straddles merged: ${straddles}`);
}

function readManifestFile(): OutManifest {
  if (!existsSync(MANIFEST_PATH)) throw new Error(`missing ${MANIFEST_PATH} — run a full prepareData first`);
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as OutManifest;
}

function writeManifestFile(manifest: OutManifest): void {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

// --hist-only: rebuild the 1h series from the packed months already on disk.
// The months carry the dataset-wide shift, so the history inherits it verbatim —
// there is nothing to renormalize and nothing to refetch.
function histOnlyRun(): void {
  const manifest = readManifestFile();
  if (manifest.months.length === 0) throw new Error('manifest.json lists no months');
  console.log(`--hist-only: folding ${manifest.months.length} packed month(s) from ${MONTH_DIR}`);

  const hourly: Bar[] = [];
  let straddles = 0;
  let sourceBars = 0;
  for (const meta of [...manifest.months].sort((a, b) => a.month.localeCompare(b.month))) {
    const path = join(MONTH_DIR, `${meta.month}.bin`);
    if (!existsSync(path)) throw new Error(`missing ${path} — the manifest and data-out/m/ disagree`);
    const buf = readFileSync(path);
    if (buf.length !== meta.byteSize) {
      throw new Error(`${meta.month}.bin: ${buf.length} bytes, manifest says ${meta.byteSize} — regenerate`);
    }
    const bars = unpack(buf);
    sourceBars += bars.length;
    straddles += foldMonthHourly(hourly, bars, meta.month);
  }

  const hist = writeHourly(hourly);
  manifest.hist = hist;
  writeManifestFile(manifest);
  console.log(`folded ${sourceBars} 1m bars from ${manifest.months.length} month(s)`);
  reportHourly(hist, straddles);
  console.log('round-trip: OK (hist:1h unpacked and compared exactly)');
}

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
  if (histOnly) {
    histOnlyRun();
    return;
  }

  const manifest = await loadDayManifest();
  console.log(`manifest: ${manifest.length} ${INSTRUMENT}/${RESOLUTION} trading days`);

  const byMonth = new Map<string, DayRow[]>();
  for (const day of manifest) {
    const month = day.trading_date.slice(0, 7);
    if (onlyMonths && !onlyMonths.has(month)) continue;
    const list = byMonth.get(month);
    if (list) list.push(day);
    else byMonth.set(month, [day]);
  }
  if (onlyMonths) {
    for (const m of onlyMonths) if (!byMonth.has(m)) throw new Error(`--months ${m}: no trading days in the manifest`);
  }
  const months = [...byMonth.keys()].sort();
  if (months.length === 0) throw new Error('no months selected');
  console.log(`processing ${months.length} month(s): ${months.join(', ')}`);
  if (onlyMonths) {
    console.warn(
      '\n!!! --months: the normalization shift is derived from the EARLIEST PACKED day,\n' +
        '!!! so this subset gets a different shift than a full run. The output is NOT\n' +
        '!!! canonical and MUST NOT be uploaded or committed. Rerun without --months.\n',
    );
  }

  mkdirSync(MONTH_DIR, { recursive: true });

  const failed: string[] = [];
  const monthsOut: MonthOut[] = [];
  let totalBars = 0;

  // Folded as the months stream past; `aggregate` builds fresh bars, so nothing
  // here keeps a month's 1m array alive past its iteration.
  const hourly: Bar[] = [];
  let histStraddles = 0;

  // Months are processed in ascending order, so the first month with usable
  // days carries the earliest packed day — the anchor for the whole dataset.
  let shift: number | null = null;

  // The dataset's newest month is still in progress (its last trading day can
  // be a partial session), so the sample prefers any earlier — complete —
  // month and only falls back to it when nothing else was processed.
  const newestMonth = manifest[manifest.length - 1]?.trading_date.slice(0, 7);
  let sampleRun: Array<{ date: string; bars: Bar[] }> | null = null;
  let sampleFallback: Array<{ date: string; bars: Bar[] }> | null = null;

  for (const month of months) {
    const rows = byMonth.get(month)!;
    const fetched = await mapPool(rows, FETCH_CONCURRENCY, async (row) => {
      try {
        return { date: row.trading_date, bars: await fetchDayBars(row), meta: row };
      } catch (e) {
        failed.push(`${row.trading_date}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    });
    const days = fetched.filter((d): d is NonNullable<typeof d> => d !== null && d.bars.length > 0);
    if (days.length === 0) {
      failed.push(`${month}: no usable days`);
      continue;
    }
    for (const d of days) inspectRawDay(d.date, d.bars, d.meta);

    if (shift === null) {
      const anchor = days[0];
      shift = globalShiftFrom(anchor.bars[0].o);
      console.log(`global shift ${shift} (anchor ${anchor.date} first open ${anchor.bars[0].o})`);
    }
    normalizeDays(days, shift);
    const bars = days.flatMap((d) => d.bars);
    const buf = pack(bars, TICK_SIZE);
    assertRoundTrip(month, bars, buf);
    writeFileSync(join(MONTH_DIR, `${month}.bin`), buf);
    totalBars += bars.length;
    histStraddles += foldMonthHourly(hourly, bars, month);

    monthsOut.push({
      month,
      key: `m:${month}`,
      byteSize: buf.length,
      days: days.map((d) => ({
        date: d.date,
        firstTs: d.bars[0].t,
        lastTs: d.bars[d.bars.length - 1].t,
        barCount: d.bars.length,
      })),
    });
    console.log(`  ${month}: ${days.length} days, ${bars.length} bars, ${(buf.length / 1024).toFixed(1)} KiB`);

    // Keep only the most recent viable sample run in memory; whole months are
    // dropped as soon as they are packed so a full-history run stays bounded.
    const run = pickSampleRun(days, sampleDaysWanted);
    if (run) {
      const kept = run.map((d) => ({ date: d.date, bars: d.bars }));
      if (month === newestMonth) sampleFallback = kept;
      else sampleRun = kept;
    }
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} day(s) FAILED:`);
    for (const f of failed) console.error(`  ${f}`);
    throw new Error('aborting: incomplete data — rerun (fetches are idempotent)');
  }

  const hist = writeHourly(hourly);
  const outManifest: OutManifest = { tickSize: TICK_SIZE, baseSec: BASE_SEC, months: monthsOut, hist };
  writeManifestFile(outManifest);

  const chosen = sampleRun ?? sampleFallback;
  if (!chosen) throw new Error(`no run of ${sampleDaysWanted} consecutive weekday trading days found`);
  const sample = writeSampleData(chosen);
  const fixtureChars = writeCodecFixture(chosen[0].bars);

  console.log(
    `\npacked ${monthsOut.length} month(s), ${totalBars} bars, ` +
      `${(monthsOut.reduce((s, m) => s + m.byteSize, 0) / 1048576).toFixed(2)} MiB total`,
  );
  console.log(
    `SampleData.luau: ${sample.bars} bars from ${chosen.length} day(s) ` +
      `(${chosen.map((d) => d.date).join(', ')}), ${sample.chars} chars`,
  );
  console.log(`tests/fixtures/Codec.json: ${fixtureChars} chars`);
  reportHourly(hist, histStraddles);
  console.log(
    `normalization: global shift ${shift}, post-shift range ${minLow} .. ${maxHigh} ` +
      `(${ticks(minLow, TICK_SIZE)} .. ${ticks(maxHigh, TICK_SIZE)} ticks, i32 limit ±2147483647)`,
  );
  console.log('round-trip: OK (every month + hist:1h + sample + fixture unpacked and compared exactly)');
  console.log(
    `data quality: off-grid raw prices ${quality.offGridPrices} across ${quality.offGridDays.size} day(s), ` +
      `max deviation ${quality.maxRawDevTicks.toExponential(3)} ticks` +
      `${quality.maxRawDevWhere ? ` (${quality.maxRawDevWhere})` : ''}; ` +
      `snapped by at most ${maxSnapTicks.toExponential(3)} ticks`,
  );
  console.log(
    `              out-of-order ${quality.outOfOrder}, duplicate ts ${quality.duplicateTs}, ` +
      `non-integer volume ${quality.nonIntegerVolume}, ` +
      `largest intra-day gap ${quality.maxGapMin} min${quality.maxGapWhere ? ` (${quality.maxGapWhere})` : ''}`,
  );
  for (const mm of quality.barCountMismatch.slice(0, 5)) console.log(`  bar_count mismatch: ${mm}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});

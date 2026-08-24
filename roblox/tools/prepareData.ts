// Phase 2 data pipeline: Supabase 1m day-chunks -> price-normalized, packed
// BarCodec-v1 month buffers under roblox/data-out/, ready for the Open Cloud
// DataStore upload (tools/uploadData.ts).
//
// Run: `npx tsx roblox/tools/prepareData.ts [--months 2025-04,2025-05,2025-06]
//       [--sample-days 3]` with cwd = repo root.
//
// roblox/src/shared/Data/BarCodec.luau is the SINGLE source of truth for the
// byte layout; pack()/unpack() here mirror it field for field and the generated
// tests/fixtures/Codec.json pins the two implementations byte-for-byte. Change
// one without the other and parity breaks by construction.
//
// Prices are rebased per calendar month (licensing hygiene, PORT_PLAN) — an
// undisclosed constant shift that preserves every bar's shape and every
// intra-month price relationship while destroying the absolute price identity.
// Timestamps and volume are untouched.
//
// Nothing here is a replay-clock read: this is an offline preprocessing tool
// operating on whole trading days, the same as scripts/ingest.mjs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { roundToTick } from '../../web/src/lib/trading/contractMath';
import type { Bar } from '../../web/src/lib/types';

const INSTRUMENT = 'NQ';
const RESOLUTION = '1m';
const TICK_SIZE = 0.25;
const BASE_SEC = 60;

// Every month's first open is rebased to this price. Arbitrary and undisclosed
// on purpose — see the licensing-hygiene row in PORT_PLAN.
const NORMALIZED_OPEN = 20_000;

// Script.Source caps at 200k chars; SampleData.luau is Rojo-mapped to a
// ModuleScript, so the base64 payload plus wrapper must stay under this.
const MAX_SAMPLE_CHARS = 190_000;

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

const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'roblox', 'tools', 'prepareData.ts'))) {
  throw new Error(`run from the repo root (cwd is ${ROOT})`);
}
const OUT_DIR = join(ROOT, 'roblox', 'data-out');
const MONTH_DIR = join(OUT_DIR, 'm');
const SAMPLE_PATH = join(ROOT, 'roblox', 'src', 'server', 'Data', 'SampleData.luau');
const CODEC_FIXTURE_PATH = join(ROOT, 'roblox', 'tests', 'fixtures', 'Codec.json');

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const monthsArg = argValue('--months');
const onlyMonths = monthsArg ? new Set(monthsArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
const sampleDaysWanted = Math.max(1, Number(argValue('--sample-days') ?? 3));

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

const envPath = join(ROOT, 'web', '.env.local');
if (!existsSync(envPath)) throw new Error(`missing ${envPath} (NEXT_PUBLIC_SUPABASE_URL / _KEY)`);
const env = loadEnvFile(envPath);
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = env.NEXT_PUBLIC_SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('web/.env.local must define NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_KEY');
}
const authHeaders = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

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
  const select = 'trading_date,storage_path,bar_count,first_ts,last_ts,checksum';
  const base =
    `${SUPABASE_URL}/rest/v1/dataset_days?select=${select}` +
    `&instrument_id=eq.${INSTRUMENT}&resolution=eq.${RESOLUTION}&order=trading_date.asc`;
  const days: DayRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetchRetry(
      base,
      { headers: { ...authHeaders, Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' } },
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
    `${SUPABASE_URL}/storage/v1/object/public/chunks/${day.storage_path}`,
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

// Rebase the whole calendar month by one constant so its first open lands on
// NORMALIZED_OPEN. One shift per month keeps every intra-month relationship
// (gaps, levels, ranges) intact; cross-month levels are deliberately broken.
function normalizeMonth(month: string, days: Array<{ date: string; bars: Bar[] }>): number {
  const first = days.find((d) => d.bars.length > 0);
  if (!first) throw new Error(`${month}: no bars`);
  const shift = roundToTick(first.bars[0].o - NORMALIZED_OPEN, TICK_SIZE);
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
      if (!Number.isInteger(b.v) || b.v < 0 || b.v > 0xffffffff) {
        throw new Error(`${day.date} t=${b.t}: volume ${b.v} does not fit u32`);
      }
      if (!Number.isInteger(b.t) || b.t < 0 || b.t > 0xffffffff) {
        throw new Error(`${day.date}: timestamp ${b.t} does not fit u32`);
      }
    }
  }
  return shift;
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
// cover the representation edges — normalization never pushes a modern NQ month
// negative — so the tail bars are constructed to exercise i32 sign, the u32
// volume range and the u32 timestamp range.
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

// ---------------------------------------------------------------------- main

async function main(): Promise<void> {
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

  mkdirSync(MONTH_DIR, { recursive: true });

  const failed: string[] = [];
  const monthsOut: Array<{ month: string; key: string; byteSize: number; days: DayOut[] }> = [];
  let totalBars = 0;

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

    const shift = normalizeMonth(month, days);
    const bars = days.flatMap((d) => d.bars);
    const buf = pack(bars, TICK_SIZE);
    assertRoundTrip(month, bars, buf);
    writeFileSync(join(MONTH_DIR, `${month}.bin`), buf);
    totalBars += bars.length;

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
    console.log(
      `  ${month}: ${days.length} days, ${bars.length} bars, ${(buf.length / 1024).toFixed(1)} KiB, shift ${shift}`,
    );

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

  const outManifest = { tickSize: TICK_SIZE, baseSec: BASE_SEC, months: monthsOut };
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(outManifest, null, 2), 'utf8');

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
  console.log('round-trip: OK (every month + sample + fixture unpacked and compared exactly)');
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

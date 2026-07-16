// Ingest NQ 1-minute CSV into Supabase Storage as gzipped columnar JSON day-chunks.
//
// CSV format: Date,Time,Open,High,Low,Close,Volume with timestamps in US/Eastern
// (verified: the 17:00-17:59 ET maintenance halt is absent from the data).
//
// Chunking: one file per CME trading day (18:00 ET -> 17:00 ET next day).
// A bar stamped >= 18:00 ET belongs to the NEXT calendar date's trading day.
//
// Resumable: days already present in dataset_days are skipped. Re-run freely.
//
// Usage: node scripts/ingest.mjs [path-to-csv]
//        node scripts/ingest.mjs [path-to-csv] --aggregates
//
// --aggregates builds ONE gzipped file of full-history HOURLY bars
// (NQ/1h/all.json.gz, ~1.5MB) so charts can show years of 1h/4h/1D history
// without loading millions of 1-minute bars. Buckets are aligned to the
// 18:00 ET trading-day open, matching the client's aggregate.ts.

import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://hvsmxueyhrtbwfcrqncb.supabase.co';
// Publishable (anon) key — public by design. Writes work only while the
// temporary ingest RLS policy exists on the chunks bucket.
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? 'sb_publishable_GFAjoK3lOJlxOBZe_kPuow_HxrKDZ0k';
const args = process.argv.slice(2);
const CSV_PATH = args.find((a) => !a.startsWith('--')) ?? 'NQ_1min.csv';
const AGGREGATES_MODE = args.includes('--aggregates');
const FORCE = args.includes('--force'); // re-upload days even if already ingested
const INSTRUMENT = 'NQ';
const RESOLUTION = '1m';
const SCHEMA_VERSION = 1;
const UPLOAD_CONCURRENCY = 6;
const META_BATCH = 50;

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

// ---------- price sanitizing ----------
// The source CSV has one week (2012-02-05 18:00 .. 2012-02-10) where the
// vendor dropped the decimal point: 2519.75 was written as 251975.0. No NQ
// price in (or anywhere near) this dataset's era legitimately reaches 50,000,
// so any such row is scaled back by 100.
let scaledRows = 0;
function sanitizePrices(o, h, l, c) {
  if (h >= 50000) {
    scaledRows++;
    return [o / 100, h / 100, l / 100, c / 100];
  }
  return [o, h, l, c];
}

// ---------- ET -> UTC conversion (DST-safe) ----------
// The UTC offset of America/New_York is constant within any single calendar
// date *during market hours*: DST transitions happen Sundays at 2:00 AM ET,
// when the market is closed (Fri 17:00 close -> Sun 18:00 open). So we can
// compute the offset once per calendar date (probed at noon) and cache it.

const etProbe = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

const offsetCache = new Map(); // 'YYYY-MM-DD' -> offset ms (UTC = ET wall + offset)

function etOffsetMs(dateStr) {
  let off = offsetCache.get(dateStr);
  if (off !== undefined) return off;
  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  // Iteratively find the instant whose ET wall clock reads noon on dateStr.
  const wantWall = Date.UTC(y, mo - 1, d, 12, 0, 0);
  let guess = wantWall;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(etProbe.formatToParts(guess).map(x => [x.type, x.value]));
    const shownWall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    guess += wantWall - shownWall;
  }
  off = guess - wantWall; // e.g. +5h in winter (EST), +4h in summer (EDT)
  offsetCache.set(dateStr, off);
  return off;
}

function nextDate(dateStr) {
  const t = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function prevDate(dateStr) {
  const t = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) - 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

// Epoch of the 18:00 ET open of a trading day. The open falls on the calendar
// day BEFORE the trading date.
const dayStartCache = new Map();
function tradingDayStartEpoch(tradingDate) {
  let e = dayStartCache.get(tradingDate);
  if (e === undefined) {
    const openDate = prevDate(tradingDate);
    const wall = Date.UTC(+openDate.slice(0, 4), +openDate.slice(5, 7) - 1, +openDate.slice(8, 10), 18);
    e = (wall + etOffsetMs(openDate)) / 1000;
    dayStartCache.set(tradingDate, e);
  }
  return e;
}

// ---------- Supabase helpers ----------

async function fetchExistingDays() {
  const days = new Set();
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/dataset_days?select=trading_date&instrument_id=eq.${INSTRUMENT}&resolution=eq.${RESOLUTION}`,
      { headers: { ...headers, Range: `${from}-${from + 999}` } },
    );
    if (!res.ok) throw new Error(`fetch existing days: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    for (const r of rows) days.add(r.trading_date);
    if (rows.length < 1000) break;
  }
  return days;
}

async function uploadChunk(path, gz) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/chunks/${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/gzip', 'x-upsert': 'true' },
    body: gz,
  });
  if (!res.ok) throw new Error(`upload ${path}: ${res.status} ${await res.text()}`);
}

async function upsertMeta(rows) {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/dataset_days`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`upsert meta: ${res.status} ${await res.text()}`);
}

// ---------- concurrency pool ----------

const inFlight = new Set();
async function pooled(fn) {
  while (inFlight.size >= UPLOAD_CONCURRENCY) await Promise.race(inFlight);
  const p = fn().finally(() => inFlight.delete(p));
  inFlight.add(p);
  return p;
}

// ---------- contract-roll back-adjustment (Tradovate NQ1!-style) ----------
// The vendor splices the front-month contract at 00:00 UTC on each quarterly
// roll date, leaving the raw calendar spread as an artificial price jump
// (up to +277 pts in 2024). Detection: within each quarterly roll window
// (days 5-20 of Mar/Jun/Sep/Dec), find the largest jump between CONSECUTIVE
// bars (<= 5 min apart) that cross a 00:00 UTC boundary — organic moves at
// that hour are tiny, and this signature appears exactly once per quarter.
// Adjustment: difference back-adjustment — all bars BEFORE a splice are
// shifted by that splice's gap (cumulative), so the latest contract's prices
// stay real and every seam disappears. Point distances within a session are
// unaffected. NOTE: appending new data after a future roll requires a full
// re-ingest (the whole history re-shifts) — inherent to back-adjustment.

async function detectRolls() {
  const rl = readline.createInterface({ input: fs.createReadStream(CSV_PATH), crlfDelay: Infinity });
  let hdr = true;
  let prev = null;
  const byQuarter = new Map();
  for await (const line of rl) {
    if (hdr) { hdr = false; continue; }
    if (!line) continue;
    const p = line.split(',');
    if (p.length !== 7) continue;
    let close = +p[5], open = +p[2];
    if (+p[3] >= 50000) { close /= 100; open /= 100; }
    const wallMs = Date.UTC(
      +p[0].slice(0, 4), +p[0].slice(5, 7) - 1, +p[0].slice(8, 10),
      +p[1].slice(0, 2), +p[1].slice(3, 5), +p[1].slice(6, 8),
    );
    const ts = (wallMs + etOffsetMs(p[0])) / 1000;
    if (prev && ts - prev.ts <= 300 && Math.floor(ts / 86400) !== Math.floor(prev.ts / 86400)) {
      const m = +p[0].slice(5, 7), d = +p[0].slice(8, 10);
      if ([3, 6, 9, 12].includes(m) && d >= 5 && d <= 20) {
        const q = p[0].slice(0, 7);
        const jump = open - prev.close;
        const cur = byQuarter.get(q);
        if (!cur || Math.abs(jump) > Math.abs(cur.gap)) byQuarter.set(q, { ts, gap: jump, date: p[0], time: p[1] });
      }
    }
    prev = { close, ts };
  }
  const rolls = [...byQuarter.values()].sort((a, b) => a.ts - b.ts);
  console.log(`Detected ${rolls.length} contract rolls; largest gap ${Math.max(...rolls.map(r => Math.abs(r.gap))).toFixed(2)} pts.`);
  return rolls;
}

// Streaming offset applier: bars arrive chronologically; offset = sum of gaps
// of all rolls strictly AFTER the bar's timestamp.
function makeRollAdjuster(rolls) {
  const suffix = new Array(rolls.length + 1).fill(0);
  for (let i = rolls.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + rolls[i].gap;
  let idx = 0;
  return (ts) => {
    while (idx < rolls.length && ts >= rolls[idx].ts) idx++;
    return suffix[idx];
  };
}

// ---------- aggregates mode ----------

if (AGGREGATES_MODE) {
  const rollOffset = makeRollAdjuster(await detectRolls());
  const t = [], o = [], h = [], l = [], c = [], v = [];
  let bt = -1; // current hourly bucket start
  let last = 0;
  const rl2 = readline.createInterface({ input: fs.createReadStream(CSV_PATH), crlfDelay: Infinity });
  let hdr = true;
  for await (const line of rl2) {
    if (hdr) { hdr = false; continue; }
    if (!line) continue;
    const p = line.split(',');
    if (p.length !== 7) continue;
    const [dateStr, timeStr, po, ph, pl, pc, pv] = p;
    const hour = +timeStr.slice(0, 2);
    const tradingDate = hour >= 18 ? nextDate(dateStr) : dateStr;
    const wallMs = Date.UTC(
      +dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10),
      hour, +timeStr.slice(3, 5), +timeStr.slice(6, 8),
    );
    const ts = (wallMs + etOffsetMs(dateStr)) / 1000;
    if (ts <= last) continue;
    last = ts;
    const adj = rollOffset(ts);
    const [so, sh, sl, sc] = sanitizePrices(+po, +ph, +pl, +pc).map((x) => Math.round((x + adj) * 4) / 4);
    const dayStart = tradingDayStartEpoch(tradingDate);
    const bucket = ts - ((ts - dayStart) % 3600);
    if (bucket !== bt) {
      bt = bucket;
      t.push(bucket); o.push(so); h.push(sh); l.push(sl); c.push(sc); v.push(+pv);
    } else {
      const i = t.length - 1;
      h[i] = Math.max(h[i], sh);
      l[i] = Math.min(l[i], sl);
      c[i] = sc;
      v[i] += +pv;
    }
  }
  const payload = { instrument: INSTRUMENT, resolution: '1h', schemaVersion: SCHEMA_VERSION, t, o, h, l, c, v };
  const gz = zlib.gzipSync(JSON.stringify(payload), { level: 6 });
  await uploadChunk(`${INSTRUMENT}/1h/all.json.gz`, gz);
  console.log(`Aggregates uploaded: ${t.length} hourly bars, ${(gz.length / 1048576).toFixed(2)} MB gzipped. ${scaledRows} rows rescaled /100.`);
  process.exit(0);
}

// ---------- main ----------

const rollOffset = makeRollAdjuster(await detectRolls());
const existing = FORCE ? new Set() : await fetchExistingDays();
console.log(`${existing.size} trading days already ingested; resuming${FORCE ? ' (FORCED full re-upload)' : ''}.`);

let cur = null; // { tradingDate, t, o, h, l, c, v }
let pendingMeta = [];
let done = 0, skipped = 0, badLines = 0, lastTs = 0;
const failures = [];

async function flushDay(day) {
  if (existing.has(day.tradingDate)) { skipped++; return; }
  const payload = {
    instrument: INSTRUMENT, tradingDate: day.tradingDate, resolution: RESOLUTION,
    schemaVersion: SCHEMA_VERSION, t: day.t, o: day.o, h: day.h, l: day.l, c: day.c, v: day.v,
  };
  const gz = zlib.gzipSync(JSON.stringify(payload), { level: 6 });
  const path = `${INSTRUMENT}/${RESOLUTION}/${day.tradingDate}.json.gz`;
  const meta = {
    instrument_id: INSTRUMENT, trading_date: day.tradingDate, resolution: RESOLUTION,
    bar_count: day.t.length,
    first_ts: new Date(day.t[0] * 1000).toISOString(),
    last_ts: new Date(day.t[day.t.length - 1] * 1000).toISOString(),
    storage_path: path, byte_size: gz.length,
    checksum: crypto.createHash('md5').update(gz).digest('hex'),
  };
  await pooled(async () => {
    try {
      await uploadChunk(path, gz);
      pendingMeta.push(meta);
      if (pendingMeta.length >= META_BATCH) {
        const batch = pendingMeta; pendingMeta = [];
        await upsertMeta(batch);
      }
      done++;
      if (done % 100 === 0) console.log(`uploaded ${done} days (latest: ${day.tradingDate})`);
    } catch (e) {
      failures.push(day.tradingDate);
      console.error(String(e));
    }
  });
}

const rl = readline.createInterface({ input: fs.createReadStream(CSV_PATH), crlfDelay: Infinity });
let isHeader = true;

for await (const line of rl) {
  if (isHeader) { isHeader = false; continue; }
  if (!line) continue;
  const parts = line.split(',');
  if (parts.length !== 7) { badLines++; continue; }
  const [dateStr, timeStr, o, h, l, c, v] = parts;
  const hour = +timeStr.slice(0, 2);
  const tradingDate = hour >= 18 ? nextDate(dateStr) : dateStr;
  const wallMs = Date.UTC(
    +dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10),
    hour, +timeStr.slice(3, 5), +timeStr.slice(6, 8),
  );
  const ts = (wallMs + etOffsetMs(dateStr)) / 1000;
  if (ts <= lastTs) { badLines++; continue; } // enforce strictly increasing time
  lastTs = ts;

  if (!cur || cur.tradingDate !== tradingDate) {
    if (cur) await flushDay(cur);
    cur = { tradingDate, t: [], o: [], h: [], l: [], c: [], v: [] };
  }
  const adj = rollOffset(ts);
  const [so, sh, sl, sc] = sanitizePrices(+o, +h, +l, +c).map((x) => Math.round((x + adj) * 4) / 4);
  cur.t.push(ts); cur.o.push(so); cur.h.push(sh); cur.l.push(sl); cur.c.push(sc); cur.v.push(+v);
}
if (cur) await flushDay(cur);
await Promise.all(inFlight);
await upsertMeta(pendingMeta);

console.log(`\nIngest complete: ${done} uploaded, ${skipped} skipped (already present), ${badLines} bad/out-of-order lines, ${scaledRows} rows rescaled /100.`);
if (failures.length) {
  console.log(`FAILED days (${failures.length}) — re-run to retry: ${failures.slice(0, 20).join(', ')}${failures.length > 20 ? ' …' : ''}`);
  process.exitCode = 1;
}

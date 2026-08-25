// Uploads the packed month buffers and the deep 1h history from
// roblox/data-out/ into the experience's standard DataStore via Open Cloud.
//
// Run: `npx tsx roblox/tools/uploadData.ts --universe <universeId> [--dry-run]`
// with cwd = repo root. Requires ROBLOX_OPENCLOUD_KEY in the environment — see
// roblox/tools/DATA.md for the one-time API-key setup.
//
// Open Cloud entry values are JSON, so the binary month chunks travel as base64
// strings; the game decodes them with EncodingService before handing the bytes
// to BarCodec. The "manifest" key is a plain JSON object (day index), the only
// value the server needs before it knows which month to fetch.
//
// Rate: standard DataStore writes are throttled to ~1 per 500 ms here, well
// under Open Cloud's per-key and per-universe limits, so a full-history upload
// of ~190 month keys plus `hist:1h` takes ~2 minutes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATASTORE_NAME = 'bars_v1';
const MANIFEST_KEY = 'manifest';
const WRITE_INTERVAL_MS = 500;
// DataStore hard limit per key; base64 inflates the packed bytes by 4/3.
const MAX_VALUE_BYTES = 4 * 1024 * 1024;

const MAGIC = 0x4b42514e;
const VERSION = 1;

interface MonthMeta {
  month: string;
  key: string;
  byteSize: number;
  days: Array<{ date: string; firstTs: number; lastTs: number; barCount: number }>;
}

interface HistMeta {
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
  months: MonthMeta[];
  hist?: HistMeta;
}

const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'roblox', 'tools', 'uploadData.ts'))) {
  throw new Error(`run from the repo root (cwd is ${ROOT})`);
}
const OUT_DIR = join(ROOT, 'roblox', 'data-out');
const MONTH_DIR = join(OUT_DIR, 'm');
const HIST_DIR = join(OUT_DIR, 'hist');

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const DRY_RUN = process.argv.includes('--dry-run');
const universeId = argValue('--universe');
if (!universeId || !/^\d+$/.test(universeId)) {
  throw new Error('usage: npx tsx roblox/tools/uploadData.ts --universe <universeId> [--dry-run]');
}

const apiKey = process.env.ROBLOX_OPENCLOUD_KEY ?? '';
if (!apiKey && !DRY_RUN) {
  throw new Error(
    'ROBLOX_OPENCLOUD_KEY is not set.\n' +
      '  Create an API key at https://create.roblox.com/dashboard/credentials with the\n' +
      '  universe-datastores.objects: read+write scope for this universe, then:\n' +
      '    PowerShell:  $env:ROBLOX_OPENCLOUD_KEY = "<key>"\n' +
      '    bash:        export ROBLOX_OPENCLOUD_KEY="<key>"\n' +
      '  See roblox/tools/DATA.md.',
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function entryUrl(entryKey: string): string {
  return (
    `https://apis.roblox.com/datastores/v1/universes/${universeId}/standard-datastores/datastore/entries/entry` +
    `?datastoreName=${encodeURIComponent(DATASTORE_NAME)}&entryKey=${encodeURIComponent(entryKey)}`
  );
}

// content-md5 is REQUIRED by the standard-datastores entry endpoint: base64 of
// the raw MD5 digest of the exact request body bytes.
async function setEntry(entryKey: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.length > MAX_VALUE_BYTES) {
    throw new Error(`${entryKey}: value is ${bytes.length} bytes, over the ${MAX_VALUE_BYTES} DataStore limit`);
  }
  const res = await fetch(entryUrl(entryKey), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'content-md5': createHash('md5').update(bytes).digest('base64'),
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`${entryKey}: ${res.status} ${res.statusText} — ${await res.text()}`);
}

function readManifest(): OutManifest {
  const path = join(OUT_DIR, 'manifest.json');
  if (!existsSync(path)) throw new Error(`missing ${path} — run tools/prepareData.ts first`);
  return JSON.parse(readFileSync(path, 'utf8')) as OutManifest;
}

async function main(): Promise<void> {
  const manifest = readManifest();
  const files = existsSync(MONTH_DIR)
    ? readdirSync(MONTH_DIR).filter((f) => f.endsWith('.bin')).sort()
    : [];
  if (files.length === 0) throw new Error(`no .bin files in ${MONTH_DIR} — run tools/prepareData.ts first`);

  // Cross-check both directions: a manifest month with no file would leave a
  // dangling day index in game, and a stray .bin from an earlier partial run
  // would upload a month the manifest never mentions.
  const byMonth = new Map(manifest.months.map((m) => [m.month, m]));
  const onDisk = new Set(files.map((f) => f.replace(/\.bin$/, '')));
  const missing = manifest.months.filter((m) => !onDisk.has(m.month)).map((m) => m.month);
  if (missing.length > 0) throw new Error(`manifest lists months with no .bin: ${missing.join(', ')}`);
  const stray = files.map((f) => f.replace(/\.bin$/, '')).filter((m) => !byMonth.has(m));
  if (stray.length > 0) {
    console.warn(`WARNING: ${stray.length} .bin file(s) not in manifest.json, skipping: ${stray.join(', ')}`);
  }

  const plan: Array<{ key: string; file: string; b64: number; bars: number }> = [];

  const readChunk = (path: string, label: string, byteSize: number): Buffer => {
    const buf = readFileSync(path);
    if (buf.readUInt32LE(0) !== MAGIC || buf.readUInt8(4) !== VERSION) {
      throw new Error(`${label}: not a BarCodec v1 chunk`);
    }
    if (buf.length !== byteSize) {
      throw new Error(`${label}: ${buf.length} bytes, manifest says ${byteSize} — regenerate`);
    }
    return buf;
  };

  for (const meta of manifest.months) {
    const file = `${meta.month}.bin`;
    const buf = readChunk(join(MONTH_DIR, file), file, meta.byteSize);
    const b64 = buf.toString('base64');
    plan.push({ key: meta.key, file, b64: b64.length, bars: buf.readUInt32LE(8) });
    if (!DRY_RUN) {
      await setEntry(meta.key, b64);
      await sleep(WRITE_INTERVAL_MS);
    }
  }

  // The deep 1h history (META_PLAN §4). ~3 MB base64 against a 4 MB/min per-key
  // write ceiling, so it is written exactly once per run — never rewrite this
  // key inside a minute.
  if (manifest.hist) {
    const hist = manifest.hist;
    const buf = readChunk(join(HIST_DIR, hist.file), hist.file, hist.byteSize);
    if (buf.readUInt32LE(8) !== hist.barCount) {
      throw new Error(`${hist.file}: ${buf.readUInt32LE(8)} bars, manifest says ${hist.barCount} — regenerate`);
    }
    const b64 = buf.toString('base64');
    plan.push({ key: hist.key, file: hist.file, b64: b64.length, bars: hist.barCount });
    if (!DRY_RUN) {
      await setEntry(hist.key, b64);
      await sleep(WRITE_INTERVAL_MS);
    }
  } else {
    console.warn('WARNING: manifest.json has no `hist` entry — deep history will be absent in game');
  }

  if (!DRY_RUN) await setEntry(MANIFEST_KEY, manifest);

  const label = DRY_RUN ? 'PLAN (dry run, nothing written)' : 'WROTE';
  console.log(`${label} — universe ${universeId}, DataStore "${DATASTORE_NAME}"`);
  for (const p of plan) {
    console.log(`  ${p.key.padEnd(12)} <- ${p.file.padEnd(14)} ${p.bars} bars, ${(p.b64 / 1024).toFixed(1)} KiB base64`);
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');
  console.log(`  ${MANIFEST_KEY.padEnd(12)} <- manifest.json  ${manifest.months.length} months, ${manifestBytes} bytes`);
  console.log(
    `${plan.length + 1} key(s), ${(plan.reduce((s, p) => s + p.b64, 0) / 1048576).toFixed(2)} MiB base64 total` +
      `${DRY_RUN ? '' : `, ~${(((plan.length * WRITE_INTERVAL_MS) / 1000) | 0)}s of throttled writes`}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});

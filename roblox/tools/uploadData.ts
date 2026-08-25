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
// The uploaded manifest is NOT the on-disk manifest.json verbatim: the game's
// BarStore.coerceDays wants ONE flat `days` array, while the disk shape nests
// days under `months` for this tool's own cross-checks. See flattenManifest.
//
// Every artifact carries the normalization scheme it was produced under. Mixing
// two schemes in one DataStore is undetectable in game — every month would sit
// in a different price frame — so an unmarked manifest is refused outright.
//
// Rate: standard DataStore writes are throttled to ~1 per 500 ms here, well
// under Open Cloud's per-key and per-universe limits, so a full-history upload
// of ~190 month keys plus `hist:1h` takes ~2 minutes.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DATASTORE_NAME = 'bars_v1';
const MANIFEST_KEY = 'manifest';
// Must match prepareData.ts's SCHEME. Bumping the normalization scheme means
// bumping this and re-uploading EVERY key, never just the changed ones.
const EXPECTED_SCHEME = 'global-offset-v1';
const WRITE_INTERVAL_MS = 500;
// DataStore hard limit per key; base64 inflates the packed bytes by 4/3.
const MAX_VALUE_BYTES = 4 * 1024 * 1024;

const MAGIC = 0x4b42514e;
const VERSION = 1;

interface MonthMeta {
  month: string;
  key: string;
  byteSize: number;
  days: DayMeta[];
}

interface HistMeta {
  key: string;
  file: string;
  barCount: number;
  byteSize: number;
  firstTs: number;
  lastTs: number;
}

interface DayMeta {
  date: string;
  firstTs: number;
  lastTs: number;
  barCount: number;
}

interface OutManifest {
  scheme?: string;
  tickSize: number;
  baseSec: number;
  months: MonthMeta[];
  hist?: HistMeta;
}

// What the `manifest` KEY holds — BarStore reads `days` and nothing else.
interface UploadManifest {
  scheme?: string;
  tickSize: number;
  baseSec: number;
  days: DayMeta[];
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
const FORCE_SCHEME = process.argv.includes('--force-scheme');
const universeId = argValue('--universe');
if (!universeId || !/^\d+$/.test(universeId)) {
  throw new Error(
    'usage: npx tsx roblox/tools/uploadData.ts --universe <universeId> [--dry-run] [--force-scheme]',
  );
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

// BarStore.coerceDays consumes ONE flat `days` array; the disk manifest nests
// days under `months` because this tool cross-checks per month. Uploading the
// disk shape verbatim yields zero days in game — the server then falls back to
// the bundled SampleData chunk and looks like it merely lost its DataStore.
//
// tickSize/baseSec/hist are not read out of this key today; they are cheap and
// they keep the uploaded value self-describing.
function flattenManifest(manifest: OutManifest): UploadManifest {
  const days = manifest.months.flatMap((m) => m.days).sort((a, b) => a.date.localeCompare(b.date));
  const value: UploadManifest = {
    scheme: manifest.scheme,
    tickSize: manifest.tickSize,
    baseSec: manifest.baseSec,
    days,
  };
  if (manifest.hist) value.hist = manifest.hist;
  return value;
}

async function main(): Promise<void> {
  const manifest = readManifest();

  // The DataStore holds one price frame. An unmarked manifest is either
  // pre-marker output or per-month-rebased output, and neither can be told from
  // globally-shifted output by looking at the bars, so it never goes up by
  // accident. --force-scheme exists for the one legitimate case: an operator who
  // has just wiped the store and knows what these bytes are.
  if (manifest.scheme !== EXPECTED_SCHEME) {
    const found = manifest.scheme === undefined ? 'absent' : `"${manifest.scheme}"`;
    if (!FORCE_SCHEME) {
      throw new Error(
        `manifest.json scheme is ${found}, expected "${EXPECTED_SCHEME}" — these artifacts may be in a\n` +
          '  different price frame than what is already in the DataStore, and nothing in game could tell.\n' +
          '  Rerun a FULL `npx tsx roblox/tools/prepareData.ts`, or pass --force-scheme if you are\n' +
          '  deliberately replacing the whole store.',
      );
    }
    console.warn(`WARNING: --force-scheme — uploading artifacts whose scheme is ${found}`);
  }

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

  // Same check for data-out/hist/. A leftover 1h.bin from a superseded run is
  // the more dangerous stray of the two — it is the one key the whole deep chart
  // reads, so an unnoticed file here is a whole multi-year history in the wrong
  // frame sitting next to the right one.
  const histFiles = existsSync(HIST_DIR) ? readdirSync(HIST_DIR).filter((f) => f.endsWith('.bin')).sort() : [];
  if (manifest.hist && !histFiles.includes(manifest.hist.file)) {
    throw new Error(`manifest lists hist file ${manifest.hist.file} with no .bin in ${HIST_DIR}`);
  }
  const histStray = histFiles.filter((f) => f !== manifest.hist?.file);
  if (histStray.length > 0) {
    console.warn(
      `WARNING: ${histStray.length} .bin file(s) in ${HIST_DIR} not in manifest.json, skipping: ${histStray.join(', ')}`,
    );
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

  const uploadManifest = flattenManifest(manifest);
  if (!DRY_RUN) await setEntry(MANIFEST_KEY, uploadManifest);

  const label = DRY_RUN ? 'PLAN (dry run, nothing written)' : 'WROTE';
  console.log(`${label} — universe ${universeId}, DataStore "${DATASTORE_NAME}"`);
  for (const p of plan) {
    console.log(`  ${p.key.padEnd(12)} <- ${p.file.padEnd(14)} ${p.bars} bars, ${(p.b64 / 1024).toFixed(1)} KiB base64`);
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(uploadManifest), 'utf8');
  console.log(
    `  ${MANIFEST_KEY.padEnd(12)} <- manifest.json  ${uploadManifest.days.length} days flattened from ` +
      `${manifest.months.length} months, scheme ${uploadManifest.scheme ?? 'absent'}, ${manifestBytes} bytes`,
  );
  console.log(
    `${plan.length + 1} key(s), ${(plan.reduce((s, p) => s + p.b64, 0) / 1048576).toFixed(2)} MiB base64 total` +
      `${DRY_RUN ? '' : `, ~${(((plan.length * WRITE_INTERVAL_MS) / 1000) | 0)}s of throttled writes`}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exitCode = 1;
});

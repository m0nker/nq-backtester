// Validate served chunk data: strict time ordering, no dupes, no NaN, sane
// prices, and monotonicity of client-style 15s/1m aggregation.
// Usage: node scripts/validate_chunks.mjs

const URL_BASE = 'https://hvsmxueyhrtbwfcrqncb.supabase.co';
const KEY = 'sb_publishable_GFAjoK3lOJlxOBZe_kPuow_HxrKDZ0k';

async function manifest(instrument, resolution) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${URL_BASE}/rest/v1/dataset_days?select=trading_date,storage_path,bar_count&instrument_id=eq.${instrument}&resolution=eq.${resolution}&order=trading_date`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` } },
    );
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

async function chunk(path) {
  const res = await fetch(`${URL_BASE}/storage/v1/object/public/chunks/${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).json();
}

function validate(name, f, expectDur) {
  const n = f.t.length;
  const problems = [];
  for (let i = 0; i < n; i++) {
    const t = f.t[i], o = f.o[i], h = f.h[i], l = f.l[i], c = f.c[i], v = f.v[i];
    if (i > 0 && t <= f.t[i - 1]) problems.push(`order @${i}: ${f.t[i - 1]} -> ${t}`);
    if (![o, h, l, c].every(Number.isFinite)) problems.push(`NaN @${i}`);
    if (h < l || h < o || h < c || l > o || l > c) problems.push(`OHLC bad @${i}: ${o},${h},${l},${c}`);
    if (o < 100 || o > 60000) problems.push(`price range @${i}: ${o}`);
    if (!Number.isInteger(v) || v < 0) problems.push(`vol @${i}: ${v}`);
    if (t % expectDur !== 0 && expectDur === 60) problems.push(`misaligned t @${i}: ${t}`);
    if (problems.length > 5) break;
  }
  if (problems.length) console.log(`  BAD ${name}: ${problems.slice(0, 5).join(' | ')}`);
  return problems.length === 0;
}

function checkAggMonotonic(name, f, bucketSec) {
  // mimic client aggregation bucket starts (UTC-mod is fine for sub-hour buckets)
  let last = -1;
  for (let i = 0; i < f.t.length; i++) {
    const b = f.t[i] - (f.t[i] % bucketSec);
    if (b < last) {
      console.log(`  BAD ${name}: ${bucketSec}s bucket goes backward @${i} (${last} -> ${b})`);
      return false;
    }
    last = Math.max(last, b);
  }
  return true;
}

const samples = [
  ['NQ', '1m', ['2026-03-10', '2026-07-13', '2025-03-17', '2025-12-15', '2024-03-12']],
  ['NQ', '1s', ['2026-03-10', '2026-07-13', '2025-03-17', '2025-12-15']],
  ['ES', '1m', ['2026-03-10', '2026-07-13', '2025-06-02', '2020-03-12']],
  ['ES', '1s', ['2026-03-10', '2026-07-13', '2025-06-02']],
];

let allOk = true;
for (const [inst, res, days] of samples) {
  const man = await manifest(inst, res);
  const byDate = new Map(man.map((r) => [r.trading_date, r]));
  console.log(`${inst}/${res}: ${man.length} days in manifest`);
  for (const d of days) {
    const meta = byDate.get(d);
    if (!meta) {
      console.log(`  MISSING day ${d}`);
      allOk = false;
      continue;
    }
    const f = await chunk(meta.storage_path);
    const dur = res === '1m' ? 60 : 1;
    const ok = validate(`${inst}/${res}/${d}`, f, dur);
    const aggOk =
      res === '1s'
        ? checkAggMonotonic(`${inst}/1s/${d}`, f, 15) && checkAggMonotonic(`${inst}/1s/${d}`, f, 30)
        : true;
    if (ok && aggOk) console.log(`  ok ${d} (${f.t.length} bars)`);
    allOk = allOk && ok && aggOk;
  }
}
console.log(allOk ? 'ALL OK' : 'PROBLEMS FOUND');

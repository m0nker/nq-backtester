# Data pipeline runbook (Phase 2)

Supabase 1m day-chunks → normalized, packed month buffers → Open Cloud
DataStore. Run everything from the **repo root**.

## The three commands

```sh
# 1. dev slice — a few months, fast, proves the pipeline end to end
npx tsx roblox/tools/prepareData.ts --months 2026-05,2026-06,2026-07 --sample-days 3

# 2. full history — every month in the dataset (~4150 trading days)
npx tsx roblox/tools/prepareData.ts

# 3. upload (dry run first, ALWAYS)
npx tsx roblox/tools/uploadData.ts --universe <universeId> --dry-run
npx tsx roblox/tools/uploadData.ts --universe <universeId>
```

## What gets produced

| Path | Content | Committed? |
|---|---|---|
| `roblox/data-out/m/YYYY-MM.bin` | one BarCodec v1 chunk per calendar month | no (gitignored) |
| `roblox/data-out/manifest.json` | `{ tickSize, baseSec, months:[{ month, key, byteSize, days:[{ date, firstTs, lastTs, barCount }] }] }` | no (gitignored) |
| `roblox/src/server/Data/SampleData.luau` | 3 consecutive weekday trading days, base64, for Studio/offline runs | yes |
| `roblox/tests/fixtures/Codec.json` | ~8 bars + their exact packed bytes — pins the TS packer to `BarCodec.luau` | yes |

`prepareData.ts` reads `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_KEY`
straight out of `web/.env.local` (hand-parsed, no dotenv dependency). It fetches
the same day set the web app sees — `dataset_days` filtered to
`instrument_id=NQ`, `resolution=1m`, ordered by `trading_date`, paged 1000 —
then pulls each day's gzipped columnar chunk from the public `chunks` bucket
(≤6 concurrent, 3 attempts with backoff, and it aborts listing every failed day
rather than shipping a hole).

Every packed month is immediately unpacked again and compared field-for-field
against the pre-pack bars. Zero tolerance: any mismatch aborts the run.

## Normalization

Licensing hygiene (see `PORT_PLAN.md`): the game must never ship recognizable
CME price levels. Per **calendar month of trading dates**:

```
shift = roundToTick(firstOpenOfMonth - 20000, 0.25)
o,h,l,c -= shift          # timestamps and volume untouched
```

Each month therefore opens at 20000. One constant shift per month preserves
every intra-month relationship — ranges, gaps, swing structure, level retests —
while destroying the absolute price identity and any cross-month continuity.

Prices are snapped back onto the 0.25 grid after the shift. Some source chunks
carry float dust from the roll adjustment (observed max ~1.5e-11 ticks); the
packed form is integer tick counts regardless, and the snap is bounded at 1e-6
ticks so a genuinely off-grid price would still abort the run.

Tick counts are **i32**, not u32 — a month whose data sits far below its rebase
anchor can go negative, and the Codec fixture pins that case.

## One-time Open Cloud setup (user action)

`uploadData.ts` cannot run until this exists — no key is provisioned yet.

1. Publish the place so the experience has a **universe ID** (Creator Dashboard
   → the experience → the number in its URL).
2. Creator Dashboard → **Credentials** → **API Keys** → *Create API Key*.
   - System: **Universe Datastores API** (`universe-datastores`).
   - Add the backtester experience to that system's universe list.
   - Operations: `universe-datastores.objects:read` **and**
     `universe-datastores.objects:write`.
   - IP allowlist: `0.0.0.0/0` is fine for a hobby key, or pin your own IP.
3. Export the secret as `ROBLOX_OPENCLOUD_KEY`:

   ```powershell
   $env:ROBLOX_OPENCLOUD_KEY = "<key>"     # PowerShell, current session only
   ```
   ```sh
   export ROBLOX_OPENCLOUD_KEY="<key>"     # bash
   ```

   Never commit it; `web/.env.local` and shell env are the only homes.

## Upload shape

DataStore `bars_v1`, standard (not ordered):

- `m:YYYY-MM` → the `.bin` as a **base64 string** (Open Cloud values are JSON,
  so binary travels as text; the server decodes with `EncodingService` and
  hands the buffer to `BarCodec.decode`).
- `manifest` → the `manifest.json` object verbatim, the day index the server
  reads before it knows which month key to fetch.

Writes go to the `standard-datastores/.../entries/entry` endpoint with the
required `content-md5` header, throttled to one per 500 ms. A full-history
upload is ~190 month keys, roughly two minutes. Each key stays well under the
4 MB DataStore limit (a 22-day month is ~950 KiB base64); `uploadData.ts`
refuses any value that would exceed it, and cross-checks `manifest.json`
against the files on disk in both directions before writing anything.

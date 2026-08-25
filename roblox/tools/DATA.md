# Data pipeline runbook (Phase 2)

Supabase 1m day-chunks → normalized, packed month buffers → Open Cloud
DataStore. Run everything from the **repo root**.

## The three commands

```sh
# 1. dev slice — a few months, fast, proves the pipeline end to end.
#    NOT canonical: the normalization shift is derived from the subset. See below.
npx tsx roblox/tools/prepareData.ts --months 2026-05,2026-06,2026-07 --sample-days 3

# 2. full history — every month in the dataset (~4150 trading days).
#    The only run whose output may be uploaded or committed.
npx tsx roblox/tools/prepareData.ts

# 3. upload (dry run first, ALWAYS)
npx tsx roblox/tools/uploadData.ts --universe <universeId> --dry-run
npx tsx roblox/tools/uploadData.ts --universe <universeId>
```

A fourth, narrow one: `--hist-only` rebuilds just the deep 1h history from the
month buffers already in `data-out/m/`. No Supabase round trip, no credentials,
months and `SampleData.luau` / `Codec.json` untouched — use it after a codec or
aggregation change, not to produce data from scratch.

```sh
npx tsx roblox/tools/prepareData.ts --hist-only
```

## What gets produced

| Path | Content | Committed? |
|---|---|---|
| `roblox/data-out/m/YYYY-MM.bin` | one BarCodec v1 chunk per calendar month | no (gitignored) |
| `roblox/data-out/hist/1h.bin` | the whole dataset as 1h bars, one BarCodec v1 chunk | no (gitignored) |
| `roblox/data-out/manifest.json` | `{ tickSize, baseSec, months:[{ month, key, byteSize, days:[{ date, firstTs, lastTs, barCount }] }], hist:{ key, file, barCount, byteSize, firstTs, lastTs } }` | no (gitignored) |
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
CME price levels. **One shift for the whole dataset**:

```
shift = roundToTick(firstOpenOfEarliestPackedDay - 20000, 0.25)
o,h,l,c -= shift          # every bar of every month; timestamps and volume untouched
```

The dataset's earliest day therefore opens at 20000 and every later month
floats where its real history puts it. A single constant shift preserves every
price relationship — ranges, gaps, swing structure, level retests, and
**continuity across month boundaries** — while destroying the absolute price
identity. Cross-month continuity is the point: a deep 1D/1W/1M chart *is* that
continuity, and the earlier per-month rebase turned it into a sawtooth back to
20000 at every boundary (`META_PLAN.md` §4).

**Only a full run is canonical.** The anchor is the earliest day *actually
packed*, so `--months 2026-05,2026-06` derives its shift from May 2026 and
produces prices incompatible with every other run. The script prints a loud
warning when `--months` is used; that output is for pipeline smoke-testing
only — never upload it, never commit the `SampleData.luau` / `Codec.json` it
regenerates. Anything destined for the DataStore comes from
`npx tsx roblox/tools/prepareData.ts` with no flags.

Prices are snapped back onto the 0.25 grid after the shift. Some source chunks
carry float dust from the roll adjustment (observed max ~1.5e-11 ticks); the
packed form is integer tick counts regardless, and the snap is bounded at 1e-6
ticks so a genuinely off-grid price would still abort the run.

Tick counts are **i32**, not u32. Under a global shift anchored at the
dataset's earliest day no real bar goes negative, so the Codec fixture pins the
negative and sign-extreme cases with synthetic bars instead. The run prints the
post-shift min low / max high in both price and ticks, so the i32 margin stays
visible if the dataset is ever extended backwards.

## Deep 1h history (`META_PLAN.md` §4)

One extra artifact: the entire dataset folded to 1h bars, so the game can draw a
multi-year 1h/4h/1D/1W/1M chart without loading 190 month keys.

```
hist:1h   95,789 bars   2,298,956 B raw   3,065,276 base64 chars
                                          = 73.1% of the 4,194,304 DataStore cap
```

Headroom is ~1.13 M chars ≈ 35,000 more hourly bars ≈ six more years of daily
data. Past the `3,800,000`-char split trigger, `META_PLAN.md` §4.1's year-boundary
split (`hist:1h:1`, `hist:1h:2`, … concatenated by the server until a `GetAsync`
returns nil) has to be built; until then the tool **aborts** at that threshold
rather than shipping untested split code.

Three properties this artifact must keep, all enforced in the tool:

- **It shares the global shift.** The hourly bars are folded from the same
  normalized 1m bars the months are packed from, so the shift is inherited, not
  reapplied — the history and the live minute data are in one price frame and
  splice without a step. There is no separate normalization pass to keep in sync.
- **Buckets are the game's buckets.** Aggregation goes through
  `web/src/lib/replay/aggregate.ts`, which anchors 1h to the **18:00 ET
  trading-day open**, not to UTC hours. Hand-rolled hourly bucketing would split
  the hour differently from the live data and put a one-candle lie at every
  session start.
- **Months are folded one at a time**, carrying only the currently open bucket
  across the boundary, so a full run never holds 5.4 M bars at once. A month's
  first trading date opens 18:00 ET the previous evening — itself a bucket
  start — so the carry never actually merges anything; the run prints the
  straddle count (observed: 0) so a silent change would be visible.

The packed chunk is round-tripped like every month. Independently verified once
against a from-scratch recomputation off the month `.bin`s (all 95,789 buckets
identical, volume conserved, every bucket start 1h-aligned and monotonic), and
two runs produce byte-identical output.

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
- `hist:1h` → `hist/1h.bin` the same way. Written **once per run**: 3 MB against
  a 4 MB/min per-key write ceiling. Read once per server and cached forever on
  the read side (25 MB/min ⇒ 8 reads/min), never per session.
- `manifest` → the `manifest.json` object verbatim, the day index the server
  reads before it knows which month key to fetch.

Writes go to the `standard-datastores/.../entries/entry` endpoint with the
required `content-md5` header, throttled to one per 500 ms. A full-history
upload is ~190 month keys, roughly two minutes. Each key stays well under the
4 MB DataStore limit (a 22-day month is ~950 KiB base64; `hist:1h` is the one
big key at 73%); `uploadData.ts` refuses any value that would exceed it, and
cross-checks `manifest.json` against the files on disk in both directions before
writing anything.

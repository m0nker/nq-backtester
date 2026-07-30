# NQ Replay Backtester — Design & Architecture

A single reference covering what this project is, why it's built the way it is, and how every major
part works. Compiled from the original build spec and the architecture decisions locked in during
development.

---

## 1. What it is

A browser-based **bar-replay backtesting platform** for futures, in the spirit of FX Replay. You load a
real historical trading day, step through it bar by bar (or autoplay), and place trades against the
market exactly as it unfolded — with a hard guarantee that you can never see future price data.

- **Primary instrument:** NQ (E-mini Nasdaq-100). Full trading + fills.
- **Reference instrument:** ES (E-mini S&P 500). Side-by-side chart only, for context.
- **Live:** https://nq-backtester-three.vercel.app
- **Repo:** https://github.com/m0nker/nq-backtester

### The larger vision

This backtester is **Phase 1** of a longer-term project: an ML data-collection tool that learns to
imitate discretionary trading. Eventually a mechanical bot would propose trades during replay and the
trader labels them (take/skip + attribute ratings) to train a model. That work is out of scope, but two
architectural requirements flow from it and shaped everything below:

1. An **append-only event log** as the core data model (so labeling events plug in without migrations).
2. A **replay clock at base-data resolution** that guarantees **no lookahead**.

> "A beautiful backtester with lookahead leaks is worthless." Correctness of the replay clock and fill
> simulation was prioritized over UI polish throughout.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Charting | TradingView `lightweight-charts` v5 |
| State | Zustand (replay clock, trading engine, drawings) |
| Backend | Supabase — Postgres for metadata, Storage for price-data chunks |
| Styling | Tailwind CSS v4 |
| Hosting | Vercel (Git-integrated auto-deploy from `main`, root dir `web/`) |

The replay engine, fill simulator, aggregation, and time logic are all **pure and fully client-side** —
there is no server ticking. Supabase only stores the event log and serves compressed price data.

---

## 3. The no-lookahead invariant (the most important design decision)

Lookahead is treated as a critical bug class and made **impossible by construction**, not by convention.

- There is exactly **one** code path that reads price data: `lib/data/barSource.ts`.
- Every read is clipped to bars that have already closed relative to the replay clock: a bar with open
  time `t` is visible **iff `t + duration <= currentTime`**.
- Development builds throw an assertion if anything attempts to read a bar from the future.
- Higher-timeframe candles show the **partially-formed current candle** (e.g. at 09:37 a 15m candle
  shows 7 minutes of formation) — computed only from revealed base bars, never from future data.

Full-day chunks live privately in `chunkCache.ts` (in-memory LRU of ~60 days → IndexedDB → public
bucket URL, decompressed in-browser via `DecompressionStream`).

---

## 4. The replay clock

One global `currentTime` (epoch-seconds UTC, at base-data resolution) is the **only** source of truth
for "now." Implemented in `lib/replay/clock.ts` (Zustand).

- **Step forward** — reveals bars through the end of the bucket the next hidden bar belongs to
  (completes partial candles first, skips halts/weekends naturally). Step size is decoupled from the
  viewed timeframe: you can watch 1h and step 1m.
- **Step back** — hides the latest bucket.
- **Autoplay** — ticks one base bar at 1–20 bars/second, pausable.
- **Rewind / jump-to** — jump `currentTime` to any past point. Rewinding **voids** (does not delete)
  all orders/fills after the new time; voiding is **derived in the reducer from a `time_rewound`
  event**, never destructively written. Session stats always exclude voided trades.
- **Optional session end date** — clock clamps, autoplay pauses, a "range end" indicator shows.

---

## 5. Event-sourced sessions

Nothing about a session is stored as mutable state. Every meaningful action is an append-only event;
current state (position, orders, balance, clock) is **derived** by replaying the log through a pure
reducer. Materialized/cached views are used only for performance.

- **Supabase tables:** `instruments`, `dataset_days`, `sessions`, `events`.
- **`events`:** `(session_id, seq, event_type, timestamp_market, timestamp_wall, payload JSONB)`.
- **Event types:** `session_started`, `time_advanced` (coalesced), `time_rewound`, `order_placed`,
  `order_modified`, `order_cancelled`, `order_filled`, `position_closed`, `timeframe_switched`, …
- New event types are addable without migration pain — this is how future labeling events
  (`candidate_shown`, `decision_made`, …) will plug in.
- **Resume** rehydrates the event log from Supabase and replays the reducer, restoring a session to its
  exact last clock time and P&L. Verified working.

Code: `lib/events/` (typed payloads, append-only log, batched Supabase sync, `time_advanced`
coalescing).

---

## 6. Trading engine & fill simulation

All fill assumptions live in **one module** (`lib/trading/fills.ts`) so they can be refined later. The
reducer (`lib/trading/engine.ts`) applies them; the store (`lib/trading/store.ts`) subscribes to the
clock and simulates each revealed bar.

**Order types:** market, limit, stop (stop-market), plus brackets (SL + TP attached to an entry, OCO
between them).

**Fill rules:**
- Wherever the day has 1-second coverage, each closed minute expands into its **1s bars** and the
  rules below apply per second (market fills at the next second's open, touches at 1s precision).
  The minute model below is the fallback for days/chunks without seconds.
- Market → fills at the **next base bar's open**.
- Limit → fills when price trades through the level (at `min/max(open, level)`).
- Stop → fills on touch.
- **Stops resolve before limits** intrabar.
- **Same-bar SL/TP:** when a stop-loss and take-profit both trigger inside one minute, the engine drops
  to that minute's **1-second bars** to decide which was touched first (first touch wins,
  unambiguous). It falls back to the conservative "**stop-loss wins**, flag the bar" assumption only
  when 1s coverage is missing. Fill *prices* stay on the 1-minute formulas.
- Bracket legs evaluate from the bar **after** the entry fill.

**Position logic:** long/short, multiple contracts, add/reduce/reverse, average entry, realized +
unrealized P&L in ticks/points/dollars. NQ contract math: tick 0.25, $5.00/tick ($20/point). ES:
tick 0.25, $12.50/tick ($50/point). No commissions in v1 (config slot left open).

**Reduce-only orders are position-linked:** auto-cancel when the position goes flat or reverses. A
position has exactly **one SL and one TP** — modifying drags the existing leg (`order_modified`,
re-sized to the position) rather than stacking orders.

**A trade** = a round trip (flat to flat), assembled from fill events, with entry/exit times, prices,
size, P&L, and MAE/MFE.

---

## 7. Time & Eastern Time handling

- All timestamps are **epoch-seconds UTC**. ET exists only in `lib/time/et.ts`.
- The chart axis shows ET via shifted timestamps (`toChartTime` / `fromChartTime`).
- ET offset is computed with **O(1) arithmetic** from the post-2007 US DST rule (2nd Sunday March
  07:00 UTC → 1st Sunday November 06:00 UTC), validated exact against `Intl` for 2008–2030 including
  transition minutes. This replaced per-call `Intl.formatToParts` (~35µs each), which had made a 1h
  timeframe switch a single **3.4-second** main-thread task; it's now ~320ms.

---

## 8. Timeframes & aggregation

Aggregation (`lib/replay/aggregate.ts`) is pure, with buckets aligned to the **18:00 ET trading-day
open**.

- **Timeframes:** 15s, 30s, 1m, 2m, 3m, 4m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M.
- 4h buckets = 18/22/02/06/10/14 ET; 1D = one bar per trading day; 1W anchors Sunday 18:00 ET; 1M
  anchors 18:00 ET on the last day of the prior month.
- Bar `t` = **open time**. Bucket membership is decided by bucket **start**, never elapsed duration.
- The UI only offers timeframes ≥ the base resolution; 1s data auto-unlocks 15s/30s.
- **Deep history:** an `--aggregates` ingest pass builds one full-history hourly file
  (`chunks/NQ/1h/all.json.gz`, ~88k bars); `getVisibleCandles` stitches precomputed 1h/4h/1D history
  (buckets strictly before the live window) with live aggregation near the cursor.

**Data-era quirk:** 2010–2015 CSV has bars in the 17:00–17:59 ET hour (old CME session hours), so the
"23h trading day, empty halt hour" assumption only holds for modern data. Aggregation decides bucket
membership by start, and steppers guarantee progress past nominal bucket ends, so old-era days don't
produce duplicate candles or a pinned clock.

---

## 9. Charting & trading UX

Designed to feel like real trading software (ProjectX-style).

- **Dual-instrument layout:** NQ | draggable divider | ES, with an ES header toggle. One global clock
  drives both charts. Per-chart timeframes with click-to-focus; TF buttons and a typed quick-switcher
  ("15" / "1h" / "240" / "d" + Enter) act on the focused chart.
- **On-chart orders/positions** render as **draggable HTML chips** at their price: drag to move an
  order with a live line preview; drag the POS chip to spawn a position-sized leg that becomes TP or SL
  depending on drop side; ✕ cancels / flattens.
- **Draft (schema) bracket orders:** visually draft entry/SL/TP before anything commits — nothing hits
  the event log until the entry chip's Place button.
- **Camera policy (firm):** the chart **never auto-scrolls** on new candles. New candles drift past the
  right edge. Recenter happens only on fresh mount, rewind, or a manual ⇥ button — via
  `timeScale().scrollToPosition(6, false)` (not `scrollToRealTime()`, which animates and can strand a
  bad offset).
- **Movable order panel**, draggable via a grip, position persisted in localStorage.

### Drawing tools

`lib/drawings/store.ts` + `components/DrawingLayer.tsx` (SVG overlay).

- Tools: **trend line** and **rectangle**; click-move-click with a custom crosshair.
- **Anchors are (epoch sec, price)** — timeframe-invariant, so a line drawn on 1m stays put on 5m.
  Time↔x maps through the chart's **logical space** (interpolated from the chart's own candle array),
  so drawings compress across gaps exactly like the candles do.
- Snapping: Ctrl = magnet to nearest bar OHLC; Shift = 45° angle snap. Select → handles (rect: 4
  corners + 4 single-axis edge midpoints) + style editor. Per-pane clear-all.

---

## 10. Dashboard

Per-session and all-sessions analytics (`lib/stats/metrics.ts`): equity curve (from event-derived
fills), win rate, profit factor, average win/loss, expectancy, max drawdown, trade count, and P&L
broken down by hour-of-day and day-of-week (ET).

Completed trades table (per session and across sessions) with direction, size, entry/exit time+price,
P&L ($/points/R), duration, MAE/MFE. Clicking a trade opens a **dynamic** chart viewer — a real
re-rendered lightweight-charts instance around the trade window with entry/exit/SL/TP markers and full
timeframe switching, reusing the same aggregation code as the main chart (not a screenshot).

---

## 11. Data pipeline & contract rolls

Price data is built and uploaded by scripts in `scripts/`, stored as gzipped columnar JSON day-chunks
(chunked by CME trading day, 18:00 ET boundary). Postgres holds metadata only — never raw bars as rows.

- **`ingest_dbn.py`** (current) — Databento DBN sources. Selects the **volume-weighted front-month**
  contract for a continuous series; roll gaps are **measured** from the overlap between expiring and
  incoming contracts (median of simultaneous closes); legacy NQ CSV is stitched at a measured seam.
- **`ingest.mjs`** (legacy CSV path) — detects quarterly rolls (largest consecutive-bar jump crossing
  midnight UTC in days 5–20 of Mar/Jun/Sep/Dec) and **difference-back-adjusts**: all bars before a
  splice shift by the cumulative later gaps, latest prices stay real.
- **Validators:** `validate_chunks.mjs` (chunk integrity), `validate_et_offset.mjs` (ET arithmetic vs
  `Intl`, 2008–2030), `test_fills.mjs` (fill behavior).

**Consequence of back-adjustment:** 2010-era displayed prices sit well above their historical nominal
values, and appending future data requires a full re-ingest (history re-shifts). A known CSV corruption
(2012-02-05 → 2012-02-10 had prices ×100) is sanitized during ingest.

**Approximate coverage:** NQ 1m ~4,100 days (2010 → 2026), NQ 1s ~340 days, ES 1m ~2,900 days
(2015 → 2026), ES 1s ~290 days. Raw source data stays local and is never committed.

---

## 12. Performance

- **Incremental candle cache:** `getVisibleCandlesIncremental` folds only newly-revealed base bars into
  a cached candle tail and reports `dirtyFrom`; the chart calls `series.update()` per changed candle
  instead of `setData()` — stepping is ~2ms/step.
- **Critical invariant:** the cache addresses `ds.bars` by index, so every mutation of `ds.bars` must
  bump a generation counter synchronously, or a chart effect can fold shifted-index bars onto the
  candle tail and throw "Cannot update oldest data." (This was the root cause of a production crash,
  fixed.)
- **O(1) ET math** (see §7) and binary-search stitch cutoffs keep timeframe switches fast.

---

## 13. Repository layout

```
web/                    Next.js app
  src/lib/
    data/               barSource (the single no-lookahead read path), chunkCache, manifest, sessions
    replay/             clock, stepping semantics, aggregation
    trading/            fills, engine (reducer), store, contractMath
    events/             typed append-only event log + Supabase sync
    drawings/           trend-line / rectangle drawing store
    time/               O(1) ET offset arithmetic
    stats/              dashboard metrics
    supabase.ts         client (reads keys from NEXT_PUBLIC_* env vars)
  src/components/        ReplayChart, ReplayControls, DrawingLayer,
                         trading/, trades/, dashboard/, sessions/
scripts/                ingest_dbn.py, ingest.mjs, peek_dbn.py, validators
backtesting_platform_build_prompt.md   original authoritative spec
trading_imitation_project_brief.md     longer-term ML vision
```

Secrets: only the Supabase **publishable** (anon) key is used, read from `NEXT_PUBLIC_*` env vars — it
is public by design (ships in the client bundle). No service-role key is present anywhere. `.env*` and
raw data files are gitignored. The real security boundary is Supabase Row Level Security.

---

## 14. Build status

Built in four phases with sign-off between each — **all four complete and verified**:

1. **Phase 1** — Data ingest + charting with timeframe switching + replay clock (step/autoplay/rewind/
   jump-to); no-lookahead invariant and partial-candle rendering proven.
2. **Phase 2** — Event-sourced sessions + trading engine + on-chart order placement.
3. **Phase 3** — Trade log + dynamic trade viewer.
4. **Phase 4** — Dashboard + session management (list/create/resume/archive) + deployment.

Beyond the original spec, the project also gained: multi-instrument NQ/ES layout with per-chart
timeframes, 1-second data and sub-minute timeframes, draft bracket orders, 1s same-bar SL/TP
disambiguation, and a full drawing-tools layer.

### Approved deviations from the original spec

- Gzipped columnar JSON instead of Parquet.
- Rewind-voiding computed in the reducer, not marked in storage.
- Trading-day (18:00 ET) chunk boundary.
- Ingest via script rather than an admin page.

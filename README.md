# NQ Replay Backtester

A browser-based bar-replay backtesting platform for futures. You load a real historical trading day, step through it bar by bar (or let it autoplay), and place trades against the market exactly as it unfolded — without ever being able to peek at what happens next. Every action is logged to an append-only event stream, so any session can be paused, resumed, and replayed to reconstruct its exact state, P&L, and clock.

Built around **NQ** (E-mini Nasdaq-100 futures), with **ES** (E-mini S&P 500) available as a side-by-side reference chart. ~15 years of minute data and a rolling window of 1-second data back the replay.

**Live:** https://nq-backtester-three.vercel.app

---

## Why this exists

Most "backtesters" either run a strategy over historical data in a batch and hand you a number, or they're paper-trading toys that only work in the live present. Neither lets you sit in front of a *past* chart and discretionarily trade it the way you actually would — reading the tape, managing a position, feeling the drawdown — with an ironclad guarantee that you aren't cheating by seeing the future.

That guarantee is the hard part, and it's the core of this project. The whole system is designed so that lookahead is impossible *by construction*, not by convention.

## What makes it interesting

**No-lookahead by construction.** There is exactly one code path that reads price data, and every read is clipped to bars that have already closed relative to the replay clock (a bar is visible only once `open_time + duration <= now`). Development builds throw an assertion if anything tries to read a bar from the future. You cannot accidentally leak tomorrow's candle into today's decision.

**Event-sourced sessions.** Nothing about a session is stored as mutable state. Every step, trade, order modification, timeframe switch, and rewind is an append-only event. Current state — position, working orders, balance, clock time — is *derived* by replaying the log through a pure reducer. This is what makes resume work: reopen a session weeks later and it rehydrates to the exact bar and P&L it was on. It's also how "rewind" stays honest — rewinding writes a `time_rewound` event and the voiding of trades-that-hadn't-happened-yet is computed from the log, never destructively edited.

**Realistic, explicit fills.** Fill logic lives in one place with every assumption written down: market orders fill at the next bar's open, limits fill when price trades through the level, stops fill on touch, stops resolve before limits intrabar. When a stop-loss and take-profit would both trigger inside the same minute, the engine drops down to that minute's 1-second bars to decide which was actually touched first — and only falls back to the conservative "stop wins" assumption when second-resolution data isn't available.

**Continuous contracts done properly.** Futures contracts expire quarterly, so a continuous series has to be stitched across rolls. Roll dates are detected automatically and the price history is difference-back-adjusted so the splices are seamless and the most recent prices stay real. Roll gaps are *measured* from the overlap between the expiring and incoming contracts rather than guessed.

**A charting surface that behaves like real trading software.** Fourteen timeframes from 15-second to monthly, all aggregated on the fly from a single base resolution with buckets aligned to the 18:00 ET trading-day open. Orders and positions render as draggable chips on the chart (ProjectX-style) — drag to move a stop, drop to spawn a take-profit. Bracket orders can be drafted visually before anything commits to the log. There's a full drawing layer (trend lines, rectangles, magnet snapping) whose anchors are timeframe-invariant, so a line drawn on the 1-minute stays put when you switch to 5-minute.

**Performance under a replay loop.** Stepping the clock re-aggregates only the newly revealed bars and updates the chart series incrementally instead of repainting — roughly 2 ms per step. Eastern Time conversion (needed constantly for session boundaries) is done with O(1) arithmetic derived from the US DST rules rather than per-call locale formatting, which turned a 3.4-second timeframe switch into ~320 ms.

**A dashboard that measures what matters.** Per-session and aggregate analytics: equity curve, win rate, profit factor, expectancy, max drawdown, and P&L broken down by hour-of-day and day-of-week (in ET).

## How it's built

| Layer | Choice |
|---|---|
| Framework | Next.js 16, React 19, TypeScript |
| Charting | TradingView lightweight-charts v5 |
| State | Zustand (replay clock, trading engine, drawings) |
| Backend | Supabase — Postgres for session/event metadata, Storage for price-data chunks |
| Styling | Tailwind CSS v4 |
| Hosting | Vercel (Git-integrated auto-deploy) |

The replay engine, fill simulator, aggregation, and time logic are all pure and run entirely client-side. Supabase holds the append-only event log and serves gzipped, columnar day-chunks of price data (decompressed in the browser via `DecompressionStream`, cached in memory → IndexedDB → CDN).

### Repository layout

```
web/                  Next.js app
  src/lib/
    data/             barSource — the single no-lookahead price read path + chunk cache
    replay/           clock, stepping semantics, timeframe aggregation
    trading/          fills, event reducer, order/position engine
    events/           typed append-only event log + Supabase sync
    drawings/         trend-line / rectangle drawing store
    time/             O(1) ET offset arithmetic
    stats/            dashboard metrics
  src/components/      chart, controls, order panel, dashboard, session list
scripts/              data pipeline (Databento DBN + legacy CSV ingest) & validators
```

## Running locally

Requires Node 20+ (built on Node 24 LTS) and a Supabase project holding the price data.

```bash
cd web
npm install
```

Create `web/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_KEY=your-publishable-anon-key
```

```bash
npm run dev
```

Then open http://localhost:3000.

## Data pipeline

Price data is built and uploaded by the scripts in `scripts/`:

- **`ingest_dbn.py`** — the current pipeline. Takes Databento DBN exports, selects the volume-weighted front-month contract to build a continuous series, measures roll gaps from contract overlap, and uploads gzipped day-chunks (minute and second resolution for NQ and ES).
- **`ingest.mjs`** — the original CSV path, including the automatic roll detection and difference-back-adjustment described above.
- **`validate_chunks.mjs`**, **`validate_et_offset.mjs`**, **`test_fills.mjs`** — validators for chunk integrity, the ET arithmetic (checked against `Intl` for 2008–2030), and fill behavior.

Raw data files stay local and are never committed.

## Status

All core functionality is built and in use: the replay engine with no-lookahead guarantees, discretionary chart trading, event-sourced session persistence with resume, multi-timeframe charting with drawing tools, dual-instrument NQ/ES layout, and the analytics dashboard.

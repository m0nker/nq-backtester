# Build Prompt: NQ Futures Replay Backtesting Platform

You are helping me build a web-based bar-replay backtesting platform for NQ futures (similar to FX Replay), which will later be extended into a machine-learning data-collection tool for imitating my discretionary trading. Build it with that extension in mind, but the scope of THIS project is the backtesting platform only.

## Context (read first)

I'm a discretionary NQ futures trader. This platform is Phase 1 of a larger project: eventually it will host a "candidate review" workflow where a mechanical bot proposes trades during replay and I label them (take/skip + attribute ratings) to train a model on my discretion. That's out of scope for now, but the architecture must not block it. The two future-proofing requirements that follow from this: (1) an append-only event log as the core data model, and (2) a replay clock at base-data resolution that guarantees no lookahead.

## Tech stack (decided, don't relitigate)

- **Frontend:** Next.js (App Router) + TypeScript, deployed on Vercel
- **Charts:** TradingView `lightweight-charts` (open-source library)
- **Backend/DB:** Supabase (Postgres for structured data, Supabase Storage for price data files, Supabase Auth later)
- **Price data:** I will upload my own NQ data (1-minute OHLCV initially; the design must accommodate second-level data later without re-architecting)
- **Replay engine:** fully client-side (no server ticking)

## Core architecture requirements

### 1. Data layer
- Price data stored as compressed chunk files (Parquet or gzipped JSON/CSV — recommend and justify) in Supabase Storage, chunked by trading day. Postgres stores metadata only (available days, instrument specs) — never raw bars as rows.
- Client fetches day-chunks on demand and caches them (IndexedDB or in-memory with LRU).
- An upload/ingest path for me to load my NQ CSV data (a simple admin page or script is fine).
- Instrument spec table: NQ = tick size 0.25, tick value $5.00 ($20/point), with session times (ET). Design so other instruments can be added later.

### 2. Replay clock (the most important invariant)
- One global `currentTime` (timestamp at base-data resolution) per session. This is the ONLY source of truth for "now."
- ALL chart timeframes (1m, 2m, 3m, 5m, 15m, 30m, 1h, 4h, 1D — dynamically switchable) render as aggregations of base data up to `currentTime`, including the PARTIALLY FORMED current candle on higher timeframes (e.g., at 9:37 the 15m candle shows 7 minutes of formation). No future data may ever be computed, fetched into chart state, or rendered. Treat lookahead as a critical bug class; structure the code so it's impossible by construction (e.g., a single data-access function that takes `currentTime` and physically cannot return later bars).
- **Step forward:** advance `currentTime` by one bar of the CURRENTLY VIEWED timeframe (stepping on the 5m chart advances 5 minutes of base data). Keyboard shortcut (space/arrow).
- **Autoplay:** play/pause at selectable speeds.
- **Rewind:** jump `currentTime` backward to any past point (click on chart or time input). Rewinding VOIDS all orders and fills with timestamps after the new `currentTime` (mark voided, don't hard-delete — keep for audit). Session stats always exclude voided trades.
- **Jump-to:** date/time picker to start a session at any point in the loaded data (e.g., 9:25 AM on a chosen day — this exact use case matters for the future project).

### 3. Event-sourced session model
- A `sessions` table (id, user placeholder, instrument, created_at, starting timestamp, starting balance/config).
- An append-only `events` table: (session_id, seq, event_type, timestamp_market, timestamp_wall, payload JSONB). Every meaningful action is an event: session_started, time_advanced, time_rewound, order_placed, order_modified, order_cancelled, order_filled, position_closed, timeframe_switched. Derived state (positions, P&L, equity) is computed from events, not stored as mutable truth (materialized/cached views are fine for performance).
- New event types must be addable without migration pain — this is how the future labeling features (bias_entered, candidate_shown, decision_made) will plug in.

### 4. Trading engine (client-side simulation)
- Order types: market, limit, stop (stop-market). Bracket support: attach stop-loss and take-profit to an entry order (OCO between them).
- Position logic: long/short, multiple contracts, add/reduce/reverse, average entry price, realized + unrealized P&L in ticks/points/dollars using NQ contract math.
- Fill simulation against base-resolution data as time advances: market fills at next bar open (state this assumption in the UI); limit fills when price trades through the level; stop triggers when price touches. Document fill assumptions clearly and keep them in one module so they can be refined later (e.g., intrabar sequencing rules for when a bar touches both SL and TP — pick a conservative default: assume stop-loss hits first, and flag such bars).
- No commission/fees in v1 but leave a config slot.
- Trade = round trip (flat to flat), assembled from fill events, with entry/exit times, prices, size, P&L, MAE/MFE.

### 5. Trade log + dynamic trade viewer
- Table of completed trades per session (and across sessions): direction, size, entry/exit time+price, P&L ($, points, R if bracket was used), duration, MAE/MFE.
- Clicking a trade opens a DYNAMIC chart viewer — NOT a screenshot: re-render a real lightweight-charts instance from stored price data around the trade window (configurable context, e.g., ±2 hours), with entry/exit/SL/TP markers overlaid, and full timeframe switching within the viewer. This must reuse the same aggregation code as the main chart.

### 6. Dashboard
- Per-session and all-sessions stats: equity curve (from event-derived fills), win rate, profit factor, average win/loss, expectancy, max drawdown, trade count, P&L by time-of-day and day-of-week.
- Keep it clean and minimal; recharts or lightweight-charts line series is fine.

### 7. Deployment + future features
- Deploys to Vercel + Supabase from day one.
- Auth: stub a single-user mode now, but use Supabase Auth-compatible patterns (user_id columns everywhere, RLS-ready) so real accounts are a small step later.
- Session management UI: list sessions, create new (pick start date/time, starting balance), resume, archive.

## Build order (work in these phases, get my sign-off between phases)

1. **Phase 1:** Data ingest + chart with timeframe switching + replay clock (step, autoplay, rewind, jump-to). Prove the no-lookahead invariant and partial-candle rendering. This phase alone must be usable for manual replay practice.
2. **Phase 2:** Event-sourced sessions + trading engine + on-chart order placement (buy/sell buttons, click-to-place limit/stop, draggable SL/TP lines if feasible).
3. **Phase 3:** Trade log + dynamic trade viewer.
4. **Phase 4:** Dashboard + session management + deployment polish.

## Non-goals for this project (do not build)

- No live data feeds, no broker connections, no real execution
- No ML, no bias input, no candidate review, no voice recording (future phases — just don't block them)
- No multi-instrument UI (architecture supports it; UI is NQ-only)
- No mobile optimization (desktop-first)

## Working style

- Start by proposing the database schema (tables + event payload shapes) and the client-side module structure for my review before writing feature code.
- Flag any decision where you deviate from this spec and why.
- Prioritize correctness of the replay clock and fill simulation over UI polish — a beautiful backtester with lookahead leaks is worthless.

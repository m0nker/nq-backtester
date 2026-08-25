# Web → Roblox chart/replay parity gap report (2026-08-24)

Produced by a read-through of the web reference (ReplayChart/ReplayControls/
OrderPanel/PositionBar/TradeLog/TradeViewer/NewSessionModal/SessionList/
SessionLayer/DrawingLayer/page.tsx/clock.ts/concepts store) against the whole
Roblox client. Items marked [in-flight] were already being fixed when this was
written. Strike items off as they land; this file is the round-2+ work queue.

KEY FACT: the web chart's colors are NOT lightweight-charts defaults — they
come from DEFAULT_CHART_COLORS in web/src/lib/concepts/store.ts (user-editable
profiles). Roblox Theme.luau hardcodes the TV dark ground (#131722) with LWC
default candles (#26a69a/#ef5350). Pick per feature; both differ from web.

## A. Chart visual parity

P1
1. NO last-price line + colored last-value axis chip (bg = last candle's
   up/down color, white text; dotted 1px line at last close). Most-noticed
   missing element.
2. No candle BORDER capability (web: borderVisible, single border color for
   both directions; wick color separate from body). Options: 1px UIStroke per
   body frame, or accept LWC-borderless deliberately.
3. Crosshair lines must be DASHED (~4px large-dash), not solid. [in-flight]
4. Crosshair axis chips: 4px horiz padding, v-center on crosshair y; clamp
   time chip inside the axis; LWC time chip shows full context string
   ("Fri 24 Mar '23 13:30"). [partially in-flight]

P2
5. Axis border lines missing: 1px #232a3b separators plot|priceaxis and
   plot|timeaxis.
6. Autoscale margins asymmetric: top 20% / bottom 10% (Roblox: 5/5).
   [in-flight]
7. Grid/label density: derive from plot size (plotH/45, plotW/90), don't cap
   at 9/8 — fullscreen looks empty.
8. Grid color should be expressed as transparency (web: 6% opacity of
   #f0f3fa) so a future color-settings pass maps 1:1.
9. Time-axis day-boundary labels: LWC shows short "24" / "Mar '23" at day and
   month ticks, not date+time concatenation; labels anchor at interpolated
   tick x, not the next candle's x.
10. Time step ladder: add 2h/3h/6h/8h between 1h and 12h (and LWC has
    2m/10m too). [partially in-flight]

P3
11. Body width: LWC bodies nearly touch at wide spacing — use
    bw - clamp(round(bw/8), 1, 4), not fixed 0.7 fraction.
12. Web uses ONE wick color for both directions (#000000 in default scheme) —
    only relevant if item 2 is adopted.
13. Price labels: always %.2f at every zoom (Roblox drops to 0 decimals at
    step >= 10). [in-flight]
14. Fonts: LWC axis text = FULL text color at 12px (not a dim variant); web
    numeric chips are mono 11px. [in-flight]
15. Web chart has no watermark — do not add one.

## B. Chart behavior

P1
1. Timeframe switch must recenter (web: scrollToPosition(6) on every tf
   switch). Roblox keeps a raw rightIndex into the OLD array — 1m→1h lands
   the camera in an arbitrary spot. Convert rightIndex to time across the
   rebuild, or snap to tail.
2. Rewind/jump/reset (Bars reset packet) must recenter too: stale rightIndex
   over a shrunk array can show an empty plot. BarCache should tag
   append-vs-reset in onChanged; ChartView snaps on reset.

P2
3. followTail semantics: web = sticky manual toggle (pan-away does NOT
   disarm; next advance snaps back) + separate one-shot ⇥ recenter. Roblox =
   TradingView-ish auto arm/disarm. DECIDE deliberately; currently divergent.
4. When price scale is MANUAL: chart-body vertical drag pans the range;
   double-click time axis resets time scale. [sent to in-flight agent]
5. Wheel zoom ~1.25-1.3 per notch (1.15 sluggish). [sent to in-flight agent]
6. Zoom-out floor: min bar width 2px + pool 700 means a full 1m session
   (context+day ≈ 3400 bars) can never fit on screen. Raise pool to ~1600 or
   decimate (every 2nd bar) below 2px.
7. Order/position line styles (web ReplayChart.tsx:317-367): working orders
   = 1px DASHED; SL #ef5350, TP #26a69a, entry buy #4caf9d, entry sell
   #e57373; each with an AXIS label chip ("SL 1", "B limit 1"). Position =
   1px SOLID #f5b942 labeled "POS +1". Draft bracket = DOTTED
   #38bdf8/#ef5350/#26a69a. Roblox: all solid, entries amber both sides,
   position line white, no axis chips.
8. POS chip affordances: web ✕ = flatten; drag the POS chip to spawn an
   SL/TP leg (auto-classified by drag direction, ghost label with projected
   pts/$). Roblox chip does nothing.
9. Drag ghost feedback: follow-cursor label with the live price ("→
   23145.25"), projected pts/$ for SL/TP legs.
10. Data edges: no fixLeftEdge/fixRightEdge (parity OK). Context boundary is
    a hard wall (OK). Web backfills older days on pan-left — n/a here.
11. NO kinetic scroll for mouse in LWC (touch only) — parity already
    correct; do not add momentum.

P3
12. Chip geometry: web chips sit ~10px left of the price axis, rounded 4px,
    translucent per-kind tinted bg; Roblox: square, opaque, fixed 176px.
13. Out-of-range chip hiding — parity OK, keep.
14. Web chart click modes (rewind-to-time, place-at-price) — see C3.

## C. Controls/HUD parity

P1
1. PositionBar missing: UNREALIZED P&L (from last visible close — BarCache
   has it), BALANCE (startingBalance + realized — protocol already carries
   it), VOIDED count (amber when > 0).
2. No jump-to-time UI. Server cmd jumpTo is fully implemented and unused by
   the client. Valuable subset: "jump to HH:MM ET" box + "to 09:30" preset.
3. No click-price order placement: web arms Buy/Sell Lmt/Stp from the panel,
   then click-on-chart captures the price (Esc cancels). Biggest order-entry
   ergonomics gap; xToIndex/yToPrice inverses already exist.

P2
4. Working-order chip strip in the HUD (web PositionBar lists each order as
   a cancellable chip "SL 1 @ 23120.00 ✕").
5. Trade log columns missing: entry/exit ET times, duration, pts (all in
   TradeView already), MAE/MFE (computable client-side), row numbers,
   click-through to a trade viewer.
6. Range-end/end-of-data feedback: web shows red "■ range end", disables
   step/play at end. Add atEnd to Protocol.Clock (server knows) or derive.
7. Speed control: web is a select over all SPEEDS (1..500 direct); Roblox
   cycle-button takes 8 clicks. Flyout dropdown like the step-size one.
8. Session start options: web modal has name, date validation, START TIME
   ET (default 09:25), optional end date, starting balance (default
   $50,000 — Roblox hardcodes 10,000, values disagree). High-value piece:
   start-time (or auto-jump to 09:25).
9. No explicit End-session control (web header has one). Needs an
   endSession cmd → finalizeActive + picker.
10. Ctrl/Cmd+Space = step exactly one bar (web), distinct from Space.

P3
11. Typed-timeframe buffer ("15↵", "4h↵", "d↵", "M") with overlay + 2.5s
    timeout — finer version of the digit hotkeys.
12. Loading indicator during startSession/jump (picker gives no feedback
    after click; DataStore fetch can take a beat).
13. Play-button labels: web deliberately reads "▶ auto" / "❚❚ playing".
14. Trade-log cap: show "showing 200 of N" when clipped.

## D. Missing subsystems (scope decisions, not bugs)

- Drawing tools (rays/rects, (t,price) anchors, persisted) — absent.
- Session/killzone boxes + prev-day H/L overlay — absent.
- FVG/liquidity overlays — deliberately cut (per CLAUDE.md).
- TradeViewer (per-trade replay modal) — absent.
- Dashboard/aggregate stats UI — absent (PlayerStore.stats has the data).
- Dual-instrument ES split layout — absent; port is NQ-only.
- Sub-minute (15s/30s/1s) — deliberately cut.
- Chart color settings/profiles — absent; Theme hardcoded.
- Session list/archive (multiple saved sessions) — absent; one active
  session per player.
- Bot subsystem — deliberately cut.
- Movable order panel — web panel is user-draggable; Roblox fixed.

## Top 10 highest-impact fixes

1. Last-price dotted line + colored last-value axis chip (A1).
2. Dashed crosshair + dashed/dotted order lines, per-side entry colors,
   amber POS line (A3, B7).
3. Recenter on timeframe switch and on reset packets (B1, B2).
4. Unrealized P&L + Balance + Voided in the position bar (C1).
5. Jump-to-time (ET) UI over the existing jumpTo cmd (C2).
6. Click-price order placement (C3).
7. Asymmetric autoscale margins + axis border lines #232a3b (A5, A6).
8. Grid/label density from plot size (A7).
9. Order axis chips + HUD working-order strip + ✕/flatten on POS chip
   (B7, B8, C4).
10. Trade-log time/duration/pts columns + range-end transport feedback
    (C5, C6).

# Roblox backtester — project handoff

Written 2026-08-24 at the end of the build-out session. Read this first;
everything else is linked. The game is **live and playable end to end**.

## What this is

A friends-only Roblox port of the web NQ backtester (`../web/`): server-
authoritative bar-replay, manual trading with brackets/OCO, 16 years of
normalized 1m data hosted in the game's own DataStores, leaderboards,
drawing tools, deep-history charts. The web app's engine is the reference;
the port is proven equivalent by golden-fixture parity, not by trust.

- Place: **"nasdaq"**, placeId 86127867374204 (the user's account owns it).
- The user keeps OTHER, non-scratch places open in Studio — always confirm
  the target instance before any Studio MCP mutation.

## Current state (all verified live in Studio)

- **Data: uploaded and live.** 194 month keys (`m:YYYY-MM`), `hist:1h`
  (95,789 hourly bars), and a flattened `manifest` (4,147 days; 4,141
  playable after the <100-bar filter) sit in DataStore `bars_v1`.
  Prices carry ONE dataset-wide shift (-14699; "global-offset-v1" scheme
  marker): 2010 opens at 20000, 2026 tops ~45800, cross-month continuity
  intact. 2013 sessions were loaded and traded as a smoke test.
- **Test suites: 1,272 assertions, all green.**
  Parity 599 (engine ≡ web, incl. codec byte-pin) · ServerSpec 383 (replay
  session behavior incl. anti-lookahead audit) · BoardSpec 290 (leaderboard
  eligibility/encoding/gates).
- **Client**: lightweight-charts-style chart (dashed crosshair + axis chips,
  last-price line, dashed SL/TP/entry order lines with axis chips, amber
  position line, draggable price/time scales, decimated zoom-out, deep
  1D/1W/1M history), order panel with click-to-place arming, trade log +
  trade viewer with MAE/MFE, drawing tools (rays/rects/trend lines with
  select/move/resize), drill-down session picker, leaderboard panel,
  typed-timeframe buffer, full keyboard map (see README.md).
- **Server**: reveal loop with hitch cap, context bars (~1.5 days before
  each session open), bracket/OCO fill mechanics mirrored from the web
  store, per-player persistence with resume, eligible-only leaderboard
  stats (`elig` bucket — rewind-laundering closed), deep-history packets.

## Docs map

| File | What |
|---|---|
| `README.md` | Newcomer setup, controls, suite invocations |
| `CLAUDE.md` | Conventions, lint gate, port rules, Studio safety |
| `PORT_PLAN.md` | Architecture decisions + phase ledger |
| `META_PLAN.md` | Phase-5 designs (challenge/1v1/etc), partially landed |
| `GAP_REPORT.md` | Web-vs-port audit; remaining items are the polish queue |
| `tools/DATA.md` | Data pipeline runbook |

## Operational knowledge (hard-won; do not rediscover)

1. **Rojo**: ports 34872/34873 are taken on this machine —
   `rojo serve --port 34875` always.
2. **Lint gate** (from `roblox/`): `rojo sourcemap default.project.json -o
   sourcemap.json` then `luau-lsp analyze --sourcemap=sourcemap.json
   --definitions=globalTypes.d.luau --platform=roblox --ignore="Packages/**"
   src tests` + `stylua --check src tests`. Zero diagnostics is the bar;
   `globalTypes.d.luau` is vendored at roblox/ root.
3. **Studio module cache**: `require` caches per DataModel session. Rojo
   updating a ModuleScript's Source does NOT invalidate it. Run test suites
   in a FRESH Play session (Server context via execute_luau), or clone the
   Tests folder for pure-shared suites (Parity). An Edit-DM run after any
   prior require may execute STALE code — this burned a whole debug cycle.
4. **Studio API access is ENABLED** on this place (needed for the data
   upload). Consequences: (a) test suites would hit REAL stores — they set
   `_G.__BACKTESTER_TEST_MEMORY = true`, honored by `PlayerStore.getStore`
   and `Board.getOrdered` (Studio-only), which pins them to memory; keep
   that switch working; (b) Play Solo sessions write real
   `players_v1`/board entries for the real user — that's intended.
5. **Virtual input vs chat**: Studio MCP mouse clicks are BLOCKED over the
   chat CoreGui canvas (top-left) and cannot reach y<58 (topbar). Real mice
   are unaffected. Drive blocked UI via remotes when verifying with MCP;
   `user_mouse_input` y-coords are GUI-space (AbsolutePosition space).
6. **EncodingService Base64** takes/returns BUFFERS, not strings.
7. **`GetGuiInset()` returned (0,0) in a LocalScript** here — the chart
   measures the inset from its root frame's AbsolutePosition instead.
   Don't "simplify" that back.
8. **OrderedDataStore accepts negative values** (probe-proven live,
   contradicting community lore). The cent-offset encoding is kept anyway —
   monotonic, harmless, migration-free.
9. **Data pipeline**: full runs only for canonical artifacts (`--months` is
   fenced); uploads are scheme-gated (`global-offset-v1`). The upload that
   actually happened went Studio-side (local HTTP server + SetAsync job in
   `scratchpad`, ~4 min); `tools/uploadData.ts` (Open Cloud) is the
   repeatable path and now uploads the FLATTENED manifest shape BarStore
   reads.
10. **Licensing hygiene**: prices are shifted, but bar TIMESTAMPS are real —
    anyone can identify the actual dates. Fine for friends-only; the daily
    challenge design (META_PLAN §2) specifies re-anchoring timestamps for
    hidden sessions, and `sendHistory` must be gated for them too.

## Remaining roadmap (nothing here is started)

- **Daily challenge** (META_PLAN §2): hidden mystery day — needs §0's
  session fields (wireOffset/mode/noRewind), timestamp re-anchoring via
  `Et.etWallToUtc`, `sendHistory` gating, its own board keyed by challenge
  date, one-attempt tracking.
- **1v1** (§3): same hidden day for both players; per-player Session
  registry already supports it; fairness unit = bars revealed.
- **Drawing tools v3** (§5.4): magnet/angle snapping, persistence in
  PlayerStore, id-based selection.
- **Polish queue**: GAP_REPORT P2/P3 leftovers (session start-time option +
  balance choice, end-session button, trade-viewer mini-chart, order-chip
  qty drag, click-arbiter for chart clicks when both order-arm and draw-arm
  are active, month/year-anchored deep-chart time labels).
- **Known cosmetic quirks**: seam bucket on a 1h chart can be short up to
  59 min of extremes; DrawToolbar hardcodes y=340 clearance over the order
  panel; chip vs follow-button overlap at the plot's right edge.

## Session-verified numbers (for future sanity checks)

Fill model: market fills at next bar open; a 20/40-pt bracket on 1 contract
returned exactly -$200 (SL) and +$600/2.0R (TP) in live tests. Unrealized
P&L matched (close - avgEntry) × $20 to the cent. The 2013-03-28 session
opened at ~21,006 = real ~6,307 + 14,699 shift. Trust these invariants;
if one breaks, something real broke.

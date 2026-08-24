# Port plan and architecture decisions

Decisions from the Aug 2026 research pass (three deep-research reports:
toolchain, chart rendering, data delivery). Revisit only with new evidence.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Language | Hand-port to `--!strict` Luau. NOT roblox-ts. | UI is native anyway; roblox-ts stable channel frozen at v3.0.0 (Sept 2024); generated-code debugging; a one-time ~2.5k LOC port doesn't justify a permanent compiler toolchain. Luau's new type solver (GA Nov 2025) gives TS-grade checking. |
| Sync/toolchain | Rojo 7.7 + Rokit pins. Code lives in git, synced to Studio. | Standard 2026 practice; keeps the senior/subagent workflow intact. |
| Parity | Golden fixtures dumped from the TS engine, replayed in Studio. | Proves behavioral equality instead of asserting it. See CLAUDE.md. |
| Chart | Pooled Frames (wick+body per candle), virtualized, one repaint per render frame. NOT EditableImage. | ~900 instances is 10x below trouble; a shipped 2026 DevForum project renders 2000+ candles this way. EditableImage: 1024px cap, ~1 texture upload/frame throttle, ID-verify gate. |
| Chart ScreenGui | Chart in its OWN ScreenGui, HUD in another. | LayerCollector invalidation is per-ScreenGui; a per-frame-moving chart must not invalidate static UI. |
| Data host | Roblox DataStore, packed binary, one key per calendar month. NO external services at runtime. | Zero external dependencies (Supabase free tier pauses on inactivity — would brick a hobby game). 4 MB/key vs ~1 MB/month packed+base64; ~130 keys total; well under the 500 MB experience quota. Read budget (300 + 40x users req/min) is irrelevant at friends scale. |
| Bar encoding | Columnar packed binary in `buffer`: u32 t + f32 o/h/l/c + f32 v = 24 B/bar (~33 KB/day). Base64 via native `EncodingService` only at the DataStore boundary. | Buffers replicate natively over remotes with on-the-wire compression. No gzip in Luau; native compression is Zstd-only — v1 skips compression entirely (86 MB raw dataset fits the quota; add Zstd later if wanted). |
| 1s data | CUT. 1m base only. | 14 MB/day doesn't fit the platform; engine's SL-first ambiguous-bar fallback already handles absent 1s coverage. |
| Sub-minute TFs | CUT (15s/30s need 1s base). Timeframes: 1m..1M. | Follows from 1s cut. |
| Licensing hygiene | Normalize prices per session (undisclosed rebase) + shuffle date identity before upload; never label data as NQ/CME in-game. | CME historical-distribution licensing is triggered by distribution, not revenue. Friends-only today, but hygiene is cheap now and expensive later. |
| Multiplayer | Server-authoritative clock; clients receive only revealed bars. | Anti-lookahead becomes cheat-proof by construction; enables 1v1/daily-challenge later. |

## What ports where

| Web (reference) | Roblox | Notes |
|---|---|---|
| `lib/types.ts` | `src/shared/Types.luau` | minus 15s/30s |
| `lib/time/et.ts` | `src/shared/Time/Et.luau` | Date.UTC → pure civil-date math (days-from-civil) |
| `lib/replay/aggregate.ts` | `src/shared/Replay/Aggregate.luau` | 1:1 |
| `lib/trading/contractMath.ts` | `src/shared/Trading/ContractMath.luau` | 1:1 |
| `lib/trading/fills.ts` | `src/shared/Trading/Fills.luau` | `secondsFor` kept, always nil |
| `lib/trading/engine.ts` | `src/shared/Trading/Engine.luau` | ordered-map for workingOrders |
| `lib/events/types.ts` | `src/shared/Events/Types.luau` | payload shapes preserved |
| `lib/replay/clock.ts` (zustand) | `src/server/Replay/Clock.luau` (rewrite) | server loop + RemoteEvents, not a store |
| `lib/data/barSource.ts` | `src/server/Data/BarSource.luau` (rewrite) | DataStore month-chunks + buffer decode |
| `lib/events/eventLog.ts` (Supabase) | `src/server/Sessions/` (rewrite) | player DataStore, same event shapes |
| ReplayChart.tsx (lightweight-charts) | `src/client/Chart/` (rewrite) | pooled Frames; see research |
| DrawingLayer.tsx (SVG) | later phase | Frames/Path2D |

## Phases

1. **Engine port + parity** — ✅ DONE 2026-08-24. 599/599 parity assertions
   green in Studio (incl. the Codec byte-layout pin).
2. **Data pipeline** — ✅ DONE 2026-08-24 (3-month validation run). Remaining:
   full-history run + Open Cloud upload — needs the user's API key; commands
   in `tools/DATA.md`.
3. **Server replay service** — ✅ DONE 2026-08-24. Verified live in Play mode:
   reveal loop, step/rewind, fills+brackets+OCO ($-200 SL round trip exact).
   Deferred: event-log persistence to player DataStores, multi-day sessions.
4. **Client chart + controls** — ✅ DONE 2026-08-24 (phase 4a). Live chart
   with pan/zoom/crosshair/axes/follow-tail, replay controls, session picker,
   position HUD. Phase 4b remaining: order placement UI, chart order
   markers/price lines, keyboard shortcuts, trade log panel.
5. **Meta** — sessions UI, OrderedDataStore leaderboard, daily challenge
   (seeded mystery day), 1v1 rooms.

Cleanup backlog: export payload types from Protocol.luau (client currently
mirrors them in Net/Messages.luau); a `ready` cmd to replace the SessionInfo
resend loop; `running` flag in SessionInfo; pin luau-lsp/stylua in rokit.toml.

## Key platform numbers (research-verified, Aug 2026)

- DataStore: 4 MB/key; storage 500 MB + 1 MB/lifetime user; reads
  300 + 40x concurrent users per min (shared with Open Cloud since Jul 2026);
  25 MB/min per-key read. Buffers storable since Feb 2024.
- Remotes: buffers native incl. wire compression; keep single fires modest;
  UnreliableRemoteEvent caps ~900 B (unused here).
- HttpService (if ever needed): 500 req/min/server, server-side only.
- UI: ~1k pooled Frames repositioned per frame is comfortable; never
  create/destroy per frame; no UIListLayout in the candle container; text
  labels pooled, text rewritten only on scale change.
- `EncodingService`: native Base64 + Zstd (only) compression, ~Oct 2025.
- Script.Source cap: 200k chars (constrains Rojo-mapped JSON fixtures).

# NQ Backtester — Roblox port

A friends-only trading **replay backtester**, ported from the web app in
`../web/`. You pick a historical trading day, the chart replays it bar by bar,
and you trade it live — market/limit/stop orders with brackets, an event-logged
session you can rewind, a trade log with R multiples, and leaderboards.

No bots, no strategy perception: this port is the replay engine, the chart, and
manual trading. Prices are normalized (see below), so nothing in game is labelled
or recognizable as any real instrument.

## Architecture in one paragraph

The **server owns the replay clock** and streams only revealed bars to clients
over remotes, so lookahead is impossible by construction rather than by
convention — client code never holds a bar the clock hasn't reached. Bar data is
packed to binary (`BarCodec` v1, 24 B/bar), hosted in a **DataStore** as one key
per calendar month plus one deep-history key, and decoded into `buffer`s on the
server; there are no external services at runtime. The trading engine
(`src/shared/Trading/`) is a hand port of the web app's, and the port is held to
it by **golden fixtures** dumped from the live TS engine and replayed in Studio —
behavioral equality is proven, not asserted. Pure logic lives in `src/shared/`
(server + client); `src/server/` owns the clock, data and persistence;
`src/client/` is display and input only.

## Setup

1. Install [Rokit](https://github.com/rojo-rbx/rokit), then from this directory:

   ```sh
   rokit install          # pins rojo, luau-lsp, stylua per rokit.toml
   ```

2. Serve the project. **Ports 34872 (Rojo's default) and 34873 are taken on the
   author's machine — always use 34875:**

   ```sh
   rojo serve --port 34875
   ```

3. In Studio, install the Rojo plugin (`rojo plugin install`), open a place, and
   click **Connect** with the port set to **34875**. The filesystem now syncs into
   the DataModel; see the layout table in `CLAUDE.md`.

Press Play. With no DataStore provisioned the server falls back to the bundled
`SampleData.luau` (3 trading days), so the game is fully playable offline.

## Lint gate

Zero diagnostics required, both commands:

```sh
rojo sourcemap default.project.json -o sourcemap.json
luau-lsp analyze --sourcemap=sourcemap.json --definitions=globalTypes.d.luau \
  --platform=roblox --ignore="Packages/**" src tests
stylua --check src tests
```

## Tests

Both suites run from the Studio **command bar in EDIT mode** (not a playtest —
`ServerScriptService` isn't visible to a client-context command bar, and edit mode
also guarantees no real session is running alongside):

```lua
require(game.ReplicatedStorage.Tests.Parity).run()      -- 599 assertions
require(game.ReplicatedStorage.Tests.ServerSpec).run()  -- 383 assertions
```

- **`Parity`** replays `tests/fixtures/*.json` — recordings of the live TS engine
  produced by `tools/dumpFixtures.ts` — against the Luau modules (Et, Aggregate,
  Fills, Engine, ContractMath, and BarCodec's exact byte layout). Any change to
  web engine behavior means regenerating the fixtures and rerunning this.
- **`ServerSpec`** drives the real `Session` against the real `BarStore` and
  asserts the packets it emits: reveal loop, step/rewind voiding, command
  surface, fills and brackets, persistence, and the anti-lookahead audit.

Both print a pass/fail summary and the first failing cases.

## Data pipeline

```sh
npx tsx roblox/tools/prepareData.ts                          # from the REPO ROOT
npx tsx roblox/tools/uploadData.ts --universe <id> --dry-run  # then without --dry-run
```

`prepareData` pulls the day chunks, applies one dataset-wide price shift
(licensing hygiene — absolute levels are destroyed, every price *relationship*
including cross-month continuity survives), packs month buffers plus a deep 1h
history, and round-trips every byte. `uploadData` needs an Open Cloud API key in
`ROBLOX_OPENCLOUD_KEY`. **Read `tools/DATA.md` before running either** — it has
the one-time key setup, the canonical-vs-dev-slice rules, and the upload shape.

## Controls

**Keyboard** (all ignored while a text box has focus):

| Key | Action |
|---|---|
| `Space` | play / pause |
| `Ctrl`+`Space` | step forward exactly one bar |
| `→` / `←` | step forward / back one bar |
| `↑` / `↓` | speed up / down one rung of the ladder |
| `1`…`0` | timeframe: 1m, 2m, 3m, 4m, 5m, 15m, 30m, 1h, 4h, 1D |
| `Esc` | cancel an armed order placement or drawing tool |

**Chart:** mouse wheel zooms about the cursor; drag the plot to pan; drag the
**price axis** to stretch the scale (double-click it to return to auto-fit); drag
the **time axis** to change bar spacing. Parking at the right edge re-arms
follow-tail, panning away disarms it; the **follow** button re-arms it directly.

**Trading:** in the order panel (top-left) pick BUY/SELL and MKT/LMT/STP, fill
qty/SL/TP, and press the submit button. The four **arm** buttons (Buy/Sell Lmt,
Buy/Sell Stp) are the second way in: arming hands the *next* chart click to the
panel and turns the clicked price into that order. Working orders
render as draggable lines with ✕ to cancel. The **draw toolbar** (left edge) arms
ray/rect/delete the same way. Bottom bar holds the clock, transport, speed, step
size, timeframes and a jump-to-ET-time box; **boards** opens the leaderboards.

## Where to read next

| File | What's in it |
|---|---|
| `CLAUDE.md` | non-negotiable invariants, Luau conventions, Rojo layout, parity rules |
| `PORT_PLAN.md` | every architecture decision and *why*, phase status, platform limits |
| `META_PLAN.md` | Phase 5 designs: leaderboard, daily challenge, 1v1, deep history, drawings |
| `GAP_REPORT.md` | the round-2+ work queue — where the port still differs from the web chart |
| `tools/DATA.md` | data pipeline runbook, normalization, Open Cloud setup, upload shape |

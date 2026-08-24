# Roblox Backtester (port)

Friends-only Roblox port of the base NQ backtester — replay engine, chart,
manual trading. NO bots, NO FVG/strategy perception. Decisions and phase plan
live in `PORT_PLAN.md`. The web engine (`../web/src/lib/`) is the reference
implementation; the parity fixtures under `tests/fixtures/` are the contract
between the two.

## Non-negotiables (carried over from the web app)

- All timestamps are epoch seconds UTC. Eastern-Time math exists ONLY in
  `src/shared/Time/Et.luau` — pure arithmetic, no `DateTime`/`os.date`, so the
  module also runs outside Roblox (Lune) unchanged.
- No-lookahead is structural: the SERVER owns the replay clock and streams
  revealed bars to clients over remotes. Client code never holds future bars.
- Fill rules are the spec in `web/src/lib/trading/fills.ts`, ported exactly.
  This port has no 1s data: the conservative SL-first same-bar default always
  applies (the `secondsFor` resolver is kept in the API, always nil in game).
- The event log is append-only; trading state is always derived by folding
  (`Engine.deriveState`). Rewind voiding is derived, never written.

## Luau conventions

- `--!strict` in every file (new type solver).
- Arrays are 1-based; never leave nil holes; `#` only on hole-free arrays.
- Luau `%` is FLOORED modulo (JS `%` truncates toward zero) — audit any
  modulo with possibly-negative operands when porting.
- Where the TS relies on insertion-ordered `Map`s and that order is observable
  (Engine's `workingOrders`), use an ordered-map idiom (keys array + dict).
  `pairs()` order is unspecified — never let it reach an output.
- Bar data crossing remotes or storage travels as `buffer` (packed binary),
  never as tables of tables.
- Keep the load-bearing invariant comments from the TS source (translated);
  drop TS-specific noise.

## Layout (Rojo)

`default.project.json` maps:

| Filesystem | DataModel |
|---|---|
| `src/shared/` | `ReplicatedStorage.Shared` (pure engine — server+client) |
| `src/server/` | `ServerScriptService.Server` |
| `src/client/` | `StarterPlayer.StarterPlayerScripts.Client` |
| `tests/` | `ReplicatedStorage.Tests` (parity runner + JSON fixtures) |

`rojo serve` + the Studio plugin syncs the filesystem into Studio. Tool
versions are pinned in `rokit.toml`.

PORTS: 34872 (Rojo's default) and 34873 are TAKEN on this machine. Always
serve with `rojo serve --port 34875` and point the Studio plugin at that port.

STUDIO SAFETY: the user keeps OTHER, non-scratch places open in Studio.
Before any Studio MCP call that mutates state, list the open instances and
confirm the backtester place is the target — never assume the only/first
instance is ours.

## Parity testing

- `tools/dumpFixtures.ts` (run: `npx tsx roblox/tools/dumpFixtures.ts` from
  the repo root) imports the LIVE web engine and records inputs+outputs as
  JSON fixtures in `tests/fixtures/`. Fixtures are recordings of the TS
  engine's behavior — never hand-computed.
- Rojo maps each fixture `.json` to a ModuleScript.
  `ReplicatedStorage.Tests.Parity:run()` replays every case against the Luau
  port in Studio and prints a summary.
- Keep each fixture file under 120k chars (Script.Source caps at 200k).
- Display-only formatters (`fmtPts`, `fmtUsd`, `formatET`) are excluded from
  parity — JS `toFixed` and `string.format` round differently.
- Any engine-behavior change on the web side ⇒ regenerate fixtures, rerun
  parity.

The repo-root senior/subagent workflow (`.claude/AGENT_WORKFLOW.md`) applies
here unchanged.

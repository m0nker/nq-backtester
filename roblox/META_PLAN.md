# Phase 5 — Meta layer (leaderboard, daily challenge, 1v1) + two scopings

Implementation-ready design. Each numbered section is written to be handed to
one implementer agent as-is. Sections 0–3 share a spine; **§0 must land before
§1/§2/§3 start** (they would otherwise all edit `Protocol.luau` and
`Session.luau` at once). §4 and §5 are independent of §1–§3 once §0's remote
signature change is in.

Everything here obeys the standing ground rules: ET math only in
`src/shared/Time/Et.luau`, no-lookahead enforced server-side, pure logic in
`shared/`+`server/`, client modules display-only.

## Platform limits this plan relies on

Verified Aug 2026 against `create.roblox.com/docs/cloud-services/data-stores/error-codes-and-limits`
unless noted.

| Limit | Value | Where it binds |
|---|---|---|
| DataStore value size | 4,194,304 characters per key | §4 `hist:1h` (73% used) |
| DataStore key name | 50 chars | all keys below |
| DataStore scope | 50 chars | §1 weekly board rotation |
| Storage quota | 500 MB + 1 MB × lifetime users | §4 adds ~3 MB once |
| Per-key read throughput | 25 MB/min | §4: 3 MB key ⇒ 8 reads/min ceiling |
| Per-key write throughput | 4 MB/min | §4 upload: don't rewrite the key twice in a minute |
| Ordered SetAsync/IncrementAsync budget | 300 + 20 × concurrent users /min | §1/§2 board writes (trivial at friends scale) |
| Ordered GetSortedAsync (List) budget | 300 + 20×… experience-wide, **but server default 5 + 2 × numPlayers /min** | §1 — this is the tight one, mandates server-side caching |
| OrderedDataStore value type | 64-bit **integer**; negative values are rejected/mis-sorted in practice | §1/§2 integer encoding |
| Luau number exactness | f64 ⇒ integers exact only up to 2^53 ≈ 9.007e15 | §1 encoding must stay ≤ 2^53, **not** 2^63 |
| `GetSortedAsync` pageSize | believed capped at 100 | §1 asks for 20 — **VERIFY in Studio**, the docs page does not state it |

Two of these are not stated cleanly in current Roblox docs and must be
confirmed in Studio before the code depends on them:

1. **OrderedDataStore rejects negative values.** RESOLVED 2026-08-24 — the
   startup probe ran against the live store and a negative value was
   **ACCEPTED**, so the long-standing community claim is wrong (at least
   today). The cent-offset encoding is therefore not strictly required; it
   is KEPT anyway (monotonic, harmless, and immune to the behavior ever
   changing back). Do not remove the offset without migrating stored values.
2. **`GetSortedAsync` pageSize cap.** Ask for 20; if 100 is legal we still
   only want 20.

---

## §0 — Meta spine (prerequisite, not parallelizable)

Files: `src/shared/Net/Protocol.luau`, `src/server/Data/PlayerStore.luau`,
`src/server/Replay/Session.luau`, `src/server/Main.server.luau`.

Nothing user-visible ships here. This exists so §1/§2/§3/§4 never touch the
same file.

### 0.1 Protocol additions

Add one server→client remote, `Meta`, carrying a tagged union. One remote, not
five, keeps `REMOTE_NAMES` short and the client's boundary casts in one place.

```
M.REMOTE_NAMES = { "Cmd", "Clock", "Bars", "TradeState", "SessionInfo", "Meta" }
```

```
--   Meta (RemoteEvent, server -> client): { kind = string, ... }
--     kind = "board"      -> { board: string, rows: { BoardRow }, you: BoardRow? }
--     kind = "challenge"  -> { dateKey: string, state: "available"|"live"|"done",
--                              score: number?, rows: { BoardRow }, you: BoardRow? }
--     kind = "duelInvite" -> { matchId: string, fromUserId: number, fromName: string,
--                              expiresIn: number }
--     kind = "duelState"  -> { matchId: string, oppName: string, barsLeft: number,
--                              oppBarsLeft: number }
--     kind = "duelResult" -> { matchId: string, date: string, you: DuelSide,
--                              opp: DuelSide, outcome: "win"|"loss"|"draw"|"void" }
```

```lua
export type BoardRow = { rank: number, userId: number, name: string, value: number }
export type DuelSide = { name: string, scoreUsd: number, trades: number, forfeit: boolean }
```

New `Cmd` shapes (all server-validated; the client stays untrusted):

```
--   { cmd = "board", board = "pnlAll"|"pnlWeek"|"winRate" }
--   { cmd = "challengeInfo" }
--   { cmd = "challengeStart" }
--   { cmd = "duelInvite", targetUserId = number }
--   { cmd = "duelAccept", matchId = string }
--   { cmd = "duelDecline", matchId = string }
--   { cmd = "drawingUpsert", d = { ... } }     -- §5
--   { cmd = "drawingRemove", id = string }     -- §5
--   { cmd = "drawingClear" }                   -- §5
```

**Bars remote signature change (needed by §4, folded in here so §4 can start
immediately):**

```
--   Bars  (RemoteEvent, server -> client): (packet: buffer, mode: string)
--         mode = "reset"   -> replace the client bar cache (session start / jump / rewind)
--         mode = "append"  -> newly revealed base bars
--         mode = "history" -> 1h bars strictly BEFORE the cache's first base bar
--                             (§4); never revealed data, never appended to `base`
```

The existing `reset: boolean` argument becomes `mode: string`. Both call sites
(`Session.sendBars`, `Main.client.luau`) change together; `BarCache.applyPacket`
takes `mode: string`. This is a breaking wire change and is the reason it goes
in §0 rather than in §4.

`SessionInfo` gains two fields:

```lua
export type SessionInfo = {
	...
	hidden: boolean?, -- challenge/duel session: `date` is nil and every outgoing
	                  -- timestamp is in the wire frame (see §2.3)
	mode: string?,    -- "free" | "challenge" | "duel"
}
```

### 0.2 `Session` hidden-session support

`Session.Session` gains four fields:

```lua
	-- Challenge/duel sessions never ship real timestamps. EVERY outgoing time is
	-- +wireOffset and every inbound time is -wireOffset; the server's own state
	-- (bars, currentTime, event log) stays in real epoch seconds so the
	-- anti-lookahead asserts keep comparing real values.
	wireOffset: number,     -- 0 for free sessions
	mode: string,           -- "free" | "challenge" | "duel"
	noRewind: boolean,      -- stepBack and backwards jumpTo are rejected
	endIdx: number?,        -- reveal stops here (index into `bars`); nil = end of day
```

Add `Session.startHidden(s, date, opts)` beside `cmdStartSession`. It is
`startSessionInner` with three deltas, and the existing `switching` guard is
reused verbatim:

- session start anchors at `opts.startAtEtHour` when given (see §0.3) instead
  of `bars[1]`;
- `s.wireOffset`, `s.mode`, `s.noRewind`, `s.endIdx` are set before the first
  `sendBars`;
- `persistWrite(s)` is called immediately after the client is served — the
  attempt must be recorded before the player can crash out of it.

`handleCmd` gains, right after the `s.date == nil` guard:

```lua
	if s.noRewind and (cmd == "stepBack" or (cmd == "jumpTo" and msg.t ~= nil and msg.t - s.wireOffset < s.currentTime)) then
		return -- a rewind voids the losing trade; on a scored session that is free money
	end
```

`revealOne` gains an `endIdx` stop; `tick` treats reaching it exactly like
reaching `#s.bars` (stop playing, mark clock dirty, flush).

### 0.3 RTH anchoring for scored sessions

A trading day opens 18:00 ET. A scored session that starts there spends its
first hours in thin overnight tape, which is bad gameplay and makes the
"same duration" fairness rule of §3 nearly meaningless.

`startHidden` accepts `startAtEtHour = 9, startAtEtMin = 30`. Implementation:
`BarStore` already parses `YYYY-MM-DD` into y/mo/d; call
`Et.etWallToUtc(y, mo, d, 9, 30)` and pick the first bar with `b.t >= that` as
`bars[1]` of the *session*, with every earlier bar of the day folded into the
context prefix (they are closed history, exactly like `withContext`'s output —
`revealedCount` starts at the new, larger `contextCount` and `processBar`'s
`bar.t >= s.startTs` assert still holds).

**Constraint:** this is the ONLY new ET arithmetic in the whole plan, and it is
a call into `Et.luau`. No section below may compute a timezone offset itself.

### 0.4 `PlayerStore` schema extension

`PlayerData` grows three optional branches. Every one gets a `sanitizeX`
following the existing idiom exactly: unknown/malformed ⇒ drop that branch,
never the whole record (the "one malformed event discards the whole session"
rule stays specific to `active`, whose partial read is genuinely dangerous).

```lua
export type Stats = {
	sessions: number, trades: number, pnlUsd: number, wins: number,
	week: { key: string, sessions: number, trades: number, pnlUsd: number, wins: number }?,
}
export type ChallengeRecord = { dateKey: string, tradingDate: string, done: boolean, scoreUsd: number, startedAt: number }
export type DuelRecord = { matchId: string, oppUserId: number, oppName: string, myUsd: number, oppUsd: number, result: string, at: number }
export type Drawing = { id: string, kind: string, t1: number, p1: number, t2: number, p2: number, palette: number, width: number }
export type PlayerData = {
	active: ActiveSession?,
	stats: Stats,
	challenge: ChallengeRecord?,   -- the MOST RECENT attempt only
	duels: { DuelRecord }?,        -- capped, newest first
	drawings: { [string]: { Drawing } }?, -- instrument -> shapes
}
```

Caps, all enforced in `M.save` beside the existing `MAX_EVENTS` check, because
they share the same 4 MB key:

```lua
M.MAX_EVENTS = 20000            -- unchanged; ~dominant term
M.MAX_DUELS = 20                -- ~150 B each = 3 KB
M.MAX_DRAWINGS = 200            -- ~120 B each = 24 KB
```

Over-cap duels/drawings are **truncated** (drop oldest) rather than making the
save fail — unlike the event log, losing an old drawing is not a correctness
problem, and refusing the write would take the event log down with it.

`MAX_DEPTH = 16` still covers the new shapes (deepest is
`data.stats.week.pnlUsd` = 3, `data.drawings.NQ[i].t1` = 4).

---

## §1 — Leaderboard

New files: `src/server/Meta/Board.luau`, `src/client/UI/Leaderboard.luau`.
Edited: `src/server/Replay/Session.luau` (one hook), `src/server/Main.server.luau`
(one command route).

Size: **M**.

### 1.1 Metrics and boards

Three boards, all sourced from `PlayerStore.Stats.elig` — the eligible-only
fold (see the revision note below).

| Board id | Metric | Source | Gate |
|---|---|---|---|
| `pnlAll` | lifetime realized USD | `stats.elig.pnlUsd` | `elig.sessions` ≥ 3 |
| `pnlWeek` | this trading week's realized USD | `stats.elig.week.pnlUsd` | `elig.week.key` is the current week |
| `winRate` | **trade** win rate, basis points | `stats.elig.tradeWins / stats.elig.trades` | `elig.sessions` ≥ 10 |

**REVISION (implementation of §1, landed): boards read `stats.elig`, never the
lifetime counters.** As originally written, §1.5 gated which *session* was
allowed to trigger a post, but the value posted was the lifetime total — and
`finalizeActive` folds every session into that total, ineligible ones included.
A player could therefore rewind-farm free money in session 1 (never posted, but
banked in `stats.pnlUsd`), then play one clean session 2 and launder the whole
contaminated total onto the board. `Stats` now carries a second bucket,
`elig = { sessions, trades, tradeWins, pnlUsd, week = { key, pnlUsd }? }`,
folded **only** when `Board.eligible` passes; the lifetime fields stay as the
HUD/lifetime truth and are folded unconditionally as before. This also makes
the "≥ N eligible sessions" gates exact rather than an approximation against
`stats.sessions`. `elig.week` is created solely by an eligible fold, so its
presence under the current week key *is* "≥ 1 eligible session this week" and
needs no session counter of its own. Players who predate the branch start with
an empty one — their boards start clean, which is the intent, not a migration
gap.

**Read `wins` carefully before implementing.** `finalizeActive` increments
`stats.wins` when `outgoing.realizedUsd > 0 and #outgoing.trades > 0` — that is
a *winning session*, not a winning trade. The board must be labelled "session
win rate" in the UI. A per-trade win rate would need a new counter
(`stats.tradeWins += count of trades with pnlUsd > 0`) in the same fold; that
is a one-line addition and is the better metric, but it starts at zero for
every existing player, so it needs a schema-version bump or an accepted
discontinuity. **Recommendation: add `tradeWins`, ship `winRate` off it, and
accept that pre-existing players start at 0/0 (gated out by the min-sessions
rule anyway).**

**LANDED: the recommendation was taken.** `winRate` is a per-TRADE rate off
`elig.tradeWins / elig.trades`, so §1.7's UI must label it "win rate" (per
trade), NOT "session win rate". `stats.wins` still counts winning sessions and
is kept for the HUD; no board reads it.

### 1.2 OrderedDataStore layout

One `OrderedDataStore` per metric, **rotated by scope**, not by name — the
store name stays stable and readable, and scope is the mechanism Roblox
provides for exactly this:

```lua
local PNL_STORE = "lb_pnl_v1"       -- 9 chars, cap 50
local WR_STORE  = "lb_winrate_v1"
-- scopes:
--   "all"          lifetime
--   "w2026-08-24"  the trading week whose Sunday-18:00-ET open maps to that
--                  Monday trading date
```

**Deviation from the spec's `lb:pnl:2026-W35`, deliberate.** ISO week numbers
require week-53 and year-boundary handling that does not exist anywhere in this
codebase, and `Et.luau` has no week-number function. The week's *start date* is
already computable from `Et.tradingWeekStartSec` + `Et.tradingDateOf` with zero
new date math, sorts lexicographically, and cannot collide across years:

```lua
-- The leaderboard week is the CME trading week (Sunday 18:00 ET open); the key
-- is that week's Monday trading date. Everything a player books between two
-- Sunday opens lands in one key.
local function weekKey(nowSec: number): string
	return "w" .. Et.tradingDateOf(Et.tradingWeekStartSec(nowSec))
end
```

Known quirk to document in the code: Friday 17:00 ET → Sunday 18:00 ET is
outside every trading week; `tradingWeekStartSec` maps that dead zone to the
*outgoing* week. A player who finishes a session Saturday afternoon scores into
the week that just closed. This is deterministic and defensible; do not
"fix" it with ad-hoc arithmetic outside `Et.luau`.

### 1.3 Integer encoding

OrderedDataStore takes integers, and negatives must be assumed unusable
(§ Platform limits). PnL is a float in dollars and routinely negative.

```lua
-- OrderedDataStore values are integers and (per the platform notes) must be
-- non-negative, so dollars travel as cents shifted into a non-negative window.
-- The window is sized so the ENCODED value stays under 2^53: Luau numbers are
-- f64, and an integer past 2^53 stops round-tripping exactly long before the
-- store's own 2^63 ceiling.
local CENTS_OFFSET = 10_000_000_000        -- encodes down to -$100,000,000.00
local CENTS_MAX = 10_000_000_000           -- and up to +$100,000,000.00

local function encodeUsd(usd: number): number
	-- floor(x + 0.5) is the codebase's rounding idiom (BarCodec); it rounds
	-- half toward +inf on both signs, which is deterministic.
	local cents = math.floor(usd * 100 + 0.5)
	cents = math.clamp(cents, -CENTS_OFFSET, CENTS_MAX)
	return cents + CENTS_OFFSET            -- [0, 2e10], exact in f64
end

local function decodeUsd(v: number): number
	return (v - CENTS_OFFSET) / 100
end
```

Clamp **before** the offset, never after: an unclamped pathological value could
land negative post-offset, which is the one thing the encoding exists to
prevent.

Win rate needs no offset — basis points are already in `[0, 10000]`:
`math.floor(wins / sessions * 10000 + 0.5)`.

### 1.4 When writes happen — and the gap you must know about

**The hook is `finalizeActive(s)` in `src/server/Replay/Session.luau`.** That
is the single function that folds a finished session into `data.stats`, and it
is the only correct place to post a score.

`finalizeActive` is currently called from exactly one place: `startSessionInner`,
i.e. **when the player starts their NEXT day**. It is *not* called from
`PlayerRemoving`/`BindToClose` (`persistNow` → `persistWrite` saves the active
log for resume but never folds it). Consequence: a player who plays one day and
leaves does not appear on the board until they come back and start another
session. Three options, pick one and state it in the code:

- **(a) Accept it** (recommended for v1). It is consistent with resume
  semantics — an unfinished session is still resumable, and folding it into
  stats on disconnect would double-count it when they resume. Zero risk.
- (b) Fold on disconnect *and* clear `data.active`, i.e. disconnect ends the
  session. Changes resume behavior; out of scope for §1.
- (c) Post a provisional score. Two sources of truth on the board; don't.

Write mechanics, in `finalizeActive` after the stats update:

```lua
	-- The board write is a DataStore round trip and finalizeActive runs inside
	-- startSessionInner's switching guard, on the path the player is waiting on.
	-- Totals are captured here (synchronously, before any yield) and the write
	-- goes to its own thread.
	if Board.eligible(outgoing, s) then
		Board.post(s.player, table.clone(data.stats))
	end
```

`Board.post` spawns, retries 3× with backoff, and is a no-op in Studio without
API access (same `pcall` + degrade idiom as `PlayerStore`/`BarStore` — never
assert a platform call).

Write budget: one `SetAsync` per board per session switch. With 8 friends that
is a handful per minute against a `300 + 20 × users` allowance. Non-issue.

### 1.5 Anti-abuse

A session is **leaderboard-eligible** only if all of these hold. Check them in
`Board.eligible(outgoing: Engine.EngineState, s: Session.Session)`:

```lua
-- 1. NO REWINDS. Engine.deriveState voids every event after a rewind target,
--    so a rewound losing trade simply stops existing — on a scored board that
--    is a money printer. This is the rule that matters; the rest are hygiene.
outgoing.voidedCount == 0
-- 2. Real session length: at least MIN_SESSION_BARS base bars revealed past
--    the context prefix (120 = two hours of tape).
(s.revealedCount - s.contextCount) >= 120
-- 3. At least one CLOSED trade — an untraded session is neither win nor loss
--    (finalizeActive already declines to count it as a win).
#outgoing.trades >= 1
```

Deliberately **not** gated: position size. `MAX_QTY = 100` already bounds it,
and size selection is part of the game on the free-play boards. If the pnl
boards turn into a one-lucky-100-lot contest, the fix is a separate
`lb_pnl_1lot_v1` board gated on `every trade qty <= 1`, not a global cap —
raise it with the senior rather than changing `MAX_QTY`.

### 1.6 Reads, caching, names

`GetSortedAsync` is a **List** operation, and the per-server default list
budget is `5 + 2 × numPlayers` per minute. With 6 players that is 17/min for
the whole server across all three boards. A UI that refetches on every panel
open would exhaust it.

```lua
-- GetSortedAsync draws on the server's LIST budget (5 + 2*players per minute),
-- which a panel that refetches on open would burn through in seconds. Every
-- board is fetched at most once per BOARD_TTL and every client request is
-- answered from that snapshot.
local BOARD_TTL = 60
```

Cache shape: `{ [boardId]: { fetchedAt: number, rows: { BoardRow } } }`, top 20
(`ods:GetSortedAsync(false, 20)`, descending, first page only). A request
inside the TTL is answered synchronously from cache; a request past it starts
one fetch and every concurrent caller waits on that same fetch (same
`while loading do task.wait() end` idiom as `ensurePersistLoaded`).

Player names: `Players:GetNameFromUserIdAsync(userId)` yields, is rate-limited
and can throw. Memoize permanently per server, `pcall`ed, fallback
`"Player " .. userId`. Do not persist names in `players_v1` — a stale name
there would outlive a rename with no way to notice.

"Your rank" (`you`): `GetSortedAsync` does not give a rank for an arbitrary
key. v1 answer: if the player is in the top 20, `you` is their row; otherwise
`you = { rank = 0, userId, name, value }` and the UI prints "—" for rank.
Computing a true global rank means paging the whole board; explicitly out of
scope.

### 1.7 Client UI

`src/client/UI/Leaderboard.luau`, modeled on `SessionPicker.luau` line for
line: full-screen modal `Frame` (`Active = true` to swallow chart clicks),
inner `Panel`, a `ScrollingFrame` of pooled rows, a HUD `TextButton` to open
it. Three tab buttons switch `board` and fire
`send({ cmd = "board", board = id })`.

Follow `SessionPicker`'s rebuild discipline: rows are rebuilt only when a
`Meta { kind = "board" }` payload arrives, never per frame. Unlike
`SessionPicker` (which destroys and recreates), pool the rows — a board
refresh is periodic, a date list is not. Cap at 20 rows, created once.

Formatting: `string.format("%+.2f", usd)` for pnl, `string.format("%.1f%%", bp / 100)`
for win rate. Display formatters are excluded from parity (CLAUDE.md) so
there is no fixture obligation here.

---

## §2 — Daily challenge

New files: `src/server/Meta/Challenge.luau`, `src/client/UI/Challenge.luau`.
Edited: `src/server/Replay/Session.luau` (scoring hook), `src/server/Main.server.luau`
(command routes).

Size: **L** — the wire-frame plumbing (§2.3) is most of it.

### 2.1 The seeded day pick

Same mystery day for everyone, deterministic from the ET calendar date, and
**not computable by a client**.

```lua
-- The challenge rolls at ET midnight. Et.formatET is the only ET formatter in
-- the codebase and its first 10 chars ARE the ET calendar date, so the key
-- needs no new date math.
local function challengeDateKey(nowSec: number): string
	return string.sub(Et.formatET(nowSec), 1, 10)   -- "YYYY-MM-DD"
end
```

```lua
-- Deterministic across servers and Luau versions. bit32 has no multiply, and a
-- 32-bit FNV would lose precision in f64, so this is a rolling polynomial mod a
-- prime: the largest intermediate is 1e9 * 131 + 255, far under 2^53, so every
-- step is exact.
local MOD = 1000000007
local function hashString(s: string): number
	local h = 166136247 -- 2166136261 % MOD
	for i = 1, #s do
		h = (h * 131 + string.byte(s, i)) % MOD
	end
	return h
end
```

**The salt lives in this server-only module and must never move to `Shared`.**
`SessionInfo.availableDates` is sent to every client, so an unsalted pick is
reproducible client-side — a player could compute tomorrow's day and practise
it. Rojo maps `src/server/` to `ServerScriptService`, which never replicates.

```lua
-- Rerolling this invalidates nothing but future picks; never log it.
local SALT = "<generate 16 random chars at implementation time>"
```

Eligible pool, from `BarStore.availableDates()`:

```lua
-- A day a player might RECOGNIZE is a broken challenge. Price normalization
-- already destroys absolute levels, so recognition would have to come from
-- shape — which is exactly what recent memory supplies. The trailing window is
-- cut wholesale.
local RECENT_EXCLUDE_MONTHS = 24
-- The first days of the dataset have no prior month to draw a context prefix
-- from (BarStore.barsBefore degrades to fewer bars); a challenge that opens on
-- a blank chart reads as broken.
local LEADING_EXCLUDE_DAYS = 5
```

`index = 1 + (hashString(SALT .. ":" .. dateKey) % #eligible)`.

Cache the resolved `tradingDate` per `dateKey` per server. **Known risk:** the
pool is derived from the live manifest, so an upload that adds a month changes
`#eligible` and therefore changes today's pick on servers that start after the
upload. The dataset is upload-static in practice; note it in the code and do
not upload data mid-day.

### 2.2 One attempt per player per day

`PlayerData.challenge` (§0.4) holds only the most recent attempt.

```lua
local function attemptState(data: PlayerStore.PlayerData, dateKey: string): string
	local c = data.challenge
	if c == nil or c.dateKey ~= dateKey then return "available" end
	return if c.done then "done" else "live"
end
```

The record is written **at start, not at finish**:

`Challenge.start(s)` → `ensurePersistLoaded` → set
`data.challenge = { dateKey, tradingDate, done = false, scoreUsd = 0, startedAt = os.time() }`
→ `Session.startHidden(...)` → `persistWrite(s)` before returning. Anything
else lets a player quit before the write and retry forever.

`"live"` is resumable (the existing `tryResume` path restores the session log
as usual; `Challenge` re-derives `wireOffset` from `tradingDate`, which is a
pure function of it — see §2.3, so no offset is persisted).

### 2.3 Hiding the date — the leak surface, exactly

**Enumerate before designing.** Four things carry the real date to a client
today, and only four:

1. **`Bars` packet `t` values** (`BarCodec` writes `u32 t` epoch seconds).
   Consumed by `ChartView.paintTimeAxis` (`Et.tradingDateOf`, `Et.formatET`)
   and the crosshair readout.
2. **`Clock.t`** — `src/client/UI/Controls.luau` renders it as
   `Et.formatET(msg.t, true)`, which prints the full `YYYY-MM-DD … ET`.
3. **`SessionInfo.date`** — populated whenever a session is running.
4. **`TradeState.trades[].entryTs` / `.exitTs`** — on the wire today even
   though `TradeLog.luau` does not currently render them. A client that dumps
   the payload reads the date straight off.

Nothing else leaks: prices are per-month rebased to open at 20000 already, and
`ChartView` never draws volume.

**Design: one wire frame, applied at the boundary.**

```lua
-- Challenge and duel sessions expose a SHIFTED clock. The shift is not an
-- arbitrary offset: it maps the day's 18:00 ET open onto a fixed synthetic
-- week's 18:00 ET open, so ET wall-clock times are preserved EXACTLY and every
-- client-side ET computation (bucket alignment, axis labels, the trading-day
-- boundary) stays correct in the shifted frame. Only the calendar date is a
-- lie, and it is the same lie every time.
```

```lua
-- Mid-January 2001: far from any DST transition, so neither the session day nor
-- the ~1.5 trading days of context prefix can straddle one. 2001-01-08 is a
-- Monday, so aligning the weekday costs nothing and keeps the weekend gap in
-- the context prefix where the data actually has it.
local SYNTH_MONDAY = { y = 2001, mo = 1, d = 8 }

local function wireOffsetFor(tradingDate: string, dayStartSec: number): number
	local dow = weekdayIndexOf(tradingDate)                 -- 0 = Monday
	local y, mo, d = civilAdd(SYNTH_MONDAY, dow)            -- via Et helpers
	return Et.etWallToUtc(y, mo, d, 18) - dayStartSec
end
```

Why this is exact, and why the naive "add a constant" version is not: the ET
UTC offset is constant *within* a trading day (DST flips Sunday 02:00 ET, market
closed — `Et.luau` says so in its own comments). Both anchors are 18:00 ET
computed by `Et.etWallToUtc`, so adding the difference maps real 09:30 ET to
synthetic 09:30 ET regardless of whether the real day was EDT and the synthetic
one EST. An arbitrary offset (e.g. "+3 years") would land the 18:00 ET open at
17:00 or 19:00 ET in the shifted frame, and `Aggregate.bucketStart` would then
assign the first hour to the previous trading day — silently corrupting every
1D/1W/1M candle and the intraday bucket phase.

**Application points — the complete list.** Add `+ s.wireOffset` at:

| Where | What |
|---|---|
| `Session.sendBars` | shift each bar's `t` in the encoded slice. **Do the shift in the copy `encodeSlice` builds, never in `s.bars`** — `revealedAt`, `processBar`, `rewindTo` and both anti-lookahead asserts all read `s.bars` in real time |
| `Session.sendClock` | `t = s.currentTime + s.wireOffset` |
| `Session.sendTradeState` | `entryTs` / `exitTs` on every trade (rebuild the trade rows; do not mutate `st.trades`, it is derived state) |
| `Session.sendSessionInfo` | `date = nil`, `hidden = true`, `mode = s.mode` |

And `- s.wireOffset` at:

| Where | What |
|---|---|
| `handleCmd` `jumpTo` | `msg.t` before validation. The client does not send `jumpTo` today (grep: no client call site) but the rule must be in the code, not in a comment |

`BarCodec.encodeSlice` gains an optional `tOffset: number?` parameter (default
0) rather than a caller-side copy of the bar array — 2000 bars copied per
reset packet is avoidable, and the codec is the one place that already knows
the `t` field.

**Residual leak, accepted with a cheap mitigation available:** volume is not
normalized, and NQ volume grew by an order of magnitude between 2010 and 2026.
Nothing renders it, but it is in the buffer. If that matters, zero the `v`
field in hidden-session packets (one line in `encodeSlice`'s offset branch).
Recommend doing it — it costs nothing and the client has no use for volume
today.

**Rejected alternative: client-side session-relative display.** Making
`ChartView` print "T+03:15" instead of a wall clock in challenge mode is
strictly weaker — the real timestamps are still in the buffer, so it protects
against nothing but a casual glance, and it costs a display branch in the hot
repaint path. It is worth adding *on top of* the wire offset only if the fake
"2001-01-10" date reads as confusing; the wire offset is the security boundary
either way.

### 2.4 Scoring

- Starting balance: the existing `STARTING_BALANCE = 10000`.
- Session window: `startAtEtHour = 9, startAtEtMin = 30` (§0.3),
  `endIdx = contextCount + CHALLENGE_BARS` with `CHALLENGE_BARS = 390`
  (6.5 h — one RTH session).
- Forced end: reveal stops at `endIdx`; `tick` and `cmdStepForward` both
  refuse to go past it.
- **Settlement is mark-to-market, not a forced flatten.** A synthetic market
  order cannot fill: market orders fill on the *next* revealed bar and there
  is none. Instead:

```lua
-- The day is over and there is no next bar to fill against, so an open
-- position is settled at the last revealed close rather than through a fake
-- order. Points -> dollars goes through ContractMath so the challenge and the
-- trade log agree to the cent.
local function scoreUsd(s: Session.Session): number
	local st = s.derived
	local usd = st.realizedUsd
	if st.position.qty ~= 0 then
		local last = s.bars[s.revealedCount]
		if last ~= nil then
			usd += ContractMath.pointsToUsd((last.c - st.position.avgPrice) * st.position.qty)
		end
	end
	return usd
end
```

(Check the exact `ContractMath` helper name when implementing; the signed-qty
form above is the one `Engine` uses for unrealized pnl — mirror it, do not
reinvent it.)

- **Disconnect mid-challenge scores where they stand**, via the existing
  `PlayerRemoving` → `Session.persistNow` path: `Challenge.finish(s)` runs
  first, writes `challenge.done = true` and `scoreUsd`, then the normal flush
  happens. Rationale to put in the comment: scoring a rage-quit as 0 would be
  harsher than the trade already was, and *not* scoring it would make quitting
  the optimal move on a losing day.
- Rewind is rejected (`noRewind = true`), so `voidedCount` is 0 by
  construction and the §1.5 gate is automatically satisfied.
- Starting a free session while a challenge is `"live"` **ends the challenge**
  (score it, then let `startSessionInner` proceed). Do not silently discard it.

### 2.5 Challenge board

`OrderedDataStore("challenge_v1", dateKey)` — scope rotation again, one scope
per challenge day, so the board is naturally per-day with no cleanup. Key =
`tostring(userId)`, value = `encodeUsd(scoreUsd)` from §1.3 (shared module:
put `encodeUsd`/`decodeUsd` in `Board.luau` and have `Challenge` require it —
two copies of that offset is a bug waiting to happen).

Reads go through the same TTL cache as §1.6 with board id
`"challenge:" .. dateKey`.

### 2.6 UX flow

1. HUD "daily challenge" button → `{ cmd = "challengeInfo" }`.
2. Server replies `Meta { kind = "challenge", dateKey, state, score?, rows, you? }`.
3. `state == "available"` → panel shows a confirm ("one attempt, no rewinds,
   6.5 hours of tape, the date is hidden") and a start button →
   `{ cmd = "challengeStart" }`.
4. Server: `Challenge.start` → `Session.startHidden` → the normal
   `SessionInfo` / `Bars(reset)` / `Clock` / `TradeState` burst, with
   `hidden = true`.
5. Client on `hidden`: hides the "new session" button (it would abandon the
   challenge), disables the step-back key binding, and shows a "challenge —
   N bars left" strip. The date shows as the synthetic one; no special-casing
   needed in `ChartView`.
6. On `endIdx`: server scores, posts, replies
   `Meta { kind = "challenge", state = "done", score, rows }` — and this is
   where the real `tradingDate` may finally be revealed, as the payoff.

---

## §3 — 1v1

New file: `src/server/Meta/Match.luau`, `src/client/UI/Duel.luau`.
Edited: `Main.server.luau` (routes + `PlayerRemoving` hook).

Size: **M** *given §2 has landed* (it reuses `startHidden`, `wireOffset`,
`scoreUsd`, `endIdx` wholesale). **L** if built standalone — do not build it
standalone.

### 3.1 Verified: the per-player session registry already supports this

Confirmed by reading `src/server/Main.server.luau`:

- `sessions: { [Player]: Session.Session }` — one independent `Session` per
  player, created in `onPlayerAdded`.
- One `RunService.Heartbeat` walks `joined` in join order and calls
  `Session.tick(s, dt)` per session; nothing is shared between them.
- Every send is `FireClient(s.player, …)`; there is no broadcast anywhere.
- `BarStore` chunk decoding is cached per month, so two sessions on the same
  day share the decoded chunk with no extra DataStore traffic — but note
  `withContext` builds a **separate** `{ Bar }` array per session (two ~3400-bar
  arrays, ~kilobytes; irrelevant).

**No engine change is required to run two sessions on the same hidden day.**
§3 is a coordinator on top, nothing more.

### 3.2 Match lifecycle

```lua
export type Match = {
	id: string,
	a: Player, b: Player,
	tradingDate: string,
	wireOffset: number,      -- SHARED: both sides see the same synthetic clock
	bars: number,            -- DUEL_BARS
	state: string,           -- "pending" | "live" | "done" | "void"
	scored: { [Player]: { usd: number, trades: number, forfeit: boolean } },
	deadline: number,        -- os.clock() wall-clock backstop
}
```

- `DUEL_BARS = 390`, `INVITE_TTL_SEC = 30`, `MATCH_DEADLINE_SEC = 25 * 60`.
- **Invite:** `{ cmd = "duelInvite", targetUserId }` → target must be on this
  server, not already in a match, and not mid-challenge. Server sends
  `Meta { kind = "duelInvite" }` to the target and holds a `"pending"` match.
  One outstanding invite per player, in each direction.
- **Accept:** `{ cmd = "duelAccept", matchId }` → pick the day
  (`Challenge`'s picker, salted with `SALT .. ":duel:" .. matchId` so it is
  never today's challenge day), compute one `wireOffset`, then
  `Session.startHidden(sessionOf(a), date, opts)` and the same for `b` with
  **identical** opts. Both sides get `mode = "duel"`.
- **Fairness unit is bars revealed, not seconds elapsed.** Players pick their
  own playback speed; a wall-clock match would just reward whoever pressed
  "500x". Each side ends at its own `endIdx`; the match resolves when both
  sides are done.
- **Progress:** `Meta { kind = "duelState", barsLeft, oppBarsLeft }` on each
  side, throttled to ~1/sec (piggyback the existing `persistTick` cadence, do
  not add a second heartbeat).
- **Resolve:** both done → `Meta { kind = "duelResult" }` to both, carrying
  both `DuelSide`s **and the real `tradingDate`** (the reveal is the payoff),
  plus a `DuelRecord` appended to each player's `PlayerData.duels`.
- **Forfeit / disconnect:** `PlayerRemoving` → `Match.onLeave(player)`:
  - opponent still live ⇒ leaver is scored where they stand (`scoreUsd`),
    `forfeit = true`, and the result is `"loss"` **regardless of pnl**. State
    the reason in the comment: without it, quitting the moment you are ahead
    on an unfinished match is strictly optimal.
  - both gone ⇒ `state = "void"`, no records written.
  - the leaver's own `DuelRecord` is still written (their session's
    `persistNow` runs right after), so a forfeit shows in their history.
- **Deadline:** `os.clock() > deadline` with either side unfinished ⇒ score
  both where they stand, no forfeit flag. Checked from the same heartbeat as
  `persistTick`.

### 3.3 Explicitly out of scope (minimal-viable)

No matchmaking queue, no rating/ELO, no spectating, no rematch button, no
cross-server matches, no more than 2 players. The roster the client shows is
just `Players:GetPlayers()` minus self, sent on request.

---

## §4 — Scoping: deep history for high timeframes

Size: **L**, and it carries one product decision that must be made before any
code is written.

### 4.0 BLOCKING: the normalization conflict

`prepareData.ts` rebases prices **per calendar month** so every month opens at
20000 (PORT_PLAN's licensing-hygiene row). That is precisely a deliberate
destruction of cross-month price continuity.

A deep 1D/1W/1M chart *is* cross-month price continuity. Built from the
existing per-month-shifted data it would be a sawtooth — a vertical gap back to
20000 at every month boundary — not a price series.

You cannot have both. The three real options:

| | Deep chart | Licensing posture | Cost |
|---|---|---|---|
| **(b) Keep per-month shifts** | sawtooth; 1D/1W usable *within* a month only | unchanged | zero |
| **(c) One global shift for the whole dataset** | correct, continuous | absolute levels still destroyed; **relative history fully preserved and recognizable** | rerun `prepareData.ts` over everything, re-upload ~190 keys |
| **(d) Re-shift the hourly series per session at serve time** | correct, continuous, splices exactly | identical to (c) — it reconstructs the same relative history, just at runtime | (c)'s risk plus per-session compute |

(d) is not a middle ground; it is (c) with extra steps. The honest framing for
the senior: **a continuous multi-year chart and month-broken price continuity
are the same property, and you are choosing which one you want.** (c) still
satisfies the stated goal ("never ship recognizable CME price levels" — a
single undisclosed shift does that), it just no longer breaks the *shape* of
multi-year history. If that is acceptable, take (c): it is one flag in
`prepareData.ts` (`--global-shift`) and a re-upload, and everything below then
works unmodified.

Everything from §4.1 on assumes the decision is made; the design is identical
either way, only the numbers in the packed file change.

### 4.1 The `hist:1h` key

Same `bars_v1` DataStore (standard, not ordered), key `hist:1h` (7 chars, cap
50). Value: base64 of a **BarCodec v1** buffer — same format, same decoder,
same `tickSizeOf` header accessor. No new codec.

Size, computed against the real dataset (~4150 trading days, 23 hourly buckets
per 23 h trading day plus the old-era 17:00–17:59 hour, ≈ 23.2 avg):

```
bars      ≈ 4150 × 23.2                = 96,280
raw       = 20 + 24 × 96,280           = 2,310,740 B   (2.20 MiB)
base64    = ceil(2310740/3) × 4        = 3,081,000 chars
limit                                    4,194,304 chars
headroom  = 1,113,304 chars ≈ 35,000 more bars ≈ 1,500 trading days ≈ 6 years
```

**It fits, with 27% to spare, and stays fitting for roughly six more years of
daily data.** Split rule for beyond that, to write into the tool now so the
format never needs a migration: if the packed value would exceed
`3,800,000` chars, emit `hist:1h:1`, `hist:1h:2`, … split on year boundaries,
and have the server concatenate keys until a `GetAsync` returns nil. One extra
`GetAsync` per key at server start, cached forever.

Throughput notes that bind the *upload*, not the game:

- per-key write throughput is 4 MB/min ⇒ the 3 MB write consumes most of a
  minute's budget for that key. `uploadData.ts`'s existing 500 ms throttle is
  fine as long as it does not write `hist:1h` twice in one run.
- per-key read throughput is 25 MB/min ⇒ 8 reads/min ceiling. The server reads
  it **once per server**, cached in `BarStore`. Never per session.

### 4.2 `prepareData.ts` addition

The critical constraint: **the hourly buckets must be the game's buckets.** The
game anchors 1h to the 18:00 ET trading-day open (`Aggregate.bucketStart`), not
to UTC hours. `prepareData.ts` already imports from `web/src/lib/`, so:

```ts
import { aggregate } from '../../web/src/lib/replay/aggregate';
// The hourly series MUST come from the same aggregator the game runs, or the
// spliced history and the live minute data would disagree about where an hour
// starts. Do not hand-roll hourly bucketing.
const hourly = aggregate(monthBars, '1h', 60);
```

Aggregate per month and concatenate — safe, and the reason is worth a comment:
month chunks are grouped by **trading date** (`day.trading_date.slice(0,7)`),
and a month's first trading date opens at 18:00 ET the previous evening, which
is itself a bucket start. So a 1h bucket can never straddle two month chunks.

Emit `roblox/data-out/hist-1h.bin` plus a `hist` entry in `manifest.json`
(`{ key: "hist:1h", barCount, byteSize, firstTs, lastTs }`), and round-trip
assert it exactly like every month (`assertRoundTrip`). `uploadData.ts` uploads
it with the same base64 + `content-md5` path and the same
"refuse anything over 4 MB" guard.

### 4.3 Server side

`BarStore` gains:

```lua
-- Loaded ONCE per server and cached forever: the series never changes, it is
-- ~3 MB base64, and the per-key read ceiling is 25 MB/min.
function M.hourlyHistory(): { Bar }
```

Same degradation ladder as `loadMonth`: memory → DataStore → nothing (an
absent key is not an error; deep history is a nicety, and a session must never
fail to start over it).

`Session` gains, called once after `startSessionInner`/`tryResume` has sent the
reset packet:

```lua
-- History is strictly BEFORE the session's first bar, so nothing in it is
-- future data — but assert it rather than trust it, exactly as sendBars does.
local function sendHistory(s: Session)
	local hist = BarStore.hourlyHistory()
	local cut = <binary search: last i with hist[i].t + 3600 <= s.bars[1].t>
	assert(cut == 0 or hist[cut].t + 3600 <= s.bars[1].t,
		"LOOKAHEAD VIOLATION: hourly history overlaps the session's first bar")
	...
end
```

Send policy — three constraints and the resulting default:

- 2.3 MB in one `FireClient` is far past PORT_PLAN's "keep single fires modest".
- The series never changes, so it is per-**player**, not per-session.
- Most players never open a 1D chart.

```lua
-- Deep history is sent LAZILY (first time the client selects an hourly-backed
-- timeframe), ONCE per player per server, and CHUNKED so no single frame
-- serializes megabytes.
local HISTORY_HORIZON_SEC = 3 * 365 * 86400   -- ~17.4k bars, ~420 KB
local HISTORY_CHUNK_BARS = 10000              -- one packet per heartbeat
```

Three years already makes 1D/1W deep and 1M usable; lift the horizon to
`math.huge` behind the constant once the chunked path is proven. Add
`{ cmd = "wantHistory" }` to the Cmd list in §0.1 (the client fires it the first
time `setTimeframe` picks an hourly-backed tf).

Hidden sessions (§2/§3): **do not send history at all.** Three years of hourly
tape leading into the challenge day is a date fingerprint no offset can hide
(the shift is per-session and would have to shift the history too, which the
`wireOffset` design supports — but the *shape* of three years of index history
is instantly recognizable). Gate on `s.mode == "free"`.

### 4.4 Client side — `BarCache` mixed resolutions

The web app already solved this exactly; port `barSource.ts`
`getVisibleCandles` lines 274–304 rather than inventing a merge.

`BarCache` gains:

```lua
	hist: { Bar },                     -- 1h bars, all strictly before base[1]
	histSec: number,                   -- 3600
	histDerived: { [Timeframe]: { Bar } }, -- aggregate(hist, tf, 3600), cached
```

```lua
-- Timeframes whose deep history can come from the hourly series. Below 1h an
-- hourly bar cannot be split, so those stay minute-only.
local HOURLY_BACKED: { [Timeframe]: boolean } =
	{ ["1h"] = true, ["4h"] = true, ["1D"] = true, ["1W"] = true, ["1M"] = true }
```

`applyPacket(packet, "history")` decodes into `hist`, clears `histDerived`,
rebuilds, fires. `"reset"`/`"append"` are unchanged and **must not touch
`hist`** — a rewind replaces the revealed prefix, not the history.

The splice, in `rebuildAll` (and skipped entirely on the incremental append
path, since an append can never change the history cut — assert that by
recomputing only when `#self.candles == 0`):

```lua
-- Cut the hourly-derived candles at the first minute bar we hold, then drop any
-- live candle the history already covers. Binary-search the cut: bucketEnd()
-- does ET math per call and a linear scan over a 95k-bar series measurably
-- stalls (the web app hit exactly this — barSource.ts, "took seconds").
```

1. `hist1 = if tf == "1h" then self.hist else cached Aggregate.aggregate(self.hist, tf, 3600)`
   — note `Aggregate.aggregate` already takes `baseSec` and its passthrough
   branch is `TF_SECONDS[tf] == bSec`, so `("1h", 3600)` **returns the input
   array by reference**. Same "never mutate in place" hazard `BarCache` already
   documents for `candles`/`base`; alias, do not copy, and never write to it.
2. `histLimit = if #self.base > 0 then self.base[1].t else <clock unknown client-side>`
   — the client has no clock, but it does not need one: everything in `hist` is
   already closed (server-asserted), so the only cut needed is against
   `base[1].t`. This is *simpler* than the web version, which also had to clip
   against `upTo`. Say so in the comment; a reviewer comparing the two will ask.
3. Binary-search the largest `cut` with `hist1[cut].t < histLimit`.
4. `lastHistT = hist1[cut].t`; advance `liveFrom` past every live candle with
   `t <= lastHistT` (the boundary bucket is owned by the live data, which has
   minute resolution).
5. `candles = hist1[1..cut] .. live[liveFrom..]`.

Downstream is index-based and needs no change: `ChartView.repaint` slices
`[first, last]`, `tailRightIndex` uses `#candles`, `OrderLayer` maps prices
only. One thing to check in review: `ChartView.paintTimeAxis` picks a step from
`TIME_STEPS` by span — with three years spliced in, the coarse end of that
ladder (`365 * 86400`) finally gets used. Verify the labels read sanely.

---

## §5 — Scoping: drawing tools

Reference: `web/src/components/DrawingLayer.tsx` (607 lines) +
`web/src/lib/drawings/store.ts` (162 lines).

### 5.1 The good news: the overlay contract already exists

`OrderLayer.luau` is a working precedent for everything a drawing layer needs,
and `ChartView` already exposes the hooks:

| Need | Already there |
|---|---|
| parent into the clipped plot, above candles | `ChartView:getPlot()` + ZIndex |
| price ↔ pixel | `ChartView:priceToY` / `:yToPrice` |
| cursor in plot space (incl. the topbar-inset term) | `ChartView:mouseToPlot()` |
| repaint on pan/zoom/resize/new bars | `ChartView:onRepaint(fn)` |
| suppress panning during a shape drag | `ChartView:setPanLocked(true)` |
| pooling + "write `.Text` only on change" discipline | `OrderLayer` idiom |

**Missing and required:** `indexToX` / `xToIndex` are file-local functions in
`ChartView.luau`. Export them as methods mirroring `priceToY`/`yToPrice`
exactly (two 3-line additions). That is the only edit to an existing chart file.

### 5.2 Anchor space — unchanged from the web

Anchors are `(t, p)` = epoch seconds UTC + price, **not** pixels and **not**
bar indices, so a shape spans the same wall-clock/price region on every
timeframe. Same reasoning as `store.ts`'s header comment; keep the comment.

Time → x needs the web's interpolating `timeToLogical` (DrawingLayer.tsx
lines 45–59): binary-search the candle array for the bracketing pair, then
interpolate, with the `span > 0` guard that keeps it from producing NaN on a
degenerate pair. Then `ChartView:indexToX(logical)`. Linear-in-time mapping is
wrong for the same reason it is wrong on the web: the chart compresses
weekend/halt gaps, so a shape placed across one would land in the wrong place.

Two interactions specific to this port, both worth a comment:

- **Prices are per-month rebased** (§4.0). A drawing anchored at 20034.25 in
  one month means nothing in the next. Acceptable — drawings are session-scoped
  in practice — but if §4.0 lands as option (c), this problem disappears.
- **Hidden sessions shift `t`** (§2.3). Drawings made in a challenge/duel are
  anchored in the wire frame. **Do not persist drawings from hidden sessions**
  — one line in the server command handler (`if s.mode ~= "free" then return end`),
  and far cleaner than storing an offset per shape.

### 5.3 Rendering: rotated Frames, not Path2D

| Shape | Instances | Notes |
|---|---|---|
| horizontal ray | 1 `Frame`, `Size = UDim2.new(1,0,0,w)`, `Position.Y = priceToY(p)` | identical to `OrderLayer.newLine`; trivial |
| rectangle (axis-aligned) | 1 `Frame`, `BackgroundTransparency = 1 - fillOpacity`, `UIStroke` for the outline | trivial; fall back to 4 edge Frames if `UIStroke`'s `ApplyStrokeMode` misbehaves |
| trend line | 1 rotated `Frame`: `AnchorPoint = (0.5, 0.5)`, `Position = midpoint`, `Size = (length, width)`, `Rotation = math.deg(math.atan2(dy, dx))` | see the two catches below |

**Pick: rotated Frame, not `Path2D`.** `Path2D` exists and does draw arbitrary
polylines, but its control-point API is heavier per update, it is aimed at
curves rather than single segments, and it interacts differently with ancestor
clipping. A trend line is one segment; a rotated Frame is one instance and four
property writes per repaint, which is exactly the budget `ChartView` and
`OrderLayer` already work in.

Two catches, and they are the entire reason trend lines are v2 and not v1:

1. **A `Frame` with `Rotation ~= 0` is not clipped by an ancestor's
   `ClipsDescendants`.** The plot sets `ClipsDescendants = true` and
   `OrderLayer` relies on it. A trend line with an off-screen endpoint will
   spill across the price axis and the HUD. Fix: clip the segment
   **analytically** to the plot rect (Liang–Barsky, ~30 lines, pure, testable)
   before computing midpoint/length/rotation, and hide the Frame when the
   segment is fully outside. Non-negotiable; without it the feature looks
   broken the first time someone zooms in.
2. **Rotated Frames are not anti-aliased.** A 1 px rotated line reads as a
   staircase. Minimum width 2 px for lines.

**Hit testing.** SVG gets a fat transparent stroke for free (`pointerEvents="stroke"`,
`strokeWidth={12}`). The Frame equivalent is a second, transparent
`TextButton` with the same geometry and a 12 px cross-axis size — including for
rotated lines, since Roblox hit-tests rotated `GuiObject`s in their rotated
space. Same trick, one extra instance per shape.

### 5.4 Persistence

`PlayerData.drawings[instrument]` (§0.4), `MAX_DRAWINGS = 200`
(≈ 24 KB of the shared 4 MB key — negligible next to `MAX_EVENTS = 20000`, but
it must be capped, because it shares the key).

Client → server commands (§0.1): `drawingUpsert` / `drawingRemove` /
`drawingClear`. Server validation:

```lua
-- Every field is attacker-controlled. Colours travel as a PALETTE INDEX, never
-- as a string: an arbitrary string that becomes a Color3 is an unbounded input
-- with no validation story, and a fixed palette is a better UI anyway.
local PALETTE: { Color3 } = { ... }   -- shared, in UI/Theme.luau
```

plus finite-number checks on `t1/p1/t2/p2` (reuse `isFiniteNumber`), `kind`
against a whitelist, `width` clamped to `[1, 10]`, and `id` length-capped.

**Send on drag END only.** The rate limiter is 30 cmds/sec and a drag emits a
position per frame; `OrderLayer` already establishes the pattern (local
override price during the drag, one `modifyOrder` on release). Do the same:
render locally from a draft, send one `drawingUpsert` on `InputEnded`.

Writes ride the existing debounced persist: set `s.persist.dirty = true` and
let `persistTick`'s 8 s cadence handle it. No new write path.

### 5.5 Phased cut

- **v1 — horizontal rays + rectangles.** Axis-aligned only, so no rotation, no
  clipping problem, no Liang–Barsky. Reuses `OrderLayer`'s idiom almost
  literally. Includes: place, select, drag body, drag handles, delete,
  persistence, palette. Size **S/M**.
- **v2 — trend lines.** Rotated Frames + analytic segment clipping + rotated
  hit target. Size **M**.
- **v3 — magnet snapping.** Ctrl → nearest candle's nearest OHLC
  (DrawingLayer.tsx `magnetSnap`, lines 176–189) and Shift → 45° angle snap
  (`angleSnap`, 191–198). Both need only `xToIndex` + the candle array, which
  v1 already wired. Size **S**.
- **Out of scope for all three:** the style-editor popover (colour pickers,
  opacity slider), multi-select, undo/redo, clear-all-with-confirm. The web
  layer's last 180 lines are that editor; the palette-index design makes most
  of it unnecessary.

---

## Build order

**Wave 0 — decisions (senior, before any implementer starts)**

- §4.0: per-month vs. global price normalization. Blocks all of §4.
- §1.5: whether to add `stats.tradeWins` (schema-ish change, affects §0.4).
- §1.4: confirm option (a) — leaderboard updates lazily at session switch.
- Studio probes: OrderedDataStore negative-value behavior, `GetSortedAsync`
  pageSize cap. Record both back into this file.

**Wave 1 — the spine (serial, one implementer, no worktree needed)**

- **§0** in full. Everything downstream edits only its own new files. Size **M**.
- **§4.2** (`prepareData.ts` + `uploadData.ts`) can run *in parallel* in a
  separate worktree — it touches only `tools/`, which §0 does not.

**Wave 2 — three-way parallel, each in its own worktree**

| Agent | Sections | Files it owns | Size |
|---|---|---|---|
| A | §1 | `server/Meta/Board.luau`, `client/UI/Leaderboard.luau`, one hook in `Session.finalizeActive` | M |
| B | §2 | `server/Meta/Challenge.luau`, `client/UI/Challenge.luau`, `Session` scoring hook | L |
| C | §5 v1 | `client/Chart/DrawingLayer.luau`, 2 method exports in `ChartView`, drawing cmd handlers | S/M |

Collision risk: A and B both touch `Session.luau` (different functions —
`finalizeActive` vs. the scoring/`startHidden` paths). Give B `Session.luau`
outright and have A deliver its hook as a 3-line patch the senior applies.

**Wave 3 — depends on Wave 2**

| Agent | Sections | Depends on | Size |
|---|---|---|---|
| D | §3 | §2 (`startHidden`, `wireOffset`, `scoreUsd`, `endIdx`) | M |
| E | §4.1/4.3/4.4 | §0's `Bars` mode flag, §4.2's output, Wave 0's normalization call | L |
| F | §5 v2, then v3 | §5 v1 | M, then S |

D and E and F are mutually independent and parallelize cleanly.

**Rough totals:** §0 M · §1 M · §2 L · §3 M · §4 L · §5 S/M + M + S.

## Open risks not designed around

1. **§4.0 is a product/licensing decision, not an engineering one.** Do not let
   an implementer resolve it by picking whichever is easier to code.
2. **`finalizeActive` is not called on disconnect** (§1.4). Anyone who later
   "fixes" that will double-count sessions against resume. Leave a comment at
   the call site saying so.
3. **The challenge pool is derived from the live manifest** (§2.1). A data
   upload mid-day changes the pick on newly started servers. Freeze uploads
   during play, or pin the pool length in a constant.
4. **`wireOffset` must be applied at exactly four outgoing points and one
   inbound point** (§2.3). A fifth timestamp added to the protocol later
   without the shift silently leaks the date and nothing will fail loudly.
   Consider a small `Wire.out(s, t)` / `Wire.in(s, t)` pair so the shift is a
   named operation rather than four `+ s.wireOffset` expressions.
5. **Rotated Frames escape `ClipsDescendants`** (§5.3). If v2 ships without the
   analytic clip, it will look correct in every screenshot and wrong the moment
   anyone zooms.
6. **Volume is not normalized** and is present in every bar packet (§2.3).
   Cheap to zero out for hidden sessions; do it.

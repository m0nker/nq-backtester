--!strict
-- Behavior suite for the LEADERBOARD layer — the half ServerSpec deliberately
-- leaves out.
--
-- ServerSpec drives real Sessions, but every one of them stays UNDER the
-- eligibility gates (none reveals two hours of tape), so Board.eligible always
-- answers false there and Board.post is never reached. Nothing therefore covers
-- weekKey, the cent encoding, the min-session gates, the `elig` fold, or the
-- payload Board replies to a client with. This file drives Sessions PAST those
-- gates through the same public surface and asserts what reaches the board.
--
-- Usage — Studio COMMAND BAR, EDIT MODE:
--   require(game.ReplicatedStorage.Tests.BoardSpec).run()
--
-- Same context rules as ServerSpec: Board, Session and PlayerStore all live in
-- ServerScriptService, which a play-mode client command bar cannot see, and edit
-- mode additionally guarantees Main.server.luau is not running real sessions
-- alongside these.
--
-- IN-MEMORY MODE IS THE CONTRACT. Board's whole post/fetch/rank path degrades to
-- an in-process table when Studio has no DataStore API access, and that fallback
-- is what this file asserts against: the real OrderedDataStores are shared,
-- live and eventually consistent, so a suite that wrote to them would be neither
-- deterministic nor safe. run() therefore REFUSES to test when a DataStore is
-- reachable and warns instead of failing.
--
-- The degrade is forced up front (Board.probeNegativeValues, whose failing
-- SetAsync is what flips the module to memory) because it also makes posting
-- SYNCHRONOUS: Board.post spawns its writes, and only the memory path runs to
-- completion without yielding. Every "the board now has this row" case below
-- depends on that — a row missing immediately after an eligible fold means the
-- module did not degrade, not that the fold failed.
--
-- FAKES. As in ServerSpec: a fake player exposing UserId and Name only (every
-- other index raises a named error), stub remotes for the session packets this
-- file does not read, and one CAPTURING Meta remote — the seam that makes
-- Board.handleRequest's reply observable at all.
--
-- DETERMINISM. Board's memory board and PlayerStore's memory table are module
-- globals keyed by UserId with no reset seam, so they outlive a run: ids are
-- salted per run and no case may assume the board starts empty. Two consequences
-- are load-bearing:
--   * membership and value are read through the requesting player's OWN `you`
--     row, which Board resolves per user against live state, never through the
--     top-N rows, which are a cached snapshot full of earlier runs' users;
--   * for the same reason the one case that needs a player INSIDE those rows
--     degrades to a warn rather than a failure.
-- Board also caches each board for BOARD_TTL with no invalidation seam, and
-- memoizes a player's own value onto that snapshot. Each user is therefore read
-- AT MOST ONCE after their last post: a second read would answer with the first
-- one's number.

local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local ServerScriptService = game:GetService("ServerScriptService")

local Shared = ReplicatedStorage.Shared
local ContractMath = require(Shared.Trading.ContractMath)
local Et = require(Shared.Time.Et)
local Protocol = require(Shared.Net.Protocol)

local Server = ServerScriptService.Server
local BarStore = require(Server.Data.BarStore)
local Board = require(Server.Meta.Board)
local PlayerStore = require(Server.Data.PlayerStore)
local Session = require(Server.Replay.Session)

-- Mirrors of Board's private gates. Drift shows up as a failing threshold case
-- rather than as a suite that quietly stopped testing the threshold.
local MIN_SESSIONS_PNL = 3
local MIN_SESSIONS_WIN_RATE = 10
local MIN_SESSION_BARS = 120
local TOP_N = 20
-- Board's CENTS_OFFSET: $100,000,000 in cents, the zero point of the encoding.
local CENTS_OFFSET = 10_000_000_000

-- Day bars a session needs beyond the bar minimum: two per trade, plus slack for
-- the flat bar pairs takeTrade walks past.
local TRADE_HEADROOM = 32

-- A read-only reachability probe. Its own store, never written, so an enabled
-- API only costs one GetAsync of a key that does not exist.
local PROBE_STORE = "boardspec_probe_v1"
local PROBE_KEY = "reachability"

-- Fields reported per failing case, and failing cases printed in full.
local MAX_FIELDS_PER_CASE = 6
local MAX_PRINTED_FAILURES = 50

-- ---------------------------------------------------------------------------
-- runner (ServerSpec's, kept in step with it by copy — Tests modules expose
-- run() only, so there is nothing to import)
-- ---------------------------------------------------------------------------

type Suite = {
	name: string,
	current: string,
	passed: number,
	failed: number,
	failures: { string },
}

local function newSuite(name: string): Suite
	return { name = name, current = "", passed = 0, failed = 0, failures = {} }
end

local function fail(suite: Suite, case: string, detail: string)
	suite.failed += 1
	table.insert(suite.failures, `[{suite.name}] {suite.current} / {case}\n    {detail}`)
end

local function childPath(path: string, key: any): string
	if typeof(key) == "number" then
		return `{path}[{key}]`
	end
	if path == "" then
		return tostring(key)
	end
	return `{path}.{tostring(key)}`
end

local function keyLess(a: any, b: any): boolean
	local ta, tb = typeof(a), typeof(b)
	if ta ~= tb then
		return ta == "number"
	end
	if ta == "number" then
		return (a :: number) < (b :: number)
	end
	return tostring(a) < tostring(b)
end

type Budget = { n: number }

-- Numbers compare EXACTLY: every dollar figure here is a whole number of $5
-- point-value steps and every encoded value is an integer, so a delta of any
-- size is a real divergence.
local function deepDiff(path: string, expected: any, actual: any, out: { string }, budget: Budget)
	if budget.n <= 0 or (expected == nil and actual == nil) then
		return
	end

	local where = if path == "" then "<root>" else path
	local te, ta = typeof(expected), typeof(actual)
	if te ~= ta then
		table.insert(out, `{where}: expected {te} {tostring(expected)}, got {ta} {tostring(actual)}`)
		budget.n -= 1
		return
	end

	if te == "table" then
		local keys: { any } = {}
		local seen: { [any]: boolean } = {}
		for k in pairs(expected :: any) do
			table.insert(keys, k)
			seen[k] = true
		end
		for k in pairs(actual :: any) do
			if not seen[k] then
				table.insert(keys, k)
			end
		end
		table.sort(keys, keyLess)
		for _, k in keys do
			deepDiff(childPath(path, k), (expected :: any)[k], (actual :: any)[k], out, budget)
			if budget.n <= 0 then
				return
			end
		end
		return
	end

	if expected ~= actual then
		table.insert(out, `{where}: expected {tostring(expected)}, got {tostring(actual)}`)
		budget.n -= 1
	end
end

local function check(suite: Suite, case: string, expected: any, actual: any)
	local msgs: { string } = {}
	deepDiff("", expected, actual, msgs, { n = MAX_FIELDS_PER_CASE })
	if #msgs == 0 then
		suite.passed += 1
	else
		fail(suite, case, table.concat(msgs, "\n    "))
	end
end

local function ok(suite: Suite, case: string, condition: boolean, detail: string)
	if condition then
		suite.passed += 1
	else
		fail(suite, case, detail)
	end
end

-- One test = one isolated scenario. The body is pcall'd so a blown assert inside
-- Session or Board is reported as a failing case instead of taking the rest of
-- the suite with it.
local function test(suite: Suite, name: string, body: () -> ())
	suite.current = name
	-- pcall's result arity follows its callee, which returns nothing; the cast
	-- buys back the error value (same idiom as Session's cmdStartSession).
	local success, err = pcall(body :: any)
	if not success then
		fail(suite, "<error>", tostring(err))
	end
end

-- ---------------------------------------------------------------------------
-- fakes
-- ---------------------------------------------------------------------------

type Reply = { player: any, payload: any }

type Harness = {
	userId: number,
	player: any,
	remotes: any,
	meta: any,
	replies: { Reply },
}

-- Board and PlayerStore keep module-global state keyed by UserId for the whole
-- Studio session, so ids must be unique per RUN as well as per test: a reused id
-- would carry a previous run's eligible sessions into a gate assertion and a
-- previous run's score onto the board.
local ID_BASE = 760000000 + Random.new():NextInteger(0, 99999) * 1000
local idCounter = 0

local function newUserId(): number
	idCounter += 1
	return ID_BASE + idCounter
end

local function newHarness(userId: number): Harness
	local replies: { Reply } = {}

	-- Session's own packets are not read here — this file asserts on stored stats
	-- and on Board's reply — but they still have to go somewhere. Auto-vivified by
	-- name, so a remote added to Session.Remotes later is swallowed rather than
	-- nil-indexed.
	local remotes: any = setmetatable({}, {
		__index = function(t: any, key: any): any
			local stub = { FireClient = function() end }
			rawset(t, key, stub)
			return stub
		end,
	})

	local meta: any = {
		FireClient = function(_self: any, player: any, payload: any)
			table.insert(replies, { player = player, payload = payload })
		end,
	}

	local player: any = setmetatable({ UserId = userId, Name = `BoardSpec{userId}` }, {
		__index = function(_t: any, key: any): any
			error(`BoardSpec: read Player.{tostring(key)}; the fake player provides UserId and Name only`, 2)
		end,
	})

	return { userId = userId, player = player, remotes = remotes, meta = meta, replies = replies }
end

local function newSession(): (Session.Session, Harness)
	local h = newHarness(newUserId())
	return Session.new(h.player, h.remotes), h
end

local function cmd(s: Session.Session, msg: any)
	Session.handleCmd(s, msg)
end

-- The fold's output, read straight off the session's own persistence copy: the
-- store round trip behind it is PlayerStore's business and ServerSpec's.
local function statsOf(s: Session.Session): PlayerStore.Stats
	return s.persist.data.stats
end

-- ---------------------------------------------------------------------------
-- driving sessions past the gates
-- ---------------------------------------------------------------------------

type Taken = { pnlUsd: number, win: boolean }

-- One closed trade: entered at the next day bar's open, flattened out at the one
-- after it. The DIRECTION is picked from those two opens, so `win` decides the
-- outcome and the sample only decides where in the day it happens. A flat pair
-- would be neither a win nor a loss, so the cursor walks past it.
local function takeTrade(s: Session.Session, win: boolean): Taken?
	while true do
		local k = s.revealedCount - s.contextCount
		local entryBar = s.bars[s.contextCount + k + 1]
		local exitBar = s.bars[s.contextCount + k + 2]
		if entryBar == nil or exitBar == nil then
			return nil
		end
		if entryBar.o ~= exitBar.o then
			local side = if (exitBar.o > entryBar.o) == win then "buy" else "sell"
			local dir = if side == "buy" then 1 else -1
			cmd(s, { cmd = "placeOrder", side = side, type = "market", qty = 1 })
			cmd(s, { cmd = "stepForward" })
			cmd(s, { cmd = "flatten" })
			cmd(s, { cmd = "stepForward" })
			return { pnlUsd = ContractMath.ptsToUsd((exitBar.o - entryBar.o) * dir, 1), win = win }
		end
		cmd(s, { cmd = "stepForward" })
	end
end

-- Reveal exactly to the eligibility boundary — the gate is `>=`, so landing ON
-- MIN_SESSION_BARS is the case worth driving — in one jump rather than 120
-- commands. A session already past it is left alone; jumping backwards would
-- rewind and void the trades that were just taken.
local function revealToMinimum(s: Session.Session): boolean
	local idx = math.max(MIN_SESSION_BARS, s.revealedCount - s.contextCount)
	local bar = s.bars[s.contextCount + idx]
	if bar == nil then
		return false
	end
	local target = bar.t + s.baseSec
	if target > s.currentTime then
		cmd(s, { cmd = "jumpTo", t = target })
	end
	return true
end

type Fold = { pnlUsd: number, trades: number, tradeWins: number }

-- Drive the RUNNING day into the cheapest shape the gates accept: the listed
-- trades, then tape to the bar minimum, and no rewind anywhere. The three
-- eligibility conditions are asserted here rather than assumed, so a session
-- that silently stopped qualifying reports as itself instead of as a missing
-- board row three suites later.
local function driveEligible(suite: Suite, s: Session.Session, outcomes: { boolean }, label: string): Fold?
	local pnlUsd = 0
	local tradeWins = 0
	for i, win in ipairs(outcomes) do
		local taken = takeTrade(s, win)
		if taken == nil then
			fail(suite, label, `the day ran out of bars before trade {i}`)
			return nil
		end
		-- Accumulated in the same order the engine realizes it, so the expectation
		-- carries the same float history as the number it is compared against.
		pnlUsd += taken.pnlUsd
		if taken.win then
			tradeWins += 1
		end
	end
	if not revealToMinimum(s) then
		fail(suite, label, "the day is shorter than the bar minimum")
		return nil
	end
	ok(
		suite,
		`{label}: tape past the prefix`,
		s.revealedCount - s.contextCount >= MIN_SESSION_BARS,
		`revealed {s.revealedCount - s.contextCount} day bars`
	)
	ok(suite, `{label}: no rewinds`, s.derived.voidedCount == 0, `voidedCount was {s.derived.voidedCount}`)
	check(suite, `{label}: trades closed`, #outcomes, #s.derived.trades)
	check(suite, `{label}: realizedUsd`, pnlUsd, s.derived.realizedUsd)
	return { pnlUsd = pnlUsd, trades = #outcomes, tradeWins = tradeWins }
end

type Cum = { sessions: number, trades: number, tradeWins: number, pnlUsd: number }

-- A player who plays several eligible sessions back to back. Session j is banked
-- by the startSession that OPENS session j+1 — that is the only fold there is —
-- so the loop opens one more day than it drives and leaves the last one hanging.
-- `after` runs with the totals the fold has just produced.
local function grind(
	suite: Suite,
	s: Session.Session,
	date: string,
	plans: { { boolean } },
	label: string,
	after: (number, Cum) -> ()
): Cum
	local cum: Cum = { sessions = 0, trades = 0, tradeWins = 0, pnlUsd = 0 }
	cmd(s, { cmd = "startSession", date = date })
	for j, outcomes in ipairs(plans) do
		local fold = driveEligible(suite, s, outcomes, `{label} {j}`)
		if fold == nil then
			return cum
		end
		cmd(s, { cmd = "startSession", date = date })
		cum.sessions += 1
		cum.trades += fold.trades
		cum.tradeWins += fold.tradeWins
		cum.pnlUsd += fold.pnlUsd
		after(j, cum)
	end
	return cum
end

-- ---------------------------------------------------------------------------
-- reading the board
-- ---------------------------------------------------------------------------

-- YIELDS (Board fetches and resolves names). Returns the reply Board sent, or
-- nil when it dropped the request.
local function requestBoard(h: Harness, boardId: any): Reply?
	local before = #h.replies
	Board.handleRequest(h.player, h.meta, boardId)
	if #h.replies == before then
		return nil
	end
	return h.replies[#h.replies]
end

local function rowFor(rows: { Protocol.BoardRow }, userId: number): Protocol.BoardRow?
	for _, row in ipairs(rows) do
		if row.userId == userId then
			return row
		end
	end
	return nil
end

-- Membership only. The value is deliberately NOT read here: Board memoizes a
-- player's own value onto the cached snapshot, so the first non-nil read is the
-- last honest one for that user.
local function onBoard(h: Harness, boardId: string): boolean
	local reply = requestBoard(h, boardId)
	return reply ~= nil and reply.payload.you ~= nil
end

local function checkReplyShape(suite: Suite, case: string, boardId: string, h: Harness, reply: Reply)
	local payload = reply.payload
	ok(suite, `{case}: replied to the requesting player`, reply.player == h.player, "the reply went to another player")
	check(suite, `{case}: envelope`, { kind = "board", board = boardId }, {
		kind = payload.kind,
		board = payload.board,
	})
	if typeof(payload.rows) ~= "table" then
		fail(suite, `{case}: rows`, `rows was {typeof(payload.rows)}`)
		return
	end
	local rows = payload.rows :: { Protocol.BoardRow }
	ok(suite, `{case}: at most TOP_N rows`, #rows <= TOP_N, `{#rows} rows`)
	local badRank: string? = nil
	local badOrder: string? = nil
	local badField: string? = nil
	for i, row in ipairs(rows) do
		if row.rank ~= i and badRank == nil then
			badRank = `row {i} carries rank {tostring(row.rank)}`
		end
		if
			badField == nil
			and (typeof(row.userId) ~= "number" or typeof(row.name) ~= "string" or typeof(row.value) ~= "number")
		then
			badField = `row {i} is {typeof(row.userId)}/{typeof(row.name)}/{typeof(row.value)}`
		end
		if i > 1 and rows[i - 1].value < row.value and badOrder == nil then
			badOrder = `row {i} ({row.value}) outranks row {i - 1} ({rows[i - 1].value})`
		end
	end
	ok(suite, `{case}: rank ascends from 1`, badRank == nil, tostring(badRank))
	ok(suite, `{case}: value descends`, badOrder == nil, tostring(badOrder))
	ok(suite, `{case}: row fields`, badField == nil, tostring(badField))
end

-- ---------------------------------------------------------------------------
-- context
-- ---------------------------------------------------------------------------

type Posted = {
	harness: Harness,
	-- boardId -> the DECODED value the board must answer with.
	values: { [string]: number },
}

type Ctx = {
	dates: { string },
	day: string,
	dayBars: number,
	-- Filled in by the winRate suite: a player the boards already know, for the
	-- reply-shape suite to ask as. nil means that suite never got that far.
	posted: Posted?,
}

-- ---------------------------------------------------------------------------
-- 1. encodeUsd / decodeUsd
-- ---------------------------------------------------------------------------

type EncodeCase = { usd: number, encoded: number, roundTrips: boolean }

-- Expected encodings are written out as literals, never recomputed: the point is
-- to pin the offset and the clamp bounds, and a mirrored formula would move with
-- them.
local ENCODE_CASES: { EncodeCase } = {
	{ usd = 0, encoded = 10_000_000_000, roundTrips = true },
	{ usd = 1, encoded = 10_000_000_100, roundTrips = true },
	{ usd = -1, encoded = 9_999_999_900, roundTrips = true },
	{ usd = 0.25, encoded = 10_000_000_025, roundTrips = true },
	{ usd = -0.25, encoded = 9_999_999_975, roundTrips = true },
	{ usd = 1234.5, encoded = 10_000_123_450, roundTrips = true },
	{ usd = -1234.5, encoded = 9_999_876_550, roundTrips = true },
	-- Half-cent values round toward +inf on BOTH signs (floor(x + 0.5)), which is
	-- what makes the encoding deterministic rather than platform-dependent.
	{ usd = 0.005, encoded = 10_000_000_001, roundTrips = false },
	{ usd = -0.005, encoded = 10_000_000_000, roundTrips = false },
	-- The window's edges, exactly.
	{ usd = 100_000_000, encoded = 20_000_000_000, roundTrips = true },
	{ usd = -100_000_000, encoded = 0, roundTrips = true },
	-- ...and past them: clamped in CENTS, before the offset, so nothing can land
	-- negative after it.
	{ usd = 100_000_001, encoded = 20_000_000_000, roundTrips = false },
	{ usd = 1e12, encoded = 20_000_000_000, roundTrips = false },
	{ usd = -1e10, encoded = 0, roundTrips = false },
	{ usd = -1e10 - 1, encoded = 0, roundTrips = false },
}

local function suiteEncoding(_ctx: Ctx): Suite
	local suite = newSuite("encoding")

	test(suite, "encodeUsd pins the offset and the clamp", function()
		for _, case in ipairs(ENCODE_CASES) do
			local encoded = Board.encodeUsd(case.usd)
			check(suite, `encode({case.usd})`, case.encoded, encoded)
			if case.roundTrips then
				check(suite, `decode(encode({case.usd}))`, case.usd, Board.decodeUsd(encoded))
			end
		end
	end)

	test(suite, "the offset floor absorbs everything below it", function()
		-- The spec's own statement of the floor: one cent below the bottom of the
		-- window is the bottom of the window.
		check(suite, "encode(-1e10 - 1) == encode(-1e10)", Board.encodeUsd(-1e10), Board.encodeUsd(-1e10 - 1))
		check(suite, "the floor encodes to zero", 0, Board.encodeUsd(-1e10))
		check(suite, "zero decodes back to the floor", -CENTS_OFFSET / 100, Board.decodeUsd(0))
	end)

	test(suite, "no input encodes to a value an OrderedDataStore would reject", function()
		local worst: number? = nil
		local fractional: number? = nil
		for _, case in ipairs(ENCODE_CASES) do
			local encoded = Board.encodeUsd(case.usd)
			if encoded < 0 and worst == nil then
				worst = case.usd
			end
			if encoded % 1 ~= 0 and fractional == nil then
				fractional = case.usd
			end
		end
		ok(suite, "never negative", worst == nil, `encode({tostring(worst)}) went negative`)
		ok(suite, "always an integer", fractional == nil, `encode({tostring(fractional)}) was fractional`)
	end)

	test(suite, "decodeUsd inverts the offset", function()
		check(suite, "the zero point", 0, Board.decodeUsd(CENTS_OFFSET))
		check(suite, "one cent up", 0.01, Board.decodeUsd(CENTS_OFFSET + 1))
		check(suite, "one cent down", -0.01, Board.decodeUsd(CENTS_OFFSET - 1))
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 2. weekKey
-- ---------------------------------------------------------------------------

type WeekCase = { name: string, ts: number, key: string }

-- 2026-08-24 and 2026-08-31 are Mondays; 2026-01-05 and 2026-03-09 are Mondays
-- in EST and across the DST switch (2026-03-08 is the second Sunday of March).
-- Hardcoded on purpose: "Monday-anchored" is a calendar fact, and deriving it
-- from Et would only restate the implementation.
local function weekCases(): { WeekCase }
	return {
		{ name = "the Sunday open itself", ts = Et.etWallToUtc(2026, 8, 23, 18, 0, 0), key = "w2026-08-24" },
		{ name = "one second before the open", ts = Et.etWallToUtc(2026, 8, 23, 17, 59, 59), key = "w2026-08-17" },
		{ name = "Monday morning", ts = Et.etWallToUtc(2026, 8, 24, 9, 30), key = "w2026-08-24" },
		{ name = "Wednesday midday", ts = Et.etWallToUtc(2026, 8, 26, 12, 0), key = "w2026-08-24" },
		{ name = "Friday before the close", ts = Et.etWallToUtc(2026, 8, 28, 16, 59), key = "w2026-08-24" },
		-- The documented quirk: the Friday-close-to-Sunday-open dead zone scores
		-- into the week that just closed, not the one about to open.
		{ name = "Saturday (the dead zone)", ts = Et.etWallToUtc(2026, 8, 29, 12, 0), key = "w2026-08-24" },
		{ name = "the next week's open", ts = Et.etWallToUtc(2026, 8, 30, 18, 0), key = "w2026-08-31" },
		{ name = "midwinter (EST)", ts = Et.etWallToUtc(2026, 1, 7, 12, 0), key = "w2026-01-05" },
		{ name = "the week DST starts", ts = Et.etWallToUtc(2026, 3, 10, 12, 0), key = "w2026-03-09" },
	}
end

local function suiteWeekKey(_ctx: Ctx): Suite
	local suite = newSuite("weekKey")

	test(suite, "the key is that trading week's Monday", function()
		for _, case in ipairs(weekCases()) do
			check(suite, case.name, case.key, Board.weekKey(case.ts))
		end
	end)

	test(suite, "the key is Et's week start, formatted", function()
		local cases = weekCases()
		table.insert(cases, { name = "now", ts = os.time(), key = "" })
		for _, case in ipairs(cases) do
			-- Mirrors the implementation deliberately: the case above pins WHICH day
			-- the key names, this one pins that no other date arithmetic crept in.
			local expected = "w" .. Et.tradingDateOf(Et.tradingWeekStartSec(case.ts))
			check(suite, `{case.name}: == Et`, expected, Board.weekKey(case.ts))
		end
	end)

	test(suite, "the key is a store-safe date string", function()
		for _, case in ipairs(weekCases()) do
			local key = Board.weekKey(case.ts)
			ok(
				suite,
				`{case.name}: "w" .. YYYY-MM-DD`,
				string.match(key, "^w%d%d%d%d%-%d%d%-%d%d$") ~= nil,
				`key was "{key}"`
			)
		end
		local now = Board.weekKey(os.time())
		ok(suite, "now: format", string.match(now, "^w%d%d%d%d%-%d%d%-%d%d$") ~= nil, `key was "{now}"`)
	end)

	test(suite, "one week is one key, and the boundary is the Sunday open", function()
		local open = Et.etWallToUtc(2026, 8, 23, 18, 0, 0)
		local inside = Board.weekKey(open)
		check(suite, "the open and the Friday close agree", inside, Board.weekKey(Et.etWallToUtc(2026, 8, 28, 16, 59)))
		ok(suite, "the second before differs", Board.weekKey(open - 1) ~= inside, `both keys were {inside}`)
		ok(
			suite,
			"the next open differs",
			Board.weekKey(Et.etWallToUtc(2026, 8, 30, 18, 0)) ~= inside,
			`both keys were {inside}`
		)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 3. eligibility gating at the fold
-- ---------------------------------------------------------------------------

local function suiteEligibility(ctx: Ctx): Suite
	local suite = newSuite("eligibility")

	test(suite, "an under-length session folds into lifetime stats and reaches no board", function()
		local s, h = newSession()
		cmd(s, { cmd = "startSession", date = ctx.day })
		local taken = takeTrade(s, true)
		if taken == nil then
			fail(suite, "setup", `no moving bar pair inside {ctx.day}`)
			return
		end
		ok(
			suite,
			"under the bar minimum",
			s.revealedCount - s.contextCount < MIN_SESSION_BARS,
			`revealed {s.revealedCount - s.contextCount} day bars`
		)
		check(suite, "it did trade", 1, #s.derived.trades)

		-- The only fold there is: starting the next day banks the outgoing one.
		cmd(s, { cmd = "startSession", date = ctx.day })
		local stats = statsOf(s)
		check(
			suite,
			"lifetime folded it",
			{ sessions = 1, trades = 1, pnlUsd = taken.pnlUsd, wins = 1, tradeWins = 1 },
			{
				sessions = stats.sessions,
				trades = stats.trades,
				pnlUsd = stats.pnlUsd,
				wins = stats.wins,
				tradeWins = stats.tradeWins,
			}
		)
		check(suite, "elig untouched", { sessions = 0, trades = 0, tradeWins = 0, pnlUsd = 0 }, {
			sessions = stats.elig.sessions,
			trades = stats.elig.trades,
			tradeWins = stats.elig.tradeWins,
			pnlUsd = stats.elig.pnlUsd,
		})
		ok(suite, "no eligible week bucket", stats.elig.week == nil, "an ineligible fold created elig.week")

		-- pnlWeek is the ONLY board a first eligible session could already reach
		-- (the other two gate on session count), so it is the one whose silence
		-- means something here.
		local reply = requestBoard(h, "pnlWeek")
		if reply == nil then
			fail(suite, "pnlWeek", "Board dropped a valid board request")
		else
			ok(suite, "no board row", reply.payload.you == nil, `the board answered with {tostring(reply.payload.you)}`)
		end
	end)

	test(suite, "an eligible session folds into elig and reaches the weekly board", function()
		local s, h = newSession()
		cmd(s, { cmd = "startSession", date = ctx.day })
		local fold = driveEligible(suite, s, { true }, "session")
		if fold == nil then
			return
		end
		cmd(s, { cmd = "startSession", date = ctx.day })

		local stats = statsOf(s)
		check(suite, "elig folded exactly", { sessions = 1, trades = 1, tradeWins = 1, pnlUsd = fold.pnlUsd }, {
			sessions = stats.elig.sessions,
			trades = stats.elig.trades,
			tradeWins = stats.elig.tradeWins,
			pnlUsd = stats.elig.pnlUsd,
		})
		local week = stats.elig.week
		if week == nil then
			fail(suite, "elig week", "an eligible fold left elig.week nil")
		else
			check(
				suite,
				"elig week bucket",
				{ key = Board.weekKey(os.time()), pnlUsd = fold.pnlUsd },
				{ key = week.key, pnlUsd = week.pnlUsd }
			)
		end
		check(suite, "lifetime folded it too", { sessions = 1, trades = 1, pnlUsd = fold.pnlUsd, wins = 1 }, {
			sessions = stats.sessions,
			trades = stats.trades,
			pnlUsd = stats.pnlUsd,
			wins = stats.wins,
		})

		local reply = requestBoard(h, "pnlWeek")
		if reply == nil then
			fail(suite, "pnlWeek", "Board dropped a valid board request")
			return
		end
		local you = reply.payload.you
		if you == nil then
			fail(
				suite,
				"pnlWeek row",
				"no row after an eligible fold; Board.post is still in flight, i.e. the module did not degrade to memory"
			)
			return
		end
		check(suite, "the row is this player's", h.userId, you.userId)
		-- The board stores encodeUsd(elig.pnlUsd) and hands back decodeUsd of it;
		-- the round trip is the observable form of "it posted the encoded value".
		check(suite, "the row carries encodeUsd(elig.pnlUsd)", Board.decodeUsd(Board.encodeUsd(fold.pnlUsd)), you.value)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 4. rewind contamination
-- ---------------------------------------------------------------------------

local function suiteRewind(ctx: Ctx): Suite
	local suite = newSuite("rewind")

	test(suite, "a rewound session banks into lifetime stats but never onto a board", function()
		local s, h = newSession()
		cmd(s, { cmd = "startSession", date = ctx.day })

		-- The laundering shape the elig fold exists to stop: bank a winner, take a
		-- loser, then rewind the loser out of existence. deriveState voids it, so
		-- the session's realized PnL is pure profit that was never actually run.
		local kept = takeTrade(s, true)
		local voided = takeTrade(s, false)
		if kept == nil or voided == nil then
			fail(suite, "setup", `no two moving bar pairs inside {ctx.day}`)
			return
		end
		ok(suite, "the winner is worth something", kept.pnlUsd ~= 0, "the kept trade broke even")
		check(suite, "both trades closed", 2, #s.derived.trades)

		-- One step back lands ON the losing exit's bar and voids nothing (voiding is
		-- strictly after the target); the second crosses it.
		cmd(s, { cmd = "stepBack" })
		cmd(s, { cmd = "stepBack" })
		ok(suite, "the rewind voided", s.derived.voidedCount > 0, "voidedCount stayed at 0")
		check(suite, "the loser is gone", 1, #s.derived.trades)
		check(suite, "laundered realizedUsd", kept.pnlUsd, s.derived.realizedUsd)

		cmd(s, { cmd = "startSession", date = ctx.day })
		local stats = statsOf(s)
		check(suite, "lifetime absorbed the laundered PnL", { sessions = 1, trades = 1, pnlUsd = kept.pnlUsd }, {
			sessions = stats.sessions,
			trades = stats.trades,
			pnlUsd = stats.pnlUsd,
		})
		check(suite, "elig did not", { sessions = 0, trades = 0, tradeWins = 0, pnlUsd = 0 }, {
			sessions = stats.elig.sessions,
			trades = stats.elig.trades,
			tradeWins = stats.elig.tradeWins,
			pnlUsd = stats.elig.pnlUsd,
		})

		-- Now a clean session on top. The post it triggers reads `stats`, which by
		-- now CONTAINS the contamination — the board must still answer with the
		-- eligible number alone.
		local clean = driveEligible(suite, s, { true }, "clean session")
		if clean == nil then
			return
		end
		cmd(s, { cmd = "startSession", date = ctx.day })
		check(suite, "lifetime holds both", kept.pnlUsd + clean.pnlUsd, stats.pnlUsd)
		check(suite, "elig holds only the clean one", clean.pnlUsd, stats.elig.pnlUsd)

		local reply = requestBoard(h, "pnlWeek")
		if reply == nil then
			fail(suite, "pnlWeek", "Board dropped a valid board request")
			return
		end
		local you = reply.payload.you
		if you == nil then
			fail(suite, "pnlWeek row", "no row after an eligible fold; Board.post did not reach the memory board")
			return
		end
		check(suite, "the board value is elig", Board.decodeUsd(Board.encodeUsd(clean.pnlUsd)), you.value)
		ok(
			suite,
			"and not lifetime",
			you.value ~= Board.decodeUsd(Board.encodeUsd(kept.pnlUsd + clean.pnlUsd)),
			`the board is carrying the rewound session's {kept.pnlUsd}`
		)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 5. win rate in basis points
-- ---------------------------------------------------------------------------

-- Ten eligible sessions carrying 14 trades, 9 of them winners. 9/14 is
-- 6428.57 bp, so the value Board posts also pins that encodedFor ROUNDS the
-- basis points (floor(x + 0.5) -> 6429) rather than truncating them (6428) —
-- the two differ only on a ratio like this one.
local WR_PLAN: { { boolean } } = {
	{ true, true },
	{ true, true },
	{ true, true },
	{ true, true },
	{ true },
	{ false },
	{ false },
	{ false },
	{ false },
	{ false },
}
local WR_TRADES = 14
local WR_WINS = 9
local WR_BP = 6429

local function suiteWinRate(ctx: Ctx): Suite
	local suite = newSuite("winRate")

	test(suite, "a rounding-sensitive ratio posts exact basis points", function()
		local s, h = newSession()
		local cum = grind(suite, s, ctx.day, WR_PLAN, "session", function() end)
		if cum.sessions < #WR_PLAN then
			return -- driveEligible already reported why
		end
		check(suite, "the plan produced the ratio it claims", { trades = WR_TRADES, wins = WR_WINS }, {
			trades = cum.trades,
			wins = cum.tradeWins,
		})
		local stats = statsOf(s)
		check(
			suite,
			"elig folded every session",
			{ sessions = #WR_PLAN, trades = WR_TRADES, tradeWins = WR_WINS, pnlUsd = cum.pnlUsd },
			{
				sessions = stats.elig.sessions,
				trades = stats.elig.trades,
				tradeWins = stats.elig.tradeWins,
				pnlUsd = stats.elig.pnlUsd,
			}
		)

		-- These three reads are the FIRST for pnlAll and winRate in a run, which is
		-- also what puts this player inside those boards' cached rows — the
		-- reply-shape suite borrows them for exactly that.
		local values: { [string]: number } = {}
		for _, boardId in ipairs(Protocol.BOARD_IDS) do
			local reply = requestBoard(h, boardId)
			if reply == nil then
				fail(suite, boardId, "Board dropped a valid board request")
				continue
			end
			local you = reply.payload.you
			if you == nil then
				fail(suite, `{boardId} row`, `{#WR_PLAN} eligible sessions did not reach {boardId}`)
				continue
			end
			local expected = if boardId == "winRate" then WR_BP else Board.decodeUsd(Board.encodeUsd(cum.pnlUsd))
			check(suite, `{boardId}: value`, expected, you.value)
			values[boardId] = expected
		end
		ctx.posted = { harness = h, values = values }
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 6. the gates on read
-- ---------------------------------------------------------------------------

-- Seven winners in ten single-trade sessions: 7000 bp exactly, and the tenth
-- session is what opens the win-rate board.
local GATE_WINS: { boolean } = { true, true, false, true, true, false, true, true, false, true }
local GATE_WIN_COUNT = 7
local GATE_BP = 7000

local function suiteGates(ctx: Ctx): Suite
	local suite = newSuite("gates")

	test(suite, "membership flips at the session minimum, not before it", function()
		local plans: { { boolean } } = {}
		for i, win in ipairs(GATE_WINS) do
			plans[i] = { win }
		end

		local s, h = newSession()
		local pnlAllValueSeen = false
		local cum = grind(suite, s, ctx.day, plans, "session", function(j: number, running: Cum)
			check(suite, `after {j}: elig.sessions`, j, statsOf(s).elig.sessions)
			ok(
				suite,
				`after {j}: pnlAll membership`,
				onBoard(h, "pnlAll") == (j >= MIN_SESSIONS_PNL),
				`{j} eligible sessions vs a gate of {MIN_SESSIONS_PNL}`
			)
			ok(
				suite,
				`after {j}: winRate membership`,
				onBoard(h, "winRate") == (j >= MIN_SESSIONS_WIN_RATE),
				`{j} eligible sessions vs a gate of {MIN_SESSIONS_WIN_RATE}`
			)
			-- Read ONCE, on the fold that opens the board: Board memoizes this
			-- player's value onto the cached snapshot, so every later read of it
			-- would answer with this same number however much the board moved.
			if j == MIN_SESSIONS_PNL then
				local reply = requestBoard(h, "pnlAll")
				if reply == nil or reply.payload.you == nil then
					fail(suite, "pnlAll value", "no row on the fold that crossed the gate")
				else
					pnlAllValueSeen = true
					check(
						suite,
						"the opening pnlAll value",
						Board.decodeUsd(Board.encodeUsd(running.pnlUsd)),
						reply.payload.you.value
					)
				end
			end
			if j == MIN_SESSIONS_WIN_RATE then
				local reply = requestBoard(h, "winRate")
				if reply == nil or reply.payload.you == nil then
					fail(suite, "winRate value", "no row on the fold that crossed the gate")
				else
					check(suite, "the opening winRate value", GATE_BP, reply.payload.you.value)
				end
			end
		end)
		ok(suite, "the grind completed", cum.sessions == #plans, `{cum.sessions} of {#plans} sessions folded`)
		ok(suite, "the pnlAll gate was actually crossed", pnlAllValueSeen, "the value was never read")
		check(suite, "the ratio the win rate came from", { trades = #plans, wins = GATE_WIN_COUNT }, {
			trades = cum.trades,
			wins = cum.tradeWins,
		})
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 7. handleRequest reply shape
-- ---------------------------------------------------------------------------

-- Every one of these is dropped in silence, exactly like an unknown command: the
-- board id is attacker-supplied and specOf is the whitelist.
local BAD_BOARDS: { { name: string, id: any } } = {
	{ name = "nil", id = nil :: any },
	{ name = "empty string", id = "" },
	{ name = "unknown id", id = "definitelyNotABoard" },
	{ name = "wrong case", id = "pnlall" },
	{ name = "trailing space", id = "pnlAll " },
	{ name = "number", id = 42 },
	{ name = "boolean", id = true },
	{ name = "table", id = {} },
}

local function suiteRequest(ctx: Ctx): Suite
	local suite = newSuite("request")

	test(suite, "every board id answers with a ranked MetaBoard", function()
		local posted = ctx.posted
		if posted == nil then
			fail(suite, "setup", "the winRate suite never produced a player the boards know")
			return
		end
		local inside = 0
		for _, boardId in ipairs(Protocol.BOARD_IDS) do
			local reply = requestBoard(posted.harness, boardId)
			if reply == nil then
				fail(suite, boardId, "Board dropped a valid board request")
				continue
			end
			checkReplyShape(suite, boardId, boardId, posted.harness, reply)

			local you = reply.payload.you
			if you == nil then
				fail(suite, `{boardId}: you`, "the player the board was just posted for has no row")
				continue
			end
			check(suite, `{boardId}: you is this player`, posted.harness.userId, you.userId)
			check(suite, `{boardId}: you carries their value`, posted.values[boardId], you.value)
			local rows = reply.payload.rows :: { Protocol.BoardRow }
			if you.rank == 0 then
				ok(
					suite,
					`{boardId}: rank 0 means outside the rows`,
					rowFor(rows, posted.harness.userId) == nil,
					"rank 0 while sitting in the rows"
				)
			else
				-- `you` IS the row object at that index, so the load-bearing part is
				-- only that the index it claims is the one it sits at.
				inside += 1
				local row = rows[you.rank]
				ok(
					suite,
					`{boardId}: you.rank indexes its own row`,
					row ~= nil and row.userId == posted.harness.userId,
					`rank {you.rank} of {#rows} rows belongs to someone else`
				)
			end
		end
		if inside == 0 then
			-- Board exposes no seam for seeding rows, and the memory board keeps
			-- every earlier run's players, so eventually nobody new is in the top N.
			warn(
				`BoardSpec: no board had this player inside its top {TOP_N}; the inside-the-rows case was not exercised`
			)
		end
	end)

	test(suite, "a player outside the rows still gets their own value", function()
		-- This player posts AFTER every board snapshot was taken, so the cached rows
		-- cannot contain them: `you` can only come from Board's per-player read.
		local s, h = newSession()
		cmd(s, { cmd = "startSession", date = ctx.day })
		local fold = driveEligible(suite, s, { true }, "session")
		if fold == nil then
			return
		end
		cmd(s, { cmd = "startSession", date = ctx.day })

		local reply = requestBoard(h, "pnlWeek")
		if reply == nil then
			fail(suite, "pnlWeek", "Board dropped a valid board request")
			return
		end
		checkReplyShape(suite, "pnlWeek", "pnlWeek", h, reply)
		local you = reply.payload.you
		if you == nil then
			fail(suite, "pnlWeek row", "no row after an eligible fold; Board.post did not reach the memory board")
			return
		end
		check(suite, "you", { userId = h.userId, value = Board.decodeUsd(Board.encodeUsd(fold.pnlUsd)) }, {
			userId = you.userId,
			value = you.value,
		})
		local rows = reply.payload.rows :: { Protocol.BoardRow }
		if rowFor(rows, h.userId) == nil then
			check(suite, "rank is 0 outside the rows", 0, you.rank)
		else
			-- Only reachable if the cached snapshot expired mid-run and refetched.
			warn("BoardSpec: the board snapshot refreshed mid-run; the outside-the-rows rank was not exercised")
		end
	end)

	test(suite, "a player the board has never seen gets no row", function()
		local h = newHarness(newUserId())
		for _, boardId in ipairs(Protocol.BOARD_IDS) do
			local reply = requestBoard(h, boardId)
			if reply == nil then
				fail(suite, boardId, "Board dropped a valid board request")
				continue
			end
			checkReplyShape(suite, boardId, boardId, h, reply)
			ok(suite, `{boardId}: no you`, reply.payload.you == nil, "a player who never played has a row")
		end
	end)

	test(suite, "an unknown board id is dropped in silence", function()
		local h = newHarness(newUserId())
		for _, case in ipairs(BAD_BOARDS) do
			local before = #h.replies
			local success, err = pcall(Board.handleRequest :: any, h.player, h.meta, case.id)
			ok(suite, `{case.name}: no error`, success, `raised: {tostring(err)}`)
			check(suite, `{case.name}: no reply`, before, #h.replies)
		end
	end)

	return suite
end

-- ---------------------------------------------------------------------------

local BoardSpec = {}

export type Result = { passed: number, failed: number, failures: { string } }

local function skip(why: string): Result
	warn(`BoardSpec: {why}; nothing was tested`)
	return { passed = 0, failed = 0, failures = {} }
end

-- True when a DataStore answers. The board assertions below all read Board's
-- in-process fallback, and a reachable store would put the real, shared,
-- eventually-consistent boards behind the same calls.
local function dataStoresReachable(): boolean
	local success = pcall(function()
		DataStoreService:GetDataStore(PROBE_STORE):GetAsync(PROBE_KEY)
	end)
	return success
end

-- The newest day long enough to reach the bar minimum with room for the trades
-- in front of it; the newest also carries the deepest context prefix, which is
-- the more interesting side of the reveal arithmetic.
local function pickDay(dates: { string }): (string?, number)
	for i = #dates, 1, -1 do
		local bars = BarStore.dayBars(dates[i])
		if bars ~= nil and #bars >= MIN_SESSION_BARS + TRADE_HEADROOM then
			return dates[i], #bars
		end
	end
	return nil, 0
end

function BoardSpec.run(): Result
	print("=== BoardSpec ===")

	if not RunService:IsStudio() then
		return skip("this suite writes to the leaderboard and must never run on a live server")
	end
	-- The test-memory switch (honored by PlayerStore.getStore and
	-- Board.getOrdered) pins BOTH stores to their in-memory paths for the rest
	-- of this Studio session, so a reachable DataStore no longer makes the run
	-- unsafe — this place has API access enabled for the data upload.
	_G.__BACKTESTER_TEST_MEMORY = true
	if dataStoresReachable() then
		print("BoardSpec: DataStores reachable; test-memory switch keeps the run off the real boards")
	end
	-- Forces Board onto its in-memory board NOW, which is also what makes
	-- Board.post synchronous: a spawned post that yields in SetAsync would not
	-- have landed by the time the assertions read the board. Studio-only and
	-- scoped to Board's own probe store, so it cannot touch a real board.
	Board.probeNegativeValues()

	local dates = BarStore.availableDates()
	if #dates == 0 then
		local why = "[preflight] BarStore.availableDates() is empty — SampleData is missing or failed to decode"
		warn(`BoardSpec: {why}; nothing was tested`)
		return { passed = 0, failed = 1, failures = { why } }
	end
	local day, dayBars = pickDay(dates)
	if day == nil then
		local why =
			`[preflight] no available date has {MIN_SESSION_BARS + TRADE_HEADROOM} bars; no session can be eligible`
		warn(`BoardSpec: {why}; nothing was tested`)
		return { passed = 0, failed = 1, failures = { why } }
	end

	local ctx: Ctx = { dates = dates, day = day, dayBars = dayBars, posted = nil }
	print(`  data: {#dates} dates, driving {ctx.day} ({ctx.dayBars} bars), week {Board.weekKey(os.time())}`)
	print(`  users: {ID_BASE + 1}.. (salted; Board and PlayerStore keep memory state for the whole Studio session)`)

	-- Order is load-bearing. Board caches each board on first read with no
	-- invalidation seam, so a board read before a player posts can never show them
	-- in its rows again: the winRate suite is what takes pnlAll's and winRate's
	-- first snapshots, and it does so with its own player already on them.
	local runners: { { name: string, fn: (Ctx) -> Suite } } = {
		{ name = "encoding", fn = suiteEncoding },
		{ name = "weekKey", fn = suiteWeekKey },
		{ name = "eligibility", fn = suiteEligibility },
		{ name = "rewind", fn = suiteRewind },
		{ name = "winRate", fn = suiteWinRate },
		{ name = "gates", fn = suiteGates },
		{ name = "request", fn = suiteRequest },
	}

	local total: Result = { passed = 0, failed = 0, failures = {} }
	for _, runner in ipairs(runners) do
		local success, result = pcall(runner.fn, ctx)
		local suite: Suite
		if success then
			suite = result :: Suite
		else
			-- Only setup outside a test body can land here; report it as the suite's
			-- single failure rather than losing the suites behind it.
			suite = newSuite(runner.name)
			suite.current = "<suite setup>"
			fail(suite, "<error>", tostring(result))
		end
		total.passed += suite.passed
		total.failed += suite.failed
		for _, f in ipairs(suite.failures) do
			table.insert(total.failures, f)
		end
		print(`  {suite.name}: {suite.passed} passed, {suite.failed} failed`)
	end

	if total.failed > 0 then
		local shown = math.min(#total.failures, MAX_PRINTED_FAILURES)
		warn(`--- {shown} of {#total.failures} failing cases ---`)
		for i = 1, shown do
			warn(total.failures[i])
		end
	end
	print(`=== {total.passed} passed, {total.failed} failed ===`)

	return total
end

return BoardSpec

--!strict
-- Behavior suite for the SERVER replay layer — the half the golden fixtures
-- cannot reach.
--
-- `tests/fixtures/` pins the SHARED modules (Et, Aggregate, Fills, Engine,
-- ContractMath, BarCodec) against the TS engine. Nothing pins
-- `src/server/Replay/Session.luau`, and the clock, the reveal loop, the command
-- surface, rewind voiding, persistence and the anti-lookahead invariant exist
-- ONLY there. This file drives the real Session against the real BarStore and
-- asserts the packets it emits.
--
-- Usage — Studio COMMAND BAR, EDIT MODE:
--   require(game.ReplicatedStorage.Tests.ServerSpec).run()
--
-- Edit mode is the supported context: Session lives in ServerScriptService,
-- which is not replicated, and during a playtest the command bar runs as a
-- CLIENT and cannot see it. To run under play mode, switch the command bar's
-- context dropdown to Server or drop a one-line Script into
-- ServerScriptService. Nothing here branches on RunService, so both behave the
-- same; edit mode additionally guarantees Main.server.luau is NOT running a
-- second, real Session and heartbeat alongside these.
--
-- FAKES. Session pushes state with `remote:FireClient(player, ...)` and a
-- Player cannot be constructed, so every session here is built on:
--   * a fake player — the only fields Session and the leaderboard hook behind
--     it touch are UserId and Name. Every OTHER index raises a named error, so
--     a new field requirement surfaces as "Session read Player.X" instead of an
--     index-nil crash somewhere downstream;
--   * a fake remotes table — one capturing stub per remote, auto-vivified by
--     name, so a remote added to Session.Remotes later is captured rather than
--     nil-indexed. Bar packets are DECODED on arrival, which is what makes the
--     anti-lookahead audit possible at all.
-- Both are cast to `any` where the Session is constructed: Session.new wants
-- real Instances and no structural fake can satisfy that under --!strict.
--
-- DETERMINISM. Bars come from BarStore, which in Studio has no DataStore and
-- falls back to the bundled SampleData chunk. Dates are read from the store at
-- runtime, never hardcoded, and every expected price and PnL is computed from
-- the loaded bars — regenerating the sample must not require editing this file.
-- Each test builds a FRESH Session under a FRESH UserId; PlayerStore's
-- in-memory fallback is keyed by UserId and outlives a single run, so the ids
-- are salted per run as well.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerScriptService = game:GetService("ServerScriptService")

local Shared = ReplicatedStorage.Shared
local Aggregate = require(Shared.Replay.Aggregate)
local BarCodec = require(Shared.Data.BarCodec)
local ContractMath = require(Shared.Trading.ContractMath)
local Protocol = require(Shared.Net.Protocol)
local Types = require(Shared.Types)

local Server = ServerScriptService.Server
local BarStore = require(Server.Data.BarStore)
local PlayerStore = require(Server.Data.PlayerStore)
local Session = require(Server.Replay.Session)

-- Mirrors Session's private CONTEXT_BARS. Only used to predict how long the
-- context prefix should be; a drift shows up as a failing startSession case
-- rather than as silently weaker assertions.
local CONTEXT_BARS = 2000
-- Session's private STARTING_BALANCE, pinned because it is on the wire in both
-- SessionInfo and TradeState.
local STARTING_BALANCE = 10000
-- Session's DEFAULT_SPEED / DEFAULT_STEP.
local DEFAULT_SPEED = 5
local DEFAULT_STEP = "1m"

-- A wide stop against a near target: the entry fills on the first revealed bar
-- and the take-profit resolves several bars later, so the fill test proves the
-- REVEAL LOOP drives fills rather than the entry alone. Points distances only;
-- every expected price below is derived from the bars, so these two numbers
-- only have to keep resolving somewhere inside the day.
local BRACKET_SL_PTS = 50
local BRACKET_TP_PTS = 25

-- Fields reported per failing case, and failing cases printed in full.
local MAX_FIELDS_PER_CASE = 6
local MAX_PRINTED_FAILURES = 50

local NAN = 0 / 0

-- ---------------------------------------------------------------------------
-- runner
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

-- Numbers compare EXACTLY, unlike Parity's tolerant compare: nothing here
-- crossed JSON, and every price in the sample is an exact multiple of the tick
-- size, so a delta of any size is a real divergence.
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

-- One test = one isolated scenario. The body is pcall'd so a blown Session
-- assert (which is exactly what the lookahead guards raise) is reported as a
-- failing case instead of taking the rest of the suite with it.
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

type BarsPacket = {
	count: number,
	firstT: number?,
	lastT: number?,
	reset: boolean,
	ascending: boolean,
}

type Sent = {
	kind: string,
	bars: BarsPacket?,
	clock: Protocol.Clock?,
	trade: Protocol.TradeState?,
	info: Protocol.SessionInfo?,
}

type Harness = {
	userId: number,
	player: any,
	remotes: any,
	sent: { Sent },
}

-- PlayerStore and Board keep module-global state keyed by UserId for the whole
-- Studio session, so ids must be unique per RUN as well as per test: a reused
-- id would carry a previous run's stats into a fold assertion.
local ID_BASE = 700000000 + Random.new():NextInteger(0, 99999) * 1000
local idCounter = 0

local function newUserId(): number
	idCounter += 1
	return ID_BASE + idCounter
end

local function newHarness(userId: number): Harness
	local sent: { Sent } = {}

	local function onBars(packet: buffer, reset: boolean)
		local bars = BarCodec.decode(packet)
		local ascending = true
		for i = 2, #bars do
			if bars[i].t <= bars[i - 1].t then
				ascending = false
				break
			end
		end
		table.insert(sent, {
			kind = "bars",
			bars = {
				count = #bars,
				firstT = if #bars > 0 then bars[1].t else nil,
				lastT = if #bars > 0 then bars[#bars].t else nil,
				reset = reset,
				ascending = ascending,
			},
		})
	end

	local function fakeRemote(name: string): any
		return {
			FireClient = function(_self: any, _player: any, a: any, b: any)
				if name == "bars" then
					onBars(a :: buffer, b == true)
				elseif name == "clock" then
					table.insert(sent, { kind = "clock", clock = a })
				elseif name == "tradeState" then
					table.insert(sent, { kind = "tradeState", trade = a })
				elseif name == "sessionInfo" then
					table.insert(sent, { kind = "sessionInfo", info = a })
				else
					-- A remote added to Session.Remotes after this file was written.
					table.insert(sent, { kind = name })
				end
			end,
		}
	end

	local remotes: any = setmetatable({}, {
		__index = function(t: any, key: any): any
			local remote = fakeRemote(tostring(key))
			rawset(t, key, remote)
			return remote
		end,
	})

	local player: any = setmetatable({ UserId = userId, Name = `ServerSpec{userId}` }, {
		__index = function(_t: any, key: any): any
			error(`ServerSpec: Session read Player.{tostring(key)}; the fake player provides UserId and Name only`, 2)
		end,
	})

	return { userId = userId, player = player, remotes = remotes, sent = sent }
end

local function newSession(userId: number?): (Session.Session, Harness)
	local h = newHarness(if userId ~= nil then userId else newUserId())
	return Session.new(h.player, h.remotes), h
end

local function startedSession(date: string): (Session.Session, Harness)
	local s, h = newSession()
	Session.handleCmd(s, { cmd = "startSession", date = date })
	return s, h
end

local function cmd(s: Session.Session, msg: any)
	Session.handleCmd(s, msg)
end

local function stepN(s: Session.Session, n: number)
	for _ = 1, n do
		Session.handleCmd(s, { cmd = "stepForward" })
	end
end

local function clearSent(h: Harness)
	table.clear(h.sent)
end

local function kindsOf(h: Harness): { string }
	local out: { string } = {}
	for i, entry in ipairs(h.sent) do
		out[i] = entry.kind
	end
	return out
end

local function lastOf(h: Harness, kind: string): Sent?
	for i = #h.sent, 1, -1 do
		if h.sent[i].kind == kind then
			return h.sent[i]
		end
	end
	return nil
end

-- ---------------------------------------------------------------------------
-- oracles
-- ---------------------------------------------------------------------------

type BracketOutcome = {
	entryPrice: number,
	slPrice: number,
	tpPrice: number,
	exitPrice: number,
	exitTs: number,
	exitIndex: number, -- 1-based index into the DAY bars == 1m steps to resolution
	winner: string, -- "sl" | "tp"
	ambiguous: boolean,
	pnlPts: number,
	pnlUsd: number,
}

-- What a market entry with a points bracket must produce, computed from the
-- session's OWN bars. It mirrors the two Fills rules this order shape can reach
-- (stop fills at max/min(open, level), limit at min/max(open, level)) plus the
-- SL-first same-bar default. Expectations come from the data so that
-- regenerating SampleData never invalidates this file.
local function expectBracket(s: Session.Session, side: string, slPts: number, tpPts: number): BracketOutcome?
	local dir = if side == "buy" then 1 else -1
	local entryPrice = s.bars[s.contextCount + 1].o
	local slPrice = ContractMath.roundToTick(entryPrice - dir * slPts, s.tickSize)
	local tpPrice = ContractMath.roundToTick(entryPrice + dir * tpPts, s.tickSize)
	-- Starts one bar AFTER the entry: the legs are appended while the entry bar's
	-- intents are already decided, so they first face the following bar.
	for i = s.contextCount + 2, #s.bars do
		local b = s.bars[i]
		-- The legs sit on the opposite side of the entry: long -> sell stop at the
		-- SL, sell limit at the TP.
		local slHit = if side == "buy" then b.l <= slPrice else b.h >= slPrice
		local tpHit = if side == "buy" then b.h >= tpPrice else b.l <= tpPrice
		if slHit or tpHit then
			local exitPrice = if slHit
				then (if side == "buy" then math.min(b.o, slPrice) else math.max(b.o, slPrice))
				else (if side == "buy" then math.max(b.o, tpPrice) else math.min(b.o, tpPrice))
			local pnlPts = (exitPrice - entryPrice) * dir
			return {
				entryPrice = entryPrice,
				slPrice = slPrice,
				tpPrice = tpPrice,
				exitPrice = exitPrice,
				exitTs = b.t,
				exitIndex = i - s.contextCount,
				winner = if slHit then "sl" else "tp",
				ambiguous = slHit and tpHit,
				pnlPts = pnlPts,
				pnlUsd = ContractMath.ptsToUsd(pnlPts, 1),
			}
		end
	end
	return nil
end

local function placeBracketOrder(s: Session.Session, side: string)
	cmd(s, {
		cmd = "placeOrder",
		side = side,
		type = "market",
		qty = 1,
		bracket = { stopLossPts = BRACKET_SL_PTS, takeProfitPts = BRACKET_TP_PTS },
	})
end

type Fingerprint = {
	date: string?,
	revealedCount: number,
	contextCount: number,
	currentTime: number,
	accumulator: number,
	playing: boolean,
	speed: number,
	stepSize: string,
	events: number,
	orders: number,
	trades: number,
	positionQty: number,
	realizedUsd: number,
	voidedCount: number,
	packets: number,
}

local function fingerprint(s: Session.Session, h: Harness): Fingerprint
	return {
		date = s.date,
		revealedCount = s.revealedCount,
		contextCount = s.contextCount,
		currentTime = s.currentTime,
		accumulator = s.accumulator,
		playing = s.playing,
		speed = s.speed,
		stepSize = s.stepSize,
		events = #s.events,
		orders = #s.derived.workingOrders,
		trades = #s.derived.trades,
		positionQty = s.derived.position.qty,
		realizedUsd = s.derived.realizedUsd,
		voidedCount = s.derived.voidedCount,
		packets = #h.sent,
	}
end

-- The replay state a rewind and an equivalent backward jump must agree on.
type ClockState = {
	revealedCount: number,
	currentTime: number,
	voidedCount: number,
	positionQty: number,
	positionAvg: number,
	orders: number,
	trades: number,
	realizedPts: number,
	realizedUsd: number,
}

local function clockState(s: Session.Session): ClockState
	return {
		revealedCount = s.revealedCount,
		currentTime = s.currentTime,
		voidedCount = s.derived.voidedCount,
		positionQty = s.derived.position.qty,
		positionAvg = s.derived.position.avgPrice,
		orders = #s.derived.workingOrders,
		trades = #s.derived.trades,
		realizedPts = s.derived.realizedPts,
		realizedUsd = s.derived.realizedUsd,
	}
end

-- The anti-lookahead audit. Session flushes bars BEFORE the clock that
-- authorizes them, so a packet is justified by the first Clock at or after it —
-- or, when it is the tail of the run, by where the clock finally stood.
local function auditLookahead(suite: Suite, case: string, h: Harness, finalTime: number, baseSec: number)
	local audited = 0
	local violations: { string } = {}
	for i, entry in ipairs(h.sent) do
		local bars = entry.bars
		if bars == nil then
			continue
		end
		if not bars.ascending then
			table.insert(violations, `packet {i} is not ascending in time`)
		end
		local lastT = bars.lastT
		if lastT == nil then
			continue
		end
		audited += 1
		local authorized = finalTime
		for j = i, #h.sent do
			local clock = h.sent[j].clock
			if clock ~= nil then
				authorized = clock.t
				break
			end
		end
		if lastT + baseSec > authorized then
			table.insert(violations, `packet {i}: last bar closes at {lastT + baseSec}, clock only at {authorized}`)
		end
	end
	ok(suite, `{case}: packets audited`, audited > 0, "no bar packets were captured; the sequence sent nothing")
	ok(suite, `{case}: no violation`, #violations == 0, table.concat(violations, "; "))
end

-- ---------------------------------------------------------------------------
-- context
-- ---------------------------------------------------------------------------

type Ctx = {
	dates: { string },
	first: string,
	last: string,
	sampleMode: boolean,
}

-- True when BarStore is serving the bundled sample rather than a live
-- DataStore. Sample-shape expectations (the first date having no context bars
-- in front of it) are asserted only then.
local function computeSampleMode(dates: { string }): boolean
	local module = (Server.Data :: any):FindFirstChild("SampleData")
	if module == nil then
		return false
	end
	local success, data = pcall(require, module)
	if not success or typeof(data) ~= "table" then
		return false
	end
	local days = (data :: any).days
	if typeof(days) ~= "table" or #(days :: { any }) ~= #dates then
		return false
	end
	for i, day in ipairs(days :: { any }) do
		if typeof(day) ~= "table" or day.date ~= dates[i] then
			return false
		end
	end
	return true
end

-- ---------------------------------------------------------------------------
-- 1. startSession
-- ---------------------------------------------------------------------------

local function suiteStartSession(ctx: Ctx): Suite
	local suite = newSuite("startSession")

	for index, date in ipairs(ctx.dates) do
		test(suite, `{date} (date {index})`, function()
			local dayBars = BarStore.dayBars(date)
			assert(dayBars ~= nil and #dayBars > 0, `BarStore has no bars for {date}`)
			local expectedContext = #BarStore.barsBefore(dayBars[1].t, CONTEXT_BARS)

			local s, h = startedSession(date)

			check(suite, "date", date, s.date)
			check(suite, "contextCount", expectedContext, s.contextCount)
			-- The context prefix is revealed from the outset and NOTHING of the day
			-- is: the clock sits on the first day bar's open, which has not closed.
			check(suite, "revealedCount == contextCount", s.contextCount, s.revealedCount)
			check(suite, "currentTime == first day bar t", dayBars[1].t, s.currentTime)
			check(suite, "startTs", dayBars[1].t, s.startTs)
			check(suite, "endTs", dayBars[#dayBars].t + s.baseSec, s.endTs)
			check(suite, "bars = context ++ day", expectedContext + #dayBars, #s.bars)
			check(suite, "baseSec", BarStore.baseSec(), s.baseSec)
			check(suite, "tickSize", BarStore.tickSize(), s.tickSize)
			if ctx.sampleMode and index == 1 then
				-- Nothing precedes the sample's first date, so its prefix is empty.
				check(suite, "first sample date has no context", 0, s.contextCount)
			end
			if index > 1 then
				ok(suite, "later dates carry context", s.contextCount > 0, `contextCount was {s.contextCount}`)
			end

			-- Exactly one reset bar packet, then the clock, then the trade state.
			check(suite, "packet order", { "bars", "clock", "tradeState" }, kindsOf(h))

			local barsSent = h.sent[1].bars
			assert(barsSent ~= nil, "first packet was not a bar packet")
			check(suite, "reset packet is a reset", true, barsSent.reset)
			check(suite, "reset packet covers [1, contextCount]", s.contextCount, barsSent.count)
			check(suite, "reset packet ascending", true, barsSent.ascending)
			if s.contextCount > 0 then
				check(suite, "reset packet first bar", s.bars[1].t, barsSent.firstT)
				check(suite, "reset packet last bar", s.bars[s.contextCount].t, barsSent.lastT)
				-- The whole point of the prefix: it is history, never session time.
				ok(
					suite,
					"reset packet holds no day bar",
					(barsSent.lastT :: number) < s.startTs,
					`last context bar t {tostring(barsSent.lastT)} is not before startTs {s.startTs}`
				)
			else
				check(suite, "empty reset packet has no bars", nil, barsSent.lastT)
			end

			local clockSent = h.sent[2].clock
			assert(clockSent ~= nil, "second packet was not a clock packet")
			check(suite, "clock packet", {
				t = dayBars[1].t,
				playing = false,
				speed = DEFAULT_SPEED,
				stepSize = DEFAULT_STEP,
				atEnd = false,
			}, clockSent)

			local tradeSent = h.sent[3].trade
			assert(tradeSent ~= nil, "third packet was not a trade state packet")
			check(suite, "trade state packet", {
				position = { qty = 0, avgPrice = 0 },
				realizedPts = 0,
				realizedUsd = 0,
				workingOrders = {},
				trades = {},
				voidedCount = 0,
				startingBalance = STARTING_BALANCE,
			}, tradeSent)
		end)
	end

	test(suite, "sessionInfo reflects the running day", function()
		local s, h = startedSession(ctx.last)
		clearSent(h)
		Session.sendSessionInfo(s)
		local info = (lastOf(h, "sessionInfo") :: Sent).info
		assert(info ~= nil, "no sessionInfo packet")
		check(suite, "running", true, info.running)
		check(suite, "date", ctx.last, info.date)
		check(suite, "baseSec", s.baseSec, info.baseSec)
		check(suite, "tickSize", s.tickSize, info.tickSize)
		check(suite, "startingBalance", s.derived.startingBalance, info.startingBalance)
		check(suite, "availableDates", ctx.dates, info.availableDates)
	end)

	test(suite, "unknown date leaves the session untouched", function()
		local s, h = newSession()
		local before = fingerprint(s, h)
		cmd(s, { cmd = "startSession", date = "1999-01-01" })
		check(suite, "state unchanged", before, fingerprint(s, h))
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 2. stepForward / stepBack bucket semantics
-- ---------------------------------------------------------------------------

local function suiteStepping(ctx: Ctx): Suite
	local suite = newSuite("stepping")

	test(suite, "1m step reveals exactly one bucket", function()
		local s, h = startedSession(ctx.last)
		local startTs = s.startTs
		local ctxCount = s.contextCount
		clearSent(h)

		cmd(s, { cmd = "stepForward" })
		check(suite, "revealedCount", ctxCount + 1, s.revealedCount)
		check(suite, "currentTime", Aggregate.bucketEnd(startTs, "1m"), s.currentTime)
		-- No fills happened, so the trade state is not resent.
		check(suite, "packets", { "bars", "clock" }, kindsOf(h))
		local barsSent = (h.sent[1] :: Sent).bars
		assert(barsSent ~= nil, "no bar packet")
		check(suite, "one bar, appended not reset", { count = 1, reset = false, firstT = startTs, lastT = startTs }, {
			count = barsSent.count,
			reset = barsSent.reset,
			firstT = barsSent.firstT,
			lastT = barsSent.lastT,
		})

		clearSent(h)
		cmd(s, { cmd = "stepForward" })
		check(suite, "second step revealedCount", ctxCount + 2, s.revealedCount)
		check(suite, "second step currentTime", startTs + 120, s.currentTime)
		local second = (h.sent[1] :: Sent).bars
		assert(second ~= nil, "no bar packet on the second step")
		check(suite, "second step reveals one bar", 1, second.count)
		check(suite, "second step bar t", startTs + 60, second.lastT)
	end)

	test(suite, "15m step reveals through the bucket end", function()
		local s, h = startedSession(ctx.last)
		local startTs = s.startTs
		local ctxCount = s.contextCount
		cmd(s, { cmd = "setStepSize", stepSize = "15m" })
		check(suite, "stepSize accepted", "15m", s.stepSize)
		clearSent(h)

		local target = Aggregate.bucketEnd(startTs, "15m")
		cmd(s, { cmd = "stepForward" })
		check(suite, "currentTime == bucketEnd", target, s.currentTime)
		check(suite, "revealedCount", ctxCount + 15, s.revealedCount)
		local barsSent = (h.sent[1] :: Sent).bars
		assert(barsSent ~= nil, "no bar packet")
		check(
			suite,
			"one packet of 15 bars",
			{ count = 15, reset = false },
			{ count = barsSent.count, reset = barsSent.reset }
		)
		check(suite, "last revealed bar closes at the target", target, (barsSent.lastT :: number) + s.baseSec)

		clearSent(h)
		cmd(s, { cmd = "stepForward" })
		check(suite, "second bucket currentTime", Aggregate.bucketEnd(target, "15m"), s.currentTime)
		check(suite, "second bucket revealedCount", ctxCount + 30, s.revealedCount)
	end)

	test(suite, "a bigger step completes the partial bucket first", function()
		local s, h = startedSession(ctx.last)
		local startTs = s.startTs
		local ctxCount = s.contextCount
		stepN(s, 3)
		cmd(s, { cmd = "setStepSize", stepSize = "15m" })
		clearSent(h)

		cmd(s, { cmd = "stepForward" })
		-- Three 1m bars are already out, so the 15m step only has to finish the
		-- bucket: it must land on the bucket end, not 15 bars past the clock.
		check(suite, "currentTime", Aggregate.bucketEnd(startTs, "15m"), s.currentTime)
		check(suite, "revealedCount", ctxCount + 15, s.revealedCount)
		local barsSent = (h.sent[1] :: Sent).bars
		assert(barsSent ~= nil, "no bar packet")
		check(suite, "revealed the remaining 12", 12, barsSent.count)
		check(suite, "resumed at the 4th day bar", startTs + 180, barsSent.firstT)
	end)

	test(suite, "every step size makes progress", function()
		-- The always-progress guard's contract at the public surface: whatever the
		-- step size, one stepForward must move the clock AND reveal at least one
		-- bar, and must never overshoot the end of the day.
		for _, tf in ipairs(Types.TIMEFRAMES) do
			local s = startedSession(ctx.last)
			cmd(s, { cmd = "setStepSize", stepSize = tf })
			local beforeTime = s.currentTime
			local beforeRevealed = s.revealedCount
			cmd(s, { cmd = "stepForward" })
			ok(
				suite,
				`{tf}: clock advanced`,
				s.currentTime > beforeTime,
				`currentTime stayed at {s.currentTime} (was {beforeTime})`
			)
			ok(
				suite,
				`{tf}: bars revealed`,
				s.revealedCount > beforeRevealed,
				`revealedCount stayed at {s.revealedCount}`
			)
			ok(
				suite,
				`{tf}: clamped to endTs`,
				s.currentTime <= s.endTs,
				`currentTime {s.currentTime} past endTs {s.endTs}`
			)
		end
	end)

	test(suite, "stepping is a no-op at the end of the day", function()
		local s, h = startedSession(ctx.last)
		cmd(s, { cmd = "jumpTo", t = s.endTs })
		check(suite, "everything revealed", #s.bars, s.revealedCount)
		check(suite, "clock at endTs", s.endTs, s.currentTime)
		local atEndClock = (lastOf(h, "clock") :: Sent).clock
		assert(atEndClock ~= nil, "no clock packet after the jump")
		check(suite, "atEnd flag", true, atEndClock.atEnd)

		clearSent(h)
		local before = fingerprint(s, h)
		cmd(s, { cmd = "stepForward" })
		check(suite, "stepForward changed nothing", before, fingerprint(s, h))
		check(suite, "and sent nothing", 0, #h.sent)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 3. play / tick accumulator
-- ---------------------------------------------------------------------------

local function suitePlay(ctx: Ctx): Suite
	local suite = newSuite("play")

	-- Every dt below is an exact binary fraction, so `speed * dt` and the
	-- accumulator carry are exact and the reveal counts are not float-sensitive.
	test(suite, "tick reveals floor(speed * dt) bars", function()
		local s, h = startedSession(ctx.last)
		local startTs = s.startTs
		local ctxCount = s.contextCount
		cmd(s, { cmd = "setSpeed", speed = 10 })
		cmd(s, { cmd = "play" })
		check(suite, "playing", true, s.playing)
		clearSent(h)

		Session.tick(s, 0.5)
		check(suite, "0.5s at 10x reveals 5", ctxCount + 5, s.revealedCount)
		check(suite, "clock at the 5th close", startTs + 300, s.currentTime)
		check(suite, "accumulator consumed", 0, s.accumulator)
		local barsSent = (h.sent[1] :: Sent).bars
		assert(barsSent ~= nil, "no bar packet")
		check(suite, "one packet of 5", 5, barsSent.count)
		check(suite, "appended, not reset", false, barsSent.reset)
	end)

	test(suite, "sub-bar dt accumulates without revealing", function()
		local s, h = startedSession(ctx.last)
		local ctxCount = s.contextCount
		cmd(s, { cmd = "setSpeed", speed = 10 })
		cmd(s, { cmd = "play" })
		clearSent(h)

		Session.tick(s, 0.03125) -- 0.3125 bars
		check(suite, "nothing revealed", ctxCount, s.revealedCount)
		check(suite, "nothing sent", 0, #h.sent)
		Session.tick(s, 0.03125)
		Session.tick(s, 0.03125) -- 0.9375 bars
		check(suite, "still nothing revealed", ctxCount, s.revealedCount)
		check(suite, "accumulator carried", 0.9375, s.accumulator)

		Session.tick(s, 0.0625) -- crosses 1.0
		check(suite, "one bar revealed", ctxCount + 1, s.revealedCount)
		check(suite, "remainder carried", 0.5625, s.accumulator)
	end)

	test(suite, "a hitch is capped at one second of playback", function()
		local s, h = startedSession(ctx.last)
		local startTs = s.startTs
		local ctxCount = s.contextCount
		cmd(s, { cmd = "setSpeed", speed = 10 })
		cmd(s, { cmd = "play" })
		clearSent(h)

		-- 3s at 10x is a 30-bar budget; the cap is speed, and the overshoot is
		-- dropped rather than carried.
		Session.tick(s, 3)
		check(suite, "revealed exactly the cap", ctxCount + 10, s.revealedCount)
		check(suite, "clock", startTs + 600, s.currentTime)
		check(suite, "overshoot dropped", 0, s.accumulator)
		local barsSent = (h.sent[1] :: Sent).bars
		assert(barsSent ~= nil, "no bar packet")
		check(suite, "one packet of 10", 10, barsSent.count)
	end)

	test(suite, "default speed", function()
		local s, h = startedSession(ctx.last)
		local ctxCount = s.contextCount
		check(suite, "starts at the default", DEFAULT_SPEED, s.speed)
		cmd(s, { cmd = "play" })
		clearSent(h)
		Session.tick(s, 0.5)
		check(suite, "0.5s at 5x reveals 2", ctxCount + 2, s.revealedCount)
		check(suite, "remainder carried", 0.5, s.accumulator)
	end)

	test(suite, "a paused session ignores dt", function()
		local s, h = startedSession(ctx.last)
		clearSent(h)
		local before = fingerprint(s, h)
		Session.tick(s, 5)
		check(suite, "unchanged", before, fingerprint(s, h))
	end)

	test(suite, "pause stops the reveal loop", function()
		local s, h = startedSession(ctx.last)
		cmd(s, { cmd = "setSpeed", speed = 10 })
		cmd(s, { cmd = "play" })
		Session.tick(s, 0.5)
		cmd(s, { cmd = "pause" })
		check(suite, "paused", false, s.playing)
		clearSent(h)
		local before = fingerprint(s, h)
		Session.tick(s, 1)
		check(suite, "unchanged after pause", before, fingerprint(s, h))
	end)

	test(suite, "play is refused at the end of the data", function()
		local s, h = startedSession(ctx.last)
		cmd(s, { cmd = "jumpTo", t = s.endTs })
		clearSent(h)
		cmd(s, { cmd = "play" })
		check(suite, "still paused", false, s.playing)
		check(suite, "nothing sent", 0, #h.sent)
	end)

	test(suite, "playback stops when the data runs out", function()
		local s, h = startedSession(ctx.last)
		cmd(s, { cmd = "jumpTo", t = s.endTs - 120 })
		cmd(s, { cmd = "setSpeed", speed = 10 })
		cmd(s, { cmd = "play" })
		clearSent(h)
		Session.tick(s, 1)
		check(suite, "revealed to the end", #s.bars, s.revealedCount)
		check(suite, "stopped playing", false, s.playing)
		check(suite, "clock at endTs", s.endTs, s.currentTime)
		local clock = (lastOf(h, "clock") :: Sent).clock
		assert(clock ~= nil, "no clock packet")
		check(suite, "atEnd", true, clock.atEnd)
		check(suite, "clock reports paused", false, clock.playing)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 4. fills through the public command surface
-- ---------------------------------------------------------------------------

local function suiteFills(ctx: Ctx): Suite
	local suite = newSuite("fills")

	test(suite, "market entry + bracket resolves to a trade", function()
		local s, h = startedSession(ctx.last)
		local expected = expectBracket(s, "buy", BRACKET_SL_PTS, BRACKET_TP_PTS)
		if expected == nil then
			fail(suite, "oracle", `no bracket resolution inside {ctx.last}; pick different SL/TP distances`)
			return
		end
		ok(
			suite,
			"oracle needs more than the entry bar",
			expected.exitIndex >= 2,
			`resolution landed on day bar {expected.exitIndex}`
		)

		clearSent(h)
		placeBracketOrder(s, "buy")
		-- Placing appends and refolds, so the trade state is resent; nothing is
		-- revealed and nothing fills until the clock moves.
		check(suite, "placing sends trade state only", { "tradeState" }, kindsOf(h))
		check(suite, "one working order", 1, #s.derived.workingOrders)
		check(suite, "still flat", 0, s.derived.position.qty)

		-- ---- the entry bar
		clearSent(h)
		cmd(s, { cmd = "stepForward" })
		check(suite, "position after entry", { qty = 1, avgPrice = expected.entryPrice }, {
			qty = s.derived.position.qty,
			avgPrice = s.derived.position.avgPrice,
		})

		local entryFill: any = nil
		for _, ev in ipairs(s.events) do
			if ev.type == "order_filled" then
				entryFill = ev
				break
			end
		end
		assert(entryFill ~= nil, "no order_filled event after the entry bar")
		check(suite, "entry fill", {
			side = "buy",
			qty = 1,
			price = expected.entryPrice,
			barTs = s.startTs,
			fillKind = "market_next_open",
			ambiguousBar = false,
		}, {
			side = entryFill.payload.side,
			qty = entryFill.payload.qty,
			price = entryFill.payload.price,
			barTs = entryFill.payload.barTs,
			fillKind = entryFill.payload.fillKind,
			ambiguousBar = entryFill.payload.ambiguousBar,
		})
		check(suite, "entry fill tsMarket is the bar open", s.startTs, entryFill.tsMarket)

		-- ---- the two OCO legs
		local legs = s.derived.workingOrders
		check(suite, "two legs spawned", 2, #legs)
		local stopLeg, limitLeg = legs[1], legs[2]
		check(suite, "stop leg", {
			side = "sell",
			type = "stop",
			qty = 1,
			stopPrice = expected.slPrice,
			reduceOnly = true,
		}, {
			side = stopLeg.side,
			type = stopLeg.type,
			qty = stopLeg.qty,
			stopPrice = stopLeg.stopPrice,
			reduceOnly = stopLeg.reduceOnly,
		})
		check(suite, "limit leg", {
			side = "sell",
			type = "limit",
			qty = 1,
			limitPrice = expected.tpPrice,
			reduceOnly = true,
		}, {
			side = limitLeg.side,
			type = limitLeg.type,
			qty = limitLeg.qty,
			limitPrice = limitLeg.limitPrice,
			reduceOnly = limitLeg.reduceOnly,
		})
		ok(
			suite,
			"legs share one OCO group",
			stopLeg.ocoId ~= nil and stopLeg.ocoId == limitLeg.ocoId,
			`ocoIds were {tostring(stopLeg.ocoId)} and {tostring(limitLeg.ocoId)}`
		)
		-- The legs reach the client, the bracket that spawned them does not.
		local tradeSent = (lastOf(h, "tradeState") :: Sent).trade
		assert(tradeSent ~= nil, "no trade state packet after the entry")
		check(suite, "legs are on the wire", 2, #tradeSent.workingOrders)
		check(suite, "leg view carries the ocoId", stopLeg.ocoId, tradeSent.workingOrders[1].ocoId)

		-- ---- run to resolution
		clearSent(h)
		stepN(s, expected.exitIndex - 1)
		check(suite, "flat after resolution", 0, s.derived.position.qty)
		check(suite, "no orders left", 0, #s.derived.workingOrders)
		check(suite, "realizedPts", expected.pnlPts, s.derived.realizedPts)
		check(suite, "realizedUsd", expected.pnlUsd, s.derived.realizedUsd)
		check(suite, "no voiding happened", 0, s.derived.voidedCount)

		check(suite, "one trade", 1, #s.derived.trades)
		local trade = s.derived.trades[1]
		check(suite, "trade", {
			entryTs = s.startTs,
			exitTs = expected.exitTs,
			side = "buy",
			qty = 1,
			avgEntry = expected.entryPrice,
			avgExit = expected.exitPrice,
			pnlPts = expected.pnlPts,
			pnlUsd = expected.pnlUsd,
			ambiguous = expected.ambiguous,
			riskPts = BRACKET_SL_PTS,
			slPrice = expected.slPrice,
			tpPrice = expected.tpPrice,
		}, trade)

		-- ---- the losing leg was cancelled by OCO, not by orphan cleanup
		local ocoCancels = 0
		local otherCancels: { string } = {}
		local closedEvents = 0
		for _, ev in ipairs(s.events) do
			if ev.type == "order_cancelled" then
				if ev.payload.reason == "oco" then
					ocoCancels += 1
				else
					table.insert(otherCancels, tostring(ev.payload.reason))
				end
			elseif ev.type == "position_closed" then
				closedEvents += 1
			end
		end
		check(suite, "exactly one OCO cancel", 1, ocoCancels)
		ok(suite, "no other cancels", #otherCancels == 0, `also cancelled for: {table.concat(otherCancels, ", ")}`)
		check(suite, "position_closed appended", 1, closedEvents)

		local finalTrade = (lastOf(h, "tradeState") :: Sent).trade
		assert(finalTrade ~= nil, "no closing trade state packet")
		check(suite, "wire trade count", 1, #finalTrade.trades)
		check(suite, "wire realizedUsd", expected.pnlUsd, finalTrade.realizedUsd)
		check(suite, "wire position flat", 0, finalTrade.position.qty)
	end)

	test(suite, "flatten cancels the legs and closes at the next open", function()
		local s = startedSession(ctx.last)
		local entryPrice = s.bars[s.contextCount + 1].o
		local exitPrice = s.bars[s.contextCount + 2].o
		placeBracketOrder(s, "buy")
		cmd(s, { cmd = "stepForward" })
		check(suite, "long with two legs", { qty = 1, orders = 2 }, {
			qty = s.derived.position.qty,
			orders = #s.derived.workingOrders,
		})

		cmd(s, { cmd = "flatten" })
		-- Both legs go, and one reduce-only market takes their place.
		check(suite, "one order after flatten", 1, #s.derived.workingOrders)
		check(
			suite,
			"it is a reduce-only market sell",
			{ type = "market", side = "sell", reduceOnly = true, qty = 1 },
			{
				type = s.derived.workingOrders[1].type,
				side = s.derived.workingOrders[1].side,
				reduceOnly = s.derived.workingOrders[1].reduceOnly,
				qty = s.derived.workingOrders[1].qty,
			}
		)
		check(suite, "still long until the next bar", 1, s.derived.position.qty)

		cmd(s, { cmd = "stepForward" })
		check(suite, "flat", 0, s.derived.position.qty)
		check(suite, "no orders left", 0, #s.derived.workingOrders)
		check(suite, "one trade", 1, #s.derived.trades)
		check(suite, "closed at the next open", {
			avgEntry = entryPrice,
			avgExit = exitPrice,
			pnlPts = exitPrice - entryPrice,
			pnlUsd = ContractMath.ptsToUsd(exitPrice - entryPrice, 1),
		}, {
			avgEntry = s.derived.trades[1].avgEntry,
			avgExit = s.derived.trades[1].avgExit,
			pnlPts = s.derived.trades[1].pnlPts,
			pnlUsd = s.derived.trades[1].pnlUsd,
		})
	end)

	test(suite, "cancel removes a resting order before it can fill", function()
		local s = startedSession(ctx.last)
		placeBracketOrder(s, "buy")
		local orderId = s.derived.workingOrders[1].id
		cmd(s, { cmd = "cancelOrder", orderId = orderId })
		check(suite, "no orders left", 0, #s.derived.workingOrders)
		stepN(s, 3)
		check(suite, "nothing filled", 0, s.derived.position.qty)
		check(suite, "no trades", 0, #s.derived.trades)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 5. rewind
-- ---------------------------------------------------------------------------

local function suiteRewind(ctx: Ctx): Suite
	local suite = newSuite("rewind")

	test(suite, "stepBack voids the fills it passes", function()
		local s, h = startedSession(ctx.last)
		local startTs = s.startTs
		local ctxCount = s.contextCount
		local expected = expectBracket(s, "buy", BRACKET_SL_PTS, BRACKET_TP_PTS)
		if expected == nil then
			fail(suite, "oracle", `no bracket resolution inside {ctx.last}`)
			return
		end
		placeBracketOrder(s, "buy")
		stepN(s, expected.exitIndex)
		check(suite, "trade closed before rewinding", 1, #s.derived.trades)

		clearSent(h)
		-- One step back lands ON the exit bar's open: voiding is strictly after
		-- the target, so the exit fill survives its own bar.
		cmd(s, { cmd = "stepBack" })
		check(suite, "clock", expected.exitTs, s.currentTime)
		check(suite, "revealedCount", ctxCount + expected.exitIndex - 1, s.revealedCount)
		check(suite, "nothing voided yet", 0, s.derived.voidedCount)
		check(suite, "trade still stands", 1, #s.derived.trades)
		check(suite, "rewind resends the whole cache", { "bars", "clock", "tradeState" }, kindsOf(h))
		local resent = (h.sent[1] :: Sent).bars
		assert(resent ~= nil, "no bar packet on rewind")
		check(suite, "reset packet", { reset = true, count = s.revealedCount }, {
			reset = resent.reset,
			count = resent.count,
		})

		-- The second step back crosses the exit: the fill and its OCO cancel are
		-- voided, and the position they closed comes back with its legs.
		cmd(s, { cmd = "stepBack" })
		check(suite, "exit fill + oco cancel voided", 2, s.derived.voidedCount)
		check(suite, "trade withdrawn", 0, #s.derived.trades)
		check(suite, "position restored", 1, s.derived.position.qty)
		check(suite, "legs restored", 2, #s.derived.workingOrders)
		check(suite, "realizedUsd reset", 0, s.derived.realizedUsd)
		check(suite, "clock", startTs + (expected.exitIndex - 2) * 60, s.currentTime)
	end)

	test(suite, "rewind floors at the day open, never into the context prefix", function()
		local s, h = startedSession(ctx.last)
		local ctxCount = s.contextCount
		stepN(s, 5)
		for _ = 1, 5 do
			cmd(s, { cmd = "stepBack" })
		end
		check(suite, "revealedCount floored at contextCount", ctxCount, s.revealedCount)
		check(suite, "clock floored at startTs", s.startTs, s.currentTime)

		clearSent(h)
		local before = fingerprint(s, h)
		cmd(s, { cmd = "stepBack" })
		-- A no-op rewind would still append an event and resend the whole cache.
		check(suite, "further stepBack is inert", before, fingerprint(s, h))
		check(suite, "and silent", 0, #h.sent)
	end)

	test(suite, "a bucket that starts before the day open is clamped", function()
		local s = startedSession(ctx.last)
		local ctxCount = s.contextCount
		-- 1W buckets open on Sunday evening, long before this day: stepping back
		-- must clamp to startTs rather than reach into the context prefix.
		cmd(s, { cmd = "setStepSize", stepSize = "1W" })
		cmd(s, { cmd = "stepForward" })
		check(suite, "the whole day revealed", #s.bars, s.revealedCount)
		cmd(s, { cmd = "stepBack" })
		check(suite, "clamped to startTs", s.startTs, s.currentTime)
		check(suite, "revealedCount at contextCount", ctxCount, s.revealedCount)
	end)

	test(suite, "a backward jump equals the same rewind", function()
		local probe = startedSession(ctx.last)
		local target = expectBracket(probe, "buy", BRACKET_SL_PTS, BRACKET_TP_PTS)
		if target == nil then
			fail(suite, "oracle", `no bracket resolution inside {ctx.last}`)
			return
		end

		local a = startedSession(ctx.last)
		placeBracketOrder(a, "buy")
		stepN(a, target.exitIndex)
		cmd(a, { cmd = "stepBack" })
		cmd(a, { cmd = "stepBack" })

		local b = startedSession(ctx.last)
		placeBracketOrder(b, "buy")
		stepN(b, target.exitIndex)
		cmd(b, { cmd = "jumpTo", t = a.currentTime })

		check(suite, "jumpTo backward == stepBack", clockState(a), clockState(b))
	end)

	test(suite, "a forward jump simulates the same fills as stepping", function()
		local probe = startedSession(ctx.last)
		local target = expectBracket(probe, "buy", BRACKET_SL_PTS, BRACKET_TP_PTS)
		if target == nil then
			fail(suite, "oracle", `no bracket resolution inside {ctx.last}`)
			return
		end

		local a = startedSession(ctx.last)
		placeBracketOrder(a, "buy")
		stepN(a, target.exitIndex + 5)

		local b = startedSession(ctx.last)
		placeBracketOrder(b, "buy")
		cmd(b, { cmd = "jumpTo", t = a.currentTime })

		check(suite, "jumpTo forward == stepping", clockState(a), clockState(b))
		check(suite, "same trade", a.derived.trades[1], b.derived.trades[1])
		check(suite, "the jump filled at all", 1, #b.derived.trades)
	end)

	test(suite, "rewinding to the open keeps the fill that happened on it", function()
		-- Voiding is strictly AFTER the rewind target, and the entry fills at the
		-- first day bar's OPEN, which is startTs — the floor itself. The position
		-- therefore survives a full rewind. Asserted because it is surprising, not
		-- because it is obviously right.
		local s = startedSession(ctx.last)
		local ctxCount = s.contextCount
		placeBracketOrder(s, "buy")
		stepN(s, 3)
		check(suite, "filled", 1, s.derived.position.qty)
		for _ = 1, 3 do
			cmd(s, { cmd = "stepBack" })
		end
		check(suite, "back at the open", s.startTs, s.currentTime)
		check(suite, "nothing of the day is revealed", ctxCount, s.revealedCount)
		check(suite, "the entry fill survived", 1, s.derived.position.qty)
		check(suite, "its legs survived", 2, #s.derived.workingOrders)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 6. anti-lookahead
-- ---------------------------------------------------------------------------

local function suiteLookahead(ctx: Ctx): Suite
	local suite = newSuite("lookahead")

	test(suite, "a hostile command sequence never leaks an unclosed bar", function()
		local s, h = startedSession(ctx.last)
		local startTs, endTs = s.startTs, s.endTs
		local mid = startTs + math.floor((endTs - startTs) / 2 / 60) * 60

		-- Everything that moves the clock, in the order most likely to trip the
		-- guard: bucket steps, a jump to the very end, rewinds out of it, autoplay,
		-- and a jump back into the middle with a bracket live the whole time.
		placeBracketOrder(s, "buy")
		cmd(s, { cmd = "setStepSize", stepSize = "15m" })
		cmd(s, { cmd = "stepForward" })
		cmd(s, { cmd = "stepForward" })
		cmd(s, { cmd = "jumpTo", t = endTs })
		cmd(s, { cmd = "stepBack" })
		cmd(s, { cmd = "jumpTo", t = startTs })
		cmd(s, { cmd = "setStepSize", stepSize = "1m" })
		stepN(s, 3)
		cmd(s, { cmd = "setSpeed", speed = 20 })
		cmd(s, { cmd = "play" })
		Session.tick(s, 0.5)
		Session.tick(s, 3)
		cmd(s, { cmd = "jumpTo", t = mid })
		cmd(s, { cmd = "jumpTo", t = startTs + 120 })
		cmd(s, { cmd = "stepForward" })
		cmd(s, { cmd = "jumpTo", t = endTs })

		auditLookahead(suite, "sequence", h, s.currentTime, s.baseSec)
		check(suite, "ended at endTs", endTs, s.currentTime)
		check(suite, "everything revealed", #s.bars, s.revealedCount)
	end)

	test(suite, "reset packets always carry exactly the revealed prefix", function()
		local s, h = startedSession(ctx.last)
		cmd(s, { cmd = "jumpTo", t = s.endTs })
		clearSent(h)

		-- Backward and forward alternating, so every reset lands on a different
		-- prefix length.
		local targets = { s.startTs, s.startTs + 900, s.startTs + 60, s.endTs - 60 }
		for _, t in ipairs(targets) do
			local from = #h.sent + 1
			cmd(s, { cmd = "jumpTo", t = t })
			for i = from, #h.sent do
				local packet = h.sent[i].bars
				if packet == nil or not packet.reset then
					continue
				end
				check(suite, `reset at {t}: covers the revealed prefix`, s.revealedCount, packet.count)
				local lastT = packet.lastT
				if lastT ~= nil then
					check(suite, `reset at {t}: last bar has closed`, true, lastT + s.baseSec <= s.currentTime)
				end
			end
		end
		auditLookahead(suite, "jump sequence", h, s.currentTime, s.baseSec)
	end)

	test(suite, "autoplay to the end of the day never oversends", function()
		local s, h = startedSession(ctx.last)
		placeBracketOrder(s, "buy")
		cmd(s, { cmd = "setSpeed", speed = 500 })
		cmd(s, { cmd = "play" })
		clearSent(h)
		-- 500 bars/s capped at 500 per tick: three ticks cover the whole day.
		for _ = 1, 5 do
			Session.tick(s, 1)
		end
		check(suite, "reached the end", #s.bars, s.revealedCount)
		check(suite, "stopped", false, s.playing)
		auditLookahead(suite, "autoplay", h, s.currentTime, s.baseSec)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 7. command validation
-- ---------------------------------------------------------------------------

type BadCommand = { name: string, msg: any }

-- Every payload below must be dropped: no error, no state change, no packet.
local BAD_COMMANDS: { BadCommand } = {
	{ name = "nil payload", msg = nil :: any },
	{ name = "string payload", msg = "stepForward" },
	{ name = "number payload", msg = 42 },
	{ name = "boolean payload", msg = true },
	{ name = "no cmd field", msg = {} },
	{ name = "numeric cmd", msg = { cmd = 42 } },
	{ name = "table cmd", msg = { cmd = {} } },
	{ name = "unknown cmd", msg = { cmd = "definitelyNotACommand" } },
	{ name = "startSession without a date", msg = { cmd = "startSession" } },
	{ name = "startSession with a numeric date", msg = { cmd = "startSession", date = 7 } },
	{ name = "negative speed", msg = { cmd = "setSpeed", speed = -5 } },
	{ name = "zero speed", msg = { cmd = "setSpeed", speed = 0 } },
	{ name = "off-ladder speed", msg = { cmd = "setSpeed", speed = 7 } },
	{ name = "NaN speed", msg = { cmd = "setSpeed", speed = NAN } },
	{ name = "infinite speed", msg = { cmd = "setSpeed", speed = math.huge } },
	{ name = "string speed", msg = { cmd = "setSpeed", speed = "10" } },
	{ name = "unknown step size", msg = { cmd = "setStepSize", stepSize = "7m" } },
	{ name = "numeric step size", msg = { cmd = "setStepSize", stepSize = 15 } },
	{ name = "jumpTo without t", msg = { cmd = "jumpTo" } },
	{ name = "jumpTo NaN", msg = { cmd = "jumpTo", t = NAN } },
	{ name = "jumpTo +inf", msg = { cmd = "jumpTo", t = math.huge } },
	{ name = "jumpTo -inf", msg = { cmd = "jumpTo", t = -math.huge } },
	{ name = "jumpTo before the day", msg = { cmd = "jumpTo", t = 0 } },
	{ name = "jumpTo a string", msg = { cmd = "jumpTo", t = "1782770400" } },
	{ name = "placeOrder with nothing", msg = { cmd = "placeOrder" } },
	{ name = "unknown side", msg = { cmd = "placeOrder", side = "long", type = "market", qty = 1 } },
	{ name = "unknown order type", msg = { cmd = "placeOrder", side = "buy", type = "iceberg", qty = 1 } },
	{ name = "NaN qty", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = NAN } },
	{ name = "infinite qty", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = math.huge } },
	{ name = "zero qty", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = 0 } },
	{ name = "negative qty", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = -1 } },
	{ name = "qty that quantizes to zero", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = 0.04 } },
	{ name = "huge qty", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = 1e9 } },
	{ name = "string qty", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = "1" } },
	{ name = "limit without a price", msg = { cmd = "placeOrder", side = "buy", type = "limit", qty = 1 } },
	{
		name = "stop with a NaN price",
		msg = { cmd = "placeOrder", side = "buy", type = "stop", qty = 1, stopPrice = NAN },
	},
	{
		name = "negative bracket stop",
		msg = {
			cmd = "placeOrder",
			side = "buy",
			type = "market",
			qty = 1,
			bracket = { stopLossPts = -1, takeProfitPts = 5 },
		},
	},
	{
		name = "zero bracket target",
		msg = {
			cmd = "placeOrder",
			side = "buy",
			type = "market",
			qty = 1,
			bracket = { stopLossPts = 5, takeProfitPts = 0 },
		},
	},
	{
		name = "half a bracket",
		msg = { cmd = "placeOrder", side = "buy", type = "market", qty = 1, bracket = { stopLossPts = 5 } },
	},
	{
		name = "NaN bracket",
		msg = {
			cmd = "placeOrder",
			side = "buy",
			type = "market",
			qty = 1,
			bracket = { stopLossPts = NAN, takeProfitPts = 5 },
		},
	},
	{ name = "modifyOrder with a numeric id", msg = { cmd = "modifyOrder", orderId = 42 } },
	{
		name = "modifyOrder on an unknown order",
		msg = { cmd = "modifyOrder", orderId = "o999", changes = { qty = 1 } },
	},
	{ name = "cancelOrder with a numeric id", msg = { cmd = "cancelOrder", orderId = 42 } },
	{ name = "cancelOrder on an unknown order", msg = { cmd = "cancelOrder", orderId = "o999" } },
	{ name = "cancelOrder without an id", msg = { cmd = "cancelOrder" } },
}

-- Commands that need a loaded day and must be inert without one.
local DAY_COMMANDS: { BadCommand } = {
	{ name = "stepForward", msg = { cmd = "stepForward" } },
	{ name = "stepBack", msg = { cmd = "stepBack" } },
	{ name = "jumpTo", msg = { cmd = "jumpTo", t = 1782770400 } },
	{ name = "play", msg = { cmd = "play" } },
	{ name = "pause", msg = { cmd = "pause" } },
	{ name = "placeOrder", msg = { cmd = "placeOrder", side = "buy", type = "market", qty = 1 } },
	{ name = "flatten", msg = { cmd = "flatten" } },
}

local function suiteValidation(ctx: Ctx): Suite
	local suite = newSuite("validation")

	test(suite, "malformed payloads neither raise nor mutate", function()
		local s, h = startedSession(ctx.last)
		-- Mid-session, with a working order and a position, so a payload that DID
		-- slip through would have somewhere visible to land.
		placeBracketOrder(s, "buy")
		stepN(s, 2)
		clearSent(h)

		for _, entry in ipairs(BAD_COMMANDS) do
			local before = fingerprint(s, h)
			local success, err = pcall(Session.handleCmd :: any, s, entry.msg)
			ok(suite, `{entry.name}: no error`, success, `raised: {tostring(err)}`)
			check(suite, `{entry.name}: inert`, before, fingerprint(s, h))
		end
	end)

	test(suite, "replay commands need a loaded day", function()
		local s, h = newSession()
		for _, entry in ipairs(DAY_COMMANDS) do
			local before = fingerprint(s, h)
			local success, err = pcall(Session.handleCmd :: any, s, entry.msg)
			ok(suite, `{entry.name}: no error`, success, `raised: {tostring(err)}`)
			check(suite, `{entry.name}: inert`, before, fingerprint(s, h))
		end
	end)

	test(suite, "clock config is accepted from the lobby", function()
		-- The positive control for the test above: setSpeed/setStepSize are the two
		-- commands that legitimately work with no day loaded.
		local s, h = newSession()
		cmd(s, { cmd = "setSpeed", speed = 50 })
		check(suite, "speed applied", 50, s.speed)
		cmd(s, { cmd = "setStepSize", stepSize = "4h" })
		check(suite, "step size applied", "4h", s.stepSize)
		local clock = (lastOf(h, "clock") :: Sent).clock
		assert(clock ~= nil, "no clock packet")
		check(suite, "echoed to the client", { speed = 50, stepSize = "4h" }, {
			speed = clock.speed,
			stepSize = clock.stepSize,
		})
		-- No day: atEnd must not claim the session finished.
		check(suite, "atEnd is false with no day", false, clock.atEnd)
	end)

	test(suite, "a hostile burst leaves a live session consistent", function()
		local s, h = startedSession(ctx.last)
		placeBracketOrder(s, "buy")
		stepN(s, 2)
		clearSent(h)
		local before = fingerprint(s, h)
		for _ = 1, 3 do
			for _, entry in ipairs(BAD_COMMANDS) do
				pcall(Session.handleCmd, s, entry.msg)
			end
		end
		check(suite, "state identical after 3 passes", before, fingerprint(s, h))
		check(suite, "no packets emitted", 0, #h.sent)
	end)

	return suite
end

-- ---------------------------------------------------------------------------
-- 8. persistence (in-memory fallback)
-- ---------------------------------------------------------------------------

local function suitePersistence(ctx: Ctx): Suite
	local suite = newSuite("persistence")

	test(suite, "the second startSession folds the first into stats", function()
		local s = startedSession(ctx.last)
		local expected = expectBracket(s, "buy", BRACKET_SL_PTS, BRACKET_TP_PTS)
		if expected == nil then
			fail(suite, "oracle", `no bracket resolution inside {ctx.last}`)
			return
		end
		local userId = s.player.UserId

		check(suite, "stats start empty", { sessions = 0, trades = 0, pnlUsd = 0, wins = 0, tradeWins = 0 }, {
			sessions = s.persist.data.stats.sessions,
			trades = s.persist.data.stats.trades,
			pnlUsd = s.persist.data.stats.pnlUsd,
			wins = s.persist.data.stats.wins,
			tradeWins = s.persist.data.stats.tradeWins,
		})

		placeBracketOrder(s, "buy")
		stepN(s, expected.exitIndex)
		check(suite, "a winning trade to fold", true, expected.pnlUsd > 0)

		cmd(s, { cmd = "startSession", date = ctx.first })
		local stats = s.persist.data.stats
		check(suite, "folded stats", {
			sessions = 1,
			trades = 1,
			pnlUsd = expected.pnlUsd,
			wins = 1,
			tradeWins = 1,
		}, {
			sessions = stats.sessions,
			trades = stats.trades,
			pnlUsd = stats.pnlUsd,
			wins = stats.wins,
			tradeWins = stats.tradeWins,
		})
		-- The active log is dropped by the fold; the NEW day is what is live now.
		check(suite, "new day loaded", ctx.first, s.date)
		check(suite, "fresh log", 0, #s.derived.trades)

		local week = stats.week
		if week == nil then
			fail(suite, "week bucket", "stats.week was nil after a fold")
		else
			check(suite, "week bucket", { sessions = 1, trades = 1, pnlUsd = expected.pnlUsd, wins = 1 }, {
				sessions = week.sessions,
				trades = week.trades,
				pnlUsd = week.pnlUsd,
				wins = week.wins,
			})
			ok(suite, "week key is a string", typeof(week.key) == "string" and week.key ~= "", tostring(week.key))
		end

		-- ...and the fold reached the store, not just the in-process copy.
		local stored = PlayerStore.load(userId)
		check(suite, "persisted stats", {
			sessions = 1,
			trades = 1,
			pnlUsd = expected.pnlUsd,
			wins = 1,
			tradeWins = 1,
		}, {
			sessions = stored.stats.sessions,
			trades = stored.stats.trades,
			pnlUsd = stored.stats.pnlUsd,
			wins = stored.stats.wins,
			tradeWins = stored.stats.tradeWins,
		})
		local active = stored.active
		if active == nil then
			fail(suite, "persisted active session", "nothing active was stored after the switch")
		else
			check(suite, "active session is the new day", ctx.first, active.date)
		end
	end)

	test(suite, "a rejoin resumes where the session stood", function()
		local userId = newUserId()
		local first, h1 = newSession(userId)
		cmd(first, { cmd = "startSession", date = ctx.last })
		local expected = expectBracket(first, "buy", BRACKET_SL_PTS, BRACKET_TP_PTS)
		if expected == nil then
			fail(suite, "oracle", `no bracket resolution inside {ctx.last}`)
			return
		end
		placeBracketOrder(first, "buy")
		stepN(first, expected.exitIndex + 2)
		Session.persistNow(first)
		check(suite, "the tail was written", false, first.persist.dirty)
		check(suite, "the first session traded", 1, #first.derived.trades)

		-- The rejoin: a brand-new Session for the same UserId, driven only by the
		-- one command the client sends on connect.
		local second, h2 = newSession(userId)
		Session.onReady(second)

		check(suite, "date", first.date, second.date)
		check(suite, "revealedCount", first.revealedCount, second.revealedCount)
		check(suite, "currentTime", first.currentTime, second.currentTime)
		check(suite, "contextCount", first.contextCount, second.contextCount)
		check(suite, "startTs", first.startTs, second.startTs)
		check(suite, "endTs", first.endTs, second.endTs)
		check(suite, "event count", #first.events, #second.events)
		check(suite, "trades", first.derived.trades, second.derived.trades)
		check(suite, "realizedUsd", first.derived.realizedUsd, second.derived.realizedUsd)
		check(suite, "position", first.derived.position, second.derived.position)
		check(suite, "working orders", #first.derived.workingOrders, #second.derived.workingOrders)
		-- Order ids are minted from nextId, so the counter has to clear every id
		-- the restored log already contains.
		check(suite, "id counter restored", first.nextId, second.nextId)
		check(suite, "resumed paused", false, second.playing)

		-- SessionInfo first (it carries the tickSize the bar packet decodes with),
		-- then the full state.
		check(suite, "packet order", { "sessionInfo", "bars", "clock", "tradeState" }, kindsOf(h2))
		local info = (h2.sent[1] :: Sent).info
		assert(info ~= nil, "first packet was not sessionInfo")
		check(suite, "info reports a running day", { running = true, date = ctx.last }, {
			running = info.running,
			date = info.date,
		})
		local barsSent = (h2.sent[2] :: Sent).bars
		assert(barsSent ~= nil, "second packet was not bars")
		check(suite, "reset covers the revealed prefix", { reset = true, count = second.revealedCount }, {
			reset = barsSent.reset,
			count = barsSent.count,
		})
		local clock = (h2.sent[3] :: Sent).clock
		assert(clock ~= nil, "third packet was not a clock")
		check(
			suite,
			"clock resumes",
			{ t = first.currentTime, playing = false },
			{ t = clock.t, playing = clock.playing }
		)
		auditLookahead(suite, "resume", h2, second.currentTime, second.baseSec)

		-- The first session's packets are irrelevant here; only that it produced
		-- some, i.e. the harness was wired to it at all.
		ok(suite, "the first session sent packets", #h1.sent > 0, "the first session never sent anything")

		-- Resume is one-shot: a second ready must not re-resume or re-send.
		clearSent(h2)
		Session.onReady(second)
		check(suite, "a second ready only re-sends sessionInfo", { "sessionInfo" }, kindsOf(h2))
	end)

	test(suite, "a fresh player gets the picker and nothing else", function()
		local s, h = newSession()
		Session.onReady(s)
		check(suite, "one packet", { "sessionInfo" }, kindsOf(h))
		local info = (h.sent[1] :: Sent).info
		assert(info ~= nil, "no sessionInfo")
		check(suite, "not running", false, info.running)
		check(suite, "no date", nil, info.date)
		check(suite, "dates offered", ctx.dates, info.availableDates)
		check(suite, "baseSec", BarStore.baseSec(), info.baseSec)
		check(suite, "tickSize", BarStore.tickSize(), info.tickSize)
		check(suite, "startingBalance", STARTING_BALANCE, info.startingBalance)
		check(suite, "no day loaded", nil, s.date)
		check(suite, "nothing revealed", 0, s.revealedCount)
	end)

	test(suite, "a session with no trades folds as neither win nor loss", function()
		local s = startedSession(ctx.last)
		stepN(s, 3)
		cmd(s, { cmd = "startSession", date = ctx.first })
		local stats = s.persist.data.stats
		check(suite, "counted, but not won", { sessions = 1, trades = 0, pnlUsd = 0, wins = 0, tradeWins = 0 }, {
			sessions = stats.sessions,
			trades = stats.trades,
			pnlUsd = stats.pnlUsd,
			wins = stats.wins,
			tradeWins = stats.tradeWins,
		})
	end)

	return suite
end

-- ---------------------------------------------------------------------------

local ServerSpec = {}

export type Result = { passed: number, failed: number, failures: { string } }

function ServerSpec.run(): Result
	print("=== ServerSpec ===")

	-- Pin PlayerStore/Board to their in-memory paths (honored by their store
	-- getters, Studio-only): with API access enabled on this place, a run
	-- would otherwise write real players_v1 keys under the fake user ids.
	_G.__BACKTESTER_TEST_MEMORY = true

	local dates = BarStore.availableDates()
	if #dates == 0 then
		local why = "[preflight] BarStore.availableDates() is empty — SampleData is missing or failed to decode"
		warn(`ServerSpec: {why}; nothing was tested`)
		return { passed = 0, failed = 1, failures = { why } }
	end

	local ctx: Ctx = {
		dates = dates,
		first = dates[1],
		-- The last date carries the deepest context prefix, so it exercises the
		-- prefix arithmetic that the first date cannot.
		last = dates[#dates],
		sampleMode = computeSampleMode(dates),
	}
	if not ctx.sampleMode then
		warn("ServerSpec: BarStore is not serving the bundled SampleData; sample-shape cases are skipped")
	end
	print(`  data: {#dates} dates, {ctx.first} .. {ctx.last}, tick {BarStore.tickSize()}, base {BarStore.baseSec()}s`)

	local runners: { { name: string, fn: (Ctx) -> Suite } } = {
		{ name = "startSession", fn = suiteStartSession },
		{ name = "stepping", fn = suiteStepping },
		{ name = "play", fn = suitePlay },
		{ name = "fills", fn = suiteFills },
		{ name = "rewind", fn = suiteRewind },
		{ name = "lookahead", fn = suiteLookahead },
		{ name = "validation", fn = suiteValidation },
		{ name = "persistence", fn = suitePersistence },
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

return ServerSpec

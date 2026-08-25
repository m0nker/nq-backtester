--!strict
-- One replay session per player: the authoritative clock, the append-only
-- event log, and the fill loop that ties them together.
--
-- The day's FULL bar array lives here and never leaves except through
-- sendBars, which can only encode the revealed prefix — that is the whole
-- anti-lookahead guarantee, and the assert in sendBars is what keeps it true.
--
-- The array is prefixed with `contextCount` bars from BEFORE the day's open.
-- They are revealed from the first frame because they closed before startTs
-- (the web shows the same window — barSource's ensureLoadedAround), and they
-- are history, not session time: nothing fills on them and no rewind reaches
-- back into them.
--
-- Semantics mirror the web reference (lib/replay/clock.ts for stepping/play,
-- lib/trading/store.ts for order mechanics). The divergences are structural:
-- stepping runs on a server heartbeat instead of a browser timer, and every
-- command arrives from an untrusted client and is re-validated here.

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage.Shared
local Aggregate = require(Shared.Replay.Aggregate)
local BarCodec = require(Shared.Data.BarCodec)
local ContractMath = require(Shared.Trading.ContractMath)
local Engine = require(Shared.Trading.Engine)
local EventTypes = require(Shared.Events.Types)
local Fills = require(Shared.Trading.Fills)
local Protocol = require(Shared.Net.Protocol)
local Types = require(Shared.Types)

local BarStore = require(script.Parent.Parent.Data.BarStore)
local PlayerStore = require(script.Parent.Parent.Data.PlayerStore)
local Board = require(script.Parent.Parent.Meta.Board)

type Bar = Types.Bar
type Timeframe = Types.Timeframe
type Side = EventTypes.Side
type SessionEvent = EventTypes.SessionEvent
type WorkingOrder = Fills.WorkingOrder

local M = {}

export type Remotes = {
	clock: RemoteEvent,
	bars: RemoteEvent,
	tradeState: RemoteEvent,
	sessionInfo: RemoteEvent,
}

-- Persistence bookkeeping. The DataStore round trip yields, the reveal loop
-- must not, so every field here exists to keep the write on its own thread and
-- to stop two of them overlapping on one key.
export type Persist = {
	data: PlayerStore.PlayerData,
	loaded: boolean,
	loading: boolean,
	writing: boolean,
	dirty: boolean,
	capped: boolean, -- log outgrew MAX_EVENTS: this session is no longer written
	resumeTried: boolean,
	lastWrite: number,
}

export type Session = {
	player: Player,
	remotes: Remotes,
	date: string?,
	bars: { Bar }, -- server-only; the client sees BarCodec slices of [1, revealedCount]
	contextCount: number, -- bars[1 .. contextCount] closed before startTs
	revealedCount: number,
	currentTime: number,
	startTs: number, -- open of the first DAY bar; the context prefix sits before it
	endTs: number, -- close of the last bar; the clock never advances past it
	playing: boolean,
	speed: number,
	stepSize: Timeframe,
	accumulator: number, -- fractional base bars carried between heartbeats
	tickSize: number,
	baseSec: number,
	events: { SessionEvent },
	derived: Engine.EngineState,
	nextId: number,
	clockDirty: boolean,
	tradeDirty: boolean,
	switching: boolean, -- a session load is mid-yield; no other load may interleave
	persist: Persist,
}

local STARTING_BALANCE = 10000
-- Closed bars shown in front of the start point, ~1.5 trading days. Costs one
-- extra month chunk on load and ~48 KB in the reset bar packet.
local CONTEXT_BARS = 2000
-- Trailing hourly bars sent as deep history, one packet per session start.
-- ~23.2 bars per trading day, so this is roughly 3.4 years — META_PLAN §4.3's
-- 3-year horizon expressed as a bar count, which is what bounds the PACKET
-- (20 + 24 * 20000 = ~480 KB) rather than the horizon. The full series is
-- ~96k bars / 2.3 MB and is far past what one FireClient should carry.
local HISTORY_MAX_BARS = 20000
local DEFAULT_SPEED = 5
local DEFAULT_STEP: Timeframe = "1m"
-- Client-supplied sizes are quantized then bounded; nothing about the sim
-- breaks above this, it just stops absurd inputs reaching the reducer.
local MAX_QTY = 100
-- Upper bound on how much of a session a crash can cost. Writes are one key
-- per player, so this is also the per-player DataStore write rate.
local PERSIST_INTERVAL_SEC = 8
-- A dirty session left mid-write on shutdown: how long the blocking flush will
-- wait for the in-flight write before giving up on the tail.
local PERSIST_WAIT_SEC = 5

local SPEED_OK: { [number]: boolean } = {}
for _, v in ipairs(Protocol.SPEEDS) do
	SPEED_OK[v] = true
end

-- The web's 'view' step size is client-side sugar (follow the chart): the
-- client resolves it and sends the concrete timeframe.
local STEP_OK: { [string]: boolean } = {}
for _, tf in ipairs(Types.TIMEFRAMES) do
	STEP_OK[tf] = true
end

local function isFiniteNumber(v: any): boolean
	return typeof(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge
end

local function oid(s: Session): string
	s.nextId += 1
	return "o" .. s.nextId
end

local function findOrder(orders: { WorkingOrder }, id: string): WorkingOrder?
	for _, o in ipairs(orders) do
		if o.id == id then
			return o
		end
	end
	return nil
end

-- ------------------------------------------------------------------- log

local function append(s: Session, evType: string, tsMarket: number, payload: any)
	-- Autoplay advances the clock every heartbeat; one event per CONTIGUOUS
	-- advance is enough (order/fill events carry their own tsMarket).
	if evType == "time_advanced" then
		local last = s.events[#s.events]
		if
			last ~= nil
			and last.type == "time_advanced"
			and last.payload.to == payload.from
			and last.payload.mode == payload.mode
		then
			last.payload.to = payload.to
			last.tsMarket = tsMarket
			s.persist.dirty = true
			return
		end
	end
	table.insert(s.events, { type = evType, tsMarket = tsMarket, payload = payload })
	s.persist.dirty = true
	if not s.persist.capped and #s.events > PlayerStore.MAX_EVENTS then
		-- Past the cap the key is at risk of growing unwritable, so this session
		-- stops being saved entirely; what is already stored stays resumable.
		s.persist.capped = true
		warn(`[backtester] {s.player.Name}'s log passed {PlayerStore.MAX_EVENTS} events; it will no longer be saved`)
	end
end

-- Derived state is never stored; every order-affecting append re-folds the log.
local function refresh(s: Session)
	s.derived = Engine.deriveState(s.events)
	s.tradeDirty = true
end

-- ------------------------------------------------------------------ send

local function sendClock(s: Session)
	s.remotes.clock:FireClient(s.player, {
		t = s.currentTime,
		playing = s.playing,
		speed = s.speed,
		stepSize = s.stepSize,
		atEnd = s.date ~= nil and s.revealedCount >= #s.bars,
	})
	s.clockDirty = false
end

local function sendTradeState(s: Session)
	local st = s.derived
	-- Exactly the Protocol fields: `bracket` stays server-side, it is an input
	-- to fill processing and not part of the contract.
	local orders: { { [string]: any } } = {}
	for _, o in ipairs(st.workingOrders) do
		table.insert(orders, {
			id = o.id,
			side = o.side,
			type = o.type,
			qty = o.qty,
			limitPrice = o.limitPrice,
			stopPrice = o.stopPrice,
			ocoId = o.ocoId,
			reduceOnly = o.reduceOnly,
		})
	end
	s.remotes.tradeState:FireClient(s.player, {
		position = { qty = st.position.qty, avgPrice = st.position.avgPrice },
		realizedPts = st.realizedPts,
		realizedUsd = st.realizedUsd,
		workingOrders = orders,
		trades = st.trades,
		voidedCount = st.voidedCount,
		startingBalance = st.startingBalance,
	})
	s.tradeDirty = false
end

local function sendBars(s: Session, fromIdx: number, toIdx: number, reset: boolean)
	-- The anti-lookahead invariant, asserted at the only place bars leave the
	-- server: never past the revealed prefix, and the last encoded bar must
	-- have CLOSED at the current clock.
	assert(toIdx <= s.revealedCount, "LOOKAHEAD VIOLATION: encode past revealedCount")
	local last = s.bars[toIdx]
	assert(
		last == nil or last.t + s.baseSec <= s.currentTime,
		"LOOKAHEAD VIOLATION: encoded bar has not closed at the current clock"
	)
	s.remotes.bars:FireClient(s.player, BarCodec.encodeSlice(s.bars, fromIdx, toIdx, s.tickSize), reset)
end

-- YIELDS on the first call per server (the DataStore read behind
-- BarStore.hourlyHistory), so it is only ever reached from a spawned thread —
-- never from the reveal loop, and never inside the `switching` guard.
--
-- Deep 1h history for the high timeframes, sent ONCE per session start/resume:
-- the series is fixed, so no reveal or rewind can change what belongs in it.
-- Everything sent CLOSED before the session's first bar OPENED, which is what
-- makes it history rather than lookahead — asserted here rather than trusted,
-- exactly as sendBars does one resolution down.
local function sendHistory(s: Session)
	local bars = s.bars
	local first = bars[1]
	if first == nil then
		return
	end
	local hist = BarStore.hourlyHistory()
	if hist == nil or #hist == 0 then
		return -- no artifact on this server: the client never hears about history
	end
	if s.bars ~= bars then
		return -- the day was replaced while the key loaded; that load sends its own
	end
	-- Number of hourly bars closed at or before `first.t`. Binary-searched: the
	-- series is ~96k bars and a linear scan of it runs on a command thread.
	local lo, hi = 1, #hist + 1
	while lo < hi do
		local mid = (lo + hi) // 2
		if hist[mid].t + Protocol.HISTORY_SEC <= first.t then
			lo = mid + 1
		else
			hi = mid
		end
	end
	local cut = lo - 1
	if cut <= 0 then
		return
	end
	assert(
		hist[cut].t + Protocol.HISTORY_SEC <= first.t,
		"LOOKAHEAD VIOLATION: hourly history overlaps the session's first bar"
	)
	local from = math.max(1, cut - HISTORY_MAX_BARS + 1)
	local packet = BarCodec.encodeSlice(hist, from, cut, s.tickSize)
	s.remotes.bars:FireClient(s.player, packet, false, Protocol.BARS_MODE_HISTORY)
end

-- One packet per operation: bars for the newly revealed range, then a clock
-- update and a trade state only if either actually changed.
local function flush(s: Session, fromIdx: number?, toIdx: number?)
	if fromIdx ~= nil and toIdx ~= nil and toIdx >= fromIdx then
		sendBars(s, fromIdx, toIdx, false)
	end
	if s.clockDirty then
		sendClock(s)
	end
	if s.tradeDirty then
		sendTradeState(s)
	end
end

function M.sendSessionInfo(s: Session)
	local info: Protocol.SessionInfo = {
		availableDates = BarStore.availableDates(),
		baseSec = s.baseSec,
		tickSize = s.tickSize,
		startingBalance = STARTING_BALANCE,
		-- A resumed session is already running when the client first hears from
		-- us, so the picker must not present itself as the only next step.
		running = s.date ~= nil,
		date = s.date,
	}
	s.remotes.sessionInfo:FireClient(s.player, info)
end

-- --------------------------------------------------------------- fills

-- Spawn the OCO bracket legs after an entry fill. Points form only: command
-- validation never produces BracketSpec's absolute-stop or absolute-TP forms,
-- which exist for the web's bot strategies.
local function spawnBracket(
	s: Session,
	entrySide: Side,
	qty: number,
	fillPrice: number,
	stopLossPts: number,
	takeProfitPts: number,
	ts: number
)
	local legSide: Side = if entrySide == "buy" then "sell" else "buy"
	local dir = if entrySide == "buy" then 1 else -1
	local ocoId = "oco-" .. oid(s)
	append(s, "order_placed", ts, {
		orderId = oid(s),
		side = legSide,
		type = "stop",
		qty = qty,
		stopPrice = ContractMath.roundToTick(fillPrice - dir * stopLossPts, s.tickSize),
		ocoId = ocoId,
		reduceOnly = true,
	})
	append(s, "order_placed", ts, {
		orderId = oid(s),
		side = legSide,
		type = "limit",
		qty = qty,
		limitPrice = ContractMath.roundToTick(fillPrice + dir * takeProfitPts, s.tickSize),
		ocoId = ocoId,
		reduceOnly = true,
	})
end

-- Returns false when the intent was voided instead of filled (reduce-only
-- no-op) — the caller still has a changed log either way.
local function applyFill(s: Session, intent: Fills.FillIntent, order: WorkingOrder, barTs: number): boolean
	local qty = intent.qty
	local pre = s.derived.position.qty
	if order.reduceOnly then
		local opposes = (intent.side == "buy" and pre < 0) or (intent.side == "sell" and pre > 0)
		if not opposes then
			append(s, "order_cancelled", barTs, { orderId = intent.orderId, reason = "reduce_only_noop" })
			return false
		end
		qty = ContractMath.quantizeQty(math.min(qty, math.abs(pre)))
	end
	append(s, "order_filled", barTs, {
		orderId = intent.orderId,
		fillId = HttpService:GenerateGUID(false),
		side = intent.side,
		qty = qty,
		price = intent.price,
		barTs = barTs,
		fillKind = intent.fillKind,
		ambiguousBar = intent.ambiguousBar,
	})
	local ocoId = order.ocoId
	if ocoId ~= nil then
		for _, o in ipairs(s.derived.workingOrders) do
			if o.ocoId == ocoId and o.id ~= order.id then
				append(s, "order_cancelled", barTs, { orderId = o.id, reason = "oco" })
			end
		end
	end
	local bracket = order.bracket
	if bracket ~= nil and bracket.stopLossPts ~= nil and bracket.takeProfitPts ~= nil then
		-- Brackets protect NEW exposure only: a bracketed order that merely
		-- closes a position must not spawn legs for a flat book.
		local signed = if intent.side == "buy" then qty else -qty
		local post = ContractMath.quantizeQty(pre + signed)
		local reversed = pre ~= 0 and post ~= 0 and math.sign(post) ~= math.sign(pre)
		local increase = if reversed
			then math.abs(post)
			else ContractMath.quantizeQty(math.max(0, math.abs(post) - math.abs(pre)))
		if increase > 0 then
			local entrySide: Side = if post > 0 then "buy" else "sell"
			spawnBracket(s, entrySide, increase, intent.price, bracket.stopLossPts, bracket.takeProfitPts, barTs)
		end
	end
	return true
end

-- Position-linked cleanup: reduce-only orders exist to protect the current
-- position. When it is gone (flat) or flipped, they cancel automatically.
local function cancelOrphanedLegs(s: Session, ts: number): boolean
	local pos = s.derived.position.qty
	local cancelled = false
	for _, o in ipairs(s.derived.workingOrders) do
		if o.reduceOnly then
			local valid = (o.side == "sell" and pos > 0) or (o.side == "buy" and pos < 0)
			if not valid then
				append(s, "order_cancelled", ts, { orderId = o.id, reason = "position_closed" })
				cancelled = true
			end
		end
	end
	return cancelled
end

-- Evaluate one newly revealed base bar. This port ships no 1s data, so the
-- seconds resolver is always nil and Fills falls back to SL-first.
local function processBar(s: Session, bar: Bar)
	-- Reveal starts at contextCount, so this can only ever see day bars. Stated
	-- as an assert because a fill on a context bar would be a trade the player
	-- was never given the chance to place.
	assert(bar.t >= s.startTs, "fill processing reached a pre-session context bar")
	if #s.derived.workingOrders == 0 then
		return
	end
	local intents = Fills.simulateBar(s.derived.workingOrders, bar, nil, s.baseSec)
	if #intents == 0 then
		return
	end
	local filled = false
	for _, intent in ipairs(intents) do
		local order = findOrder(s.derived.workingOrders, intent.orderId)
		if order == nil then
			continue
		end
		filled = applyFill(s, intent, order, bar.t) or filled
		refresh(s) -- fills/cancels affect the intents that follow
	end
	if cancelOrphanedLegs(s, bar.t) then
		refresh(s)
		filled = true
	end
	if filled then
		local lastTrade = s.derived.trades[#s.derived.trades]
		if lastTrade ~= nil and s.derived.position.qty == 0 and lastTrade.exitTs == bar.t then
			append(s, "position_closed", bar.t, {
				entryTs = lastTrade.entryTs,
				exitTs = lastTrade.exitTs,
				side = lastTrade.side,
				qty = lastTrade.qty,
				avgEntry = lastTrade.avgEntry,
				avgExit = lastTrade.avgExit,
				pnlPts = lastTrade.pnlPts,
				pnlUsd = lastTrade.pnlUsd,
			})
		end
	end
end

-- ---------------------------------------------------------------- clock

local function advanceClock(s: Session, to: number, mode: string)
	if to <= s.currentTime then
		return
	end
	append(s, "time_advanced", to, { from = s.currentTime, to = to, mode = mode })
	s.currentTime = to
	s.clockDirty = true
end

-- Reveal exactly one bar. Bars are revealed one at a time and IN ORDER even
-- when a heartbeat covers many, so fill timing stays bar-exact.
local function revealOne(s: Session, mode: string): boolean
	if s.revealedCount >= #s.bars then
		return false
	end
	local bar = s.bars[s.revealedCount + 1]
	s.revealedCount += 1
	advanceClock(s, bar.t + s.baseSec, mode)
	processBar(s, bar)
	return true
end

local function revealThrough(s: Session, target: number, mode: string): (number, number)
	local fromIdx = s.revealedCount + 1
	while s.revealedCount < #s.bars do
		local nextBar = s.bars[s.revealedCount + 1]
		if nextBar.t + s.baseSec > target then
			break
		end
		revealOne(s, mode)
	end
	return fromIdx, s.revealedCount
end

local function revealedAt(s: Session, t: number): number
	local n = 0
	for i = 1, #s.bars do
		if s.bars[i].t + s.baseSec <= t then
			n = i
		else
			break
		end
	end
	return n
end

-- Going backwards is a REWIND, not a re-render: the log keeps every order and
-- fill, and Engine.deriveState voids the ones after the target. The client
-- cache is replaced wholesale because its tail is now unrevealed.
local function rewindTo(s: Session, to: number)
	-- The floor is the day's open, never the context prefix: a bucket that
	-- starts before it (1W/1M step sizes, or the first bucket of the day) is
	-- clamped here rather than rejected, so stepping back still makes progress.
	to = math.max(to, s.startTs)
	append(s, "time_rewound", to, { from = s.currentTime, to = to })
	refresh(s)
	s.currentTime = to
	s.revealedCount = math.max(revealedAt(s, to), s.contextCount)
	s.accumulator = 0
	sendBars(s, 1, s.revealedCount, true)
	sendClock(s)
	sendTradeState(s)
end

-- ----------------------------------------------------------------- bars

-- YIELDS (BarStore may fetch a second month chunk). Returns the day's bars
-- behind their context prefix, plus the prefix length. Called BEFORE either
-- load path commits to the new day, so no yield sits between the commit and a
-- consistent bars/contextCount pair.
local function withContext(dayBars: { Bar }): ({ Bar }, number)
	local context = BarStore.barsBefore(dayBars[1].t, CONTEXT_BARS)
	local all: { Bar } = {}
	table.move(context, 1, #context, 1, all)
	table.move(dayBars, 1, #dayBars, #context + 1, all)
	return all, #context
end

-- ----------------------------------------------------------- persistence

-- Ported from the web reference (lib/data/sessions.ts):
--   export function resumeTimeOf(events: SessionEvent[], fallback: number): number {
--     let t = fallback;
--     for (const ev of events) if (ev.tsMarket > t) t = ev.tsMarket;
--     return t;
--   }
-- The clock resumes at the LATEST market time any event observed. A trailing
-- time_rewound does NOT pull it back: rewinds void, they never truncate, so
-- the log's furthest point is where the session stood.
local function resumeTimeOf(events: { SessionEvent }, fallback: number): number
	local t = fallback
	for _, ev in ipairs(events) do
		if ev.tsMarket > t then
			t = ev.tsMarket
		end
	end
	return t
end

local function idNumber(v: any): number
	if typeof(v) ~= "string" then
		return 0
	end
	local n = string.match(v, "^o(%d+)$") or string.match(v, "^oco%-o(%d+)$")
	return if n ~= nil then (tonumber(n) or 0) else 0
end

-- Order ids are minted from nextId, so a resumed log has to push the counter
-- past every id it already contains — otherwise a new order reuses a
-- historical id and deriveState folds the two into one.
local function highestOrderId(events: { SessionEvent }): number
	local hi = 0
	for _, ev in ipairs(events) do
		local payload = ev.payload
		if typeof(payload) == "table" then
			hi = math.max(hi, idNumber(payload.orderId), idNumber(payload.ocoId))
		end
	end
	return hi
end

-- YIELDS. Idempotent, and safe to call from two threads: the second waits out
-- the first rather than issuing a second read.
local function ensurePersistLoaded(s: Session)
	while s.persist.loading do
		task.wait()
	end
	if s.persist.loaded then
		return
	end
	s.persist.loading = true
	local ok, data = pcall(PlayerStore.load, s.player.UserId)
	s.persist.loading = false
	if ok and typeof(data) == "table" then
		s.persist.data = data
	else
		warn(`[backtester] player data load failed for {s.player.Name}: {data}`)
	end
	s.persist.loaded = true
end

-- YIELDS. Only ever reached from a spawned task, PlayerRemoving or
-- BindToClose — never from the reveal loop.
local function persistWrite(s: Session)
	if s.persist.writing or s.persist.capped then
		return
	end
	s.persist.writing = true
	ensurePersistLoaded(s)
	local data = s.persist.data
	if s.date ~= nil then
		-- The live log IS the saved log; PlayerStore.save makes the decoupled
		-- copy, before any yield, so later appends cannot corrupt this write.
		data.active = { date = s.date, events = s.events, savedAt = os.time() }
	end
	-- Cleared BEFORE the write: an append landing while it is in flight has to
	-- leave the session dirty, not be swallowed by a late clear.
	s.persist.dirty = false
	local ok, saved = pcall(PlayerStore.save, s.player.UserId, data)
	if not ok or saved ~= true then
		s.persist.dirty = true
	end
	s.persist.lastWrite = os.clock()
	s.persist.writing = false
end

-- Never yields: the heartbeat calls this every frame and hands the round trip
-- to its own thread.
local function persistTick(s: Session)
	local p = s.persist
	if not p.dirty or p.capped or p.writing then
		return
	end
	if os.clock() - p.lastWrite < PERSIST_INTERVAL_SEC then
		return
	end
	task.spawn(persistWrite, s)
end

-- Fold the outgoing session into lifetime stats and drop it. The live log wins
-- over the last snapshot; when nothing is loaded in memory (the player never
-- sent ready and started a fresh day) the saved log is folded instead.
--
-- THIS IS THE ONLY STATS FOLD, and it runs from startSessionInner alone — i.e.
-- when the player starts their NEXT day. PlayerRemoving/BindToClose save the
-- active log for resume but deliberately never fold it: an unfinished session
-- is still resumable, and folding it on disconnect would count it twice when
-- they come back. The visible consequence is that a player who plays one day
-- and leaves does not reach the leaderboard until they return.
local function finalizeActive(s: Session)
	local data = s.persist.data
	local outgoing: Engine.EngineState? = nil
	if s.date ~= nil then
		outgoing = s.derived
	else
		local active = data.active
		if active ~= nil then
			local ok, state = pcall(Engine.deriveState, active.events)
			if ok then
				outgoing = state
			end
		end
	end
	if outgoing ~= nil then
		local stats = data.stats
		local won = outgoing.realizedUsd > 0 and #outgoing.trades > 0
		local tradeWins = 0
		for _, trade in ipairs(outgoing.trades) do
			if trade.pnlUsd > 0 then
				tradeWins += 1
			end
		end
		stats.sessions += 1
		stats.trades += #outgoing.trades
		stats.pnlUsd += outgoing.realizedUsd
		-- A session that never traded is neither a win nor a loss, whatever
		-- rounding left behind in realizedUsd.
		if won then
			stats.wins += 1
		end
		stats.tradeWins += tradeWins
		-- The week bucket is keyed on REAL-WORLD time, not the replayed day: the
		-- weekly board is a competition among whoever is playing this week.
		local key = Board.weekKey(os.time())
		local prior = stats.week
		local week: PlayerStore.WeekStats
		if prior ~= nil and prior.key == key then
			week = prior
		else
			week = { key = key, sessions = 0, trades = 0, pnlUsd = 0, wins = 0 }
			stats.week = week
		end
		week.sessions += 1
		week.trades += #outgoing.trades
		week.pnlUsd += outgoing.realizedUsd
		if won then
			week.wins += 1
		end
		-- The SECOND fold: leaderboard-eligible sessions only, and the only one
		-- the boards read. The lifetime counters above bank a rewound session's
		-- voided-away profit too, so a board sourced from them could be farmed in
		-- an ineligible session and laundered through one clean one afterwards.
		if Board.eligible(outgoing, s) then
			local elig = stats.elig
			elig.sessions += 1
			elig.trades += #outgoing.trades
			elig.tradeWins += tradeWins
			elig.pnlUsd += outgoing.realizedUsd
			-- Same key, same rotation as the lifetime week bucket. Nothing else
			-- creates this bucket, which is what makes its presence under the
			-- current key mean "at least one eligible session this week".
			local priorElig = stats.elig.week
			local eligWeek: PlayerStore.EligWeek
			if priorElig ~= nil and priorElig.key == key then
				eligWeek = priorElig
			else
				eligWeek = { key = key, pnlUsd = 0 }
				elig.week = eligWeek
			end
			eligWeek.pnlUsd += outgoing.realizedUsd
			-- A board write is a DataStore round trip and this runs inside
			-- startSessionInner's switching guard, on the path the player is
			-- waiting on: Board.post snapshots synchronously and spawns the write.
			Board.post(s.player, stats)
		end
	end
	data.active = nil
	s.persist.dirty = true
end

-- YIELDS. Restores a saved session in full but sends nothing: the caller
-- controls packet order. Returns false when there was nothing to resume.
local function tryResume(s: Session): boolean
	local p = s.persist
	if p.resumeTried or s.switching or s.date ~= nil then
		return false
	end
	p.resumeTried = true
	local active = p.data.active
	if active == nil then
		return false
	end
	local function dropDead(why: string)
		-- The day is gone from the store, so the log can never be replayed
		-- against bars again. It is discarded WITHOUT counting toward stats:
		-- a session nobody can see the result of is not a session played.
		warn(`[backtester] dropping saved session for {s.player.Name}: {why}`)
		p.data.active = nil
		p.dirty = true
	end
	if not BarStore.hasDate(active.date) then
		dropDead(`date {active.date} is no longer available`)
		return false
	end
	local bars = BarStore.dayBars(active.date)
	if bars == nil or #bars == 0 then
		dropDead(`date {active.date} has no bars`)
		return false
	end
	local all, contextCount = withContext(bars)
	if s.date ~= nil then
		return false -- a startSession landed while the bars were loading
	end
	s.date = active.date
	s.bars = all
	s.contextCount = contextCount
	s.tickSize = BarStore.tickSize()
	s.baseSec = BarStore.baseSec()
	s.startTs = bars[1].t
	s.endTs = bars[#bars].t + s.baseSec
	s.events = active.events
	s.nextId = highestOrderId(s.events)
	-- deriveState replays the whole log, rewind voiding included; no fill is
	-- re-simulated, the log already records every one that happened.
	refresh(s)
	local t = math.clamp(resumeTimeOf(s.events, s.startTs), s.startTs, s.endTs)
	s.currentTime = t
	-- t >= startTs and every context bar closed at/before startTs, so the scan
	-- covers the whole prefix without the log knowing it exists — which is why
	-- a log saved before context existed still resumes correctly.
	s.revealedCount = revealedAt(s, t)
	s.playing = false
	s.accumulator = 0
	-- The caller sends the full state unconditionally; nothing is left pending.
	s.clockDirty = false
	s.tradeDirty = false
	return true
end

-- -------------------------------------------------------------- commands

local function startSessionInner(s: Session, date: string)
	-- The loads below YIELD (DataStore); stop the heartbeat first, or the old
	-- day keeps advancing on top of the session that is being replaced.
	s.playing = false
	s.accumulator = 0
	if not BarStore.hasDate(date) then
		return
	end
	local bars = BarStore.dayBars(date)
	if bars == nil or #bars == 0 then
		return
	end
	local all, contextCount = withContext(bars)
	-- Committed to the replacement only now: the outgoing session is closed out
	-- into lifetime stats before its log stops existing.
	ensurePersistLoaded(s)
	finalizeActive(s)
	s.persist.capped = false
	s.persist.resumeTried = true -- a started session never resumes a saved one
	s.date = date
	s.bars = all
	s.contextCount = contextCount
	s.tickSize = BarStore.tickSize()
	s.baseSec = BarStore.baseSec()
	-- The context prefix is revealed from the outset — it closed before the
	-- session began — while nothing of the DAY is revealed until the first
	-- step/play: the clock sits ON the first day bar's open, which has not
	-- closed yet (matches the web's start(ts)).
	s.revealedCount = contextCount
	s.startTs = bars[1].t
	s.currentTime = bars[1].t
	s.endTs = bars[#bars].t + s.baseSec
	s.playing = false
	s.accumulator = 0
	s.nextId = 0
	s.events = {}
	append(s, "session_started", bars[1].t, {
		startTs = bars[1].t,
		startingBalance = STARTING_BALANCE,
		config = {},
	})
	refresh(s)
	sendBars(s, 1, s.revealedCount, true)
	sendClock(s)
	sendTradeState(s)
	-- Its own thread: the history key may take seconds to load, and neither the
	-- client's session state nor the `switching` guard may wait on it. The client
	-- handles the packet whenever it lands.
	task.spawn(sendHistory, s)
	-- Written immediately, after the client is served: the cleared stats and the
	-- new active session have to land in the same value, or a crash in between
	-- would resurrect the session that was just folded in.
	s.persist.dirty = true
	persistWrite(s)
end

-- The load yields, so a second startSession could otherwise interleave with
-- the first and fold the same session into stats twice.
local function cmdStartSession(s: Session, date: string)
	if s.switching then
		return
	end
	s.switching = true
	-- pcall's result arity follows its callee, which this one has none of; the
	-- cast buys back the error value without loosening the call itself.
	local ok, err = pcall(startSessionInner :: any, s, date)
	s.switching = false
	if not ok then
		error(err, 0) -- the caller's guard owns the logging
	end
end

-- Advance by one bar of the step timeframe: reveal base bars through the end
-- of the bucket the next hidden bar belongs to. Completes a partial candle
-- first; skips halts naturally, since buckets follow the data.
local function cmdStepForward(s: Session)
	local nextBar = s.bars[s.revealedCount + 1]
	if nextBar == nil or s.currentTime >= s.endTs then
		return
	end
	local target = Aggregate.bucketEnd(nextBar.t, s.stepSize)
	-- Always make progress: old-era sessions have bars past the nominal bucket
	-- end (17:00-17:59 ET), which would otherwise pin the clock.
	target = math.max(target, nextBar.t + s.baseSec)
	target = math.min(target, s.endTs)
	local fromIdx, toIdx = revealThrough(s, target, "step")
	advanceClock(s, target, "step")
	flush(s, fromIdx, toIdx)
end

-- Hide the latest (possibly partial) bucket of the step timeframe.
local function cmdStepBack(s: Session)
	-- At the day's open there is nothing left to hide; the context prefix is not
	-- session time, so it must not be stepped into (rewindTo clamps, but a
	-- no-op rewind would still append an event and resend the whole cache).
	if s.revealedCount <= s.contextCount then
		return
	end
	rewindTo(s, Aggregate.bucketStart(s.bars[s.revealedCount].t, s.stepSize))
end

local function cmdJumpTo(s: Session, t: number)
	if #s.bars == 0 or t < s.startTs or t > s.endTs then
		return
	end
	if s.playing then
		s.playing = false
		s.clockDirty = true
	end
	s.accumulator = 0
	if t < s.currentTime then
		rewindTo(s, t)
		return
	end
	-- Forward jumps reveal bar-by-bar WITH fill simulation, exactly like play;
	-- only the network batching differs (one packet at the end).
	local fromIdx, toIdx = revealThrough(s, t, "step")
	advanceClock(s, t, "step")
	flush(s, fromIdx, toIdx)
end

local function cmdPlay(s: Session)
	if s.playing or s.revealedCount >= #s.bars then
		return
	end
	s.playing = true
	s.accumulator = 0
	s.clockDirty = true
	flush(s)
end

local function cmdPause(s: Session)
	if not s.playing then
		return
	end
	s.playing = false
	s.accumulator = 0
	s.clockDirty = true
	flush(s)
end

local function cmdPlaceOrder(s: Session, msg: any)
	local side = msg.side
	if side ~= "buy" and side ~= "sell" then
		return
	end
	local orderType = msg.type
	if orderType ~= "market" and orderType ~= "limit" and orderType ~= "stop" then
		return
	end
	if not isFiniteNumber(msg.qty) then
		return
	end
	local qty = ContractMath.quantizeQty(msg.qty)
	if qty <= 0 or qty > MAX_QTY then
		return
	end
	-- Prices are only required to be finite: session normalization can put a
	-- valid instrument anywhere on the axis, so a positivity test would be a
	-- lie. Tick-rounding is the real guard.
	local limitPrice: number? = nil
	local stopPrice: number? = nil
	if orderType == "limit" then
		if not isFiniteNumber(msg.limitPrice) then
			return
		end
		limitPrice = ContractMath.roundToTick(msg.limitPrice, s.tickSize)
	elseif orderType == "stop" then
		if not isFiniteNumber(msg.stopPrice) then
			return
		end
		stopPrice = ContractMath.roundToTick(msg.stopPrice, s.tickSize)
	end
	local bracket: EventTypes.BracketSpec? = nil
	local spec = msg.bracket
	if typeof(spec) == "table" then
		-- Bracket legs are DISTANCES from the fill, so they must be strictly
		-- positive; a non-positive one would place the leg on the wrong side.
		if not isFiniteNumber(spec.stopLossPts) or not isFiniteNumber(spec.takeProfitPts) then
			return
		end
		if spec.stopLossPts <= 0 or spec.takeProfitPts <= 0 then
			return
		end
		bracket = { stopLossPts = spec.stopLossPts, takeProfitPts = spec.takeProfitPts }
	end
	append(s, "order_placed", s.currentTime, {
		orderId = oid(s),
		side = side,
		type = orderType,
		qty = qty,
		limitPrice = limitPrice,
		stopPrice = stopPrice,
		bracket = bracket,
	})
	refresh(s)
	flush(s)
end

local function cmdModifyOrder(s: Session, msg: any)
	local orderId = msg.orderId
	if typeof(orderId) ~= "string" or findOrder(s.derived.workingOrders, orderId) == nil then
		return
	end
	local changes = msg.changes
	if typeof(changes) ~= "table" then
		return
	end
	local applied: { limitPrice: number?, stopPrice: number?, qty: number? } = {}
	local any = false
	if changes.limitPrice ~= nil then
		if not isFiniteNumber(changes.limitPrice) then
			return
		end
		applied.limitPrice = ContractMath.roundToTick(changes.limitPrice, s.tickSize)
		any = true
	end
	if changes.stopPrice ~= nil then
		if not isFiniteNumber(changes.stopPrice) then
			return
		end
		applied.stopPrice = ContractMath.roundToTick(changes.stopPrice, s.tickSize)
		any = true
	end
	if changes.qty ~= nil then
		if not isFiniteNumber(changes.qty) then
			return
		end
		local qty = ContractMath.quantizeQty(changes.qty)
		if qty <= 0 or qty > MAX_QTY then
			return
		end
		applied.qty = qty
		any = true
	end
	if not any then
		return
	end
	append(s, "order_modified", s.currentTime, { orderId = orderId, changes = applied })
	refresh(s)
	flush(s)
end

local function cmdCancelOrder(s: Session, msg: any)
	local orderId = msg.orderId
	if typeof(orderId) ~= "string" or findOrder(s.derived.workingOrders, orderId) == nil then
		return
	end
	append(s, "order_cancelled", s.currentTime, { orderId = orderId, reason = "user" })
	refresh(s)
	flush(s)
end

local function cmdFlatten(s: Session)
	local st = s.derived
	for _, o in ipairs(st.workingOrders) do
		append(s, "order_cancelled", s.currentTime, { orderId = o.id, reason = "user" })
	end
	if st.position.qty ~= 0 then
		append(s, "order_placed", s.currentTime, {
			orderId = oid(s),
			side = if st.position.qty > 0 then "sell" else "buy",
			type = "market",
			qty = math.abs(st.position.qty),
			reduceOnly = true,
		})
	end
	refresh(s)
	flush(s)
end

-- ------------------------------------------------------------------ api

function M.new(player: Player, remotes: Remotes): Session
	return {
		player = player,
		remotes = remotes,
		date = nil,
		bars = {},
		contextCount = 0,
		revealedCount = 0,
		currentTime = 0,
		startTs = 0,
		endTs = 0,
		playing = false,
		speed = DEFAULT_SPEED,
		stepSize = DEFAULT_STEP,
		accumulator = 0,
		tickSize = BarStore.tickSize(),
		baseSec = BarStore.baseSec(),
		events = {},
		derived = Engine.deriveState({} :: { SessionEvent }),
		nextId = 0,
		clockDirty = false,
		tradeDirty = false,
		switching = false,
		persist = {
			data = PlayerStore.empty(),
			loaded = false,
			loading = false,
			writing = false,
			dirty = false,
			capped = false,
			resumeTried = false,
			lastWrite = os.clock(),
		},
	}
end

-- YIELDS (DataStore). The client's handlers are connected: resume whatever was
-- saved, then answer with the picker and the state of what is now running.
function M.onReady(s: Session)
	ensurePersistLoaded(s)
	local resumed = tryResume(s)
	-- SessionInfo goes first even on resume: it carries the tickSize and
	-- baseSec the client needs to decode the bar packet behind it.
	M.sendSessionInfo(s)
	if resumed then
		sendBars(s, 1, s.revealedCount, true)
		sendClock(s)
		sendTradeState(s)
		task.spawn(sendHistory, s)
	end
end

-- YIELDS until the tail is written. For PlayerRemoving and BindToClose only:
-- both are given time to block, and the tail is the one loss resume can't heal.
function M.persistNow(s: Session)
	local deadline = os.clock() + PERSIST_WAIT_SEC
	while s.persist.writing and os.clock() < deadline do
		task.wait()
	end
	if not s.persist.dirty then
		return
	end
	persistWrite(s)
end

-- Every field below is attacker-controlled. Unknown commands, wrong types and
-- out-of-range values are dropped silently: a hostile client must not be able
-- to fill the server log either.
function M.handleCmd(s: Session, msg: any)
	if typeof(msg) ~= "table" or typeof(msg.cmd) ~= "string" then
		return
	end
	local cmd: string = msg.cmd
	if cmd == "startSession" then
		if typeof(msg.date) == "string" then
			cmdStartSession(s, msg.date)
		end
		return
	end
	-- Clock CONFIG is accepted with no day loaded (the client sets it from the
	-- lobby); anything that touches bars or the log is not.
	if cmd == "setSpeed" then
		if isFiniteNumber(msg.speed) and SPEED_OK[msg.speed] then
			s.speed = msg.speed
			s.clockDirty = true
			flush(s)
		end
		return
	elseif cmd == "setStepSize" then
		if typeof(msg.stepSize) == "string" and STEP_OK[msg.stepSize] then
			s.stepSize = msg.stepSize
			s.clockDirty = true
			flush(s)
		end
		return
	end
	if s.date == nil then
		return -- every other command needs a loaded day
	end
	if cmd == "stepForward" then
		cmdStepForward(s)
	elseif cmd == "stepBack" then
		cmdStepBack(s)
	elseif cmd == "jumpTo" then
		if isFiniteNumber(msg.t) then
			cmdJumpTo(s, msg.t)
		end
	elseif cmd == "play" then
		cmdPlay(s)
	elseif cmd == "pause" then
		cmdPause(s)
	elseif cmd == "placeOrder" then
		cmdPlaceOrder(s, msg)
	elseif cmd == "modifyOrder" then
		cmdModifyOrder(s, msg)
	elseif cmd == "cancelOrder" then
		cmdCancelOrder(s, msg)
	elseif cmd == "flatten" then
		cmdFlatten(s)
	end
end

function M.tick(s: Session, dt: number)
	-- Checked whether or not the clock is running, and never yielding: the
	-- write itself is spawned so the reveal loop below can't wait on DataStore.
	persistTick(s)
	if not s.playing then
		return
	end
	if s.revealedCount >= #s.bars then
		s.playing = false
		s.clockDirty = true
		flush(s)
		return
	end
	s.accumulator += s.speed * dt
	local budget = math.floor(s.accumulator)
	if budget <= 0 then
		return
	end
	s.accumulator -= budget
	-- A scheduler hitch must not dump the rest of the day into one frame: a
	-- heartbeat reveals at most one second of playback, and the overshoot is
	-- dropped rather than carried (playback slows, it never jumps).
	local cap = math.max(1, math.floor(s.speed))
	if budget > cap then
		budget = cap
		s.accumulator = 0
	end
	local fromIdx = s.revealedCount + 1
	for _ = 1, budget do
		if not revealOne(s, "autoplay") then
			break
		end
	end
	if s.revealedCount >= #s.bars then
		s.playing = false -- end of the day's data
		s.clockDirty = true
	end
	flush(s, fromIdx, s.revealedCount)
end

return M

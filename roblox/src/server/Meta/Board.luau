--!strict
-- Leaderboard boards: one OrderedDataStore per metric, rotated by SCOPE rather
-- than by name, so the store name stays stable and readable and rotation uses
-- the mechanism Roblox provides for it.
--
-- Reads are the scarce resource. GetSortedAsync is a LIST operation and the
-- per-server list budget defaults to 5 + 2 * players per minute, which a panel
-- that refetched on every open would burn through in seconds. Every board is
-- fetched at most once per BOARD_TTL and every client request is answered from
-- that snapshot.
--
-- Studio without API access has no DataStore at all. As in PlayerStore, every
-- platform call is pcall'd rather than asserted and the failure degrades to an
-- in-process board, so Play Solo still exercises the whole post/fetch/rank path
-- instead of skipping it.

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Shared = ReplicatedStorage.Shared
local Engine = require(Shared.Trading.Engine)
local Et = require(Shared.Time.Et)
local Protocol = require(Shared.Net.Protocol)

local PlayerStore = require(script.Parent.Parent.Data.PlayerStore)

type BoardRow = Protocol.BoardRow

-- Structurally the fields of Session.Session that eligibility reads. Session
-- requires Board for the post hook, so Board must never require Session back.
type SessionView = { revealedCount: number, contextCount: number }

type Snapshot = {
	fetchedAt: number,
	rows: { BoardRow },
	own: { [number]: number }, -- encoded value of players outside `rows`
}

local M = {}

-- Store names and the fixed scope; both are far under the 50-char key/scope cap.
local PNL_STORE = "lb_pnl_v1"
local WR_STORE = "lb_winrate_v1"
local ALL_SCOPE = "all"
-- Negative-value probing writes here so it can never land in a real board.
local PROBE_SCOPE = "probe"

local BOARD_TTL = 60
local TOP_N = 20
local POST_ATTEMPTS = 3

-- Minimum activity before a player's number means anything, counted in
-- ELIGIBLE sessions (Stats.elig) — exactly the unit META_PLAN §1.1's table
-- states, not the lifetime approximation of it.
local MIN_SESSIONS_PNL = 3
local MIN_SESSIONS_WIN_RATE = 10
-- Two hours of tape revealed past the context prefix. Below that a "session" is
-- a handful of clicks, not a day traded.
local MIN_SESSION_BARS = 120

local ordered: { [string]: OrderedDataStore } = {}
local orderedTried: { [string]: boolean } = {}
local memoryOnly = false
-- The in-process fallback board: cache key -> userId -> encoded value.
local memory: { [string]: { [number]: number } } = {}

local cache: { [string]: Snapshot } = {}
local loading: { [string]: boolean } = {}
local names: { [number]: string } = {}

-- ------------------------------------------------------------------ keys

-- The leaderboard week is the CME trading week (Sunday 18:00 ET open) and the
-- key is that week's Monday trading date: it sorts lexicographically, cannot
-- collide across years, and needs no ISO week-number arithmetic (which does not
-- exist in this codebase and must not be invented outside Et.luau).
--
-- Known quirk: Friday 17:00 ET -> Sunday 18:00 ET is outside every trading
-- week, and tradingWeekStartSec maps that dead zone to the OUTGOING week. A
-- session finished Saturday afternoon therefore scores into the week that just
-- closed. Deterministic and deliberate; do not "fix" it with ad-hoc arithmetic.
function M.weekKey(nowSec: number): string
	return "w" .. Et.tradingDateOf(Et.tradingWeekStartSec(nowSec))
end

-- Store name + scope for a board id, or nil for anything else. The board id is
-- attacker-supplied, so this is also the whitelist.
local function specOf(boardId: string): (string?, string?)
	if boardId == "pnlAll" then
		return PNL_STORE, ALL_SCOPE
	elseif boardId == "pnlWeek" then
		return PNL_STORE, M.weekKey(os.time())
	elseif boardId == "winRate" then
		return WR_STORE, ALL_SCOPE
	end
	return nil, nil
end

-- Keyed by store AND scope, so a week rollover cannot serve last week's rows
-- under this week's board id.
local function cacheKeyOf(storeName: string, scope: string): string
	return storeName .. "/" .. scope
end

-- ------------------------------------------------------------- encoding

-- OrderedDataStore values are integers and must be assumed non-negative, so
-- dollars travel as cents shifted into a non-negative window. The window is
-- sized so the ENCODED value stays under 2^53: Luau numbers are f64, and an
-- integer past 2^53 stops round-tripping exactly long before the store's own
-- 2^63 ceiling.
local CENTS_OFFSET = 10_000_000_000 -- encodes down to -$100,000,000.00
local CENTS_MAX = 10_000_000_000 -- and up to +$100,000,000.00

-- Exported: META_PLAN §2.5 scores the daily challenge onto its own ordered
-- store with this same encoding, and two copies of the offset is a bug waiting
-- to happen.
function M.encodeUsd(usd: number): number
	-- floor(x + 0.5) is the codebase's rounding idiom (BarCodec); it rounds half
	-- toward +inf on both signs, which is deterministic.
	local cents = math.floor(usd * 100 + 0.5)
	-- Clamped BEFORE the offset, never after: an unclamped pathological value
	-- could land negative post-offset, which is the one thing this prevents.
	cents = math.clamp(cents, -CENTS_OFFSET, CENTS_MAX)
	return cents + CENTS_OFFSET
end

function M.decodeUsd(v: number): number
	return (v - CENTS_OFFSET) / 100
end

local function isPlainNumber(v: any): boolean
	return typeof(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge
end

-- Win rate needs no offset: basis points are already in [0, 10000].
local function decodeFor(boardId: string, v: number): number
	if boardId == "winRate" then
		return v
	end
	return M.decodeUsd(v)
end

-- The value to post, or nil when this player is gated out of this board. The
-- gate lives here rather than at the call site so a board can never be written
-- with a number its own rules would reject.
--
-- EVERY read below is from `stats.elig`. The lifetime fields beside it absorb
-- ineligible sessions — a rewound one prints free money that deriveState voids
-- but the fold still banks — so a board sourced from them could be laundered
-- through one clean session afterwards. `elig` is the only thing a board sees.
local function encodedFor(boardId: string, stats: PlayerStore.Stats): number?
	local elig = stats.elig
	if boardId == "pnlAll" then
		if elig.sessions < MIN_SESSIONS_PNL or not isPlainNumber(elig.pnlUsd) then
			return nil
		end
		return M.encodeUsd(elig.pnlUsd)
	elseif boardId == "pnlWeek" then
		-- The bucket is created only by an eligible fold, so its presence under
		-- the current key already IS "at least one eligible session this week".
		local week = elig.week
		if week == nil or week.key ~= M.weekKey(os.time()) or not isPlainNumber(week.pnlUsd) then
			return nil
		end
		return M.encodeUsd(week.pnlUsd)
	elseif boardId == "winRate" then
		if elig.sessions < MIN_SESSIONS_WIN_RATE or elig.trades < 1 then
			return nil
		end
		-- Per-TRADE win rate (elig.tradeWins), not the winning-SESSION count.
		local bp = math.floor(elig.tradeWins / elig.trades * 10000 + 0.5)
		return math.clamp(bp, 0, 10000)
	end
	return nil
end

-- ------------------------------------------------------------- platform

-- Studio's "API services not enabled" is permanent for the session, so the
-- first failure there switches the whole module to the in-memory board. A LIVE
-- server's failure is transient and is retried instead.
local function degradeInStudio(reason: any): boolean
	if not RunService:IsStudio() then
		return false
	end
	if not memoryOnly then
		memoryOnly = true
		warn(`[Board] DataStore access denied in Studio ({reason}); leaderboards are in-memory for this session`)
	end
	return true
end

local function getOrdered(storeName: string, scope: string): OrderedDataStore?
	if memoryOnly then
		return nil
	end
	local key = cacheKeyOf(storeName, scope)
	if not orderedTried[key] then
		orderedTried[key] = true
		local ok, result = pcall(function()
			return DataStoreService:GetOrderedDataStore(storeName, scope)
		end)
		if ok then
			ordered[key] = result
		else
			degradeInStudio(result)
		end
	end
	return ordered[key]
end

-- YIELDS. Memoized permanently per server: the call is rate limited and can
-- throw, and a display name is not worth failing a board over. Names are NOT
-- persisted in players_v1 — a stale name there would outlive a rename with no
-- way to notice.
local function nameOf(userId: number): string
	local cached = names[userId]
	if cached ~= nil then
		return cached
	end
	local resolved = `Player {userId}`
	local ok, result = pcall(function()
		return Players:GetNameFromUserIdAsync(userId)
	end)
	if ok and typeof(result) == "string" and result ~= "" then
		resolved = result
	end
	names[userId] = resolved
	return resolved
end

-- ----------------------------------------------------------------- read

-- The in-process fallback board. Sorted into a total order (value descending,
-- userId ascending) so the rows never depend on pairs() iteration order.
local function memoryRows(cacheKey: string, boardId: string): { BoardRow }
	local board = memory[cacheKey]
	if board == nil then
		return {}
	end
	local entries: { { userId: number, value: number } } = {}
	for userId, value in pairs(board) do
		table.insert(entries, { userId = userId, value = value })
	end
	table.sort(entries, function(a, b): boolean
		if a.value ~= b.value then
			return a.value > b.value
		end
		return a.userId < b.userId
	end)
	local rows: { BoardRow } = {}
	for i = 1, math.min(#entries, TOP_N) do
		local e = entries[i]
		rows[i] = { rank = i, userId = e.userId, name = nameOf(e.userId), value = decodeFor(boardId, e.value) }
	end
	return rows
end

-- YIELDS. Descending, first page only.
local function fetchRows(ods: OrderedDataStore, boardId: string): { BoardRow }?
	local ok, pages = pcall(function()
		return ods:GetSortedAsync(false, TOP_N)
	end)
	if not ok then
		if not degradeInStudio(pages) then
			warn(`[Board] board fetch failed for {boardId} ({pages}); serving the previous snapshot`)
		end
		return nil
	end
	local okPage, entries = pcall(function()
		return (pages :: any):GetCurrentPage()
	end)
	if not okPage or typeof(entries) ~= "table" then
		return nil
	end
	local rows: { BoardRow } = {}
	for _, entry in ipairs(entries :: { any }) do
		if typeof(entry) ~= "table" or typeof(entry.key) ~= "string" or not isPlainNumber(entry.value) then
			continue
		end
		local userId = tonumber(entry.key)
		if userId == nil then
			continue
		end
		local rank = #rows + 1
		rows[rank] = { rank = rank, userId = userId, name = nameOf(userId), value = decodeFor(boardId, entry.value) }
	end
	return rows
end

-- YIELDS. The live board if the store is reachable, the in-process one if it
-- is not, nil if the fetch failed.
local function fetchCurrent(boardId: string, storeName: string, scope: string): { BoardRow }?
	local ods = getOrdered(storeName, scope)
	if ods == nil then
		return memoryRows(cacheKeyOf(storeName, scope), boardId)
	end
	return fetchRows(ods, boardId)
end

-- YIELDS on a miss. Two callers past the TTL wait out ONE fetch rather than
-- issuing two — same idiom as Session's ensurePersistLoaded.
local function ensureSnapshot(boardId: string, storeName: string, scope: string): Snapshot
	local cacheKey = cacheKeyOf(storeName, scope)
	while loading[cacheKey] do
		task.wait()
	end
	local cached = cache[cacheKey]
	if cached ~= nil and os.clock() - cached.fetchedAt < BOARD_TTL then
		return cached
	end
	loading[cacheKey] = true
	-- Every platform call inside is already pcall'd at its own boundary, but the
	-- flag must be cleared even if something else in there throws: the waiters
	-- above spin on it forever, and a client can open the panel 30 times a second.
	local ok, result = pcall(fetchCurrent, boardId, storeName, scope)
	loading[cacheKey] = false
	local rows: { BoardRow }? = nil
	if ok then
		if typeof(result) == "table" then
			rows = result :: { BoardRow }
		end
	else
		warn(`[Board] board fetch errored for {boardId} ({result}); serving the previous snapshot`)
	end
	-- A failed fetch already spent list budget, so it still starts the TTL: the
	-- last good snapshot is served for another minute rather than blanked.
	local previous = cache[cacheKey]
	local snapshot: Snapshot = {
		fetchedAt = os.clock(),
		rows = if rows ~= nil then rows else (if previous ~= nil then previous.rows else {}),
		own = {},
	}
	cache[cacheKey] = snapshot
	return snapshot
end

-- YIELDS on a miss. GetSortedAsync gives no rank for an arbitrary key, so a
-- player outside the top N gets their own score by direct read. Memoized on the
-- snapshot, so it dies with it and a client spamming the command cannot drain
-- the read budget either.
local function ownValue(snapshot: Snapshot, storeName: string, scope: string, userId: number): number?
	local existing = snapshot.own[userId]
	if existing ~= nil then
		return existing
	end
	local cacheKey = cacheKeyOf(storeName, scope)
	local value: number? = nil
	local ods = getOrdered(storeName, scope)
	if ods ~= nil then
		local handle: OrderedDataStore = ods
		-- GetAsync returns (value, DataStoreKeyInfo); only the value is wanted, and
		-- forwarding both through pcall widens the tuple the caller has to bind.
		local ok, result = pcall(function(): any
			local raw: any = handle:GetAsync(tostring(userId))
			return raw
		end)
		if ok and isPlainNumber(result) then
			value = result
		elseif not ok then
			degradeInStudio(result)
		end
	else
		local board = memory[cacheKey]
		value = if board ~= nil then board[userId] else nil
	end
	if value ~= nil then
		snapshot.own[userId] = value
	end
	return value
end

-- YIELDS (DataStore). Answers one client "board" command. Every field is
-- attacker-controlled; an unknown board id is dropped silently, exactly like an
-- unknown command.
function M.handleRequest(player: Player, meta: RemoteEvent, boardId: any)
	if typeof(boardId) ~= "string" then
		return
	end
	local storeName, scope = specOf(boardId)
	if storeName == nil or scope == nil then
		return
	end
	local snapshot = ensureSnapshot(boardId, storeName, scope)
	local you: BoardRow? = nil
	for _, row in ipairs(snapshot.rows) do
		if row.userId == player.UserId then
			you = row
			break
		end
	end
	if you == nil then
		local raw = ownValue(snapshot, storeName, scope, player.UserId)
		if raw ~= nil then
			-- rank 0: a true global rank means paging the whole board, which is
			-- explicitly out of scope. The UI prints "—".
			you = {
				rank = 0,
				userId = player.UserId,
				name = nameOf(player.UserId),
				value = decodeFor(boardId, raw),
			}
		end
	end
	local payload: Protocol.MetaBoard = {
		kind = "board",
		board = boardId,
		rows = snapshot.rows,
		you = you,
	}
	meta:FireClient(player, payload)
end

-- ---------------------------------------------------------------- write

-- A session counts toward the boards only if all of these hold.
function M.eligible(outgoing: Engine.EngineState, s: SessionView): boolean
	-- 1. NO REWINDS. Engine.deriveState voids every event after a rewind target,
	--    so a rewound losing trade simply stops existing — on a scored board that
	--    is a money printer. This is the rule that matters; the rest are hygiene.
	if outgoing.voidedCount ~= 0 then
		return false
	end
	-- 2. Real session length, measured past the context prefix. A session folded
	--    from the SAVED log (the player never re-opened the day this server) has
	--    revealedCount 0 here and is therefore never posted — safe by default.
	if s.revealedCount - s.contextCount < MIN_SESSION_BARS then
		return false
	end
	-- 3. At least one closed trade: an untraded session is neither win nor loss.
	return #outgoing.trades >= 1
end

-- Shallow-cloning `stats` would share `week` and `elig`, which the very next
-- fold mutates.
local function snapshotStats(stats: PlayerStore.Stats): PlayerStore.Stats
	local week = stats.week
	local elig = stats.elig
	local eligWeek = elig.week
	return {
		sessions = stats.sessions,
		trades = stats.trades,
		pnlUsd = stats.pnlUsd,
		wins = stats.wins,
		tradeWins = stats.tradeWins,
		week = if week ~= nil
			then {
				key = week.key,
				sessions = week.sessions,
				trades = week.trades,
				pnlUsd = week.pnlUsd,
				wins = week.wins,
			}
			else nil,
		elig = {
			sessions = elig.sessions,
			trades = elig.trades,
			tradeWins = elig.tradeWins,
			pnlUsd = elig.pnlUsd,
			week = if eligWeek ~= nil then { key = eligWeek.key, pnlUsd = eligWeek.pnlUsd } else nil,
		},
	}
end

-- YIELDS. One SetAsync per board per session switch; with friends-scale traffic
-- that is nowhere near the 300 + 20 * users ordered write budget.
local function postOne(userId: number, boardId: string, stats: PlayerStore.Stats)
	local value = encodedFor(boardId, stats)
	if value == nil then
		return
	end
	local storeName, scope = specOf(boardId)
	if storeName == nil or scope == nil then
		return
	end
	-- The attempt counter advances on REAL failures only: degrading to memory
	-- must not burn the last retry, or a Studio run would drop the score.
	local attempt = 0
	while true do
		local ods = getOrdered(storeName, scope)
		if ods == nil then
			local cacheKey = cacheKeyOf(storeName, scope)
			local board = memory[cacheKey]
			if board == nil then
				board = {}
				memory[cacheKey] = board
			end
			board[userId] = value
			return
		end
		local ok, err = pcall(function()
			ods:SetAsync(tostring(userId), value)
		end)
		if ok then
			return
		end
		if degradeInStudio(err) then
			continue -- getOrdered now returns nil, so the next pass writes to memory
		end
		attempt += 1
		if attempt >= POST_ATTEMPTS then
			warn(`[Board] {boardId} post failed for {userId} ({err}); the score is lost until the next session switch`)
			return
		end
		task.wait(attempt)
	end
end

-- NEVER YIELDS. finalizeActive runs inside startSessionInner's switching guard,
-- on the path the player is waiting on, so the totals are snapshotted here —
-- synchronously, before any yield — and the DataStore round trip is spawned.
function M.post(player: Player, stats: PlayerStore.Stats)
	local snapshot = snapshotStats(stats)
	local userId = player.UserId
	task.spawn(function()
		for _, boardId in ipairs(Protocol.BOARD_IDS) do
			postOne(userId, boardId, snapshot)
		end
	end)
end

-- YIELDS. The encoding above assumes OrderedDataStore rejects negative values;
-- the API reference does not actually say so. Nothing depends on the answer —
-- the encoding never writes a negative either way — but the assumption should
-- be recorded rather than believed. Studio only: on a live server this would
-- spend write budget to learn nothing.
function M.probeNegativeValues()
	if not RunService:IsStudio() then
		return
	end
	local ods = getOrdered(PNL_STORE, PROBE_SCOPE)
	if ods == nil then
		return
	end
	local ok, err = pcall(function()
		ods:SetAsync("probe", -5)
	end)
	if ok then
		warn("[Board] PROBE: OrderedDataStore ACCEPTED a negative value; META_PLAN assumes it is rejected")
	else
		warn(`[Board] PROBE: OrderedDataStore rejected a negative value as assumed ({err})`)
	end
end

return M

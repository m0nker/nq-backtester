--!strict
-- Per-player persistence: the in-flight session's event log plus lifetime
-- stats, one DataStore key per player ("players_v1" / "p:<UserId>").
--
-- Everything written is rebuilt by copyValue first, so the value is plain
-- JSON data by construction: a payload carrying an Instance, a function or a
-- NaN fails HERE — visible, recoverable, one warn — instead of throwing inside
-- the write task where the caller cannot see it.
--
-- Studio without API access has no working DataStore at all. As in BarStore,
-- every platform call is pcall'd rather than asserted; the failure degrades to
-- an in-process table so Play Solo still exercises the whole load/save/resume
-- path instead of skipping it.

local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local EventTypes = require(ReplicatedStorage.Shared.Events.Types)

type SessionEvent = EventTypes.SessionEvent

local M = {}

export type ActiveSession = { date: string, events: { SessionEvent }, savedAt: number }
export type Stats = { sessions: number, trades: number, pnlUsd: number, wins: number }
export type PlayerData = { active: ActiveSession?, stats: Stats }

local DATASTORE_NAME = "players_v1"
local KEY_PREFIX = "p:"

-- A DataStore key holds 4 MB. A day of manual trading is a few thousand
-- events; past this the log is pathological, and a key that grew too large to
-- write can never be written again — so we stop before that happens.
M.MAX_EVENTS = 20000

-- Cycles would recurse forever; the real structure is 4 deep (data.active
-- .events[i].payload.field), so anything past this is malformed.
local MAX_DEPTH = 16
local LOAD_ATTEMPTS = 3

local store: DataStore? = nil
local storeTried = false
local memoryOnly = false
local memory: { [number]: PlayerData } = {}
local blocked: { [number]: boolean } = {} -- load failed: never overwrite what we could not read
local cappedWarned: { [number]: boolean } = {}

local function getStore(): DataStore?
	if memoryOnly then
		return nil
	end
	if not storeTried then
		storeTried = true
		local ok, result = pcall(function()
			return DataStoreService:GetDataStore(DATASTORE_NAME)
		end)
		if ok then
			store = result
		else
			memoryOnly = true
			warn(`[PlayerStore] DataStoreService unavailable ({result}); persisting in memory for this server only`)
		end
	end
	return store
end

-- Studio's "API services not enabled" is permanent for the session, so the
-- first failure there switches to memory. A LIVE server's failure is treated
-- as transient instead: the caller keeps the data dirty and retries.
local function degradeInStudio(reason: any): boolean
	if not RunService:IsStudio() then
		return false
	end
	if not memoryOnly then
		memoryOnly = true
		warn(`[PlayerStore] DataStore access denied in Studio ({reason}); persisting in memory for this session`)
	end
	return true
end

local function isPlainNumber(v: any): boolean
	return typeof(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge
end

local function numberOr(v: any, fallback: number): number
	return if isPlainNumber(v) then v else fallback
end

-- Deep copy that doubles as the JSON-ability gate. Returns false for anything
-- SetAsync would reject: non-string/number/boolean leaves, non-finite numbers,
-- non-string dictionary keys, sparse arrays (JSON turns their numeric keys
-- into strings and breaks every index assumption downstream).
local function copyValue(v: any, depth: number): (boolean, any)
	local ty = typeof(v)
	if ty == "string" or ty == "boolean" then
		return true, v
	end
	if ty == "number" then
		return isPlainNumber(v), v
	end
	if ty ~= "table" or depth > MAX_DEPTH then
		return false, nil
	end
	local t = v :: { [any]: any }
	local n = #t
	local out: { [any]: any } = {}
	for i = 1, n do
		local ok, copied = copyValue(t[i], depth + 1)
		if not ok then
			return false, nil
		end
		out[i] = copied
	end
	for k, value in pairs(t) do
		local kt = typeof(k)
		if kt == "number" then
			if k % 1 ~= 0 or k < 1 or k > n then
				return false, nil
			end
			continue -- already copied by the array pass above
		end
		if kt ~= "string" then
			return false, nil
		end
		local ok, copied = copyValue(value, depth + 1)
		if not ok then
			return false, nil
		end
		out[k] = copied
	end
	return true, out
end

local function freshStats(): Stats
	return { sessions = 0, trades = 0, pnlUsd = 0, wins = 0 }
end

function M.empty(): PlayerData
	return { stats = freshStats() }
end

local function sanitizeStats(v: any): Stats
	if typeof(v) ~= "table" then
		return freshStats()
	end
	return {
		sessions = numberOr(v.sessions, 0),
		trades = numberOr(v.trades, 0),
		pnlUsd = numberOr(v.pnlUsd, 0),
		wins = numberOr(v.wins, 0),
	}
end

-- A partially readable log is worse than no log: deriveState would fold a
-- silently truncated history into a resumed session and into lifetime stats.
-- One malformed event therefore discards the whole active session.
local function sanitizeActive(v: any): ActiveSession?
	if typeof(v) ~= "table" then
		return nil
	end
	if typeof(v.date) ~= "string" or typeof(v.events) ~= "table" then
		return nil
	end
	local raw = v.events :: { any }
	local events: { SessionEvent } = {}
	for i = 1, #raw do
		local ev = raw[i]
		if typeof(ev) ~= "table" or typeof(ev.type) ~= "string" or not isPlainNumber(ev.tsMarket) then
			warn("[PlayerStore] saved session has a malformed event; discarding the saved session")
			return nil
		end
		local ok, payload = copyValue(ev.payload, 1)
		if not ok then
			warn("[PlayerStore] saved session has an unreadable payload; discarding the saved session")
			return nil
		end
		events[i] = { type = ev.type, tsMarket = ev.tsMarket, payload = payload }
	end
	return { date = v.date, events = events, savedAt = numberOr(v.savedAt, 0) }
end

local function fromValue(value: any): PlayerData
	return { active = sanitizeActive(value.active), stats = sanitizeStats(value.stats) }
end

-- Never raises: a missing key, a failed read and a corrupt value all produce
-- fresh empty data, and only a LIVE-server read failure additionally blocks
-- writes for that player.
function M.load(userId: number): PlayerData
	local ds = getStore()
	if ds ~= nil then
		local lastErr: any = nil
		for attempt = 1, LOAD_ATTEMPTS do
			local ok, value = pcall(function()
				return ds:GetAsync(KEY_PREFIX .. userId)
			end)
			if ok then
				blocked[userId] = nil
				if typeof(value) == "table" then
					return fromValue(value)
				end
				return M.empty()
			end
			lastErr = value
			if degradeInStudio(value) then
				break
			end
			task.wait(attempt)
		end
		if not memoryOnly then
			blocked[userId] = true
			warn(`[PlayerStore] load failed for {userId} ({lastErr}); this session will not be persisted`)
			return M.empty()
		end
	end
	local mem = memory[userId]
	if mem ~= nil then
		return fromValue(mem)
	end
	return M.empty()
end

-- Returns false when the caller should stay dirty and retry. Over-cap and
-- blocked players return false permanently — both are already warned about.
function M.save(userId: number, data: PlayerData): boolean
	if blocked[userId] then
		return false
	end
	local active = data.active
	if active ~= nil and #active.events > M.MAX_EVENTS then
		if not cappedWarned[userId] then
			cappedWarned[userId] = true
			warn(`[PlayerStore] session log for {userId} exceeds {M.MAX_EVENTS} events; no longer persisting it`)
		end
		return false
	end
	local ok, value = copyValue(data, 1)
	if not ok or typeof(value) ~= "table" then
		warn(`[PlayerStore] refusing to save non-JSON player data for {userId}`)
		return false
	end
	local ds = getStore()
	if ds ~= nil then
		local okSet, err = pcall(function()
			ds:SetAsync(KEY_PREFIX .. userId, value)
		end)
		if okSet then
			return true
		end
		if not degradeInStudio(err) then
			warn(`[PlayerStore] save failed for {userId} ({err}); will retry`)
			return false
		end
	end
	memory[userId] = value :: PlayerData
	return true
end

return M

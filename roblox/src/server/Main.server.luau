--!strict
-- Server entry point: create the remotes, keep one Session per player, route
-- commands into it, and drive every session's clock from ONE heartbeat.
--
-- Nothing here contains replay logic — it is the untrusted-input boundary.
-- Every command is pcall'd so a malformed payload can only kill its own
-- dispatch, and every player is rate limited so the log cannot be flooded.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Protocol = require(ReplicatedStorage.Shared.Net.Protocol)
local BarStore = require(script.Parent.Data.BarStore)
local Board = require(script.Parent.Meta.Board)
local Session = require(script.Parent.Replay.Session)

local MAX_CMDS_PER_SEC = 30
-- FireClient before the joining player's scripts have connected is a dropped
-- packet, and SessionInfo carries the date picker, so it is re-sent on this
-- schedule until the player's first command proves the client is listening.
-- A "ready" command ends it immediately; this is only the fallback for clients
-- that never send one.
local SESSION_INFO_RETRIES: { number } = { 1, 2, 4 }

local remotesFolder = Protocol.ensureRemotes()
local remotes: Session.Remotes = {
	clock = remotesFolder:WaitForChild("Clock") :: RemoteEvent,
	bars = remotesFolder:WaitForChild("Bars") :: RemoteEvent,
	tradeState = remotesFolder:WaitForChild("TradeState") :: RemoteEvent,
	sessionInfo = remotesFolder:WaitForChild("SessionInfo") :: RemoteEvent,
}
local cmdRemote = remotesFolder:WaitForChild("Cmd") :: RemoteEvent
-- The meta layer is not part of a replay session, so it stays out of
-- Session.Remotes: nothing in Session sends on it.
local metaRemote = remotesFolder:WaitForChild("Meta") :: RemoteEvent

type Bucket = { tokens: number, last: number }

-- pcall's result arity follows its callee, which none of the entry points
-- below have; the cast is confined here so call sites keep argument checking.
local function guard<A...>(fn: (A...) -> (), ...: A...): (boolean, string?)
	local ok, err = pcall(fn :: any, ...)
	return ok, err
end

-- Ordered registry: the heartbeat walks players in join order, never in
-- pairs() order.
local joined: { Player } = {}
local sessions: { [Player]: Session.Session } = {}
local buckets: { [Player]: Bucket } = {}
local heard: { [Player]: boolean } = {} -- client has sent at least one command

local function allow(player: Player): boolean
	local b = buckets[player]
	if b == nil then
		return false
	end
	local now = os.clock()
	b.tokens = math.min(MAX_CMDS_PER_SEC, b.tokens + (now - b.last) * MAX_CMDS_PER_SEC)
	b.last = now
	if b.tokens < 1 then
		return false
	end
	b.tokens -= 1
	return true
end

local function onPlayerAdded(player: Player)
	if sessions[player] ~= nil then
		return
	end
	local s = Session.new(player, remotes)
	sessions[player] = s
	buckets[player] = { tokens = MAX_CMDS_PER_SEC, last = os.clock() }
	table.insert(joined, player)

	task.spawn(function()
		-- The first send may yield on the bar manifest (DataStore), hence the
		-- separate thread.
		local ok, err = guard(Session.sendSessionInfo, s)
		if not ok then
			warn(`[backtester] SessionInfo failed for {player.Name}: {err}`)
			return
		end
		for _, delaySec in ipairs(SESSION_INFO_RETRIES) do
			task.wait(delaySec)
			if sessions[player] ~= s or heard[player] then
				return
			end
			guard(Session.sendSessionInfo, s)
		end
	end)
end

local function onPlayerRemoving(player: Player)
	local s = sessions[player]
	sessions[player] = nil
	buckets[player] = nil
	heard[player] = nil
	local i = table.find(joined, player)
	if i ~= nil then
		table.remove(joined, i)
	end
	-- Deregistered first, so the flush below cannot race a heartbeat write for
	-- a player who is already gone.
	if s ~= nil then
		local ok, err = guard(Session.persistNow, s)
		if not ok then
			warn(`[backtester] final save failed for {player.Name}: {err}`)
		end
	end
end

cmdRemote.OnServerEvent:Connect(function(player: Player, msg: any)
	local s = sessions[player]
	if s == nil or not allow(player) then
		return
	end
	heard[player] = true
	if typeof(msg) == "table" and msg.cmd == "ready" then
		-- Resume reads the player's DataStore key and the day's bars, so this
		-- handler yields; it stays on the remote's own thread.
		local ok, err = guard(Session.onReady, s)
		if not ok then
			warn(`[backtester] ready failed for {player.Name}: {err}`)
		end
		return
	end
	if typeof(msg) == "table" and msg.cmd == "board" then
		-- A cold board read hits OrderedDataStore, so this yields; like "ready" it
		-- stays on the remote's own thread rather than blocking the heartbeat.
		local okBoard, errBoard = guard(Board.handleRequest, player, metaRemote, msg.board)
		if not okBoard then
			warn(`[backtester] board request failed for {player.Name}: {errBoard}`)
		end
		return
	end
	local ok, err = guard(Session.handleCmd, s, msg)
	if not ok then
		warn(`[backtester] command failed for {player.Name}: {err}`)
	end
end)

RunService.Heartbeat:Connect(function(dt: number)
	for _, player in ipairs(joined) do
		local s = sessions[player]
		if s ~= nil then
			local ok, err = guard(Session.tick, s, dt)
			if not ok then
				warn(`[backtester] replay tick failed for {player.Name}: {err}`)
			end
		end
	end
end)

-- Shutdown is the one place a save may block: PlayerRemoving does not fire for
-- everyone on a server close, and an unwritten tail is lost replay time.
game:BindToClose(function()
	for _, player in ipairs(table.clone(joined)) do
		local s = sessions[player]
		if s ~= nil then
			sessions[player] = nil
			local ok, err = guard(Session.persistNow, s)
			if not ok then
				warn(`[backtester] shutdown save failed for {player.Name}: {err}`)
			end
		end
	end
end)

-- The deep 1h history is one ~3 MB key read once per server. Warmed at startup
-- so the first session's send finds it in memory instead of waiting on it;
-- nothing blocks on this, and a server without the key just keeps nil.
task.spawn(BarStore.hourlyHistory)

-- Records whether OrderedDataStore really rejects negative values, which the
-- leaderboard encoding assumes but the docs do not state. Studio only, on a
-- throwaway scope, and nothing waits on it.
task.spawn(Board.probeNegativeValues)

Players.PlayerAdded:Connect(onPlayerAdded)
Players.PlayerRemoving:Connect(onPlayerRemoving)
-- Play Solo can seat the player before this script runs.
for _, player in ipairs(Players:GetPlayers()) do
	onPlayerAdded(player)
end

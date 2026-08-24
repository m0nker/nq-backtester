--!strict
-- The server<->client contract. Server code and client code are written by
-- different agents against THIS file — change it only deliberately, and treat
-- every payload shape below as frozen once both sides ship.
--
-- Anti-lookahead is enforced by construction: the ONLY way bars reach a
-- client is the Bars remote, and the server only ever encodes bars whose
-- close (t + baseSec) is <= the session's currentTime.
--
-- Remotes live in ReplicatedStorage/<REMOTES_FOLDER>/<name>. The server
-- creates them at startup; clients wait for them.
--
--   Cmd   (RemoteEvent, client -> server): control + trading commands.
--         Payload: { cmd: string, ... } — shapes below.
--   Clock (RemoteEvent, server -> client): { t: number, playing: boolean,
--         speed: number, stepSize: string } after every clock change.
--   Bars  (RemoteEvent, server -> client): (packet: buffer, reset: boolean)
--         packet is BarCodec-framed. reset=true -> replace the whole client
--         bar cache (session start / jump / rewind); false -> append reveals.
--   TradeState (RemoteEvent, server -> client): sanitized derived state after
--         every order/fill/void change:
--         { position: { qty: number, avgPrice: number },
--           realizedPts: number, realizedUsd: number,
--           workingOrders: { { id, side, type, qty, limitPrice?, stopPrice?,
--                             ocoId?, reduceOnly? } },
--           trades: { Engine.Trade }, voidedCount: number,
--           startingBalance: number }
--   SessionInfo (RemoteEvent, server -> client): on join / session start:
--         { availableDates: { string }, -- "YYYY-MM-DD", picker options
--           baseSec: number,            -- base bar resolution (60)
--           tickSize: number,
--           startingBalance: number }
--
-- Cmd shapes (server validates everything; qty is quantized, prices
-- tick-rounded server-side — the client is untrusted):
--   { cmd = "startSession", date = "YYYY-MM-DD" }  -- start at that trading day's first bar
--   { cmd = "stepForward" } | { cmd = "stepBack" }
--   { cmd = "jumpTo", t = number }
--   { cmd = "play" } | { cmd = "pause" }
--   { cmd = "setSpeed", speed = number }           -- validated against SPEEDS
--   { cmd = "setStepSize", stepSize = string }     -- a concrete Types.TIMEFRAMES value;
--                                                  -- the web's 'view' mode is client-side sugar
--   { cmd = "placeOrder", side = "buy"|"sell", type = "market"|"limit"|"stop",
--     qty = number, limitPrice = number?, stopPrice = number?,
--     bracket = { stopLossPts = number, takeProfitPts = number }? }
--   { cmd = "modifyOrder", orderId = string,
--     changes = { limitPrice = number?, stopPrice = number?, qty = number? } }
--   { cmd = "cancelOrder", orderId = string }
--   { cmd = "flatten" }                            -- market-close the position, cancel all

local M = {}

M.REMOTES_FOLDER = "Remotes"
M.REMOTE_NAMES = { "Cmd", "Clock", "Bars", "TradeState", "SessionInfo" }

M.SPEEDS = { 1, 2, 5, 10, 20, 50, 100, 200, 500 } -- base bars per second

-- Server-side: create (idempotently) and return the remotes folder.
function M.ensureRemotes(): Folder
	local rs = game:GetService("ReplicatedStorage")
	local folder = rs:FindFirstChild(M.REMOTES_FOLDER) :: Folder?
	if folder == nil then
		local f = Instance.new("Folder")
		f.Name = M.REMOTES_FOLDER
		f.Parent = rs
		folder = f
	end
	local fld = folder :: Folder
	for _, name in ipairs(M.REMOTE_NAMES) do
		if fld:FindFirstChild(name) == nil then
			local r = Instance.new("RemoteEvent")
			r.Name = name
			r.Parent = fld
		end
	end
	return fld
end

-- Client-side: wait for a remote by name.
function M.waitRemote(name: string): RemoteEvent
	local rs = game:GetService("ReplicatedStorage")
	local folder = rs:WaitForChild(M.REMOTES_FOLDER)
	return folder:WaitForChild(name) :: RemoteEvent
end

return M

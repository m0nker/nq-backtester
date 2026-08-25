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
--   Bars  (RemoteEvent, server -> client): (packet: buffer, reset: boolean,
--         mode: string?) packet is BarCodec-framed. With `mode` absent (the
--         default), reset=true -> replace the whole client bar cache (session
--         start / jump / rewind); false -> append reveals.
--         mode = BARS_MODE_HISTORY marks a deep-history packet: HISTORY_SEC
--         bars that all CLOSED before the session's first bar opened, which the
--         client keeps in a separate array and splices under its own bars on
--         hourly-backed timeframes. `reset` carries no meaning on it. The
--         argument is additive — a client that ignores it sees exactly the
--         reveal contract above.
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
--   Meta  (RemoteEvent, server -> client): { kind: string, ... }, a tagged
--         union. ONE remote for the whole meta layer keeps REMOTE_NAMES short
--         and the client's boundary casts in one place.
--     kind = "board" -> { board: string, rows: { BoardRow }, you: BoardRow? }
--         Sent only in reply to a "board" command. `rows` is already ranked and
--         ordered (rank 1 first); `value` is USD on "pnlAll"/"pnlWeek" and
--         basis points (0..10000) on "winRate". `you` is the requesting
--         player's row; its rank is 0 when they are outside `rows`, because a
--         true global rank would mean paging the whole board.
--         META_PLAN §2/§3 reserve kind = "challenge" | "duelInvite" |
--         "duelState" | "duelResult" on this same remote; not sent yet.
--
-- Cmd shapes (server validates everything; qty is quantized, prices
-- tick-rounded server-side — the client is untrusted):
--   { cmd = "ready" }                              -- client's handlers are connected; server
--                                                  -- replies SessionInfo (+ full session state
--                                                  -- when a persisted session resumed)
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
--   { cmd = "board", board = "pnlAll"|"pnlWeek"|"winRate" }
--                                                  -- server replies Meta { kind = "board" }.
--                                                  -- Board reads are cached server-side, so
--                                                  -- spamming this costs the caller, not the
--                                                  -- server's DataStore list budget

local M = {}

-- Payload shapes as REAL types — the single declaration both sides typecheck
-- against. Keep in lockstep with the doc comment above.
export type WorkingOrderView = {
	id: string,
	side: string,
	type: string,
	qty: number,
	limitPrice: number?,
	stopPrice: number?,
	ocoId: string?,
	reduceOnly: boolean?,
}

-- Mirrors Engine.Trade structurally so Protocol stays dependency-free.
export type TradeView = {
	entryTs: number,
	exitTs: number,
	side: string,
	qty: number,
	avgEntry: number,
	avgExit: number,
	pnlPts: number,
	pnlUsd: number,
	ambiguous: boolean,
	riskPts: number?,
	slPrice: number?,
	tpPrice: number?,
}

export type Clock = {
	t: number,
	playing: boolean,
	speed: number,
	stepSize: string,
	atEnd: boolean?, -- every bar revealed; step/play are no-ops until rewind
}

export type TradeState = {
	position: { qty: number, avgPrice: number },
	realizedPts: number,
	realizedUsd: number,
	workingOrders: { WorkingOrderView },
	trades: { TradeView },
	voidedCount: number,
	startingBalance: number,
}

export type SessionInfo = {
	availableDates: { string },
	baseSec: number,
	tickSize: number,
	startingBalance: number,
	running: boolean?, -- a (possibly resumed) session is already active
	date: string?, -- its trading date, when running
}

export type BoardRow = { rank: number, userId: number, name: string, value: number }

export type MetaBoard = {
	kind: string,
	board: string,
	rows: { BoardRow },
	you: BoardRow?,
}

-- The Bars remote's only non-default `mode`. Named on both sides so the string
-- can never drift between the sender and the branch that decodes it.
M.BARS_MODE_HISTORY = "history"

-- Resolution of the bars inside a BARS_MODE_HISTORY packet. The packed format
-- carries a tick size but no bar duration, so both sides read it from here.
M.HISTORY_SEC = 3600

M.REMOTES_FOLDER = "Remotes"
M.REMOTE_NAMES = { "Cmd", "Clock", "Bars", "TradeState", "SessionInfo", "Meta" }

-- The board ids the "board" command accepts. Ordered, because the client's tab
-- strip is built from it and tab order is observable output.
M.BOARD_IDS = { "pnlAll", "pnlWeek", "winRate" }

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

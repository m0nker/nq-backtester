--!strict
-- Client bootstrap. The server is authoritative for everything with a clock in
-- it: this script wires remotes to a bar cache and a set of dumb views, and the
-- only thing it ever sends is a Cmd. Nothing here advances time, invents a bar,
-- or derives trading state.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))
local Types = require(Shared:WaitForChild("Types"))

local BarCache = require(script.Parent:WaitForChild("State"):WaitForChild("BarCache"))
local ChartView = require(script.Parent:WaitForChild("Chart"):WaitForChild("ChartView"))
local DrawingLayer = require(script.Parent:WaitForChild("Chart"):WaitForChild("DrawingLayer"))
local OrderLayer = require(script.Parent:WaitForChild("Chart"):WaitForChild("OrderLayer"))
local Controls = require(script.Parent:WaitForChild("UI"):WaitForChild("Controls"))
local DrawToolbar = require(script.Parent:WaitForChild("UI"):WaitForChild("DrawToolbar"))
local Leaderboard = require(script.Parent:WaitForChild("UI"):WaitForChild("Leaderboard"))
local OrderPanel = require(script.Parent:WaitForChild("UI"):WaitForChild("OrderPanel"))
local PositionBar = require(script.Parent:WaitForChild("UI"):WaitForChild("PositionBar"))
local SessionPicker = require(script.Parent:WaitForChild("UI"):WaitForChild("SessionPicker"))
local Theme = require(script.Parent:WaitForChild("UI"):WaitForChild("Theme"))
local TradeLog = require(script.Parent:WaitForChild("UI"):WaitForChild("TradeLog"))

local cmdRemote = Protocol.waitRemote("Cmd")
local clockRemote = Protocol.waitRemote("Clock")
local barsRemote = Protocol.waitRemote("Bars")
local tradeRemote = Protocol.waitRemote("TradeState")
local sessionRemote = Protocol.waitRemote("SessionInfo")
local metaRemote = Protocol.waitRemote("Meta")

-- Cmd payloads stay open-shaped on purpose: the server re-validates every
-- field, so a client-side type would only be a second place to get them wrong.
local function send(payload: { [string]: any })
	cmdRemote:FireServer(payload)
end

local cache = BarCache.new(Types.BASE_RESOLUTION_SEC)
local chart = ChartView.new(cache)

-- The HUD is a SEPARATE ScreenGui from the chart's: LayerCollector
-- invalidation is per-ScreenGui, and the chart dirties its own every frame the
-- view moves (PORT_PLAN).
local hud = Instance.new("ScreenGui")
hud.Name = "BacktesterHud"
hud.IgnoreGuiInset = true
hud.ResetOnSpawn = false
hud.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
hud.DisplayOrder = 10
hud.Parent = (Players.LocalPlayer :: Player):WaitForChild("PlayerGui")

-- The tick size is only a display/pre-validation aid here; the server rounds
-- every price it accepts. SessionInfo replaces this default on arrival.
local orderLayer = OrderLayer.new(chart, send, 0.25)
local drawLayer = DrawingLayer.new(chart, cache)
DrawToolbar.new(hud, drawLayer)
local board = Leaderboard.new(hud, send)
local tradeLog = TradeLog.new(hud)
-- MAE/MFE scans the revealed 1m bars between a trade's entry and exit.
tradeLog:setBarsProvider(function()
	return cache:getBase()
end)

-- Leaderboard toggle lives up by "new session" (the panel anchors below it);
-- the trade log's toggle stays in the position bar where trading state lives.
local boardsBtn = Instance.new("TextButton")
boardsBtn.Name = "BoardsToggle"
boardsBtn.BorderSizePixel = 0
boardsBtn.AnchorPoint = Vector2.new(1, 0)
-- y=66: below the Roblox topbar (58px) — this ScreenGui ignores the inset,
-- so a small y would render the button inside the topbar strip.
boardsBtn.Position = UDim2.new(1, -126, 0, 66)
boardsBtn.Size = UDim2.fromOffset(80, 24)
boardsBtn.Font = Theme.fontUiMedium
boardsBtn.TextSize = Theme.textMd
boardsBtn.Text = "boards"
boardsBtn.BackgroundColor3 = Theme.panel
boardsBtn.TextColor3 = Theme.text
boardsBtn.AutoButtonColor = true
boardsBtn.Parent = hud
boardsBtn.Activated:Connect(function()
	board:toggle()
end)
local function lastClose(): number?
	return cache:getLastClose()
end
-- Self-contained once built (its buttons and the chart's click hook hold it):
-- nothing else talks to it.
OrderPanel.new(hud, send, lastClose, chart)
local positionBar = PositionBar.new(hud, {
	send = send,
	toggleLog = function()
		tradeLog:toggle()
	end,
	getLastClose = lastClose,
})
-- Unrealized P&L marks against the newest revealed close, so it moves with the
-- bars and not only with TradeState.
cache:onChanged(function()
	positionBar:refresh()
end)
local controls = Controls.new(hud, {
	send = send,
	setTimeframe = function(tf: Types.Timeframe)
		cache:setTimeframe(tf)
		-- rightIndex is an INDEX: the same value means a 60x different time
		-- after 1m -> 1h. The web recenters on every switch
		-- (scrollToPosition(6)); snapping to tail is our equivalent.
		chart:snapToTail()
	end,
})
local picker = SessionPicker.new(hud, function(date: string)
	send({ cmd = "startSession", date = date })
	-- Anchors from the previous day would clamp onto the new day's first
	-- candle and pile up at the left edge.
	drawLayer:clear()
	-- The server does not answer startSession with a fresh SessionInfo, so this
	-- is the only place the client learns the new day's date.
	controls:setSessionDate(date)
	chart:snapToTail()
	-- A price range dragged out by hand belongs to the day it was dragged on;
	-- carrying it into a new session can leave the new day's candles entirely
	-- off-screen with no obvious way back.
	chart:resetPriceScale()
end)

-- Remote payloads are untrusted/untyped on the wire; each handler casts once at
-- the boundary against the exported Protocol shapes.
barsRemote.OnClientEvent:Connect(function(packet: any, reset: any, mode: any)
	local history = mode == Protocol.BARS_MODE_HISTORY
	cache:applyPacket(packet :: buffer, reset == true, if typeof(mode) == "string" then mode else nil)
	-- A reset replaces the whole bar array (session start, rewind, jump back)
	-- and a history packet inserts years of candles IN FRONT of it: either way
	-- any camera position from before is an index into an array that no longer
	-- exists. Snap rather than strand — but only when the history actually
	-- reached the candles, or a packet landing while the chart is on a
	-- minute timeframe would yank a deliberate pan back to the tail.
	if reset == true or (history and cache:hasHistory()) then
		chart:snapToTail()
	end
end)

clockRemote.OnClientEvent:Connect(function(msg: any)
	controls:onClock(msg :: Protocol.Clock)
end)

tradeRemote.OnClientEvent:Connect(function(msg: any)
	local state = msg :: Protocol.TradeState
	positionBar:update(state)
	orderLayer:setState(state)
	tradeLog:setState(state)
end)

-- SessionInfo also arrives on session START, so the picker is only auto-opened
-- the first time; after that it is the "new session" button's job.
local pickerAutoOpened = false
sessionRemote.OnClientEvent:Connect(function(msg: any)
	local info = msg :: Protocol.SessionInfo
	cache:setBaseSec(info.baseSec)
	orderLayer:setTickSize(info.tickSize)
	picker:setDates(info.availableDates)
	if info.date ~= nil then
		controls:setSessionDate(info.date)
	end
	if info.running then
		-- A session is already live (resumed): its Bars/Clock/TradeState follow
		-- immediately, and opening the picker over them would only invite the
		-- player to throw the session away.
		pickerAutoOpened = true
	end
	if not pickerAutoOpened then
		pickerAutoOpened = true
		picker:show()
	end
end)

metaRemote.OnClientEvent:Connect(function(msg: any)
	if typeof(msg) == "table" and msg.kind == "board" then
		board:onMeta(msg :: Protocol.MetaBoard)
	end
end)

-- Last: the server answers this with SessionInfo, so every handler above has to
-- be connected before it goes out or the reply lands on nothing.
send({ cmd = "ready" })

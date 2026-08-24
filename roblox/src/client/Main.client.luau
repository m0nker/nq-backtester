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
local OrderLayer = require(script.Parent:WaitForChild("Chart"):WaitForChild("OrderLayer"))
local Controls = require(script.Parent:WaitForChild("UI"):WaitForChild("Controls"))
local OrderPanel = require(script.Parent:WaitForChild("UI"):WaitForChild("OrderPanel"))
local PositionBar = require(script.Parent:WaitForChild("UI"):WaitForChild("PositionBar"))
local SessionPicker = require(script.Parent:WaitForChild("UI"):WaitForChild("SessionPicker"))
local TradeLog = require(script.Parent:WaitForChild("UI"):WaitForChild("TradeLog"))

local cmdRemote = Protocol.waitRemote("Cmd")
local clockRemote = Protocol.waitRemote("Clock")
local barsRemote = Protocol.waitRemote("Bars")
local tradeRemote = Protocol.waitRemote("TradeState")
local sessionRemote = Protocol.waitRemote("SessionInfo")

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
local tradeLog = TradeLog.new(hud)
-- Self-contained once built (its buttons hold it): nothing else talks to it.
OrderPanel.new(hud, send, function(): number?
	local candles = cache:getCandles()
	local last = candles[#candles]
	return if last ~= nil then last.c else nil
end)
local positionBar = PositionBar.new(hud, {
	send = send,
	toggleLog = function()
		tradeLog:toggle()
	end,
})
local controls = Controls.new(hud, {
	send = send,
	setTimeframe = function(tf: Types.Timeframe)
		cache:setTimeframe(tf)
	end,
})
local picker = SessionPicker.new(hud, function(date: string)
	send({ cmd = "startSession", date = date })
	chart:snapToTail()
end)

-- Remote payloads are untrusted/untyped on the wire; each handler casts once at
-- the boundary against the exported Protocol shapes.
barsRemote.OnClientEvent:Connect(function(packet: any, reset: any)
	cache:applyPacket(packet :: buffer, reset == true)
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

-- Last: the server answers this with SessionInfo, so every handler above has to
-- be connected before it goes out or the reply lands on nothing.
send({ cmd = "ready" })

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
local Messages = require(script.Parent:WaitForChild("Net"):WaitForChild("Messages"))
local Controls = require(script.Parent:WaitForChild("UI"):WaitForChild("Controls"))
local PositionBar = require(script.Parent:WaitForChild("UI"):WaitForChild("PositionBar"))
local SessionPicker = require(script.Parent:WaitForChild("UI"):WaitForChild("SessionPicker"))

local cmdRemote = Protocol.waitRemote("Cmd")
local clockRemote = Protocol.waitRemote("Clock")
local barsRemote = Protocol.waitRemote("Bars")
local tradeRemote = Protocol.waitRemote("TradeState")
local sessionRemote = Protocol.waitRemote("SessionInfo")

local function send(payload: Messages.Cmd)
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

local positionBar = PositionBar.new(hud)
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
-- the boundary against the shapes mirrored in Net.Messages.
barsRemote.OnClientEvent:Connect(function(packet: any, reset: any)
	cache:applyPacket(packet :: buffer, reset == true)
end)

clockRemote.OnClientEvent:Connect(function(msg: any)
	controls:onClock(msg :: Messages.Clock)
end)

tradeRemote.OnClientEvent:Connect(function(msg: any)
	positionBar:update(msg :: Messages.TradeState)
end)

-- SessionInfo also arrives on session START, so the picker is only auto-opened
-- the first time; after that it is the "new session" button's job.
local pickerAutoOpened = false
sessionRemote.OnClientEvent:Connect(function(msg: any)
	local info = msg :: Messages.SessionInfo
	cache:setBaseSec(info.baseSec)
	picker:setDates(info.availableDates)
	if not pickerAutoOpened then
		pickerAutoOpened = true
		picker:show()
	end
end)

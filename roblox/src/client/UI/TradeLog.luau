--!strict
-- Completed round trips, newest first. A pure readout of TradeState.trades —
-- the server folds the event log into those, and rewinding voids them, so this
-- panel must never keep a trade the latest state no longer lists.
--
-- Rows are pooled and rebuilt only when a TradeState arrives (and lazily: a
-- hidden panel defers its rebuild until it is opened).

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

local PANEL_W = 430
local PANEL_H = 240
local HEADER_H = 22
local ROW_H = 18
-- Rows past this are simply not drawn; a session that produces more than this
-- many round trips has outgrown a scrolling strip anyway.
local MAX_ROWS = 200

local COL_SIDE = { x = 4, w = 56 }
local COL_PRICES = { x = 64, w = 180 }
local COL_PNL = { x = 248, w = 88 }
local COL_R = { x = 340, w = 56 }
local COL_FLAG = { x = 400, w = 12 }

local TradeLog = {}
TradeLog.__index = TradeLog

type Row = { frame: Frame, side: TextLabel, prices: TextLabel, pnl: TextLabel, r: TextLabel, flag: TextLabel }

type Fields = {
	panel: Frame,
	title: TextLabel,
	list: ScrollingFrame,
	empty: TextLabel,
	rows: { Row },
	shown: number,
	trades: { Protocol.TradeView },
	dirty: boolean,
}

export type TradeLog = typeof(setmetatable({} :: Fields, TradeLog))

local function newCell(parent: Instance, x: number, w: number, align: Enum.TextXAlignment): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.BorderSizePixel = 0
	l.Position = UDim2.fromOffset(x, 0)
	l.Size = UDim2.fromOffset(w, ROW_H)
	l.Font = Enum.Font.Code
	l.TextSize = 12
	l.TextColor3 = Theme.text
	l.TextXAlignment = align
	l.Text = ""
	l.ZIndex = 9
	l.Parent = parent
	return l
end

local function makeRow(list: ScrollingFrame): Row
	local frame = Instance.new("Frame")
	frame.BorderSizePixel = 0
	frame.BackgroundTransparency = 1
	frame.Size = UDim2.new(1, 0, 0, ROW_H)
	frame.ZIndex = 9
	frame.Visible = false
	frame.Parent = list
	return {
		frame = frame,
		side = newCell(frame, COL_SIDE.x, COL_SIDE.w, Enum.TextXAlignment.Left),
		prices = newCell(frame, COL_PRICES.x, COL_PRICES.w, Enum.TextXAlignment.Left),
		pnl = newCell(frame, COL_PNL.x, COL_PNL.w, Enum.TextXAlignment.Right),
		r = newCell(frame, COL_R.x, COL_R.w, Enum.TextXAlignment.Right),
		flag = newCell(frame, COL_FLAG.x, COL_FLAG.w, Enum.TextXAlignment.Left),
	}
end

local function setCell(label: TextLabel, text: string, color: Color3)
	if label.Text ~= text then
		label.Text = text
	end
	if label.TextColor3 ~= color then
		label.TextColor3 = color
	end
end

local function pnlColor(v: number): Color3
	return if v > 0 then Theme.up elseif v < 0 then Theme.down else Theme.textDim
end

local function rebuild(self: TradeLog)
	self.dirty = false
	local trades = self.trades
	local total = #trades
	local count = math.min(total, MAX_ROWS)

	local titleText = string.format("trades (%d)", total)
	if self.title.Text ~= titleText then
		self.title.Text = titleText
	end
	self.empty.Visible = total == 0

	for k = #self.rows + 1, count do
		table.insert(self.rows, makeRow(self.list))
	end

	for i = 1, count do
		-- newest first
		local t = trades[total - i + 1]
		local row = self.rows[i]
		row.frame.Position = UDim2.fromOffset(0, (i - 1) * ROW_H)
		setCell(
			row.side,
			string.format("%s %.1f", if t.side == "buy" then "L" else "S", t.qty),
			if t.side == "buy" then Theme.up else Theme.down
		)
		setCell(row.prices, string.format("%.2f -> %.2f", t.avgEntry, t.avgExit), Theme.text)
		setCell(row.pnl, ContractMath.fmtUsd(t.pnlUsd), pnlColor(t.pnlUsd))
		local riskPts = t.riskPts
		-- R is only defined where the entry carried a stop to measure it against
		local rText = if riskPts ~= nil and riskPts > 0 then string.format("%.1fR", t.pnlPts / riskPts) else "-"
		setCell(row.r, rText, if riskPts ~= nil and riskPts > 0 then pnlColor(t.pnlPts) else Theme.textDim)
		-- the fill's same-bar SL/TP order could not be resolved without 1s data
		setCell(row.flag, if t.ambiguous then "*" else "", Theme.accent)
	end
	for k = count + 1, self.shown do
		self.rows[k].frame.Visible = false
	end
	for k = self.shown + 1, count do
		self.rows[k].frame.Visible = true
	end
	self.shown = count
	self.list.CanvasSize = UDim2.fromOffset(0, count * ROW_H)
end

function TradeLog.setState(self: TradeLog, state: Protocol.TradeState)
	self.trades = state.trades
	self.dirty = true
	if self.panel.Visible then
		rebuild(self)
	end
end

function TradeLog.toggle(self: TradeLog)
	local open = not self.panel.Visible
	self.panel.Visible = open
	if open and self.dirty then
		rebuild(self)
	end
end

function TradeLog.new(gui: ScreenGui): TradeLog
	local panel = Instance.new("Frame")
	panel.Name = "TradeLog"
	panel.BorderSizePixel = 0
	panel.BackgroundColor3 = Theme.panel
	panel.AnchorPoint = Vector2.new(1, 1)
	panel.Position = UDim2.new(1, -8, 1, -(Theme.hudHeight + 8))
	panel.Size = UDim2.fromOffset(PANEL_W, PANEL_H)
	panel.ZIndex = 8
	panel.Visible = false
	panel.Active = true -- swallow clicks aimed at the chart underneath
	panel.Parent = gui

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.BorderSizePixel = 0
	title.Position = UDim2.fromOffset(8, 0)
	title.Size = UDim2.new(1, -16, 0, HEADER_H)
	title.Font = Enum.Font.Code
	title.TextSize = 12
	title.TextColor3 = Theme.textDim
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Text = "trades (0)"
	title.ZIndex = 9
	title.Parent = panel

	local list = Instance.new("ScrollingFrame")
	list.Name = "Rows"
	list.BorderSizePixel = 0
	list.BackgroundTransparency = 1
	list.Position = UDim2.fromOffset(0, HEADER_H)
	list.Size = UDim2.new(1, 0, 1, -HEADER_H)
	list.CanvasSize = UDim2.fromOffset(0, 0)
	list.ScrollBarThickness = 6
	list.ZIndex = 8
	list.Parent = panel

	local empty = Instance.new("TextLabel")
	empty.BackgroundTransparency = 1
	empty.BorderSizePixel = 0
	empty.Position = UDim2.fromOffset(8, 6)
	empty.Size = UDim2.new(1, -16, 0, ROW_H)
	empty.Font = Enum.Font.Code
	empty.TextSize = 12
	empty.TextColor3 = Theme.textDim
	empty.TextXAlignment = Enum.TextXAlignment.Left
	empty.Text = "no completed trades yet"
	empty.ZIndex = 9
	empty.Parent = list

	return setmetatable(
		{
			panel = panel,
			title = title,
			list = list,
			empty = empty,
			rows = {},
			shown = 0,
			trades = {},
			dirty = false,
		} :: Fields,
		TradeLog
	)
end

return TradeLog

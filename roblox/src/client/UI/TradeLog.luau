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
local Et = require(Shared:WaitForChild("Time"):WaitForChild("Et"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

local PANEL_W = 576
local PANEL_H = 240
local TITLE_H = 22
local HEAD_H = 18
local ROW_H = 18
-- Rows past this are simply not drawn; a session that produces more than this
-- many round trips has outgrown a scrolling strip anyway.
local MAX_ROWS = 200

type Col = { x: number, w: number, align: Enum.TextXAlignment, head: string }

local LEFT = Enum.TextXAlignment.Left
local RIGHT = Enum.TextXAlignment.Right

-- Entry/exit are wall times only: every trade in a session shares its trading
-- day, so the date would be the same string on every row.
local COL_SIDE: Col = { x = 4, w = 44, align = LEFT, head = "dir" }
local COL_ENTRY: Col = { x = 52, w = 44, align = LEFT, head = "in" }
local COL_EXIT: Col = { x = 100, w = 44, align = LEFT, head = "out" }
local COL_DUR: Col = { x = 148, w = 48, align = RIGHT, head = "dur" }
local COL_PRICES: Col = { x = 202, w = 150, align = LEFT, head = "prices" }
local COL_PTS: Col = { x = 356, w = 58, align = RIGHT, head = "pts" }
local COL_PNL: Col = { x = 418, w = 78, align = RIGHT, head = "P&L" }
local COL_R: Col = { x = 500, w = 52, align = RIGHT, head = "R" }
local COL_FLAG: Col = { x = 556, w = 12, align = LEFT, head = "" }

local COLUMNS: { Col } = { COL_SIDE, COL_ENTRY, COL_EXIT, COL_DUR, COL_PRICES, COL_PTS, COL_PNL, COL_R, COL_FLAG }

local TradeLog = {}
TradeLog.__index = TradeLog

type Row = {
	frame: Frame,
	side: TextLabel,
	entry: TextLabel,
	exit: TextLabel,
	dur: TextLabel,
	prices: TextLabel,
	pts: TextLabel,
	pnl: TextLabel,
	r: TextLabel,
	flag: TextLabel,
}

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

local function newCell(parent: Instance, col: Col): TextLabel
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.BorderSizePixel = 0
	l.Position = UDim2.fromOffset(col.x, 0)
	l.Size = UDim2.fromOffset(col.w, ROW_H)
	-- a column of prices, dollars and R multiples only reads as a column with
	-- a fixed advance behind it
	l.Font = Theme.fontMono
	l.TextSize = Theme.textSm
	l.TextColor3 = Theme.text
	l.TextXAlignment = col.align
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
		side = newCell(frame, COL_SIDE),
		entry = newCell(frame, COL_ENTRY),
		exit = newCell(frame, COL_EXIT),
		dur = newCell(frame, COL_DUR),
		prices = newCell(frame, COL_PRICES),
		pts = newCell(frame, COL_PTS),
		pnl = newCell(frame, COL_PNL),
		r = newCell(frame, COL_R),
		flag = newCell(frame, COL_FLAG),
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

-- mm:ss under the hour, h:mm above it. Exits land on bar boundaries so the
-- seconds are usually 00; the column exists to separate a 3-minute scalp from
-- a 3-hour hold at a glance.
local function fmtDuration(sec: number): string
	if sec < 3600 then
		return string.format("%d:%02d", math.floor(sec / 60), sec % 60)
	end
	return string.format("%d:%02d", math.floor(sec / 3600), math.floor(sec % 3600 / 60))
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
		setCell(row.entry, Et.formatET(t.entryTs, false), Theme.textDim)
		setCell(row.exit, Et.formatET(t.exitTs, false), Theme.textDim)
		setCell(row.dur, fmtDuration(t.exitTs - t.entryTs), Theme.textDim)
		setCell(row.prices, string.format("%.2f -> %.2f", t.avgEntry, t.avgExit), Theme.text)
		setCell(row.pts, string.format("%+.2f", t.pnlPts), pnlColor(t.pnlPts))
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
	title.Size = UDim2.new(1, -16, 0, TITLE_H)
	title.Font = Theme.fontUiMedium
	title.TextSize = Theme.textMd
	title.TextColor3 = Theme.textDim
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Text = "trades (0)"
	title.ZIndex = 9
	title.Parent = panel

	-- The header sits OUTSIDE the ScrollingFrame so the columns stay named while
	-- the rows scroll under them.
	local head = Instance.new("Frame")
	head.Name = "Header"
	head.BorderSizePixel = 0
	head.BackgroundTransparency = 1
	head.Position = UDim2.fromOffset(0, TITLE_H)
	head.Size = UDim2.new(1, 0, 0, HEAD_H)
	head.ZIndex = 9
	head.Parent = panel
	for _, col in ipairs(COLUMNS) do
		if col.head ~= "" then
			local cell = newCell(head, col)
			-- column names are words, not numbers
			cell.Font = Theme.fontUi
			cell.TextColor3 = Theme.textDim
			cell.Text = col.head
		end
	end

	local list = Instance.new("ScrollingFrame")
	list.Name = "Rows"
	list.BorderSizePixel = 0
	list.BackgroundTransparency = 1
	list.Position = UDim2.fromOffset(0, TITLE_H + HEAD_H)
	list.Size = UDim2.new(1, 0, 1, -(TITLE_H + HEAD_H))
	list.CanvasSize = UDim2.fromOffset(0, 0)
	list.ScrollBarThickness = 6
	list.ZIndex = 8
	list.Parent = panel

	local empty = Instance.new("TextLabel")
	empty.BackgroundTransparency = 1
	empty.BorderSizePixel = 0
	empty.Position = UDim2.fromOffset(8, 6)
	empty.Size = UDim2.new(1, -16, 0, ROW_H)
	empty.Font = Theme.fontUi
	empty.TextSize = Theme.textSm
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

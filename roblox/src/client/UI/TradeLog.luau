--!strict
-- Completed round trips, newest first. A pure readout of TradeState.trades —
-- the server folds the event log into those, and rewinding voids them, so this
-- panel must never keep a trade the latest state no longer lists.
--
-- Rows are pooled and rebuilt only when a TradeState arrives (and lazily: a
-- hidden panel defers its rebuild until it is opened). Each row is a button
-- that opens the TradeViewer modal this panel owns.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))
local Et = require(Shared:WaitForChild("Time"):WaitForChild("Et"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))
local Types = require(Shared:WaitForChild("Types"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))
local TradeViewer = require(Client:WaitForChild("UI"):WaitForChild("TradeViewer"))

local PANEL_W = 718
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
local COL_NUM: Col = { x = 4, w = 22, align = RIGHT, head = "#" }
local COL_SIDE: Col = { x = 30, w = 44, align = LEFT, head = "dir" }
local COL_ENTRY: Col = { x = 78, w = 44, align = LEFT, head = "in" }
local COL_EXIT: Col = { x = 126, w = 44, align = LEFT, head = "out" }
local COL_DUR: Col = { x = 174, w = 48, align = RIGHT, head = "dur" }
local COL_PRICES: Col = { x = 226, w = 150, align = LEFT, head = "prices" }
local COL_PTS: Col = { x = 380, w = 58, align = RIGHT, head = "pts" }
local COL_PNL: Col = { x = 442, w = 78, align = RIGHT, head = "P&L" }
local COL_R: Col = { x = 524, w = 52, align = RIGHT, head = "R" }
local COL_MAE: Col = { x = 580, w = 56, align = RIGHT, head = "MAE" }
local COL_MFE: Col = { x = 640, w = 56, align = RIGHT, head = "MFE" }
local COL_FLAG: Col = { x = 700, w = 12, align = LEFT, head = "" }

local COLUMNS: { Col } = {
	COL_NUM,
	COL_SIDE,
	COL_ENTRY,
	COL_EXIT,
	COL_DUR,
	COL_PRICES,
	COL_PTS,
	COL_PNL,
	COL_R,
	COL_MAE,
	COL_MFE,
	COL_FLAG,
}

local TradeLog = {}
TradeLog.__index = TradeLog

-- `trade`/`index` are what the pooled button currently stands for; its
-- Activated connection is made once, at creation, and reads them, so a rebuild
-- rewrites the fields rather than reconnecting.
type Row = {
	btn: TextButton,
	num: TextLabel,
	side: TextLabel,
	entry: TextLabel,
	exit: TextLabel,
	dur: TextLabel,
	prices: TextLabel,
	pts: TextLabel,
	pnl: TextLabel,
	r: TextLabel,
	mae: TextLabel,
	mfe: TextLabel,
	flag: TextLabel,
	trade: Protocol.TradeView?,
	index: number,
}

type Fields = {
	panel: Frame,
	title: TextLabel,
	list: ScrollingFrame,
	empty: TextLabel,
	viewer: TradeViewer.TradeViewer,
	rows: { Row },
	shown: number,
	trades: { Protocol.TradeView },
	barsProvider: (() -> { Types.Bar })?,
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

-- nil while no provider is wired, which is not an error: the excursion cells
-- read "-" until Main hands the panel its bar source.
local function excursionFor(self: TradeLog, trade: Protocol.TradeView): TradeViewer.Excursion?
	local provider = self.barsProvider
	if provider == nil then
		return nil
	end
	return TradeViewer.excursion(trade, provider())
end

local function makeRow(self: TradeLog): Row
	local btn = Instance.new("TextButton")
	btn.BorderSizePixel = 0
	btn.BackgroundColor3 = Theme.panelHover
	btn.BackgroundTransparency = 1
	btn.Size = UDim2.new(1, 0, 0, ROW_H)
	btn.Text = ""
	-- the cells carry the row's color; letting the button tint itself would
	-- wash them out
	btn.AutoButtonColor = false
	btn.ZIndex = 9
	btn.Visible = false
	btn.Parent = self.list

	local row: Row = {
		btn = btn,
		num = newCell(btn, COL_NUM),
		side = newCell(btn, COL_SIDE),
		entry = newCell(btn, COL_ENTRY),
		exit = newCell(btn, COL_EXIT),
		dur = newCell(btn, COL_DUR),
		prices = newCell(btn, COL_PRICES),
		pts = newCell(btn, COL_PTS),
		pnl = newCell(btn, COL_PNL),
		r = newCell(btn, COL_R),
		mae = newCell(btn, COL_MAE),
		mfe = newCell(btn, COL_MFE),
		flag = newCell(btn, COL_FLAG),
		trade = nil,
		index = 0,
	}

	btn.MouseEnter:Connect(function()
		btn.BackgroundTransparency = 0.6
	end)
	btn.MouseLeave:Connect(function()
		btn.BackgroundTransparency = 1
	end)
	btn.Activated:Connect(function()
		local trade = row.trade
		if trade == nil then
			return
		end
		self.viewer:show(trade, row.index, excursionFor(self, trade))
	end)
	return row
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

	local titleText = string.format("trades (%d) - click a row to review", total)
	if self.title.Text ~= titleText then
		self.title.Text = titleText
	end
	self.empty.Visible = total == 0

	for k = #self.rows + 1, count do
		table.insert(self.rows, makeRow(self))
	end

	for i = 1, count do
		-- newest first
		local index = total - i + 1
		local t = trades[index]
		local row = self.rows[i]
		row.trade = t
		-- "#" is the trade's place in the SESSION, not in this listing, so it
		-- stays put as later trades push it down the strip
		row.index = index
		row.btn.Position = UDim2.fromOffset(0, (i - 1) * ROW_H)
		setCell(row.num, tostring(index), Theme.textDim)
		setCell(
			row.side,
			string.format("%s %.1f", if t.side == "buy" then "L" else "S", t.qty),
			if t.side == "buy" then Theme.up else Theme.down
		)
		setCell(row.entry, Et.formatET(t.entryTs, false), Theme.textDim)
		setCell(row.exit, Et.formatET(t.exitTs, false), Theme.textDim)
		setCell(row.dur, TradeViewer.fmtDuration(t.exitTs - t.entryTs), Theme.textDim)
		setCell(row.prices, string.format("%.2f -> %.2f", t.avgEntry, t.avgExit), Theme.text)
		setCell(row.pts, string.format("%+.2f", t.pnlPts), pnlColor(t.pnlPts))
		setCell(row.pnl, ContractMath.fmtUsd(t.pnlUsd), pnlColor(t.pnlUsd))
		local riskPts = t.riskPts
		-- R is only defined where the entry carried a stop to measure it against
		local rText = if riskPts ~= nil and riskPts > 0 then string.format("%.1fR", t.pnlPts / riskPts) else "-"
		setCell(row.r, rText, if riskPts ~= nil and riskPts > 0 then pnlColor(t.pnlPts) else Theme.textDim)
		local ex = excursionFor(self, t)
		if ex ~= nil then
			setCell(row.mae, string.format("-%.2f", ex.maePts), Theme.down)
			setCell(row.mfe, string.format("+%.2f", ex.mfePts), Theme.up)
		else
			setCell(row.mae, "-", Theme.textDim)
			setCell(row.mfe, "-", Theme.textDim)
		end
		-- the fill's same-bar SL/TP order could not be resolved without 1s data
		setCell(row.flag, if t.ambiguous then "*" else "", Theme.accent)
	end
	for k = count + 1, self.shown do
		local row = self.rows[k]
		row.trade = nil
		-- a row hidden under the cursor never gets its MouseLeave
		row.btn.BackgroundTransparency = 1
		row.btn.Visible = false
	end
	for k = self.shown + 1, count do
		self.rows[k].btn.Visible = true
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

-- Source of the BASE-resolution bars the MAE/MFE columns scan. Optional and
-- additive: until it is set the excursion cells read "-", so the panel is
-- usable before Main wires it. Aggregated candles are NOT a valid source — a
-- bucket straddling the entry would fold pre-entry range into the excursion.
function TradeLog.setBarsProvider(self: TradeLog, provider: () -> { Types.Bar })
	self.barsProvider = provider
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
	-- the viewer is opened from this panel, so it has no reason to outlive it
	if not open then
		self.viewer:hide()
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
			viewer = TradeViewer.new(gui),
			rows = {},
			shown = 0,
			trades = {},
			barsProvider = nil,
			dirty = false,
		} :: Fields,
		TradeLog
	)
end

return TradeLog

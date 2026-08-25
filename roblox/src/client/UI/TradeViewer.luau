--!strict
-- Per-trade review modal: everything the log's row had to abbreviate, plus the
-- bracket prices and the excursion the trade lived through.
--
-- This module is also the HOME of the per-trade derivations the log's own
-- columns need (`excursion`, `fmtDuration`). TradeLog requires this module and
-- calls them, so a row and the modal opened from it can never disagree; the
-- dependency only runs that way, so nothing here may ever require TradeLog.
--
-- Display only. It is handed a TradeView and a precomputed excursion and never
-- touches bars, the clock, or a remote.
--
-- NO mini-chart: the web viewer re-renders a real chart around the trade
-- window. That needs a second chart instance and is deliberately out of scope
-- for v1 (see GAP_REPORT D).

local UserInputService = game:GetService("UserInputService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))
local Et = require(Shared:WaitForChild("Time"):WaitForChild("Et"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))
local Types = require(Shared:WaitForChild("Types"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Bar = Types.Bar

local PAD = 12
local PANEL_W = 400
local HEADER_Y = 10
local HEADER_H = 22
local CLOSE_W = HEADER_H -- square, so it reads as a dismiss and not as a word

local ROWS_Y = 44
local ROW_H = 20
local LABEL_W = 74
local VALUE_X = PAD + LABEL_W + 8
local VALUE_W = PANEL_W - VALUE_X - PAD

-- Read order of a trade review: what it was, when it opened and closed, what it
-- made, and what it went through to get there.
local ROW_LABELS = { "side", "entry", "exit", "duration", "points", "P&L", "R", "stop", "target", "MAE", "MFE" }
local R_SIDE, R_ENTRY, R_EXIT, R_DUR, R_PTS, R_PNL, R_R, R_SL, R_TP, R_MAE, R_MFE = 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11

local NOTE_Y = ROWS_Y + #ROW_LABELS * ROW_H + 8
local NOTE_H = 44
local PANEL_H = NOTE_Y + NOTE_H + PAD

local AMBIGUOUS_NOTE = "* stop and target were both touched inside one bar. This port has no 1s data,"
	.. " so the fill resolved stop-first: the conservative reading, and the same one the web"
	.. " engine takes without a seconds feed."

local TradeViewer = {}
TradeViewer.__index = TradeViewer

-- Adverse/favorable excursion in points, both expressed POSITIVE.
export type Excursion = { maePts: number, mfePts: number }

type Fields = {
	modal: Frame,
	title: TextLabel,
	values: { TextLabel },
	note: TextLabel,
}

export type TradeViewer = typeof(setmetatable({} :: Fields, TradeViewer))

-- ---------------------------------------------------------------------------
-- derivations (shared with TradeLog's columns)
-- ---------------------------------------------------------------------------

-- mm:ss under the hour, h:mm above it. Exits land on bar boundaries so the
-- seconds are usually 00; the readout exists to separate a 3-minute scalp from
-- a 3-hour hold at a glance.
function TradeViewer.fmtDuration(sec: number): string
	if sec < 3600 then
		return string.format("%d:%02d", math.floor(sec / 60), sec % 60)
	end
	return string.format("%d:%02d", math.floor(sec / 3600), math.floor(sec % 3600 / 60))
end

-- Index of the last bar whose OPEN is at or before `ts`, or nil when every bar
-- opens after it. Binary search: the log re-derives this per row on every
-- TradeState arrival, and a linear scan would be O(trades * session).
local function lastAtOrBefore(bars: { Bar }, ts: number): number?
	local lo, hi = 1, #bars
	if hi == 0 or bars[1].t > ts then
		return nil
	end
	while lo < hi do
		local mid = (lo + hi + 1) // 2
		if bars[mid].t <= ts then
			lo = mid
		else
			hi = mid - 1
		end
	end
	return lo
end

-- MAE/MFE over the bars the position was actually open across. `bars` must be
-- BASE-resolution bars: an aggregated bucket straddling the entry would fold
-- pre-entry range into the excursion.
--
-- A fill's tsMarket is the CLOSE of the bar it happened in (Session advances the
-- clock to bar.t + baseSec before simulating it), so the entry bar is the last
-- one opening at or before entryTs and the exit bar is the last one opening
-- strictly before exitTs. Both ends are part of the excursion — a target that
-- was reached in the exit bar is the whole point of MFE.
--
-- Reading the client bar cache cannot leak the future: it only ever holds bars
-- the server has already revealed, and a completed trade is entirely behind the
-- clock by construction.
function TradeViewer.excursion(trade: Protocol.TradeView, bars: { Bar }): Excursion?
	local fromIdx = lastAtOrBefore(bars, trade.entryTs)
	local toIdx = lastAtOrBefore(bars, trade.exitTs - 1)
	if fromIdx == nil or toIdx == nil then
		return nil
	end
	local last = math.max(toIdx, fromIdx)
	local hi, lo = bars[fromIdx].h, bars[fromIdx].l
	for i = fromIdx + 1, last do
		local b = bars[i]
		if b.h > hi then
			hi = b.h
		end
		if b.l < lo then
			lo = b.l
		end
	end
	local long = trade.side == "buy"
	return {
		maePts = math.max(0, if long then trade.avgEntry - lo else hi - trade.avgEntry),
		mfePts = math.max(0, if long then hi - trade.avgEntry else trade.avgEntry - lo),
	}
end

-- ---------------------------------------------------------------------------
-- state -> pixels
-- ---------------------------------------------------------------------------

local function setValue(self: TradeViewer, index: number, text: string, color: Color3)
	local label = self.values[index]
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

local function fmtPrice(price: number?): string
	return if price ~= nil then string.format("%.2f", price) else "-"
end

-- ---------------------------------------------------------------------------
-- public surface
-- ---------------------------------------------------------------------------

-- `index` is the trade's position in TradeState.trades (1 = first of the
-- session), matching the log's "#" column. `ex` is nil when no bars provider is
-- wired, which is not an error — the excursion rows simply read "-".
function TradeViewer.show(self: TradeViewer, trade: Protocol.TradeView, index: number, ex: Excursion?)
	local titleText = string.format("trade #%d", index)
	if self.title.Text ~= titleText then
		self.title.Text = titleText
	end

	local long = trade.side == "buy"
	setValue(
		self,
		R_SIDE,
		string.format("%s %.2f", if long then "LONG" else "SHORT", trade.qty),
		if long then Theme.up else Theme.down
	)
	-- With the date: unlike a log row, a modal is read one trade at a time and
	-- has the width for it.
	setValue(self, R_ENTRY, string.format("%s @ %.2f", Et.formatET(trade.entryTs, true), trade.avgEntry), Theme.text)
	setValue(self, R_EXIT, string.format("%s @ %.2f", Et.formatET(trade.exitTs, true), trade.avgExit), Theme.text)
	setValue(self, R_DUR, TradeViewer.fmtDuration(trade.exitTs - trade.entryTs), Theme.text)
	setValue(self, R_PTS, ContractMath.fmtPts(trade.pnlPts), pnlColor(trade.pnlPts))
	setValue(self, R_PNL, ContractMath.fmtUsd(trade.pnlUsd), pnlColor(trade.pnlUsd))

	-- R is only defined where the entry carried a stop to measure it against.
	local riskPts = trade.riskPts
	local hasR = riskPts ~= nil and riskPts > 0
	setValue(
		self,
		R_R,
		if hasR and riskPts ~= nil then string.format("%.2fR", trade.pnlPts / riskPts) else "-",
		if hasR then pnlColor(trade.pnlPts) else Theme.textDim
	)

	setValue(self, R_SL, fmtPrice(trade.slPrice), if trade.slPrice ~= nil then Theme.down else Theme.textDim)
	setValue(self, R_TP, fmtPrice(trade.tpPrice), if trade.tpPrice ~= nil then Theme.up else Theme.textDim)

	if ex ~= nil then
		setValue(self, R_MAE, string.format("-%.2f pts", ex.maePts), Theme.down)
		setValue(self, R_MFE, string.format("+%.2f pts", ex.mfePts), Theme.up)
	else
		setValue(self, R_MAE, "-", Theme.textDim)
		setValue(self, R_MFE, "-", Theme.textDim)
	end

	self.note.Visible = trade.ambiguous
	self.modal.Visible = true
end

function TradeViewer.hide(self: TradeViewer)
	self.modal.Visible = false
end

function TradeViewer.isOpen(self: TradeViewer): boolean
	return self.modal.Visible
end

function TradeViewer.new(gui: ScreenGui): TradeViewer
	local modal = Instance.new("Frame")
	modal.Name = "TradeViewer"
	modal.BorderSizePixel = 0
	modal.BackgroundColor3 = Theme.bg
	modal.BackgroundTransparency = 0.35
	modal.Size = UDim2.fromScale(1, 1)
	-- Above the trade log (8/9) and the session picker (10/12): the viewer is
	-- opened FROM the log and must occlude it.
	modal.ZIndex = 14
	modal.Visible = false
	modal.Active = true -- swallow clicks aimed at the chart underneath
	modal.Parent = gui

	-- Clicking outside the panel closes. A button rather than an input handler,
	-- and BELOW the panel so the panel occludes it — the same shape as
	-- SessionPicker's scrim.
	local scrim = Instance.new("TextButton")
	scrim.Name = "Scrim"
	scrim.BorderSizePixel = 0
	scrim.BackgroundTransparency = 1
	scrim.Size = UDim2.fromScale(1, 1)
	scrim.Text = ""
	scrim.AutoButtonColor = false
	scrim.ZIndex = 14
	scrim.Parent = modal

	local panel = Instance.new("Frame")
	panel.Name = "Panel"
	panel.BorderSizePixel = 0
	panel.BackgroundColor3 = Theme.panel
	panel.AnchorPoint = Vector2.new(0.5, 0.5)
	panel.Position = UDim2.fromScale(0.5, 0.5)
	panel.Size = UDim2.fromOffset(PANEL_W, PANEL_H)
	panel.ZIndex = 15
	-- Sinks the clicks the scrim below must not see: a click that lands on the
	-- panel is not a dismissal.
	panel.Active = true
	panel.Parent = modal

	local title = Instance.new("TextLabel")
	title.Name = "Title"
	title.BackgroundTransparency = 1
	title.BorderSizePixel = 0
	title.Position = UDim2.fromOffset(PAD, HEADER_Y)
	title.Size = UDim2.fromOffset(PANEL_W - PAD * 2 - CLOSE_W - 8, HEADER_H)
	title.Font = Theme.fontUiMedium
	title.TextSize = Theme.textLg
	title.TextColor3 = Theme.text
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.Text = "trade"
	title.ZIndex = 16
	title.Parent = panel

	local closeBtn = Instance.new("TextButton")
	closeBtn.Name = "Close"
	closeBtn.BorderSizePixel = 0
	closeBtn.BackgroundColor3 = Theme.panelHover
	closeBtn.AnchorPoint = Vector2.new(1, 0)
	closeBtn.Position = UDim2.new(1, -PAD, 0, HEADER_Y)
	closeBtn.Size = UDim2.fromOffset(CLOSE_W, HEADER_H)
	closeBtn.Font = Theme.fontUiMedium
	closeBtn.TextSize = Theme.textLg
	closeBtn.TextColor3 = Theme.text
	closeBtn.Text = "\u{00D7}"
	closeBtn.AutoButtonColor = true
	closeBtn.ZIndex = 16
	closeBtn.Parent = panel

	-- The row set is FIXED, so every label and value instance is built once here
	-- and only its text is rewritten on show.
	local values: { TextLabel } = {}
	for i, name in ipairs(ROW_LABELS) do
		local y = ROWS_Y + (i - 1) * ROW_H

		local label = Instance.new("TextLabel")
		label.Name = "Label"
		label.BackgroundTransparency = 1
		label.BorderSizePixel = 0
		label.Position = UDim2.fromOffset(PAD, y)
		label.Size = UDim2.fromOffset(LABEL_W, ROW_H)
		-- field names are words
		label.Font = Theme.fontUi
		label.TextSize = Theme.textSm
		label.TextColor3 = Theme.textDim
		label.TextXAlignment = Enum.TextXAlignment.Left
		label.Text = name
		label.ZIndex = 16
		label.Parent = panel

		local value = Instance.new("TextLabel")
		value.Name = "Value"
		value.BackgroundTransparency = 1
		value.BorderSizePixel = 0
		value.Position = UDim2.fromOffset(VALUE_X, y)
		value.Size = UDim2.fromOffset(VALUE_W, ROW_H)
		-- prices, dollars and R multiples only stack into a column under a fixed
		-- advance
		value.Font = Theme.fontMono
		value.TextSize = Theme.textSm
		value.TextColor3 = Theme.text
		value.TextXAlignment = Enum.TextXAlignment.Left
		value.Text = "-"
		value.ZIndex = 16
		value.Parent = panel
		values[i] = value
	end

	local note = Instance.new("TextLabel")
	note.Name = "AmbiguousNote"
	note.BackgroundTransparency = 1
	note.BorderSizePixel = 0
	note.Position = UDim2.fromOffset(PAD, NOTE_Y)
	note.Size = UDim2.fromOffset(PANEL_W - PAD * 2, NOTE_H)
	note.Font = Theme.fontUi
	note.TextSize = Theme.textSm
	note.TextColor3 = Theme.accent
	note.TextXAlignment = Enum.TextXAlignment.Left
	note.TextYAlignment = Enum.TextYAlignment.Top
	note.TextWrapped = true
	note.Text = AMBIGUOUS_NOTE
	note.Visible = false
	note.ZIndex = 16
	note.Parent = panel

	local self: TradeViewer = setmetatable(
		{
			modal = modal,
			title = title,
			values = values,
			note = note,
		} :: Fields,
		TradeViewer
	)

	closeBtn.Activated:Connect(function()
		self:hide()
	end)
	scrim.Activated:Connect(function()
		self:hide()
	end)
	-- Escape is not routed through ContextActionService: it must not be sunk away
	-- from the rest of the client (SessionPicker, OrderPanel and DrawToolbar all
	-- act on it too), and closing a closed viewer is free. Gated on the focused
	-- box because the order-entry fields share this keyboard.
	UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
		if processed or UserInputService:GetFocusedTextBox() ~= nil then
			return
		end
		if input.KeyCode == Enum.KeyCode.Escape then
			self:hide()
		end
	end)

	return self
end

return TradeViewer

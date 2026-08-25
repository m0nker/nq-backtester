--!strict
-- HUD strip: position, mark-to-market and realized P&L, balance, trade and
-- voided counts, the two actions that belong next to them (flatten, trade log),
-- and a cancellable chip per working order.
--
-- Every number here is the server's derived TradeState, with ONE exception:
-- unrealized P&L marks the position against the newest revealed close, which
-- only the client's bar cache holds. That close is a revealed bar by
-- construction (BarCache never holds anything else), so the readout cannot see
-- past the replay clock.
--
-- flatten and the chips' cancel only SEND a command and wait for the state that
-- answers it.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))

local Client = script.Parent.Parent
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Send = ({ [string]: any }) -> ()

local PAD = 6
local GAP = 10
local BTN_H = 18
local CHIP_H = 18

-- Working-order chips. Widths are sized for the longest line the strip can
-- print ("S stp 10.0 @ 123456.75") at the mono face's advance.
local MAX_CHIPS = 6
local CHIP_TEXT_W = 152
local CHIP_X_W = 14
local CHIP_W = CHIP_TEXT_W + CHIP_X_W
local CHIP_GAP = 6
local CHIP_PITCH = CHIP_W + CHIP_GAP
local OVERFLOW_W = 34

local TYPE_ABBR: { [string]: string } = {
	market = "mkt",
	limit = "lim",
	stop = "stp",
}

local PositionBar = {}
PositionBar.__index = PositionBar

export type Callbacks = {
	send: Send,
	toggleLog: () -> (),
	-- newest revealed close, or nil before the first bar packet
	getLastClose: () -> number?,
}

-- `id` is rewritten on every rebuild; the cancel button's connection is made
-- once at creation and reads it through this table, so a pooled chip can never
-- cancel the order it used to show.
type Chip = { frame: Frame, label: TextLabel, cancel: TextButton, id: string }

type Fields = {
	send: Send,
	getLastClose: () -> number?,
	bar: Frame,
	posChip: TextLabel,
	unreal: TextLabel,
	realized: TextLabel,
	balance: TextLabel,
	tradeCount: TextLabel,
	voided: TextLabel,
	flattenBtn: TextButton,

	ordersRoot: Frame,
	chips: { Chip },
	chipsShown: number,
	overflow: TextLabel,

	-- last state, so a new bar can re-mark the position and a resize can re-lay
	-- the chip strip without waiting for the next TradeState
	orders: { Protocol.WorkingOrderView },
	qty: number,
	avgPrice: number,

	-- where the fixed left-hand readouts end; the chip strip may not reach it
	leftEnd: number,
}

export type PositionBar = typeof(setmetatable({} :: Fields, PositionBar))

local function newChip(parent: Instance, x: number, w: number, filled: boolean): TextLabel
	local l = Instance.new("TextLabel")
	l.BorderSizePixel = 0
	l.AnchorPoint = Vector2.new(0, 0.5)
	l.Position = UDim2.new(0, x, 0.5, 0)
	l.Size = UDim2.fromOffset(w, CHIP_H)
	l.BackgroundTransparency = if filled then 0 else 1
	l.BackgroundColor3 = Theme.border
	-- position, P&L, balance and the counts are all live numbers
	l.Font = Theme.fontMono
	l.TextSize = Theme.textSm
	l.TextColor3 = Theme.textDim
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.Text = ""
	l.Parent = parent
	return l
end

local function newButton(parent: Instance, name: string, x: number, w: number): TextButton
	local b = Instance.new("TextButton")
	b.Name = name
	b.BorderSizePixel = 0
	b.AnchorPoint = Vector2.new(0, 0.5)
	b.Position = UDim2.new(0, x, 0.5, 0)
	b.Size = UDim2.fromOffset(w, BTN_H)
	b.BackgroundColor3 = Theme.panelHover
	b.TextColor3 = Theme.text
	b.Font = Theme.fontUiMedium
	b.TextSize = Theme.textSm
	b.Text = name
	b.Parent = parent
	return b
end

local function setText(label: TextLabel, text: string, color: Color3)
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

-- ---------------------------------------------------------------------------
-- working-order strip
-- ---------------------------------------------------------------------------

local function makeChip(self: PositionBar): Chip
	local frame = Instance.new("Frame")
	frame.BorderSizePixel = 0
	frame.BackgroundColor3 = Theme.panelHover
	frame.Size = UDim2.fromOffset(CHIP_W, CHIP_H)
	frame.Visible = false
	frame.Parent = self.ordersRoot

	local label = Instance.new("TextLabel")
	label.BackgroundTransparency = 1
	label.BorderSizePixel = 0
	label.Position = UDim2.fromOffset(4, 0)
	label.Size = UDim2.fromOffset(CHIP_TEXT_W - 4, CHIP_H)
	label.Font = Theme.fontMono
	label.TextSize = Theme.textSm
	label.TextColor3 = Theme.text
	label.TextXAlignment = Enum.TextXAlignment.Left
	label.Text = ""
	label.Parent = frame

	local cancel = Instance.new("TextButton")
	cancel.Name = "Cancel"
	cancel.BorderSizePixel = 0
	cancel.BackgroundTransparency = 1
	cancel.Position = UDim2.fromOffset(CHIP_TEXT_W, 0)
	cancel.Size = UDim2.fromOffset(CHIP_X_W, CHIP_H)
	cancel.Font = Theme.fontUiMedium
	cancel.TextSize = Theme.textSm
	cancel.TextColor3 = Theme.textDim
	cancel.Text = "x"
	cancel.Parent = frame

	local chip: Chip = { frame = frame, label = label, cancel = cancel, id = "" }
	cancel.Activated:Connect(function()
		if chip.id ~= "" then
			self.send({ cmd = "cancelOrder", orderId = chip.id })
		end
	end)
	return chip
end

-- A working order names either a limit or a stop level; a market order that is
-- still working has no level to print.
local function orderPrice(o: Protocol.WorkingOrderView): string
	local p = if o.limitPrice ~= nil then o.limitPrice else o.stopPrice
	return if p ~= nil then string.format("%.2f", p) else "mkt"
end

local function relayoutOrders(self: PositionBar)
	local orders = self.orders
	local total = #orders
	-- The strip may not run into the readouts on its left, so how many chips
	-- fit is a function of the window width, not just of MAX_CHIPS.
	local avail = math.max(0, self.bar.AbsoluteSize.X - self.leftEnd - PAD)
	local fit = math.max(0, math.floor((avail + CHIP_GAP) / CHIP_PITCH))
	local count = math.min(total, MAX_CHIPS, fit)
	if count < total and count > 0 and count * CHIP_PITCH + OVERFLOW_W > avail then
		count -= 1
	end
	local hidden = total - count

	for k = #self.chips + 1, count do
		table.insert(self.chips, makeChip(self))
	end

	local width = count * CHIP_PITCH - (if count > 0 then CHIP_GAP else 0)
	if hidden > 0 then
		width += (if count > 0 then CHIP_GAP else 0) + OVERFLOW_W
	end
	self.ordersRoot.Size = UDim2.fromOffset(math.max(width, 0), CHIP_H)

	for i = 1, count do
		local o = orders[i]
		local chip = self.chips[i]
		chip.id = o.id
		chip.frame.Position = UDim2.fromOffset((i - 1) * CHIP_PITCH, 0)
		setText(
			chip.label,
			string.format(
				"%s %s %.1f @ %s",
				if o.side == "buy" then "B" else "S",
				TYPE_ABBR[o.type] or o.type,
				o.qty,
				orderPrice(o)
			),
			if o.side == "buy" then Theme.up else Theme.down
		)
	end
	for k = count + 1, self.chipsShown do
		self.chips[k].frame.Visible = false
		self.chips[k].id = ""
	end
	for k = self.chipsShown + 1, count do
		self.chips[k].frame.Visible = true
	end
	self.chipsShown = count

	self.overflow.Visible = hidden > 0
	if hidden > 0 then
		self.overflow.Position = UDim2.fromOffset(count * CHIP_PITCH, 0)
		setText(self.overflow, string.format("+%d", hidden), Theme.textDim)
	end
end

-- ---------------------------------------------------------------------------

-- Mark-to-market against the newest revealed close. Split out of update() so a
-- bar packet can re-mark without a TradeState behind it.
function PositionBar.refresh(self: PositionBar)
	local qty = self.qty
	local last = if qty ~= 0 then self.getLastClose() else nil
	if qty == 0 or last == nil then
		setText(self.unreal, "unrl -", Theme.textDim)
		return
	end
	local usd = ContractMath.ptsToUsd((last - self.avgPrice) * qty, 1)
	setText(self.unreal, "unrl " .. ContractMath.fmtUsd(usd), pnlColor(usd))
end

function PositionBar.update(self: PositionBar, state: Protocol.TradeState)
	local qty = state.position.qty
	self.qty = qty
	self.avgPrice = state.position.avgPrice
	-- Flatten is meaningless flat, and an always-visible one invites a stray
	-- click that cancels every working order for nothing.
	self.flattenBtn.Visible = qty ~= 0
	if qty == 0 then
		setText(self.posChip, "  flat", Theme.textDim)
	else
		local sign = if qty > 0 then "+" else ""
		setText(
			self.posChip,
			string.format("  %s%.1f @ %.2f", sign, qty, state.position.avgPrice),
			if qty > 0 then Theme.up else Theme.down
		)
	end
	self:refresh()

	local usd = state.realizedUsd
	setText(self.realized, "real " .. ContractMath.fmtUsd(usd), pnlColor(usd))
	-- A balance is a level, not a delta: it carries no leading sign, which is
	-- why it does not go through fmtUsd.
	setText(self.balance, string.format("bal $%.2f", state.startingBalance + usd), Theme.text)
	setText(self.tradeCount, string.format("trades %d", #state.trades), Theme.textDim)
	-- Voided trades only exist after a rewind; a permanent "voided 0" would read
	-- as a warning that never goes away.
	self.voided.Visible = state.voidedCount > 0
	if state.voidedCount > 0 then
		setText(self.voided, string.format("voided %d", state.voidedCount), Theme.accent)
	end

	self.orders = state.workingOrders
	relayoutOrders(self)
end

function PositionBar.new(gui: ScreenGui, cbs: Callbacks): PositionBar
	local bar = Instance.new("Frame")
	bar.Name = "PositionBar"
	bar.BorderSizePixel = 0
	bar.BackgroundColor3 = Theme.bg
	bar.AnchorPoint = Vector2.new(0, 1)
	bar.Position = UDim2.new(0, 0, 1, -Theme.controlBarHeight)
	bar.Size = UDim2.new(1, 0, 0, Theme.positionBarHeight)
	bar.ZIndex = 1
	bar.Parent = gui

	local x = PAD
	local posChip = newChip(bar, x, 130, true)
	x += 130 + GAP
	local unreal = newChip(bar, x, 124, false)
	x += 124 + GAP
	local realized = newChip(bar, x, 124, false)
	x += 124 + GAP
	local balance = newChip(bar, x, 116, false)
	x += 116 + GAP
	local tradeCount = newChip(bar, x, 74, false)
	x += 74 + GAP
	-- The voided slot is reserved even while empty: letting it collapse would
	-- shuffle the two buttons sideways the first time a rewind voids a trade.
	local voided = newChip(bar, x, 74, false)
	x += 74 + GAP

	local logBtn = newButton(bar, "trade log", x, 76)
	x += 76 + PAD
	local flattenBtn = newButton(bar, "flatten", x, 64)
	flattenBtn.BackgroundColor3 = Theme.down
	flattenBtn.TextColor3 = Theme.bg
	flattenBtn.Visible = false
	x += 64

	local ordersRoot = Instance.new("Frame")
	ordersRoot.Name = "WorkingOrders"
	ordersRoot.BorderSizePixel = 0
	ordersRoot.BackgroundTransparency = 1
	ordersRoot.AnchorPoint = Vector2.new(1, 0.5)
	ordersRoot.Position = UDim2.new(1, -PAD, 0.5, 0)
	ordersRoot.Size = UDim2.fromOffset(0, CHIP_H)
	ordersRoot.Parent = bar

	local overflow = Instance.new("TextLabel")
	overflow.Name = "Overflow"
	overflow.BackgroundTransparency = 1
	overflow.BorderSizePixel = 0
	overflow.Size = UDim2.fromOffset(OVERFLOW_W, CHIP_H)
	overflow.Font = Theme.fontMono
	overflow.TextSize = Theme.textSm
	overflow.TextColor3 = Theme.textDim
	overflow.TextXAlignment = Enum.TextXAlignment.Left
	overflow.Text = ""
	overflow.Visible = false
	overflow.Parent = ordersRoot

	local self: PositionBar = setmetatable(
		{
			send = cbs.send,
			getLastClose = cbs.getLastClose,
			bar = bar,
			posChip = posChip,
			unreal = unreal,
			realized = realized,
			balance = balance,
			tradeCount = tradeCount,
			voided = voided,
			flattenBtn = flattenBtn,
			ordersRoot = ordersRoot,
			chips = {},
			chipsShown = 0,
			overflow = overflow,
			orders = {},
			qty = 0,
			avgPrice = 0,
			leftEnd = x,
		} :: Fields,
		PositionBar
	)

	setText(posChip, "  flat", Theme.textDim)
	setText(unreal, "unrl -", Theme.textDim)
	setText(realized, "real " .. ContractMath.fmtUsd(0), Theme.textDim)
	setText(balance, "bal $0.00", Theme.textDim)
	setText(tradeCount, "trades 0", Theme.textDim)
	voided.Visible = false

	logBtn.Activated:Connect(function()
		cbs.toggleLog()
	end)
	flattenBtn.Activated:Connect(function()
		cbs.send({ cmd = "flatten" })
	end)
	-- How many chips fit is a function of the window width, so the strip has to
	-- re-lay itself on a resize rather than waiting for the next TradeState.
	bar:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
		relayoutOrders(self)
	end)

	return self
end

return PositionBar

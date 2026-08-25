--!strict
-- Working orders and the open position, drawn in the chart's own space: one
-- horizontal line, a right-edge chip in the plot and a chip in the price axis
-- each, above the candles by ZIndex.
--
-- Line styling mirrors the web chart (ReplayChart.tsx:317-367): a WORKING
-- order is dashed because it is an intention, the open position is solid
-- because it is a fact.
--
-- The layer NEVER derives anything. Prices come from the server's TradeState;
-- the only price this module invents is the live drag preview, and that one is
-- thrown away the moment the server answers the modifyOrder it produced.
--
-- Pooling and repaint discipline mirror ChartView's: every Instance exists
-- before it is needed, a repaint only writes Position/Visible/Color/Text, and
-- .Text is written only when the formatted value differs.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local ContractMath = require(Shared:WaitForChild("Trading"):WaitForChild("ContractMath"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))

local Client = script.Parent.Parent
local ChartViewModule = require(Client:WaitForChild("Chart"):WaitForChild("ChartView"))
local DashLineModule = require(script.Parent:WaitForChild("DashLine"))
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type ChartView = ChartViewModule.ChartView
type DashLine = DashLineModule.DashLine
type Send = ({ [string]: any }) -> ()

-- Working orders are a handful in practice; the cap only bounds a hostile or
-- runaway state, and the pool never grows during a repaint past it.
local SLOT_POOL_INITIAL = 8
local SLOT_POOL_MAX = 24

local CHIP_W = 176
local CHIP_H = 16
local CHIP_INSET = 2 -- gap between the chip and the plot's right edge
local CANCEL_W = 15
local AXIS_CHIP_H = 14

-- Dash geometry for the working-order lines. The pool cap is the one number
-- that matters for the ScreenGui's instance budget: SLOT_POOL_MAX lines times
-- this. Past the cap DashLine stretches the period instead of allocating, so a
-- very wide plot costs a sparser pattern rather than Frames.
local DASH_LEN = 5
local DASH_PERIOD = 10
local DASH_POOL_MAX = 160

local GHOST_W = 96

local Z_LINE = 6
local Z_CHIP = 7
local Z_CANCEL = 8
local Z_GHOST = 9
-- ChartView documents the price-axis stacking; order chips sit above the tick
-- labels and below the last-price and crosshair readouts.
local Z_AXIS_CHIP = 3

local TYPE_ABBR: { [string]: string } = { market = "MKT", limit = "LMT", stop = "STP" }
-- The axis strip is ~62px: the plot chip's abbreviations do not fit next to a
-- side and a quantity, so the axis gets the web chart's shorter titles.
local AXIS_TYPE_ABBR: { [string]: string } = { market = "mkt", limit = "lim", stop = "stp" }

type Slot = {
	line: DashLine,
	chip: TextButton,
	cancel: TextButton,
	axisChip: TextLabel,
	-- nil while the slot is parked: a click landing on a hidden chip must not
	-- cancel whatever order used to live here
	id: string?,
	otype: string,
	price: number,
}

local OrderLayer = {}
OrderLayer.__index = OrderLayer

type Fields = {
	chart: ChartView,
	send: Send,
	tickSize: number,
	state: Protocol.TradeState?,

	slots: { Slot },
	used: number,
	posLine: Frame,
	posChip: TextButton,
	posAxisChip: TextLabel,
	-- follow-cursor readout of the live, tick-rounded drag price
	ghost: TextLabel,

	-- The dragged order's price overrides the server's from the first drag pixel
	-- until the TradeState that answers the modifyOrder lands. Without the tail
	-- of that window the line snaps back to its old level for one round trip,
	-- which reads as a dropped command.
	overrideId: string?,
	overrideType: string,
	overridePrice: number,
	dragging: boolean,
	-- the level the drag started from; a click that never moved the line must
	-- not spend a command re-sending the price the order already has
	dragStartPrice: number,
}

export type OrderLayer = typeof(setmetatable({} :: Fields, OrderLayer))

-- ---------------------------------------------------------------------------
-- instance construction (startup / one-off pool growth only)
-- ---------------------------------------------------------------------------

-- Solid: only the open position uses this one.
local function newLine(parent: Instance): Frame
	local f = Instance.new("Frame")
	f.Name = "OrderLine"
	f.BorderSizePixel = 0
	f.BackgroundColor3 = Theme.pos
	f.AnchorPoint = Vector2.new(0, 0.5)
	f.Size = UDim2.new(1, 0, 0, 1)
	f.ZIndex = Z_LINE
	f.Visible = false
	f.Parent = parent
	return f
end

local function newDashLine(parent: Frame): DashLine
	local line = DashLineModule.new({
		parent = parent,
		name = "OrderLine",
		vertical = false,
		color = Theme.accent,
		zIndex = Z_LINE,
		dashLen = DASH_LEN,
		period = DASH_PERIOD,
		poolMax = DASH_POOL_MAX,
	})
	line:getContainer().AnchorPoint = Vector2.new(0, 0.5)
	line:layout(parent.AbsoluteSize.X)
	return line
end

-- The price-axis counterpart of the plot chip: the level's identity, printed
-- where the eye already reads prices. Colored by its line, so its type has to
-- be white against every one of those grounds.
local function newAxisChip(parent: Instance): TextLabel
	local l = Instance.new("TextLabel")
	l.Name = "OrderAxisChip"
	l.BorderSizePixel = 0
	l.AnchorPoint = Vector2.new(0, 0.5)
	l.Size = UDim2.new(1, 0, 0, AXIS_CHIP_H)
	l.BackgroundColor3 = Theme.accent
	l.Font = Theme.fontMono
	l.TextSize = Theme.textSm
	l.TextColor3 = Theme.chipText
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextTruncate = Enum.TextTruncate.AtEnd
	l.Text = ""
	l.ZIndex = Z_AXIS_CHIP
	l.Visible = false
	l.Parent = parent
	local pad = Instance.new("UIPadding")
	pad.PaddingLeft = UDim.new(0, 4)
	pad.PaddingRight = UDim.new(0, 2)
	pad.Parent = l
	return l
end

local function newChip(parent: Instance): TextButton
	local b = Instance.new("TextButton")
	b.Name = "OrderChip"
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	b.AnchorPoint = Vector2.new(1, 0.5)
	b.Size = UDim2.fromOffset(CHIP_W, CHIP_H)
	b.BackgroundColor3 = Theme.panel
	-- a drag re-prices this chip every frame: fixed advance or the level jitters
	b.Font = Theme.fontMono
	b.TextSize = Theme.textSm
	b.TextXAlignment = Enum.TextXAlignment.Left
	b.TextTruncate = Enum.TextTruncate.AtEnd
	b.Text = ""
	b.ZIndex = Z_CHIP
	b.Visible = false
	b.Parent = parent
	return b
end

local function newCancel(chip: TextButton): TextButton
	local b = Instance.new("TextButton")
	b.Name = "Cancel"
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	b.AnchorPoint = Vector2.new(1, 0.5)
	b.Position = UDim2.new(1, -1, 0.5, 0)
	b.Size = UDim2.fromOffset(CANCEL_W, CHIP_H - 2)
	b.BackgroundTransparency = 1
	b.Font = Theme.fontUiMedium
	b.TextSize = Theme.textSm
	b.TextColor3 = Theme.textDim
	b.Text = "x"
	b.ZIndex = Z_CANCEL
	b.Parent = chip
	return b
end

local function makeSlot(self: OrderLayer, plot: Frame, axis: Frame): Slot
	local chip = newChip(plot)
	local slot: Slot = {
		line = newDashLine(plot),
		chip = chip,
		cancel = newCancel(chip),
		axisChip = newAxisChip(axis),
		id = nil,
		otype = "limit",
		price = 0,
	}
	-- Connected once at construction and read through `slot`, so a recycled
	-- slot never fires against the order it used to hold.
	chip.InputBegan:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			self:beginDrag(slot)
		end
	end)
	slot.cancel.Activated:Connect(function()
		local id = slot.id
		if id ~= nil then
			self.send({ cmd = "cancelOrder", orderId = id })
		end
	end)
	return slot
end

local function ensureSlots(self: OrderLayer, want: number)
	local plot = self.chart:getPlot()
	local axis = self.chart:getPriceAxis()
	for _ = #self.slots + 1, math.min(want, SLOT_POOL_MAX) do
		table.insert(self.slots, makeSlot(self, plot, axis))
	end
end

-- ---------------------------------------------------------------------------

-- The reduce-only legs take the SL/TP colors so a bracket reads as a stop and
-- a target at a glance; an ENTRY gets its own per-side pair, because an entry
-- painted in exit colors is the single most misreadable line on the chart.
local function orderColor(o: Protocol.WorkingOrderView): Color3
	if o.reduceOnly then
		return if o.type == "stop" then Theme.down else Theme.up
	end
	return if o.side == "buy" then Theme.entryBuy else Theme.entrySell
end

-- Axis titles, straight from the web chart: "SL 1" / "TP 1" / "B lim 1".
local function axisTitle(o: Protocol.WorkingOrderView): string
	if o.reduceOnly then
		return string.format("%s %g", if o.type == "stop" then "SL" else "TP", o.qty)
	end
	return string.format("%s %s %g", if o.side == "buy" then "B" else "S", AXIS_TYPE_ABBR[o.type] or "?", o.qty)
end

-- Two of these because Luau cannot WRITE through a `TextButton | TextLabel`
-- union, and .Text is the one property that must never be written unchanged:
-- a text re-layout costs far more than the comparison.
local function setText(button: TextButton, text: string)
	if button.Text ~= text then
		button.Text = text
	end
end

local function setLabelText(label: TextLabel, text: string)
	if label.Text ~= text then
		label.Text = text
	end
end

local function hideSlot(slot: Slot)
	slot.id = nil
	slot.line:setVisible(false)
	slot.chip.Visible = false
	slot.axisChip.Visible = false
end

-- A chip is only meaningful where its line is: outside the painted price range
-- it would pile up at an edge and read as a level that is actually off-screen.
-- The price axis and the plot share an origin and a height, so one y serves
-- both.
local function place(chip: TextButton, axisChip: TextLabel, y: number, inRange: boolean)
	chip.Visible = inRange
	axisChip.Visible = inRange
	if not inRange then
		return
	end
	chip.Position = UDim2.new(1, -CHIP_INSET, 0, y)
	axisChip.Position = UDim2.new(0, 0, 0, y)
end

function OrderLayer.setTickSize(self: OrderLayer, tickSize: number)
	self.tickSize = tickSize
end

function OrderLayer.setState(self: OrderLayer, state: Protocol.TradeState)
	self.state = state
	if not self.dragging then
		self.overrideId = nil
	end
	self:refresh()
end

function OrderLayer.refresh(self: OrderLayer)
	local plot = self.chart:getPlot()
	local plotW = plot.AbsoluteSize.X
	local plotH = plot.AbsoluteSize.Y
	local pMin, pMax = self.chart:getPriceRange()
	local state = self.state
	local used = 0

	if state ~= nil and plotH >= 1 then
		for _, o in ipairs(state.workingOrders) do
			local price = if o.type == "limit" then o.limitPrice else o.stopPrice
			-- a resting market order has no level to draw
			if price == nil then
				continue
			end
			if used >= SLOT_POOL_MAX then
				break
			end
			used += 1
			ensureSlots(self, used)
			local slot = self.slots[used]
			if self.overrideId == o.id then
				price = self.overridePrice
			end
			slot.id = o.id
			slot.otype = o.type
			slot.price = price

			-- no-op unless the plot actually resized; a repaint follows every
			-- resize, so this is the only place the dashes need re-cutting
			slot.line:layout(plotW)
			local color = orderColor(o)
			slot.line:setColor(color)
			slot.chip.TextColor3 = color
			if slot.axisChip.BackgroundColor3 ~= color then
				slot.axisChip.BackgroundColor3 = color
			end
			setText(
				slot.chip,
				string.format(
					" %s %s %.1f @ %.2f",
					TYPE_ABBR[o.type] or "?",
					if o.side == "buy" then "B" else "S",
					o.qty,
					price
				)
			)
			setLabelText(slot.axisChip, axisTitle(o))
			local y = math.round(self.chart:priceToY(price))
			local inRange = price >= pMin and price <= pMax
			slot.line:setVisible(inRange)
			if inRange then
				slot.line:setPosition(UDim2.new(0, 0, 0, y))
			end
			place(slot.chip, slot.axisChip, y, inRange)
		end
	end
	for k = used + 1, self.used do
		hideSlot(self.slots[k])
	end
	self.used = used

	local qty = if state ~= nil then state.position.qty else 0
	if qty == 0 or plotH < 1 then
		self.posLine.Visible = false
		self.posChip.Visible = false
		self.posAxisChip.Visible = false
		return
	end
	local avg = (state :: Protocol.TradeState).position.avgPrice
	setText(self.posChip, string.format(" %s %.1f @ %.2f", if qty > 0 then "LONG" else "SHORT", math.abs(qty), avg))
	setLabelText(self.posAxisChip, string.format("POS %s%g", if qty > 0 then "+" else "", qty))
	local y = math.round(self.chart:priceToY(avg))
	local inRange = avg >= pMin and avg <= pMax
	self.posLine.Visible = inRange
	if inRange then
		self.posLine.Position = UDim2.new(0, 0, 0, y)
	end
	place(self.posChip, self.posAxisChip, y, inRange)
end

-- ------------------------------------------------------------------- drag

function OrderLayer.beginDrag(self: OrderLayer, slot: Slot)
	local id = slot.id
	if id == nil then
		return
	end
	self.overrideId = id
	self.overrideType = slot.otype
	self.overridePrice = slot.price
	self.dragStartPrice = slot.price
	self.dragging = true
	self.chart:setPanLocked(true)
	self:moveGhost()
end

-- Follow-cursor readout of the price the release would commit. The line itself
-- already sits at that level, but it runs the full width of the plot: the
-- number has to be where the eye is, which is the cursor.
function OrderLayer.moveGhost(self: OrderLayer)
	if not self.dragging then
		self.ghost.Visible = false
		return
	end
	local size = self.chart:getPlot().AbsoluteSize
	local m = self.chart:mouseToPlot()
	setLabelText(self.ghost, string.format("-> %.2f", self.overridePrice))
	self.ghost.Position = UDim2.fromOffset(
		math.clamp(math.round(m.X) + 14, 0, math.max(0, math.round(size.X) - GHOST_W)),
		math.clamp(math.round(m.Y), 0, math.round(size.Y))
	)
	self.ghost.Visible = true
end

-- Plot-local pixels come from the chart, which owns the one mouse -> plot
-- conversion (the topbar inset makes GetMouseLocation and AbsolutePosition
-- different spaces — see ChartView.mouseLocation).
local function dragPriceAt(self: OrderLayer): number
	local plot = self.chart:getPlot()
	local y = math.clamp(self.chart:mouseToPlot().Y, 0, plot.AbsoluteSize.Y)
	return ContractMath.roundToTick(self.chart:yToPrice(y), self.tickSize)
end

local function wireDrag(self: OrderLayer)
	-- Tracking is global: the cursor leaves the chip on the first pixel of the
	-- drag, and routinely leaves the plot entirely.
	UserInputService.InputChanged:Connect(function(input: InputObject)
		if not self.dragging or input.UserInputType ~= Enum.UserInputType.MouseMovement then
			return
		end
		self.overridePrice = dragPriceAt(self)
		self:refresh()
		self:moveGhost()
	end)
	UserInputService.InputEnded:Connect(function(input: InputObject)
		if not self.dragging or input.UserInputType ~= Enum.UserInputType.MouseButton1 then
			return
		end
		local id = self.overrideId
		self.dragging = false
		self.ghost.Visible = false
		self.chart:setPanLocked(false)
		if id == nil or self.overridePrice == self.dragStartPrice then
			self.overrideId = nil
			return
		end
		local changes: { limitPrice: number?, stopPrice: number? } = {}
		if self.overrideType == "limit" then
			changes.limitPrice = self.overridePrice
		else
			changes.stopPrice = self.overridePrice
		end
		self.send({ cmd = "modifyOrder", orderId = id, changes = changes })
	end)
end

function OrderLayer.new(chart: ChartView, send: Send, tickSize: number): OrderLayer
	local plot = chart:getPlot()
	local axis = chart:getPriceAxis()

	-- The position is a FACT, so its line is solid where the working orders'
	-- are dashed.
	local posLine = newLine(plot)
	posLine.Name = "PositionLine"
	local posChip = newChip(plot)
	posChip.Name = "PositionChip"
	posChip.TextColor3 = Theme.pos
	local posAxisChip = newAxisChip(axis)
	posAxisChip.Name = "PositionAxisChip"
	posAxisChip.BackgroundColor3 = Theme.pos

	local ghost = Instance.new("TextLabel")
	ghost.Name = "DragGhost"
	ghost.BorderSizePixel = 0
	ghost.AnchorPoint = Vector2.new(0, 0.5)
	ghost.Size = UDim2.fromOffset(GHOST_W, CHIP_H)
	ghost.BackgroundColor3 = Theme.panel
	ghost.Font = Theme.fontMono
	ghost.TextSize = Theme.textSm
	ghost.TextColor3 = Theme.text
	ghost.TextXAlignment = Enum.TextXAlignment.Center
	ghost.Text = ""
	ghost.ZIndex = Z_GHOST
	ghost.Visible = false
	ghost.Parent = plot

	local self: OrderLayer = setmetatable(
		{
			chart = chart,
			send = send,
			tickSize = tickSize,
			state = nil,
			slots = {},
			used = 0,
			posLine = posLine,
			posChip = posChip,
			posAxisChip = posAxisChip,
			ghost = ghost,
			overrideId = nil,
			overrideType = "limit",
			overridePrice = 0,
			dragging = false,
			dragStartPrice = 0,
		} :: Fields,
		OrderLayer
	)

	ensureSlots(self, SLOT_POOL_INITIAL)
	wireDrag(self)
	chart:onRepaint(function()
		self:refresh()
	end)

	return self
end

return OrderLayer

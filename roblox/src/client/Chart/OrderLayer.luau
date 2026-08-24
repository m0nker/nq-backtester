--!strict
-- Working orders and the open position, drawn in the chart's own space: one
-- horizontal line plus a right-edge chip each, above the candles by ZIndex.
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
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type ChartView = ChartViewModule.ChartView
type Send = ({ [string]: any }) -> ()

-- Working orders are a handful in practice; the cap only bounds a hostile or
-- runaway state, and the pool never grows during a repaint past it.
local SLOT_POOL_INITIAL = 8
local SLOT_POOL_MAX = 24

local CHIP_W = 176
local CHIP_H = 16
local CHIP_INSET = 2 -- gap between the chip and the plot's right edge
local CANCEL_W = 15

local Z_LINE = 6
local Z_CHIP = 7
local Z_CANCEL = 8

local TYPE_ABBR: { [string]: string } = { market = "MKT", limit = "LMT", stop = "STP" }

type Slot = {
	line: Frame,
	chip: TextButton,
	cancel: TextButton,
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

local function newLine(parent: Instance): Frame
	local f = Instance.new("Frame")
	f.Name = "OrderLine"
	f.BorderSizePixel = 0
	f.BackgroundColor3 = Theme.accent
	f.AnchorPoint = Vector2.new(0, 0.5)
	f.Size = UDim2.new(1, 0, 0, 1)
	f.ZIndex = Z_LINE
	f.Visible = false
	f.Parent = parent
	return f
end

local function newChip(parent: Instance): TextButton
	local b = Instance.new("TextButton")
	b.Name = "OrderChip"
	b.BorderSizePixel = 0
	b.AutoButtonColor = false
	b.AnchorPoint = Vector2.new(1, 0.5)
	b.Size = UDim2.fromOffset(CHIP_W, CHIP_H)
	b.BackgroundColor3 = Theme.panel
	b.Font = Enum.Font.Code
	b.TextSize = 12
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
	b.Font = Enum.Font.Code
	b.TextSize = 12
	b.TextColor3 = Theme.textDim
	b.Text = "x"
	b.ZIndex = Z_CANCEL
	b.Parent = chip
	return b
end

local function makeSlot(self: OrderLayer, plot: Frame): Slot
	local chip = newChip(plot)
	local slot: Slot = {
		line = newLine(plot),
		chip = chip,
		cancel = newCancel(chip),
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
	for _ = #self.slots + 1, math.min(want, SLOT_POOL_MAX) do
		table.insert(self.slots, makeSlot(self, plot))
	end
end

-- ---------------------------------------------------------------------------

-- Entries are the amber "my intent" color; the reduce-only legs take the SL/TP
-- colors so a bracket reads as a stop and a target at a glance.
local function orderColor(o: Protocol.WorkingOrderView): Color3
	if o.reduceOnly then
		return if o.type == "stop" then Theme.down else Theme.up
	end
	return Theme.accent
end

local function setText(button: TextButton, text: string)
	if button.Text ~= text then
		button.Text = text
	end
end

local function hideSlot(slot: Slot)
	slot.id = nil
	slot.line.Visible = false
	slot.chip.Visible = false
end

-- A chip is only meaningful where its line is: outside the painted price range
-- it would pile up at an edge and read as a level that is actually off-screen.
local function place(line: Frame, chip: TextButton, y: number, inRange: boolean)
	line.Visible = inRange
	chip.Visible = inRange
	if not inRange then
		return
	end
	line.Position = UDim2.new(0, 0, 0, y)
	chip.Position = UDim2.new(1, -CHIP_INSET, 0, y)
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

			local color = orderColor(o)
			slot.line.BackgroundColor3 = color
			slot.chip.TextColor3 = color
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
			place(slot.line, slot.chip, math.round(self.chart:priceToY(price)), price >= pMin and price <= pMax)
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
		return
	end
	local avg = (state :: Protocol.TradeState).position.avgPrice
	setText(self.posChip, string.format(" %s %.1f @ %.2f", if qty > 0 then "LONG" else "SHORT", math.abs(qty), avg))
	place(self.posLine, self.posChip, math.round(self.chart:priceToY(avg)), avg >= pMin and avg <= pMax)
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
end

-- The chart ScreenGui sets IgnoreGuiInset, so GetMouseLocation and the plot's
-- AbsolutePosition share a coordinate space (same reasoning as ChartView).
local function dragPriceAt(self: OrderLayer): number
	local plot = self.chart:getPlot()
	local y = math.clamp(UserInputService:GetMouseLocation().Y - plot.AbsolutePosition.Y, 0, plot.AbsoluteSize.Y)
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
	end)
	UserInputService.InputEnded:Connect(function(input: InputObject)
		if not self.dragging or input.UserInputType ~= Enum.UserInputType.MouseButton1 then
			return
		end
		local id = self.overrideId
		self.dragging = false
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

	local posLine = newLine(plot)
	posLine.Name = "PositionLine"
	posLine.BackgroundColor3 = Theme.text
	local posChip = newChip(plot)
	posChip.Name = "PositionChip"
	posChip.TextColor3 = Theme.text

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

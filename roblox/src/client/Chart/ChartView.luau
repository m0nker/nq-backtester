--!strict
-- Pooled-Frame candlestick renderer (PORT_PLAN: pooled Frames, NOT
-- EditableImage). Every Instance this module will ever need is created at
-- construction or on a one-off pool growth; a repaint only writes Position /
-- Size / Visible / BackgroundColor3 on existing Frames.
--
-- Hard constraints, all of them load-bearing for frame time:
--   - the chart owns its OWN ScreenGui; LayerCollector invalidation is
--     per-ScreenGui and this one is dirtied every frame the view moves.
--   - no UIListLayout / UIGridLayout / CanvasGroup anywhere in the plot: they
--     re-measure the whole container whenever a child moves.
--   - exactly one repaint per RenderStepped, and only when something actually
--     changed (data, pan, zoom, resize).
--   - axis label .Text is written only when the formatted value differs;
--     text re-layout is far more expensive than a Position write.
--
-- The crosshair does NOT go through the repaint path: it moves two Frames and
-- two labels directly on mouse move, so tracking stays smooth while paused.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Et = require(Shared:WaitForChild("Time"):WaitForChild("Et"))
local Types = require(Shared:WaitForChild("Types"))

local Client = script.Parent.Parent
local BarCacheModule = require(Client:WaitForChild("State"):WaitForChild("BarCache"))
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Bar = Types.Bar
type BarCache = BarCacheModule.BarCache

local CANDLE_POOL_INITIAL = 350
-- Hard ceiling on simultaneously drawn candles. The zoom clamp below is
-- derived from it, so the pool never has to grow during a repaint.
local CANDLE_POOL_MAX = 700
local PRICE_LABELS = 9
local TIME_LABELS = 8
local PRICE_AXIS_W = 62
local TIME_AXIS_H = 20
local MIN_BAR_W = 2
local MAX_BAR_W = 40
local ZOOM_FACTOR = 1.15
-- empty candle slots kept between the newest candle and the right edge, so
-- price has somewhere to go (mirrors the web chart's rightOffset of 6)
local TAIL_PAD = 6
local DRAG_THRESHOLD = 5
local BODY_WIDTH_FRACTION = 0.7

-- Axis steps come from the 1 / 2 / 2.5 / 5 x 10^k ladder.
local STEP_MULTIPLIERS: { number } = { 1, 2, 2.5, 5, 10 }

-- Time-axis steps, coarsest last. Every intraday entry divides an hour or is a
-- whole number of hours, so labels land on round ET wall-clock times (the ET
-- offset is always a whole number of hours).
local TIME_STEPS: { number } = {
	60,
	300,
	900,
	1800,
	3600,
	4 * 3600,
	12 * 3600,
	86400,
	7 * 86400,
	30 * 86400,
	90 * 86400,
	365 * 86400,
}

type CandleSlot = { wick: Frame, body: Frame }

local ChartView = {}
ChartView.__index = ChartView

type Fields = {
	cache: BarCache,
	gui: ScreenGui,
	plot: Frame,
	priceAxis: Frame,
	timeAxis: Frame,
	snapBtn: TextButton,

	slots: { CandleSlot },
	hLines: { Frame },
	vLines: { Frame },
	priceLabels: { TextLabel },
	timeLabels: { TextLabel },
	priceText: { string },
	timeText: { string },

	crossV: Frame,
	crossH: Frame,
	crossPrice: TextLabel,
	crossTime: TextLabel,

	-- viewport
	barWidthPx: number,
	rightIndex: number, -- fractional candle index sitting at the plot's right edge
	followTail: boolean,

	-- delta bookkeeping: only the slots crossing the used/unused boundary get a
	-- .Visible write
	drawn: number,
	priceShown: number,
	timeShown: number,

	-- last painted scale; the crosshair maps pixels back through it between
	-- repaints
	priceMin: number,
	priceMax: number,

	dirty: boolean,
	dragging: boolean,
	dragMoved: boolean,
	dragStartX: number,
	dragStartRight: number,
}

export type ChartView = typeof(setmetatable({} :: Fields, ChartView))

-- ---------------------------------------------------------------------------
-- pixel <-> data mappings. Each pair is an exact inverse for barWidthPx > 0 /
-- priceMax > priceMin, which is what keeps cursor-anchored zoom and the
-- crosshair readout from drifting.
-- ---------------------------------------------------------------------------

-- x is the pixel column of candle `index`'s CENTRE; `rightIndex` sits exactly
-- at the plot's right edge (x = plotW).
local function indexToX(index: number, rightIndex: number, barWidthPx: number, plotW: number): number
	return plotW - (rightIndex - index) * barWidthPx
end

local function xToIndex(x: number, rightIndex: number, barWidthPx: number, plotW: number): number
	return rightIndex - (plotW - x) / barWidthPx
end

-- y = 0 is priceMax at the plot's top edge, y = plotH is priceMin.
local function priceToY(price: number, pMin: number, pMax: number, plotH: number): number
	return (pMax - price) / (pMax - pMin) * plotH
end

local function yToPrice(y: number, pMin: number, pMax: number, plotH: number): number
	return pMax - (y / plotH) * (pMax - pMin)
end

local function niceStep(range: number, target: number): number
	if range <= 0 or target <= 0 then
		return 1
	end
	local raw = range / target
	local mag = 10 ^ math.floor(math.log(raw, 10))
	local norm = raw / mag
	for _, mult in ipairs(STEP_MULTIPLIERS) do
		if norm <= mult then
			return mult * mag
		end
	end
	return 10 * mag
end

local function priceDecimals(step: number): number
	if step >= 10 then
		return 0
	elseif step >= 1 then
		return 1
	elseif step >= 0.1 then
		return 2
	end
	return 3
end

-- ---------------------------------------------------------------------------
-- instance construction (startup only)
-- ---------------------------------------------------------------------------

local function newFrame(parent: Instance, name: string, color: Color3, z: number): Frame
	local f = Instance.new("Frame")
	f.Name = name
	f.BorderSizePixel = 0
	f.BackgroundColor3 = color
	f.ZIndex = z
	f.Parent = parent
	return f
end

local function newLabel(parent: Instance, name: string, z: number): TextLabel
	local l = Instance.new("TextLabel")
	l.Name = name
	l.BackgroundTransparency = 1
	l.BorderSizePixel = 0
	l.Font = Enum.Font.Code
	l.TextSize = 12
	l.TextColor3 = Theme.textDim
	l.Text = ""
	l.ZIndex = z
	l.Parent = parent
	return l
end

local function makeSlot(plot: Frame): CandleSlot
	local wick = newFrame(plot, "W", Theme.up, 2)
	wick.AnchorPoint = Vector2.new(0.5, 0)
	wick.Visible = false
	-- body above wick so a doji's body still reads over its own wick
	local body = newFrame(plot, "B", Theme.up, 3)
	body.AnchorPoint = Vector2.new(0.5, 0)
	body.Visible = false
	return { wick = wick, body = body }
end

-- Growth is amortized and capped, never per repaint: the pool only extends the
-- first time a zoom level needs more slots than it has.
local function ensureSlots(self: ChartView, want: number)
	local have = #self.slots
	local target = math.min(want, CANDLE_POOL_MAX)
	for _ = have + 1, target do
		table.insert(self.slots, makeSlot(self.plot))
	end
end

-- Smallest bar width the pool can cover at this plot width. -2 leaves slack for
-- the partially clipped candles at either edge.
local function minBarWidth(plotW: number): number
	return math.max(MIN_BAR_W, plotW / (CANDLE_POOL_MAX - 2))
end

-- ---------------------------------------------------------------------------

local function setFollowTail(self: ChartView, v: boolean)
	if self.followTail == v then
		return
	end
	self.followTail = v
	self.snapBtn.BackgroundColor3 = if v then Theme.accent else Theme.panel
	self.snapBtn.TextColor3 = if v then Theme.bg else Theme.text
end

-- Right-edge index while following the tail. The pad shrinks on a viewport too
-- narrow to hold it, so a fresh session (few candles, wide bars) can never end
-- up scrolled past every candle it has.
local function tailRightIndex(self: ChartView): number
	local slots = if self.barWidthPx > 0 then self.plot.AbsoluteSize.X / self.barWidthPx else 0
	return #self.cache:getCandles() + math.min(TAIL_PAD, slots * 0.5)
end

-- Mirrors the web chart's followTail: parking at the right edge re-arms it,
-- panning away from the tail disarms it.
local function syncFollowTail(self: ChartView)
	setFollowTail(self, self.rightIndex >= tailRightIndex(self) - 0.5)
end

function ChartView.snapToTail(self: ChartView)
	setFollowTail(self, true)
	self.dirty = true
end

function ChartView.markDirty(self: ChartView)
	self.dirty = true
end

function ChartView.repaint(self: ChartView)
	local plotW = self.plot.AbsoluteSize.X
	local plotH = self.plot.AbsoluteSize.Y
	if plotW < 1 or plotH < 1 then
		return
	end

	local candles = self.cache:getCandles()
	local n = #candles

	self.barWidthPx = math.clamp(self.barWidthPx, minBarWidth(plotW), MAX_BAR_W)
	local bw = self.barWidthPx
	if self.followTail then
		self.rightIndex = tailRightIndex(self)
	end
	local right = self.rightIndex

	local first = math.max(1, math.floor(xToIndex(0, right, bw, plotW)))
	local last = math.min(n, math.ceil(right))

	if last < first then
		self:hideAll()
		return
	end

	local lo, hi = math.huge, -math.huge
	for i = first, last do
		local c = candles[i]
		if c.l < lo then
			lo = c.l
		end
		if c.h > hi then
			hi = c.h
		end
	end
	-- 5% padding above and below; the floor keeps a flat range from collapsing
	-- the price scale to zero height
	local pad = math.max((hi - lo) * 0.05, 0.25)
	local pMin, pMax = lo - pad, hi + pad
	self.priceMin, self.priceMax = pMin, pMax

	ensureSlots(self, last - first + 1)

	local bodyW = math.max(1, math.round(bw * BODY_WIDTH_FRACTION))
	local used = 0
	for i = first, last do
		local slot = self.slots[used + 1]
		if slot == nil then
			break
		end
		used += 1
		local c = candles[i]
		local up = c.c >= c.o
		local color = if up then Theme.up else Theme.down
		local x = math.round(indexToX(i, right, bw, plotW))
		local yHigh = math.round(priceToY(c.h, pMin, pMax, plotH))
		local yLow = math.round(priceToY(c.l, pMin, pMax, plotH))
		local yTop = math.round(priceToY(if up then c.c else c.o, pMin, pMax, plotH))
		local yBot = math.round(priceToY(if up then c.o else c.c, pMin, pMax, plotH))

		local wick = slot.wick
		wick.BackgroundColor3 = color
		wick.Position = UDim2.fromOffset(x, yHigh)
		wick.Size = UDim2.fromOffset(1, math.max(1, yLow - yHigh))

		local body = slot.body
		body.BackgroundColor3 = color
		body.Position = UDim2.fromOffset(x, yTop)
		body.Size = UDim2.fromOffset(bodyW, math.max(1, yBot - yTop))
	end
	for k = used + 1, self.drawn do
		self.slots[k].wick.Visible = false
		self.slots[k].body.Visible = false
	end
	for k = self.drawn + 1, used do
		self.slots[k].wick.Visible = true
		self.slots[k].body.Visible = true
	end
	self.drawn = used

	self:paintPriceAxis(plotH)
	self:paintTimeAxis(candles, first, last, right, bw, plotW)
end

function ChartView.paintPriceAxis(self: ChartView, plotH: number)
	local pMin, pMax = self.priceMin, self.priceMax
	local step = niceStep(pMax - pMin, PRICE_LABELS - 1)
	local fmt = "%." .. priceDecimals(step) .. "f"
	-- index arithmetic instead of accumulating `p += step`: float drift would
	-- otherwise make the labels wander off the round values
	local k0 = math.ceil(pMin / step)
	local shown = 0
	for j = 0, PRICE_LABELS - 1 do
		local price = (k0 + j) * step
		if price > pMax then
			break
		end
		shown += 1
		local y = math.round(priceToY(price, pMin, pMax, plotH))
		local label = self.priceLabels[shown]
		label.Position = UDim2.fromOffset(6, y - 7)
		local s = string.format(fmt, price)
		if self.priceText[shown] ~= s then
			self.priceText[shown] = s
			label.Text = s
		end
		self.hLines[shown].Position = UDim2.fromOffset(0, y)
	end
	for k = shown + 1, self.priceShown do
		self.priceLabels[k].Visible = false
		self.hLines[k].Visible = false
	end
	for k = self.priceShown + 1, shown do
		self.priceLabels[k].Visible = true
		self.hLines[k].Visible = true
	end
	self.priceShown = shown
end

function ChartView.paintTimeAxis(
	self: ChartView,
	candles: { Bar },
	first: number,
	last: number,
	right: number,
	bw: number,
	plotW: number
)
	local sessionTf = Types.isSessionTf(self.cache:getTimeframe())
	local span = candles[last].t - candles[first].t
	local stepSec = TIME_STEPS[#TIME_STEPS]
	for _, s in ipairs(TIME_STEPS) do
		if span / s <= TIME_LABELS then
			stepSec = s
			break
		end
	end

	local shown = 0
	local nextT = math.ceil(candles[first].t / stepSec) * stepSec
	local prevDate = ""
	for i = first, last do
		if shown >= TIME_LABELS then
			break
		end
		local t = candles[i].t
		if t >= nextT then
			shown += 1
			local x = math.round(indexToX(i, right, bw, plotW))
			local date = Et.tradingDateOf(t)
			local s: string
			if sessionTf or stepSec >= 86400 then
				s = date
			elseif date ~= prevDate then
				-- first candle of a new trading day: qualify the wall time
				s = string.sub(date, 6) .. " " .. Et.formatET(t, false)
			else
				s = Et.formatET(t, false)
			end
			prevDate = date

			local label = self.timeLabels[shown]
			label.Position = UDim2.fromOffset(x, 3)
			if self.timeText[shown] ~= s then
				self.timeText[shown] = s
				label.Text = s
			end
			self.vLines[shown].Position = UDim2.fromOffset(x, 0)
			-- the boundary AFTER the one this candle satisfied, so a gap in the
			-- data never emits two labels for the same step
			nextT = (math.floor(t / stepSec) + 1) * stepSec
		end
	end
	for k = shown + 1, self.timeShown do
		self.timeLabels[k].Visible = false
		self.vLines[k].Visible = false
	end
	for k = self.timeShown + 1, shown do
		self.timeLabels[k].Visible = true
		self.vLines[k].Visible = true
	end
	self.timeShown = shown
end

function ChartView.hideAll(self: ChartView)
	for k = 1, self.drawn do
		self.slots[k].wick.Visible = false
		self.slots[k].body.Visible = false
	end
	for k = 1, self.priceShown do
		self.priceLabels[k].Visible = false
		self.hLines[k].Visible = false
	end
	for k = 1, self.timeShown do
		self.timeLabels[k].Visible = false
		self.vLines[k].Visible = false
	end
	self.drawn, self.priceShown, self.timeShown = 0, 0, 0
end

function ChartView.setCrosshairVisible(self: ChartView, v: boolean)
	if self.crossV.Visible == v then
		return
	end
	self.crossV.Visible = v
	self.crossH.Visible = v
	self.crossPrice.Visible = v
	self.crossTime.Visible = v
end

-- `mouse` is in the ScreenGui's coordinate space (see mouseLocation below);
-- nil hides the crosshair.
function ChartView.updateCrosshair(self: ChartView, mouse: Vector2?)
	if mouse == nil then
		self:setCrosshairVisible(false)
		return
	end
	local origin = self.plot.AbsolutePosition
	local size = self.plot.AbsoluteSize
	local x = mouse.X - origin.X
	local y = mouse.Y - origin.Y
	if x < 0 or y < 0 or x > size.X or y > size.Y or size.X < 1 or size.Y < 1 then
		self:setCrosshairVisible(false)
		return
	end
	self:setCrosshairVisible(true)
	self.crossV.Position = UDim2.fromOffset(math.round(x), 0)
	self.crossH.Position = UDim2.fromOffset(0, math.round(y))

	local price = yToPrice(y, self.priceMin, self.priceMax, size.Y)
	local ps = string.format("%.2f", price)
	if self.crossPrice.Text ~= ps then
		self.crossPrice.Text = ps
	end
	self.crossPrice.Position = UDim2.fromOffset(0, math.round(y) - 8)

	local candles = self.cache:getCandles()
	local c = candles[math.round(xToIndex(x, self.rightIndex, self.barWidthPx, size.X))]
	local ts = if c ~= nil then string.sub(Et.tradingDateOf(c.t), 6) .. " " .. Et.formatET(c.t, false) else ""
	if self.crossTime.Text ~= ts then
		self.crossTime.Text = ts
	end
	self.crossTime.Position = UDim2.fromOffset(math.round(x), 2)
end

-- Zoom keeps the bar under the cursor pinned: solve indexToX(anchor, right')=x
-- for the new rightIndex after the width change.
function ChartView.zoomAt(self: ChartView, mouse: Vector2, delta: number)
	local size = self.plot.AbsoluteSize
	if size.X < 1 then
		return
	end
	local x = math.clamp(mouse.X - self.plot.AbsolutePosition.X, 0, size.X)
	local anchor = xToIndex(x, self.rightIndex, self.barWidthPx, size.X)
	local factor = if delta > 0 then ZOOM_FACTOR else 1 / ZOOM_FACTOR
	self.barWidthPx = math.clamp(self.barWidthPx * factor, minBarWidth(size.X), MAX_BAR_W)
	self.rightIndex = anchor + (size.X - x) / self.barWidthPx
	syncFollowTail(self)
	self.dirty = true
end

-- The chart ScreenGui sets IgnoreGuiInset, so its coordinate space is raw
-- screen space — exactly what GetMouseLocation reports. Input positions from
-- InputObject are measured below the topbar inset instead, so they are used
-- only for the event type and the wheel delta, never for coordinates.
local function mouseLocation(): Vector2
	return UserInputService:GetMouseLocation()
end

local function wireInput(self: ChartView)
	self.plot.InputChanged:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseWheel then
			self:zoomAt(mouseLocation(), input.Position.Z)
		elseif input.UserInputType == Enum.UserInputType.MouseMovement then
			self:updateCrosshair(mouseLocation())
		end
	end)
	self.plot.InputEnded:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseMovement then
			self:updateCrosshair(nil)
		end
	end)
	self.plot.InputBegan:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			self.dragging = true
			self.dragMoved = false
			self.dragStartX = mouseLocation().X
			self.dragStartRight = self.rightIndex
		end
	end)
	-- pan tracking is global: the cursor routinely leaves the plot mid-drag
	UserInputService.InputChanged:Connect(function(input: InputObject)
		if not self.dragging or input.UserInputType ~= Enum.UserInputType.MouseMovement then
			return
		end
		local dx = mouseLocation().X - self.dragStartX
		if not self.dragMoved and math.abs(dx) < DRAG_THRESHOLD then
			return
		end
		self.dragMoved = true
		-- dragging right pulls the tape right, which reveals older bars
		self.rightIndex = self.dragStartRight - dx / self.barWidthPx
		syncFollowTail(self)
		self.dirty = true
	end)
	UserInputService.InputEnded:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			self.dragging = false
		end
	end)
end

function ChartView.new(cache: BarCache): ChartView
	local player = Players.LocalPlayer :: Player
	local gui = Instance.new("ScreenGui")
	gui.Name = "BacktesterChart"
	gui.IgnoreGuiInset = true
	gui.ResetOnSpawn = false
	gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
	gui.DisplayOrder = 0
	gui.Parent = player:WaitForChild("PlayerGui")

	local root = newFrame(gui, "Root", Theme.bg, 0)
	root.Size = UDim2.new(1, 0, 1, -Theme.hudHeight)

	local plot = newFrame(root, "Plot", Theme.bg, 1)
	plot.Size = UDim2.new(1, -PRICE_AXIS_W, 1, -TIME_AXIS_H)
	plot.ClipsDescendants = true
	plot.Active = true

	local priceAxis = newFrame(root, "PriceAxis", Theme.bg, 1)
	priceAxis.AnchorPoint = Vector2.new(1, 0)
	priceAxis.Position = UDim2.fromScale(1, 0)
	priceAxis.Size = UDim2.new(0, PRICE_AXIS_W, 1, -TIME_AXIS_H)
	priceAxis.ClipsDescendants = true

	local timeAxis = newFrame(root, "TimeAxis", Theme.bg, 1)
	timeAxis.AnchorPoint = Vector2.new(0, 1)
	timeAxis.Position = UDim2.fromScale(0, 1)
	timeAxis.Size = UDim2.new(1, -PRICE_AXIS_W, 0, TIME_AXIS_H)
	timeAxis.ClipsDescendants = true

	local hLines: { Frame } = {}
	local priceLabels: { TextLabel } = {}
	for i = 1, PRICE_LABELS do
		local line = newFrame(plot, "H" .. i, Theme.grid, 1)
		line.Size = UDim2.new(1, 0, 0, 1)
		line.Visible = false
		hLines[i] = line
		local label = newLabel(priceAxis, "P" .. i, 2)
		label.Size = UDim2.fromOffset(PRICE_AXIS_W - 6, 14)
		label.TextXAlignment = Enum.TextXAlignment.Left
		label.Visible = false
		priceLabels[i] = label
	end

	local vLines: { Frame } = {}
	local timeLabels: { TextLabel } = {}
	for i = 1, TIME_LABELS do
		local line = newFrame(plot, "V" .. i, Theme.grid, 1)
		line.Size = UDim2.new(0, 1, 1, 0)
		line.Visible = false
		vLines[i] = line
		local label = newLabel(timeAxis, "T" .. i, 2)
		label.AnchorPoint = Vector2.new(0.5, 0)
		label.Size = UDim2.fromOffset(96, 14)
		label.TextXAlignment = Enum.TextXAlignment.Center
		label.Visible = false
		timeLabels[i] = label
	end

	local crossV = newFrame(plot, "CrossV", Theme.crosshair, 4)
	crossV.Size = UDim2.new(0, 1, 1, 0)
	crossV.Visible = false
	local crossH = newFrame(plot, "CrossH", Theme.crosshair, 4)
	crossH.Size = UDim2.new(1, 0, 0, 1)
	crossH.Visible = false

	local crossPrice = newLabel(priceAxis, "CrossPrice", 3)
	crossPrice.Size = UDim2.fromOffset(PRICE_AXIS_W, 16)
	crossPrice.BackgroundTransparency = 0
	crossPrice.BackgroundColor3 = Theme.border
	crossPrice.TextColor3 = Theme.text
	crossPrice.Visible = false
	local crossTime = newLabel(timeAxis, "CrossTime", 3)
	crossTime.AnchorPoint = Vector2.new(0.5, 0)
	crossTime.Size = UDim2.fromOffset(96, 16)
	crossTime.BackgroundTransparency = 0
	crossTime.BackgroundColor3 = Theme.border
	crossTime.TextColor3 = Theme.text
	crossTime.TextXAlignment = Enum.TextXAlignment.Center
	crossTime.Visible = false

	local snapBtn = Instance.new("TextButton")
	snapBtn.Name = "SnapToTail"
	snapBtn.BorderSizePixel = 0
	snapBtn.AnchorPoint = Vector2.new(1, 1)
	snapBtn.Position = UDim2.new(1, -PRICE_AXIS_W - 8, 1, -TIME_AXIS_H - 8)
	snapBtn.Size = UDim2.fromOffset(64, 24)
	snapBtn.BackgroundColor3 = Theme.accent
	snapBtn.TextColor3 = Theme.bg
	snapBtn.Font = Enum.Font.Code
	snapBtn.TextSize = 12
	snapBtn.Text = "follow"
	snapBtn.ZIndex = 5
	snapBtn.Parent = root

	local self: ChartView = setmetatable(
		{
			cache = cache,
			gui = gui,
			plot = plot,
			priceAxis = priceAxis,
			timeAxis = timeAxis,
			snapBtn = snapBtn,
			slots = {},
			hLines = hLines,
			vLines = vLines,
			priceLabels = priceLabels,
			timeLabels = timeLabels,
			priceText = {},
			timeText = {},
			crossV = crossV,
			crossH = crossH,
			crossPrice = crossPrice,
			crossTime = crossTime,
			barWidthPx = 8,
			rightIndex = TAIL_PAD,
			followTail = true,
			drawn = 0,
			priceShown = 0,
			timeShown = 0,
			priceMin = 0,
			priceMax = 1,
			dirty = true,
			dragging = false,
			dragMoved = false,
			dragStartX = 0,
			dragStartRight = 0,
		} :: Fields,
		ChartView
	)

	for _ = 1, CANDLE_POOL_INITIAL do
		table.insert(self.slots, makeSlot(plot))
	end

	snapBtn.Activated:Connect(function()
		self:snapToTail()
	end)
	cache:onChanged(function()
		self.dirty = true
	end)
	plot:GetPropertyChangedSignal("AbsoluteSize"):Connect(function()
		self.dirty = true
	end)
	wireInput(self)

	RunService.RenderStepped:Connect(function()
		if self.dirty then
			self.dirty = false
			self:repaint()
		end
	end)

	return self
end

return ChartView

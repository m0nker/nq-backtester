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
local DEFAULT_BAR_W = 8
local ZOOM_FACTOR = 1.25
-- empty candle slots kept between the newest candle and the right edge, so
-- price has somewhere to go (mirrors the web chart's rightOffset of 6)
local TAIL_PAD = 6
local DRAG_THRESHOLD = 5
local BODY_WIDTH_FRACTION = 0.7

-- Axis-strip drags. Both are exponential in the pixel delta so the gesture
-- feels identical at every zoom level; e^(200 * 0.0035) ~= 2, i.e. a drag of
-- roughly a third of a 1080p screen doubles or halves the scale.
local AXIS_DRAG_RATE = 0.0035
-- A manual price range narrower than this would blow the candle Frames up to
-- absurd pixel heights; wider than this and the tape is a flat line.
local MIN_PRICE_RANGE = 0.05
local MAX_PRICE_RANGE = 1e7
-- Roblox has no double-click signal for a Frame; two presses inside this
-- window on the same strip are one.
local DOUBLE_CLICK_SEC = 0.35

-- Dashed crosshair (the web chart's large-dash style). A Frame has no stroke
-- pattern, so each line is a transparent CONTAINER holding one small Frame per
-- dash. Only the container moves on mouse move; the dashes are laid out once
-- per resize, so the per-frame cost is still two Position writes.
local DASH_LEN = 4
local DASH_PERIOD = 8
-- Enough for a 4K-wide plot; past it the line simply stops, which no display
-- this game runs on will reach.
local DASH_POOL_MAX = 480
local CROSS_TIME_W = 96

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
	2 * 3600,
	3 * 3600,
	4 * 3600,
	6 * 3600,
	8 * 3600,
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
	-- flush with the true top-left of the screen; mouseLocation() reads its
	-- AbsolutePosition to convert screen coordinates into AbsolutePosition space
	root: Frame,
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
	crossVDashes: { Frame },
	crossHDashes: { Frame },
	crossVShown: number,
	crossHShown: number,
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
	-- false until a repaint has painted a real price range. A blank chart has
	-- NO scale, so the axis, the gridlines and the crosshair readouts must all
	-- stay dark rather than quote the placeholder range.
	scaled: boolean,

	-- Manual price scale (price-axis drag). While manual the range is frozen:
	-- new bars, pans and zooms move the tape THROUGH it instead of rescaling
	-- it. Double-clicking the axis returns to auto-fit.
	priceManual: boolean,
	manualMin: number,
	manualMax: number,

	dirty: boolean,
	dragging: boolean,
	dragMoved: boolean,
	dragStartX: number,
	dragStartY: number,
	dragStartRight: number,
	dragStartMin: number,
	dragStartMax: number,

	-- axis-strip drags. Each records the value it started from, so the gesture
	-- is a function of total displacement rather than an accumulation of
	-- per-frame deltas (which would drift).
	priceAxisDrag: boolean,
	priceAxisStartY: number,
	priceAxisStartMin: number,
	priceAxisStartMax: number,
	priceAxisLastClick: number,
	timeAxisDrag: boolean,
	timeAxisStartX: number,
	timeAxisStartWidth: number,
	timeAxisLastClick: number,

	-- overlays that draw in this chart's space (order lines/chips) subscribe
	-- here instead of running their own RenderStepped loop
	repaintListeners: { () -> () },
	-- set while an overlay owns the mouse; a chip drag must not also pan
	panLocked: boolean,
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

-- Mouse -> the coordinate space AbsolutePosition/AbsoluteSize are reported in.
--
-- These are two DIFFERENT spaces: GetMouseLocation() measures from the true
-- top-left of the window, while AbsolutePosition is measured from the topbar
-- INSET origin — under this ScreenGui's IgnoreGuiInset the root frame is drawn
-- flush with the top of the screen and reports AbsolutePosition.Y = -58.
--
-- The offset between them is MEASURED, never asked for:
-- GuiService:GetGuiInset() reports (0, 0) to this LocalScript on a client whose
-- frames are demonstrably inset by 58px, so a fix built on it silently does
-- nothing (that is exactly how the crosshair sat one topbar below the cursor).
-- `root` is at the ScreenGui's (0, 0) with no anchor, so its AbsolutePosition
-- IS the screen origin expressed in AbsolutePosition space, whatever the inset
-- currently is — and it re-reads every call, so a changing inset self-corrects.
local function mouseLocation(self: ChartView): Vector2
	return UserInputService:GetMouseLocation() + self.root.AbsolutePosition
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
	-- every label built here is a live number (axis ticks, crosshair readouts)
	l.Font = Theme.fontMono
	l.TextSize = Theme.textSm
	-- axis type is FULL contrast, not the dimmed UI grey: the scale is read as
	-- often as the candles are
	l.TextColor3 = Theme.text
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

-- Dashes along one crosshair line. Called on resize only — growth is a one-off
-- pool extension, exactly like the candle slots.
local function layoutDashes(container: Frame, dashes: { Frame }, shown: number, span: number, vertical: boolean): number
	local want = math.min(math.ceil(span / DASH_PERIOD), DASH_POOL_MAX)
	for i = #dashes + 1, want do
		local d = newFrame(container, "D" .. i, Theme.crosshair, 1)
		d.Visible = false
		dashes[i] = d
	end
	for i = 1, want do
		local off = (i - 1) * DASH_PERIOD
		local d = dashes[i]
		if vertical then
			d.Position = UDim2.fromOffset(0, off)
			d.Size = UDim2.fromOffset(1, DASH_LEN)
		else
			d.Position = UDim2.fromOffset(off, 0)
			d.Size = UDim2.fromOffset(DASH_LEN, 1)
		end
	end
	for k = want + 1, shown do
		dashes[k].Visible = false
	end
	for k = shown + 1, want do
		dashes[k].Visible = true
	end
	return want
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

-- Re-cut both dashed crosshair lines to the plot's size. Resize only: mouse
-- movement moves the containers, never the dashes inside them.
function ChartView.layoutCrosshair(self: ChartView)
	local size = self.plot.AbsoluteSize
	self.crossVShown = layoutDashes(self.crossV, self.crossVDashes, self.crossVShown, size.Y, true)
	self.crossHShown = layoutDashes(self.crossH, self.crossHDashes, self.crossHShown, size.X, false)
end

-- --------------------------------------------------------------- price scale
-- Auto-fit (the default) refits the range to the visible candles on every
-- repaint. Dragging the price axis switches to MANUAL, which freezes the
-- range: revealed bars, pans and zooms then move the tape through a fixed
-- scale instead of moving the scale. Only a double-click on the axis and
-- resetPriceScale() go back to auto.

function ChartView.resetPriceScale(self: ChartView)
	if not self.priceManual then
		return
	end
	self.priceManual = false
	self.dirty = true
end

-- Expand/compress about the midpoint, TradingView-style: the price under the
-- middle of the axis is the one that stays put. factor < 1 zooms in.
local function scaleManualRange(self: ChartView, min0: number, max0: number, factor: number)
	local mid = (min0 + max0) * 0.5
	local half = math.clamp((max0 - min0) * 0.5 * factor, MIN_PRICE_RANGE * 0.5, MAX_PRICE_RANGE * 0.5)
	self.priceManual = true
	self.manualMin, self.manualMax = mid - half, mid + half
	self.dirty = true
end

-- ---------------------------------------------------------------------------
-- overlay API. An overlay parents its Instances into the plot (clipped, and
-- above the candles by ZIndex) and maps prices through the scale the LAST
-- repaint painted — re-deriving it would let the two drift apart.
-- ---------------------------------------------------------------------------

function ChartView.getPlot(self: ChartView): Frame
	return self.plot
end

-- Plot-local pixel y for a price. Values outside [priceMin, priceMax] map
-- outside the plot; callers hide rather than clamp, so a chip never lies.
function ChartView.priceToY(self: ChartView, price: number): number
	return priceToY(price, self.priceMin, self.priceMax, self.plot.AbsoluteSize.Y)
end

function ChartView.yToPrice(self: ChartView, y: number): number
	return yToPrice(y, self.priceMin, self.priceMax, self.plot.AbsoluteSize.Y)
end

function ChartView.getPriceRange(self: ChartView): (number, number)
	return self.priceMin, self.priceMax
end

-- Cursor position in plot-local pixels. Overlays MUST go through this rather
-- than subtracting AbsolutePosition from GetMouseLocation themselves: those
-- two are in different spaces, and mouseLocation() above owns the (measured)
-- term that reconciles them.
function ChartView.mouseToPlot(self: ChartView): Vector2
	return mouseLocation(self) - self.plot.AbsolutePosition
end

-- Fired after every repaint, in subscription order. Overlays also repaint on
-- their own data changes; this hook only covers pan/zoom/resize/new bars.
function ChartView.onRepaint(self: ChartView, fn: () -> ())
	table.insert(self.repaintListeners, fn)
end

function ChartView.setPanLocked(self: ChartView, locked: boolean)
	self.panLocked = locked
	if locked then
		self.dragging = false
	end
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

	local pMin, pMax
	if self.priceManual then
		pMin, pMax = self.manualMin, self.manualMax
	else
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
		-- Asymmetric margins, mirroring the web chart's price scale: 20% of the
		-- range above, 10% below, so the tape sits low and new highs have room.
		-- The floors keep a flat range from collapsing the scale to zero height.
		local range = hi - lo
		pMin, pMax = lo - math.max(range * 0.10, 0.25), hi + math.max(range * 0.20, 0.5)
	end
	self.priceMin, self.priceMax = pMin, pMax
	self.scaled = true
	self:syncCrosshairVisibility()

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
	-- two decimals at EVERY zoom: a scale that drops decimals as it widens
	-- makes two adjacent ticks read as the same price
	local fmt = "%.2f"
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
	-- nothing drawn means no scale to read prices or times off
	self.scaled = false
	self:syncCrosshairVisibility()
end

-- The readouts are gated on `scaled` on top of the crosshair's own visibility:
-- with no bars the placeholder range would otherwise print a price the chart
-- is not showing.
function ChartView.syncCrosshairVisibility(self: ChartView)
	local readouts = self.crossV.Visible and self.scaled
	if self.crossPrice.Visible ~= readouts then
		self.crossPrice.Visible = readouts
		self.crossTime.Visible = readouts
	end
end

function ChartView.setCrosshairVisible(self: ChartView, v: boolean)
	if self.crossV.Visible == v then
		return
	end
	self.crossV.Visible = v
	self.crossH.Visible = v
	self:syncCrosshairVisibility()
end

-- `mouse` is already plot-local (mouseToPlot); nil hides the crosshair.
function ChartView.updateCrosshair(self: ChartView, mouse: Vector2?)
	if mouse == nil then
		self:setCrosshairVisible(false)
		return
	end
	local size = self.plot.AbsoluteSize
	local x = mouse.X
	local y = mouse.Y
	if x < 0 or y < 0 or x > size.X or y > size.Y or size.X < 1 or size.Y < 1 then
		self:setCrosshairVisible(false)
		return
	end
	self:setCrosshairVisible(true)
	self.crossV.Position = UDim2.fromOffset(math.round(x), 0)
	self.crossH.Position = UDim2.fromOffset(0, math.round(y))
	if not self.scaled then
		return
	end

	local price = yToPrice(y, self.priceMin, self.priceMax, size.Y)
	local ps = string.format("%.2f", price)
	if self.crossPrice.Text ~= ps then
		self.crossPrice.Text = ps
	end
	-- anchored at its own vertical centre, so the chip is centred on the line
	-- rather than hanging off it
	self.crossPrice.Position = UDim2.fromOffset(0, math.round(y))

	local candles = self.cache:getCandles()
	local c = candles[math.round(xToIndex(x, self.rightIndex, self.barWidthPx, size.X))]
	local ts = if c ~= nil then string.sub(Et.tradingDateOf(c.t), 6) .. " " .. Et.formatET(c.t, false) else ""
	if self.crossTime.Text ~= ts then
		self.crossTime.Text = ts
	end
	-- clamped inside the strip: at either extreme the chip would otherwise hang
	-- half off the time axis and be clipped mid-timestamp
	local half = CROSS_TIME_W * 0.5
	local cx = if size.X >= CROSS_TIME_W then math.clamp(x, half, size.X - half) else size.X * 0.5
	self.crossTime.Position = UDim2.fromOffset(math.round(cx), 2)
end

-- Zoom keeps the bar under the cursor pinned: solve indexToX(anchor, right')=x
-- for the new rightIndex after the width change.
function ChartView.zoomAt(self: ChartView, mouse: Vector2, delta: number)
	local size = self.plot.AbsoluteSize
	if size.X < 1 then
		return
	end
	local x = math.clamp(mouse.X, 0, size.X)
	local anchor = xToIndex(x, self.rightIndex, self.barWidthPx, size.X)
	local factor = if delta > 0 then ZOOM_FACTOR else 1 / ZOOM_FACTOR
	self.barWidthPx = math.clamp(self.barWidthPx * factor, minBarWidth(size.X), MAX_BAR_W)
	self.rightIndex = anchor + (size.X - x) / self.barWidthPx
	syncFollowTail(self)
	self.dirty = true
end

-- InputObject.Position is used only for the event type and the wheel delta,
-- never for coordinates: mouseLocation is the one conversion.
local function wireInput(self: ChartView)
	self.plot.InputChanged:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseWheel then
			self:zoomAt(self:mouseToPlot(), input.Position.Z)
		elseif input.UserInputType == Enum.UserInputType.MouseMovement then
			self:updateCrosshair(self:mouseToPlot())
		end
	end)
	self.plot.InputEnded:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseMovement then
			self:updateCrosshair(nil)
		end
	end)
	self.plot.InputBegan:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseButton1 and not self.panLocked then
			local m = mouseLocation(self)
			self.dragging = true
			self.dragMoved = false
			self.dragStartX = m.X
			self.dragStartY = m.Y
			self.dragStartRight = self.rightIndex
			self.dragStartMin, self.dragStartMax = self.priceMin, self.priceMax
		end
	end)
	-- pan tracking is global: the cursor routinely leaves the plot mid-drag
	UserInputService.InputChanged:Connect(function(input: InputObject)
		if not self.dragging or input.UserInputType ~= Enum.UserInputType.MouseMovement then
			return
		end
		local m = mouseLocation(self)
		local dx = m.X - self.dragStartX
		local dy = m.Y - self.dragStartY
		if not self.dragMoved and math.abs(dx) < DRAG_THRESHOLD and math.abs(dy) < DRAG_THRESHOLD then
			return
		end
		self.dragMoved = true
		-- dragging right pulls the tape right, which reveals older bars
		self.rightIndex = self.dragStartRight - dx / self.barWidthPx
		syncFollowTail(self)
		-- Vertical panning exists ONLY on a manual scale: under auto-fit the
		-- range is a function of the visible candles, so the next repaint would
		-- immediately undo it.
		local plotH = self.plot.AbsoluteSize.Y
		if self.priceManual and plotH >= 1 then
			-- the price under the cursor stays under the cursor: shifting the
			-- range by dy/plotH of its own span is exactly that condition
			local shift = (dy / plotH) * (self.dragStartMax - self.dragStartMin)
			self.manualMin = self.dragStartMin + shift
			self.manualMax = self.dragStartMax + shift
		end
		self.dirty = true
	end)
	UserInputService.InputEnded:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			self.dragging = false
		end
	end)
end

-- The strips have no cursor image of their own to offer (a custom Mouse.Icon
-- would need an uploaded asset), so the affordance is a one-step-lighter
-- ground while the pointer is over them.
local function wireHover(strip: Frame)
	strip.InputBegan:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseMovement then
			strip.BackgroundColor3 = Theme.grid
		end
	end)
	strip.InputEnded:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseMovement then
			strip.BackgroundColor3 = Theme.bg
		end
	end)
end

local function wireAxes(self: ChartView)
	wireHover(self.priceAxis)
	wireHover(self.timeAxis)

	self.priceAxis.InputBegan:Connect(function(input: InputObject)
		if input.UserInputType ~= Enum.UserInputType.MouseButton1 then
			return
		end
		local now = os.clock()
		if now - self.priceAxisLastClick <= DOUBLE_CLICK_SEC then
			self.priceAxisLastClick = 0
			self:resetPriceScale()
			return
		end
		self.priceAxisLastClick = now
		if not self.scaled then
			return -- nothing painted: there is no range to seize, only the placeholder
		end
		-- Seizing the range the LAST repaint painted (rather than fitting a new
		-- one) is what makes the auto -> manual switch invisible: the first drag
		-- pixel starts from exactly what is on screen.
		self.priceAxisStartMin, self.priceAxisStartMax = self.priceMin, self.priceMax
		self.priceAxisStartY = mouseLocation(self).Y
		self.priceAxisDrag = true
	end)

	self.timeAxis.InputBegan:Connect(function(input: InputObject)
		if input.UserInputType ~= Enum.UserInputType.MouseButton1 then
			return
		end
		local now = os.clock()
		if now - self.timeAxisLastClick <= DOUBLE_CLICK_SEC then
			self.timeAxisLastClick = 0
			-- the time scale's "auto": default bar width, parked back on the tail
			self.barWidthPx = DEFAULT_BAR_W
			self:snapToTail()
			return
		end
		self.timeAxisLastClick = now
		self.timeAxisStartX = mouseLocation(self).X
		self.timeAxisStartWidth = self.barWidthPx
		self.timeAxisDrag = true
	end)

	-- Tracking is global for the same reason panning is: the cursor leaves the
	-- strip within the first few pixels of the gesture.
	UserInputService.InputChanged:Connect(function(input: InputObject)
		if input.UserInputType ~= Enum.UserInputType.MouseMovement then
			return
		end
		if self.priceAxisDrag then
			-- TradingView convention: dragging UP compresses the range, i.e.
			-- zooms the price scale in.
			local dy = mouseLocation(self).Y - self.priceAxisStartY
			scaleManualRange(self, self.priceAxisStartMin, self.priceAxisStartMax, math.exp(dy * AXIS_DRAG_RATE))
		elseif self.timeAxisDrag then
			-- Anchored at the right edge: rightIndex is deliberately untouched,
			-- so the bar at the edge stays put and the tape stretches away from
			-- it.
			local dx = mouseLocation(self).X - self.timeAxisStartX
			local plotW = self.plot.AbsoluteSize.X
			self.barWidthPx =
				math.clamp(self.timeAxisStartWidth * math.exp(dx * AXIS_DRAG_RATE), minBarWidth(plotW), MAX_BAR_W)
			self.dirty = true
		end
	end)
	UserInputService.InputEnded:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			self.priceAxisDrag = false
			self.timeAxisDrag = false
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
	priceAxis.Active = true -- the strip is a drag target, not decoration

	local timeAxis = newFrame(root, "TimeAxis", Theme.bg, 1)
	timeAxis.AnchorPoint = Vector2.new(0, 1)
	timeAxis.Position = UDim2.fromScale(0, 1)
	timeAxis.Size = UDim2.new(1, -PRICE_AXIS_W, 0, TIME_AXIS_H)
	timeAxis.ClipsDescendants = true
	timeAxis.Active = true

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

	-- containers only: the dashes are children, cut to size by layoutCrosshair
	local crossV = newFrame(plot, "CrossV", Theme.crosshair, 4)
	crossV.BackgroundTransparency = 1
	crossV.Size = UDim2.new(0, 1, 1, 0)
	crossV.Visible = false
	local crossH = newFrame(plot, "CrossH", Theme.crosshair, 4)
	crossH.BackgroundTransparency = 1
	crossH.Size = UDim2.new(1, 0, 0, 1)
	crossH.Visible = false

	local crossPrice = newLabel(priceAxis, "CrossPrice", 3)
	crossPrice.AnchorPoint = Vector2.new(0, 0.5)
	crossPrice.Size = UDim2.fromOffset(PRICE_AXIS_W, 16)
	crossPrice.BackgroundTransparency = 0
	crossPrice.BackgroundColor3 = Theme.border
	crossPrice.TextColor3 = Theme.text
	crossPrice.TextXAlignment = Enum.TextXAlignment.Left
	crossPrice.Visible = false
	local pricePad = Instance.new("UIPadding")
	pricePad.PaddingLeft = UDim.new(0, 4)
	pricePad.PaddingRight = UDim.new(0, 4)
	pricePad.Parent = crossPrice
	local crossTime = newLabel(timeAxis, "CrossTime", 3)
	crossTime.AnchorPoint = Vector2.new(0.5, 0)
	crossTime.Size = UDim2.fromOffset(CROSS_TIME_W, 16)
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
	snapBtn.Font = Theme.fontUiMedium
	snapBtn.TextSize = Theme.textMd
	snapBtn.Text = "follow"
	snapBtn.ZIndex = 5
	snapBtn.Parent = root

	local self: ChartView = setmetatable(
		{
			cache = cache,
			gui = gui,
			root = root,
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
			crossVDashes = {},
			crossHDashes = {},
			crossVShown = 0,
			crossHShown = 0,
			crossPrice = crossPrice,
			crossTime = crossTime,
			barWidthPx = DEFAULT_BAR_W,
			rightIndex = TAIL_PAD,
			followTail = true,
			drawn = 0,
			priceShown = 0,
			timeShown = 0,
			priceMin = 0,
			priceMax = 1,
			scaled = false,
			priceManual = false,
			manualMin = 0,
			manualMax = 1,
			dirty = true,
			dragging = false,
			dragMoved = false,
			dragStartX = 0,
			dragStartY = 0,
			dragStartRight = 0,
			dragStartMin = 0,
			dragStartMax = 1,
			priceAxisDrag = false,
			priceAxisStartY = 0,
			priceAxisStartMin = 0,
			priceAxisStartMax = 1,
			priceAxisLastClick = 0,
			timeAxisDrag = false,
			timeAxisStartX = 0,
			timeAxisStartWidth = DEFAULT_BAR_W,
			timeAxisLastClick = 0,
			repaintListeners = {},
			panLocked = false,
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
		self:layoutCrosshair()
		self.dirty = true
	end)
	self:layoutCrosshair()
	wireInput(self)
	wireAxes(self)

	RunService.RenderStepped:Connect(function()
		if self.dirty then
			self.dirty = false
			self:repaint()
			for _, fn in ipairs(self.repaintListeners) do
				fn()
			end
		end
	end)

	return self
end

return ChartView

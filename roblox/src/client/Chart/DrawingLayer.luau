--!strict
-- User drawings, v1: horizontal rays and axis-aligned rectangles, drawn in the
-- chart's own space above the candles.
--
-- Anchors are (epoch seconds UTC, price) pairs — NOT pixels and NOT bar
-- indices — so a shape spans the same wall-clock/price region on every
-- timeframe (the web layer's rule, web/src/lib/drawings/store.ts). Nothing here
-- stores a pixel; the mapping is re-run from scratch on every render.
--
-- time -> x goes through the candle array's FRACTIONAL INDEX space,
-- interpolating between the two bracketing candles. A linear-in-time mapping
-- would misplace a shape across a weekend or a halt, which the chart compresses
-- to nothing.
--
-- v1 scope, deliberately: no trend lines, no magnet snapping, no selection or
-- dragging, no persistence. A drawing lives and dies with the client session,
-- so nothing here touches a remote and nothing is timeframe- or session-scoped
-- beyond the cache it reads.
--
-- Pooling and render discipline mirror OrderLayer's: Instances are allocated in
-- pages before they are needed, never during a placement, and a render only
-- writes Position / Size / Visible / Text on existing Frames. The ONLY per-frame
-- work in this module is the rectangle placement ghost, and its RenderStepped
-- connection exists only while a corner is pending.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Types = require(Shared:WaitForChild("Types"))

local Client = script.Parent.Parent
local BarCacheModule = require(Client:WaitForChild("State"):WaitForChild("BarCache"))
local ChartViewModule = require(script.Parent:WaitForChild("ChartView"))
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Bar = Types.Bar
type BarCache = BarCacheModule.BarCache
type ChartView = ChartViewModule.ChartView

-- Hard cap on shapes. It bounds the Instance budget of this overlay (worst case
-- 40 rectangles = 200 Frames) and, with no persistence, is far more than a
-- session ever accumulates.
local MAX_DRAWINGS = 40
-- Pools grow a page at a time so the first ray does not allocate 40 slots and
-- the 9th does not allocate one mid-click.
local POOL_PAGE = 8

-- Click tolerance for the delete tool. A 1px line is unhittable at exact
-- pixels; this is the web layer's fat-transparent-stroke trick done in
-- arithmetic instead of instances.
local HIT_PX = 6

local RECT_FILL_TRANSPARENCY = 0.92
local STROKE_PX = 1
local TAG_W = 52
local TAG_H = 13

-- Above the candles (2/3) and the gridlines (1), below OrderLayer's lines (6):
-- an order level is a fact about the account, a drawing is a note about the
-- chart, and the fact wins when they overlap.
local Z_SHAPE = 4
local Z_TAG = 5

export type Tool = string -- "none" | "ray" | "rect" | "del"

-- t1/p1 is the anchor a ray hangs from and one corner of a rectangle; t2/p2 is
-- the opposite corner and is unused by rays.
type Drawing = { kind: string, t1: number, p1: number, t2: number, p2: number }

type RaySlot = { line: Frame, tag: TextLabel, tagText: string }
-- The 4 stroke Frames are children of the fill and positioned in ITS scale
-- space, so a render writes two properties per rectangle rather than ten.
type RectSlot = { fill: Frame }

local DrawingLayer = {}
DrawingLayer.__index = DrawingLayer

type Fields = {
	chart: ChartView,
	cache: BarCache,
	drawings: { Drawing },
	tool: Tool,

	rays: { RaySlot },
	rects: { RectSlot },
	raysUsed: number,
	rectsUsed: number,

	-- first corner of a rectangle, held between the two clicks that place it
	pendingT: number,
	pendingP: number,
	pending: boolean,
	ghost: RectSlot,
	ghostConn: RBXScriptConnection?,
}

export type DrawingLayer = typeof(setmetatable({} :: Fields, DrawingLayer))

-- ---------------------------------------------------------------------------
-- instance construction (startup / one-off pool growth only)
-- ---------------------------------------------------------------------------

local function newFrame(parent: Instance, name: string, z: number): Frame
	local f = Instance.new("Frame")
	f.Name = name
	f.BorderSizePixel = 0
	f.BackgroundColor3 = Theme.accent
	f.ZIndex = z
	f.Visible = false
	f.Parent = parent
	return f
end

local function makeRay(plot: Frame): RaySlot
	local line = newFrame(plot, "Ray", Z_SHAPE)
	line.AnchorPoint = Vector2.new(0, 0.5)

	-- The price is the same everywhere along a horizontal ray, so the tag sits
	-- at the anchor end where the eye starts rather than following the cursor.
	local tag = Instance.new("TextLabel")
	tag.Name = "RayTag"
	tag.BorderSizePixel = 0
	tag.AnchorPoint = Vector2.new(0, 1)
	tag.Size = UDim2.fromOffset(TAG_W, TAG_H)
	tag.BackgroundColor3 = Theme.panel
	-- a price, and it is rewritten while the eye is on it
	tag.Font = Theme.fontMono
	tag.TextSize = Theme.textSm
	tag.TextColor3 = Theme.accent
	tag.TextXAlignment = Enum.TextXAlignment.Center
	tag.Text = ""
	tag.ZIndex = Z_TAG
	tag.Visible = false
	tag.Parent = plot

	return { line = line, tag = tag, tagText = "" }
end

-- Stroke edges are laid out ONCE, in the fill's own scale space; moving the
-- fill moves them. Under Sibling ZIndexBehavior a descendant always draws above
-- its ancestor, so the edges need no ZIndex of their own to sit on the fill.
local function makeRect(plot: Frame): RectSlot
	local fill = newFrame(plot, "Rect", Z_SHAPE)
	fill.BackgroundTransparency = RECT_FILL_TRANSPARENCY

	local top = newFrame(fill, "T", Z_SHAPE)
	top.Size = UDim2.new(1, 0, 0, STROKE_PX)
	top.Visible = true
	local bottom = newFrame(fill, "B", Z_SHAPE)
	bottom.AnchorPoint = Vector2.new(0, 1)
	bottom.Position = UDim2.fromScale(0, 1)
	bottom.Size = UDim2.new(1, 0, 0, STROKE_PX)
	bottom.Visible = true
	local left = newFrame(fill, "L", Z_SHAPE)
	left.Size = UDim2.new(0, STROKE_PX, 1, 0)
	left.Visible = true
	local right = newFrame(fill, "R", Z_SHAPE)
	right.AnchorPoint = Vector2.new(1, 0)
	right.Position = UDim2.fromScale(1, 0)
	right.Size = UDim2.new(0, STROKE_PX, 1, 0)
	right.Visible = true

	return { fill = fill }
end

local function ensureRays(self: DrawingLayer, want: number)
	if #self.rays >= want then
		return
	end
	local plot = self.chart:getPlot()
	local target = math.min(math.ceil(want / POOL_PAGE) * POOL_PAGE, MAX_DRAWINGS)
	for _ = #self.rays + 1, target do
		table.insert(self.rays, makeRay(plot))
	end
end

local function ensureRects(self: DrawingLayer, want: number)
	if #self.rects >= want then
		return
	end
	local plot = self.chart:getPlot()
	local target = math.min(math.ceil(want / POOL_PAGE) * POOL_PAGE, MAX_DRAWINGS)
	for _ = #self.rects + 1, target do
		table.insert(self.rects, makeRect(plot))
	end
end

-- ---------------------------------------------------------------------------
-- anchors -> pixels
-- ---------------------------------------------------------------------------

-- Fractional candle index for an anchor time: the last candle with c.t <= t,
-- plus how far into that candle's own span `t` sits.
--
-- Off-data times CLAMP to the first / last candle instead of extrapolating. An
-- anchor outside the cache has no bucket to be a fraction of, and a clamped
-- shape stays visibly on the tape rather than flying off it — which matters
-- after a rewind, when a reset packet can drop the bars an anchor was placed
-- against.
local function timeToIndex(candles: { Bar }, t: number): number
	local n = #candles
	if n == 0 or t <= candles[1].t then
		return 1
	end
	if t >= candles[n].t then
		return n
	end
	local lo, hi = 1, n
	while lo < hi do
		local mid = (lo + hi + 1) // 2
		if candles[mid].t <= t then
			lo = mid
		else
			hi = mid - 1
		end
	end
	-- lo < n here (t is strictly below the last candle's open), so lo + 1 exists
	local span = candles[lo + 1].t - candles[lo].t
	if span <= 0 then
		-- unreachable on a monotonic array, but a zero denominator would put a
		-- NaN into a Position and take the whole overlay down with it
		return lo
	end
	return lo + (t - candles[lo].t) / span
end

-- ChartView keeps index -> x file-local (only priceToY / yToPrice are exported),
-- so the mapping is rebuilt here from the viewport the LAST repaint painted.
-- Reading `rightIndex` / `barWidthPx` rather than re-deriving them is the point:
-- a second derivation would drift from the candles the moment either changes.
local function indexToX(chart: ChartView, index: number, plotW: number): number
	return plotW - (chart.rightIndex - index) * chart.barWidthPx
end

function DrawingLayer.xForTime(self: DrawingLayer, t: number, plotW: number): number
	return indexToX(self.chart, timeToIndex(self.cache:getCandles(), t), plotW)
end

-- ---------------------------------------------------------------------------
-- render
-- ---------------------------------------------------------------------------

local function hideRay(slot: RaySlot)
	slot.line.Visible = false
	slot.tag.Visible = false
end

-- A rectangle whose pixel bounds are entirely outside the plot is hidden rather
-- than drawn and clipped: the clamp below keeps the Size finite for one that is
-- only PARTLY outside, and a clamped shape that is wholly outside would collapse
-- onto an edge and read as a 1px sliver pinned there.
local function placeRect(slot: RectSlot, x1: number, y1: number, x2: number, y2: number, plotW: number, plotH: number)
	if x2 < 0 or x1 > plotW or y2 < 0 or y1 > plotH then
		slot.fill.Visible = false
		return
	end
	local left = math.round(math.max(x1, -STROKE_PX))
	local top = math.round(math.max(y1, -STROKE_PX))
	local right = math.round(math.min(x2, plotW + STROKE_PX))
	local bottom = math.round(math.min(y2, plotH + STROKE_PX))
	slot.fill.Position = UDim2.fromOffset(left, top)
	slot.fill.Size = UDim2.fromOffset(math.max(1, right - left), math.max(1, bottom - top))
	slot.fill.Visible = true
end

function DrawingLayer.render(self: DrawingLayer)
	local plot = self.chart:getPlot()
	local plotW = plot.AbsoluteSize.X
	local plotH = plot.AbsoluteSize.Y
	local rays, rects = 0, 0

	if plotW >= 1 and plotH >= 1 then
		for _, d in ipairs(self.drawings) do
			if d.kind == "ray" then
				rays += 1
				ensureRays(self, rays)
				local slot = self.rays[rays]
				local x = self:xForTime(d.t1, plotW)
				local y = math.round(self.chart:priceToY(d.p1))
				-- past the right edge there is no ray on screen, and a tag clamped
				-- into the plot would quote a level the shape does not reach
				local visible = x <= plotW
				slot.line.Visible = visible
				slot.tag.Visible = visible
				if visible then
					-- the ray runs from its anchor to the RIGHT edge (web
					-- semantics); an anchor off the left edge still covers the plot
					local vx = math.round(math.max(x, 0))
					slot.line.Position = UDim2.fromOffset(vx, y)
					slot.line.Size = UDim2.fromOffset(math.max(1, math.round(plotW) - vx), 1)
					slot.tag.Position = UDim2.fromOffset(math.min(vx, math.round(plotW) - TAG_W), y - 1)
					local text = string.format("%.2f", d.p1)
					if slot.tagText ~= text then
						slot.tagText = text
						slot.tag.Text = text
					end
				end
			else
				rects += 1
				ensureRects(self, rects)
				local xa = self:xForTime(d.t1, plotW)
				local xb = self:xForTime(d.t2, plotW)
				local ya = self.chart:priceToY(d.p1)
				local yb = self.chart:priceToY(d.p2)
				placeRect(
					self.rects[rects],
					math.min(xa, xb),
					math.min(ya, yb),
					math.max(xa, xb),
					math.max(ya, yb),
					plotW,
					plotH
				)
			end
		end
	end

	for k = rays + 1, self.raysUsed do
		hideRay(self.rays[k])
	end
	for k = rects + 1, self.rectsUsed do
		self.rects[k].fill.Visible = false
	end
	self.raysUsed = rays
	self.rectsUsed = rects
end

-- ---------------------------------------------------------------------------
-- placement
-- ---------------------------------------------------------------------------

function DrawingLayer.moveGhost(self: DrawingLayer)
	local plot = self.chart:getPlot()
	local plotW = plot.AbsoluteSize.X
	local plotH = plot.AbsoluteSize.Y
	if not self.pending or plotW < 1 or plotH < 1 then
		self.ghost.fill.Visible = false
		return
	end
	local m = self.chart:mouseToPlot()
	local xa = self:xForTime(self.pendingT, plotW)
	local ya = self.chart:priceToY(self.pendingP)
	-- the cursor end is clamped INTO the plot: the ghost is a preview of a
	-- corner the second click has not committed yet, and a preview that runs off
	-- the edge cannot be aimed
	local xb = math.clamp(m.X, 0, plotW)
	local yb = math.clamp(m.Y, 0, plotH)
	placeRect(self.ghost, math.min(xa, xb), math.min(ya, yb), math.max(xa, xb), math.max(ya, yb), plotW, plotH)
end

-- The ghost is the one thing in this module that moves with the cursor rather
-- than with a repaint, so it owns a RenderStepped connection — and only for the
-- few seconds between the two clicks that place a rectangle.
local function startGhost(self: DrawingLayer)
	if self.ghostConn ~= nil then
		return
	end
	self.ghostConn = RunService.RenderStepped:Connect(function()
		self:moveGhost()
	end)
end

function DrawingLayer.cancelPending(self: DrawingLayer)
	self.pending = false
	self.ghost.fill.Visible = false
	local conn = self.ghostConn
	if conn ~= nil then
		conn:Disconnect()
		self.ghostConn = nil
	end
end

-- Index of the topmost shape under `pos` (plot-local pixels), or nil. Later
-- drawings paint over earlier ones, so the scan runs backwards.
function DrawingLayer.hitTest(self: DrawingLayer, pos: Vector2): number?
	local plot = self.chart:getPlot()
	local plotW = plot.AbsoluteSize.X
	if plotW < 1 then
		return nil
	end
	for i = #self.drawings, 1, -1 do
		local d = self.drawings[i]
		if d.kind == "ray" then
			local y = self.chart:priceToY(d.p1)
			local x = self:xForTime(d.t1, plotW)
			if math.abs(pos.Y - y) <= HIT_PX and pos.X >= x - HIT_PX then
				return i
			end
		else
			local xa = self:xForTime(d.t1, plotW)
			local xb = self:xForTime(d.t2, plotW)
			local ya = self.chart:priceToY(d.p1)
			local yb = self.chart:priceToY(d.p2)
			if
				pos.X >= math.min(xa, xb)
				and pos.X <= math.max(xa, xb)
				and pos.Y >= math.min(ya, yb)
				and pos.Y <= math.max(ya, yb)
			then
				return i
			end
		end
	end
	return nil
end

-- Every plot click arrives here, armed or not (the subscription is for the
-- layer's whole life). `tSec` is nil past either end of the data — an anchor
-- needs a wall-clock time, so a click with no bar under it is dropped rather
-- than anchored to an invented one.
function DrawingLayer.onClick(self: DrawingLayer, pos: Vector2, price: number, tSec: number?)
	local tool = self.tool
	if tool == "none" then
		return
	end
	if tool == "del" then
		local i = self:hitTest(pos)
		if i ~= nil then
			table.remove(self.drawings, i)
			self:render()
		end
		return
	end
	if tSec == nil then
		return
	end
	local t = tSec :: number
	if tool == "ray" then
		if #self.drawings >= MAX_DRAWINGS then
			return
		end
		table.insert(self.drawings, { kind = "ray", t1 = t, p1 = price, t2 = t, p2 = price })
		self:render()
	elseif tool == "rect" then
		if not self.pending then
			if #self.drawings >= MAX_DRAWINGS then
				return
			end
			self.pendingT, self.pendingP = t, price
			self.pending = true
			startGhost(self)
			self:moveGhost()
			return
		end
		local t1, p1 = self.pendingT, self.pendingP
		self:cancelPending()
		table.insert(self.drawings, { kind = "rect", t1 = t1, p1 = p1, t2 = t, p2 = price })
		self:render()
	end
end

-- ---------------------------------------------------------------------------

function DrawingLayer.getTool(self: DrawingLayer): Tool
	return self.tool
end

-- Arming is exclusive and a re-arm of the live tool disarms, exactly like
-- OrderPanel's. The two panels cannot see each other's arm state, so the chart's
-- click cursor is told what THIS layer wants; see the module header of
-- UI/DrawToolbar for the double-consumption caveat that follows from it.
function DrawingLayer.setTool(self: DrawingLayer, tool: Tool)
	if self.tool == tool then
		return
	end
	self.tool = tool
	self:cancelPending()
	self.chart:setClickCursor(tool ~= "none")
end

function DrawingLayer.count(self: DrawingLayer): number
	return #self.drawings
end

function DrawingLayer.clear(self: DrawingLayer)
	self:cancelPending()
	table.clear(self.drawings)
	self:render()
end

function DrawingLayer.new(chart: ChartView, cache: BarCache): DrawingLayer
	local plot = chart:getPlot()

	-- One rank above the placed shapes: the ghost is the thing being aimed, so
	-- it must not end up underneath a rectangle that is already on the chart.
	local ghost = makeRect(plot)
	ghost.fill.ZIndex = Z_TAG

	local self: DrawingLayer = setmetatable(
		{
			chart = chart,
			cache = cache,
			drawings = {},
			tool = "none" :: Tool,
			rays = {},
			rects = {},
			raysUsed = 0,
			rectsUsed = 0,
			pendingT = 0,
			pendingP = 0,
			pending = false,
			ghost = ghost,
			ghostConn = nil,
		} :: Fields,
		DrawingLayer
	)

	-- Subscribed ONCE, for the layer's whole life: the chart delivers every plot
	-- click and onClick is a no-op unless a tool is armed.
	chart:onPlotClick(function(pos: Vector2, price: number, tSec: number?)
		self:onClick(pos, price, tSec)
	end)
	-- Pan / zoom / resize / new bars.
	chart:onRepaint(function()
		self:render()
	end)
	-- AND the cache, on its own: a timeframe switch rebuilds the candle array, so
	-- the index a given anchor time maps to changes even when the viewport does
	-- not. The chart's repaint follows on the next frame; re-rendering here is
	-- what keeps the shapes glued to their wall-clock time through the switch
	-- rather than for one frame after it.
	cache:onChanged(function()
		self:render()
	end)

	return self
end

return DrawingLayer

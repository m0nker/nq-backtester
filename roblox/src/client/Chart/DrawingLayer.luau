--!strict
-- User drawings, v2: horizontal rays, trend lines and axis-aligned rectangles
-- drawn in the chart's own space above the candles, plus select / move / resize
-- of a placed shape.
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
-- A trend line is a ROTATED Frame, and a rotated Frame is NOT clipped by an
-- ancestor's ClipsDescendants — the plot's clipping, which every other element
-- here leans on, does nothing for it. The segment is therefore clipped
-- ANALYTICALLY (Liang-Barsky, placeLine below) and only the surviving
-- sub-segment is drawn: without that, a line with one endpoint off-screen
-- paints straight across the price axis and the HUD.
--
-- v2 scope, deliberately: no magnet snapping, no persistence. A drawing lives
-- and dies with the client session, so nothing here touches a remote and
-- nothing is timeframe- or session-scoped beyond the cache it reads.
--
-- Pooling and render discipline mirror OrderLayer's: Instances are allocated in
-- pages before they are needed, never during a placement or a drag, and a
-- render only writes Position / Size / Rotation / Visible / Text on existing
-- Frames. The only RenderStepped connection in this module belongs to the
-- placement ghost and exists only while a first anchor is pending; edit drags
-- ride the mouse-move signal instead.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Types = require(Shared:WaitForChild("Types"))

local Client = script.Parent.Parent
local BarCacheModule = require(Client:WaitForChild("State"):WaitForChild("BarCache"))
local ChartViewModule = require(script.Parent:WaitForChild("ChartView"))
local Theme = require(Client:WaitForChild("UI"):WaitForChild("Theme"))

type Bar = Types.Bar
type BarCache = BarCacheModule.BarCache
type ChartView = ChartViewModule.ChartView

-- Hard cap on shapes, across kinds. It bounds the Instance budget of this
-- overlay (worst case 40 rectangles = 200 Frames) and, with no persistence, is
-- far more than a session ever accumulates.
local MAX_DRAWINGS = 40
-- Pools grow a page at a time so the first ray does not allocate 40 slots and
-- the 9th does not allocate one mid-click.
local POOL_PAGE = 8

-- Click tolerance for the delete tool and for selection. A 1px line is
-- unhittable at exact pixels; this is the web layer's fat-transparent-stroke
-- trick done in arithmetic instead of instances.
local HIT_PX = 6
-- Travel that turns a press on a shape into a drag rather than a click. It
-- matches ChartView's own pan threshold on purpose: below it BOTH agree the
-- gesture was a click, so a press that never moved still reaches the chart's
-- click listeners.
local DRAG_THRESHOLD = 5

local RECT_FILL_TRANSPARENCY = 0.92
local STROKE_PX = 1
-- Rotated Frames are not anti-aliased, so a 1px trend line reads as a
-- staircase; 2px is the floor at which it reads as a line.
local LINE_PX = 2
local HANDLE_PX = 6
local TAG_W = 52
local TAG_H = 13

-- Above the candles (2/3) and the gridlines (1), below OrderLayer's lines (6):
-- an order level is a fact about the account, a drawing is a note about the
-- chart, and the fact wins when they overlap.
local Z_SHAPE = 4
local Z_TAG = 5
-- Handles and the placement ghost share the rank above the shapes: both are
-- things being aimed at, and neither is ever on screen at the same time as the
-- other.
local Z_HANDLE = 5

export type Tool = string -- "none" | "ray" | "line" | "rect" | "del"

-- t1/p1 is the anchor a ray hangs from, one corner of a rectangle, one end of a
-- trend line; t2/p2 is the opposite end and is a copy of the first for rays.
type Drawing = { kind: string, t1: number, p1: number, t2: number, p2: number }

type RaySlot = { line: Frame, tag: TextLabel, tagText: string }
-- The 4 stroke Frames are children of the fill and positioned in ITS scale
-- space, so a render writes two properties per rectangle rather than ten.
type RectSlot = { fill: Frame }
type LineSlot = { line: Frame }

local DrawingLayer = {}
DrawingLayer.__index = DrawingLayer

type Fields = {
	chart: ChartView,
	cache: BarCache,
	drawings: { Drawing },
	tool: Tool,

	rays: { RaySlot },
	rects: { RectSlot },
	lines: { LineSlot },
	raysUsed: number,
	rectsUsed: number,
	linesUsed: number,
	-- exactly two: handles mark the anchors of the ONE selected drawing
	handles: { Frame },

	-- index into `drawings`, cleared by every removal (table.remove shifts the
	-- indices of everything after it, so a stale one would point at a neighbour)
	selected: number?,

	-- first anchor of a two-click shape, held between the clicks that place it
	pendingT: number,
	pendingP: number,
	pendingKind: string,
	pending: boolean,
	ghost: RectSlot,
	ghostLine: LineSlot,
	ghostConn: RBXScriptConnection?,

	-- Edit gesture. A press on a shape only ARMS `grabbed`; the drag begins on
	-- the first movement past DRAG_THRESHOLD, and the anchors it interpolates
	-- from are captured then rather than at the press (see beginDrag).
	grabbed: boolean,
	grabIndex: number,
	grabKind: string, -- "body" | "a1" | "a2"
	grabX: number,
	grabY: number,
	dragging: boolean,
	dragT: number,
	dragP: number,
	origT1: number,
	origP1: number,
	origT2: number,
	origP2: number,
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

local function makeLine(plot: Frame): LineSlot
	local line = newFrame(plot, "Line", Z_SHAPE)
	-- Rotation pivots about the AnchorPoint, and placeLine positions the Frame
	-- at the segment's MIDPOINT, so the pivot has to be the Frame's own centre.
	line.AnchorPoint = Vector2.new(0.5, 0.5)
	return { line = line }
end

local function makeHandle(plot: Frame): Frame
	local h = newFrame(plot, "Handle", Z_HANDLE)
	h.AnchorPoint = Vector2.new(0.5, 0.5)
	h.Size = UDim2.fromOffset(HANDLE_PX, HANDLE_PX)
	-- the shapes are accent-colored, so a handle in the same accent would
	-- disappear into the thing it is marking
	h.BackgroundColor3 = Theme.text
	return h
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

local function ensureLines(self: DrawingLayer, want: number)
	if #self.lines >= want then
		return
	end
	local plot = self.chart:getPlot()
	local target = math.min(math.ceil(want / POOL_PAGE) * POOL_PAGE, MAX_DRAWINGS)
	for _ = #self.lines + 1, target do
		table.insert(self.lines, makeLine(plot))
	end
end

-- ---------------------------------------------------------------------------
-- anchors <-> pixels
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

-- The inverse, used only by edit drags to turn a cursor column into an anchor
-- time. It CLAMPS at both ends for the same reason timeToIndex does: past the
-- array there is no bucket to interpolate over, so an anchor dragged off the
-- tape pins to the outermost candle instead of being extrapolated into a time
-- no bar exists at.
local function indexToTime(candles: { Bar }, index: number): number
	local n = #candles
	if n == 0 then
		return 0
	end
	local i = math.clamp(math.floor(index), 1, n)
	if i >= n then
		return candles[n].t
	end
	local span = candles[i + 1].t - candles[i].t
	if span <= 0 then
		return candles[i].t
	end
	return candles[i].t + math.clamp(index - i, 0, 1) * span
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

-- Cursor as an anchor pair. The x half is indexToX inverted, then run back
-- through the candle array; the y half is the chart's own scale.
function DrawingLayer.cursorAnchor(self: DrawingLayer): (number, number)
	local size = self.chart:getPlot().AbsoluteSize
	local bw = self.chart.barWidthPx
	if size.X < 1 or size.Y < 1 or bw <= 0 then
		-- no painted viewport to measure against: the drag holds where it is
		-- rather than folding a NaN into an anchor
		return self.dragT, self.dragP
	end
	local m = self.chart:mouseToPlot()
	local index = self.chart.rightIndex - (size.X - m.X) / bw
	return indexToTime(self.cache:getCandles(), index), self.chart:yToPrice(m.Y)
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

-- One Liang-Barsky half-plane: the segment point is P0 + t*D and the constraint
-- is t*p <= q. p < 0 is an edge the segment ENTERS through (it raises the near
-- end), p > 0 one it LEAVES through (it lowers the far end), p == 0 is parallel
-- and decides acceptance outright by the sign of q. Each accepted update keeps
-- t0 <= t1, so the caller needs no separate emptiness test.
local function clipT(p: number, q: number, t0: number, t1: number): (number, number, boolean)
	if p == 0 then
		return t0, t1, q >= 0
	end
	local r = q / p
	if p < 0 then
		if r > t1 then
			return t0, t1, false
		end
		if r > t0 then
			t0 = r
		end
	else
		if r < t0 then
			return t0, t1, false
		end
		if r < t1 then
			t1 = r
		end
	end
	return t0, t1, true
end

-- THE trap of this whole feature: `Rotation ~= 0` opts a Frame out of every
-- ancestor's ClipsDescendants, so the plot cannot contain a trend line the way
-- it contains everything else here. The segment is clipped to the plot rect
-- analytically and only the surviving piece is drawn.
--
-- Rotation comes from the UNCLIPPED direction: a segment clipped down to a
-- single point (one that only grazes a corner) has no direction of its own, and
-- atan2(0, 0) would silently flatten it to 0 degrees.
local function placeLine(slot: LineSlot, x1: number, y1: number, x2: number, y2: number, plotW: number, plotH: number)
	local dx, dy = x2 - x1, y2 - y1
	local t0, t1, ok = 0, 1, true
	t0, t1, ok = clipT(-dx, x1, t0, t1)
	if ok then
		t0, t1, ok = clipT(dx, plotW - x1, t0, t1)
	end
	if ok then
		t0, t1, ok = clipT(-dy, y1, t0, t1)
	end
	if ok then
		t0, t1, ok = clipT(dy, plotH - y1, t0, t1)
	end
	if not ok then
		slot.line.Visible = false
		return
	end
	local ax, ay = x1 + t0 * dx, y1 + t0 * dy
	local bx, by = x1 + t1 * dx, y1 + t1 * dy
	local len = math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay))
	slot.line.Position = UDim2.fromOffset(math.round((ax + bx) * 0.5), math.round((ay + by) * 0.5))
	slot.line.Size = UDim2.fromOffset(math.max(1, math.round(len)), LINE_PX)
	slot.line.Rotation = math.deg(math.atan2(dy, dx))
	slot.line.Visible = true
end

-- A handle whose anchor is off the plot is hidden rather than clamped: clamped
-- it would sit on an edge and invite a drag from a point the anchor is not at.
local function placeHandle(h: Frame, x: number, y: number, plotW: number, plotH: number)
	if x < 0 or x > plotW or y < 0 or y > plotH then
		h.Visible = false
		return
	end
	h.Position = UDim2.fromOffset(math.round(x), math.round(y))
	h.Visible = true
end

-- Handles mark the anchors of the SELECTED drawing and nothing else, so the
-- pool is exactly two. A ray shows one: its second pair is a copy of its first,
-- and two handles stacked on the same pixel cannot be told apart or aimed at.
function DrawingLayer.placeHandles(self: DrawingLayer, plotW: number, plotH: number)
	local i = self.selected
	local d = if i ~= nil then self.drawings[i] else nil
	if d == nil or plotW < 1 or plotH < 1 then
		self.handles[1].Visible = false
		self.handles[2].Visible = false
		return
	end
	placeHandle(self.handles[1], self:xForTime(d.t1, plotW), self.chart:priceToY(d.p1), plotW, plotH)
	if d.kind == "ray" then
		self.handles[2].Visible = false
	else
		placeHandle(self.handles[2], self:xForTime(d.t2, plotW), self.chart:priceToY(d.p2), plotW, plotH)
	end
end

function DrawingLayer.render(self: DrawingLayer)
	local plot = self.chart:getPlot()
	local plotW = plot.AbsoluteSize.X
	local plotH = plot.AbsoluteSize.Y
	local rays, rects, lines = 0, 0, 0

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
			elseif d.kind == "line" then
				lines += 1
				ensureLines(self, lines)
				placeLine(
					self.lines[lines],
					self:xForTime(d.t1, plotW),
					self.chart:priceToY(d.p1),
					self:xForTime(d.t2, plotW),
					self.chart:priceToY(d.p2),
					plotW,
					plotH
				)
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
	for k = lines + 1, self.linesUsed do
		self.lines[k].line.Visible = false
	end
	self.raysUsed = rays
	self.rectsUsed = rects
	self.linesUsed = lines

	self:placeHandles(plotW, plotH)
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
		self.ghostLine.line.Visible = false
		return
	end
	local m = self.chart:mouseToPlot()
	local xa = self:xForTime(self.pendingT, plotW)
	local ya = self.chart:priceToY(self.pendingP)
	-- the cursor end is clamped INTO the plot: the ghost is a preview of an
	-- anchor the second click has not committed yet, and a preview that runs off
	-- the edge cannot be aimed
	local xb = math.clamp(m.X, 0, plotW)
	local yb = math.clamp(m.Y, 0, plotH)
	if self.pendingKind == "line" then
		placeLine(self.ghostLine, xa, ya, xb, yb, plotW, plotH)
	else
		placeRect(self.ghost, math.min(xa, xb), math.min(ya, yb), math.max(xa, xb), math.max(ya, yb), plotW, plotH)
	end
end

-- The ghost is the one thing in this module that moves with the cursor rather
-- than with a repaint, so it owns a RenderStepped connection — and only for the
-- few seconds between the two clicks that place a rectangle or a trend line.
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
	self.ghostLine.line.Visible = false
	local conn = self.ghostConn
	if conn ~= nil then
		conn:Disconnect()
		self.ghostConn = nil
	end
end

-- ---------------------------------------------------------------------------
-- hit testing
-- ---------------------------------------------------------------------------

local function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number
	local vx, vy = bx - ax, by - ay
	local l2 = vx * vx + vy * vy
	local u = if l2 > 0 then math.clamp(((px - ax) * vx + (py - ay) * vy) / l2, 0, 1) else 0
	local dx, dy = ax + u * vx - px, ay + u * vy - py
	return math.sqrt(dx * dx + dy * dy)
end

-- Index of the topmost shape under `pos` (plot-local pixels), or nil. Later
-- drawings paint over earlier ones, so the scan runs backwards.
--
-- `borderOnly` changes what a RECTANGLE means: selection passes it so that only
-- the frame of a rectangle grabs, because a filled hit region would turn every
-- large rectangle into a region of the chart that cannot be panned. The delete
-- tool leaves it off — it never seizes the mouse, so a forgiving whole-body
-- target costs nothing there.
function DrawingLayer.hitTest(self: DrawingLayer, pos: Vector2, borderOnly: boolean?): number?
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
		elseif d.kind == "line" then
			local ax = self:xForTime(d.t1, plotW)
			local bx = self:xForTime(d.t2, plotW)
			local ay = self.chart:priceToY(d.p1)
			local by = self.chart:priceToY(d.p2)
			if distToSegment(pos.X, pos.Y, ax, ay, bx, by) <= HIT_PX then
				return i
			end
		else
			local xa = self:xForTime(d.t1, plotW)
			local xb = self:xForTime(d.t2, plotW)
			local ya = self.chart:priceToY(d.p1)
			local yb = self.chart:priceToY(d.p2)
			local l, r = math.min(xa, xb), math.max(xa, xb)
			local t, b = math.min(ya, yb), math.max(ya, yb)
			if pos.X >= l - HIT_PX and pos.X <= r + HIT_PX and pos.Y >= t - HIT_PX and pos.Y <= b + HIT_PX then
				-- a rectangle thinner than 2 * HIT_PX has no inside left, and the
				-- strict comparisons below are what make that case a border hit
				local inside = pos.X > l + HIT_PX and pos.X < r - HIT_PX and pos.Y > t + HIT_PX and pos.Y < b - HIT_PX
				if not (borderOnly and inside) then
					return i
				end
			end
		end
	end
	return nil
end

-- Which anchor handle of the SELECTED drawing `pos` lands on, or nil. Anchor 2
-- is tested first because it is the one a rectangle's second click placed, and
-- on a rectangle dragged onto itself the two can coincide.
local function handleHit(self: DrawingLayer, pos: Vector2): string?
	local i = self.selected
	local d = if i ~= nil then self.drawings[i] else nil
	if d == nil then
		return nil
	end
	local plotW = self.chart:getPlot().AbsoluteSize.X
	if plotW < 1 then
		return nil
	end
	if d.kind ~= "ray" then
		local x2 = self:xForTime(d.t2, plotW)
		local y2 = self.chart:priceToY(d.p2)
		if math.abs(pos.X - x2) <= HIT_PX and math.abs(pos.Y - y2) <= HIT_PX then
			return "a2"
		end
	end
	local x1 = self:xForTime(d.t1, plotW)
	local y1 = self.chart:priceToY(d.p1)
	if math.abs(pos.X - x1) <= HIT_PX and math.abs(pos.Y - y1) <= HIT_PX then
		return "a1"
	end
	return nil
end

-- ---------------------------------------------------------------------------
-- select / move
-- ---------------------------------------------------------------------------

function DrawingLayer.setSelected(self: DrawingLayer, i: number?)
	if self.selected == i then
		return
	end
	self.selected = i
	self:render()
end

-- Both anchors move by the same (t, price) delta for a body drag; a handle drag
-- moves only its own. A ray owns ONE anchor, so its pair is kept equal whatever
-- was grabbed — hit tests and handles then never have to reason about a
-- half-moved ray.
local function applyDrag(self: DrawingLayer, dt: number, dp: number)
	local d = self.drawings[self.grabIndex]
	if d == nil then
		return
	end
	if d.kind == "ray" then
		d.t1, d.p1 = self.origT1 + dt, self.origP1 + dp
		d.t2, d.p2 = d.t1, d.p1
		return
	end
	if self.grabKind ~= "a2" then
		d.t1, d.p1 = self.origT1 + dt, self.origP1 + dp
	end
	if self.grabKind ~= "a1" then
		d.t2, d.p2 = self.origT2 + dt, self.origP2 + dp
	end
end

-- The origin is captured HERE and not at the press. The threshold pixels are
-- spent before the pan lock goes on, so the chart may already have shifted
-- under the cursor; a delta measured from the press would then teleport the
-- shape by that shift on the drag's first frame.
local function beginDrag(self: DrawingLayer)
	local d = self.drawings[self.grabIndex]
	if d == nil then
		self.grabbed = false
		return
	end
	self.dragging = true
	self.origT1, self.origP1, self.origT2, self.origP2 = d.t1, d.p1, d.t2, d.p2
	self.dragT, self.dragP = self:cursorAnchor()
	self.chart:setPanLocked(true)
	self.selected = self.grabIndex
	self:render()
end

-- The pan lock is released here and nowhere else, so no path out of a drag can
-- leave the chart unpannable. `restore` puts the anchors back where the drag
-- started (Escape); a normal release keeps them.
function DrawingLayer.cancelDrag(self: DrawingLayer, restore: boolean)
	self.grabbed = false
	if not self.dragging then
		return
	end
	self.dragging = false
	self.chart:setPanLocked(false)
	if not restore then
		return
	end
	local d = self.drawings[self.grabIndex]
	if d ~= nil then
		d.t1, d.p1, d.t2, d.p2 = self.origT1, self.origP1, self.origT2, self.origP2
	end
	self:render()
end

-- Every plot click arrives here, armed or not (the subscription is for the
-- layer's whole life). `tSec` is nil past either end of the data — an anchor
-- needs a wall-clock time, so a click with no bar under it is dropped rather
-- than anchored to an invented one.
function DrawingLayer.onClick(self: DrawingLayer, pos: Vector2, price: number, tSec: number?)
	local tool = self.tool
	if tool == "none" then
		-- implicit select mode; empty space deselects
		self:setSelected(self:hitTest(pos, true))
		return
	end
	if tool == "del" then
		local i = self:hitTest(pos)
		if i ~= nil then
			table.remove(self.drawings, i)
			self.selected = nil
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
	elseif tool == "rect" or tool == "line" then
		if not self.pending then
			if #self.drawings >= MAX_DRAWINGS then
				return
			end
			self.pendingT, self.pendingP = t, price
			self.pendingKind = tool
			self.pending = true
			startGhost(self)
			self:moveGhost()
			return
		end
		local t1, p1, kind = self.pendingT, self.pendingP, self.pendingKind
		self:cancelPending()
		table.insert(self.drawings, { kind = kind, t1 = t1, p1 = p1, t2 = t, p2 = price })
		self:render()
	end
end

-- ---------------------------------------------------------------------------
-- input
-- ---------------------------------------------------------------------------

local function wireEdit(self: DrawingLayer)
	-- The PLOT's own signal rather than UserInputService's: it fires only for
	-- presses that actually landed on the tape, so a press on a HUD panel drawn
	-- over the chart can never grab a shape sitting underneath it. (The
	-- double-consumption caveat in UI/DrawToolbar's header is about ARMED tools
	-- and is untouched by this.)
	self.chart:getPlot().InputBegan:Connect(function(input: InputObject)
		if input.UserInputType ~= Enum.UserInputType.MouseButton1 or self.tool ~= "none" then
			return
		end
		local m = self.chart:mouseToPlot()
		local kind = handleHit(self, m)
		local i = if kind ~= nil then self.selected else self:hitTest(m, true)
		if i == nil then
			self.grabbed = false
			return
		end
		-- Only a CANDIDATE until the cursor travels. A press that ends as a click
		-- must still reach the chart's click listeners, or an armed OrderPanel
		-- would silently lose the order it was aiming at whenever a drawing
		-- happened to be under the cursor.
		self.grabbed = true
		self.grabIndex = i
		self.grabKind = kind or "body"
		self.grabX, self.grabY = m.X, m.Y
	end)

	-- Tracking is global for the same reason the chart's pan is: the cursor
	-- leaves the shape on the first pixel of the drag, and routinely leaves the
	-- plot entirely.
	UserInputService.InputChanged:Connect(function(input: InputObject)
		if input.UserInputType ~= Enum.UserInputType.MouseMovement then
			return
		end
		if self.dragging then
			local t, p = self:cursorAnchor()
			applyDrag(self, t - self.dragT, p - self.dragP)
			self:render()
			return
		end
		if not self.grabbed then
			return
		end
		local m = self.chart:mouseToPlot()
		if math.abs(m.X - self.grabX) < DRAG_THRESHOLD and math.abs(m.Y - self.grabY) < DRAG_THRESHOLD then
			return
		end
		beginDrag(self)
	end)

	UserInputService.InputEnded:Connect(function(input: InputObject)
		if input.UserInputType == Enum.UserInputType.MouseButton1 then
			self:cancelDrag(false)
		end
	end)
end

local function wireKeys(self: DrawingLayer)
	-- Escape is not routed through ContextActionService: it must not be sunk
	-- away from the rest of the client (the toolbar disarms on it too). The
	-- focused-box gate is what keeps a Backspace typed into the session
	-- picker's date field from deleting a drawing instead.
	UserInputService.InputBegan:Connect(function(input: InputObject, processed: boolean)
		if processed or UserInputService:GetFocusedTextBox() ~= nil then
			return
		end
		local key = input.KeyCode
		if key == Enum.KeyCode.Escape then
			self:cancelDrag(true)
			self:setSelected(nil)
		elseif key == Enum.KeyCode.Delete or key == Enum.KeyCode.Backspace then
			local i = self.selected
			if i == nil or self.dragging then
				return
			end
			table.remove(self.drawings, i)
			self.selected = nil
			self:render()
		end
	end)
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
	self:cancelDrag(true)
	if tool ~= "none" then
		-- selection belongs to the no-tool mode: left live under an armed tool it
		-- would show handles that nothing can grab
		self:setSelected(nil)
	end
	self.chart:setClickCursor(tool ~= "none")
end

function DrawingLayer.count(self: DrawingLayer): number
	return #self.drawings
end

function DrawingLayer.clear(self: DrawingLayer)
	self:cancelPending()
	self:cancelDrag(false)
	self.selected = nil
	table.clear(self.drawings)
	self:render()
end

function DrawingLayer.new(chart: ChartView, cache: BarCache): DrawingLayer
	local plot = chart:getPlot()

	-- One rank above the placed shapes: a ghost is the thing being aimed, so it
	-- must not end up underneath a shape that is already on the chart.
	local ghost = makeRect(plot)
	ghost.fill.ZIndex = Z_TAG
	local ghostLine = makeLine(plot)
	ghostLine.line.ZIndex = Z_TAG

	local self: DrawingLayer = setmetatable(
		{
			chart = chart,
			cache = cache,
			drawings = {},
			tool = "none" :: Tool,
			rays = {},
			rects = {},
			lines = {},
			raysUsed = 0,
			rectsUsed = 0,
			linesUsed = 0,
			handles = { makeHandle(plot), makeHandle(plot) },
			selected = nil,
			pendingT = 0,
			pendingP = 0,
			pendingKind = "rect",
			pending = false,
			ghost = ghost,
			ghostLine = ghostLine,
			ghostConn = nil,
			grabbed = false,
			grabIndex = 0,
			grabKind = "body",
			grabX = 0,
			grabY = 0,
			dragging = false,
			dragT = 0,
			dragP = 0,
			origT1 = 0,
			origP1 = 0,
			origT2 = 0,
			origP2 = 0,
		} :: Fields,
		DrawingLayer
	)

	-- Subscribed ONCE, for the layer's whole life: the chart delivers every plot
	-- click and onClick is a no-op unless a tool is armed or a shape is hit.
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
	wireEdit(self)
	wireKeys(self)

	return self
end

return DrawingLayer

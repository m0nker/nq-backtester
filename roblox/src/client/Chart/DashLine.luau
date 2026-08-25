--!strict
-- A 1px dashed/dotted line, drawn as a pooled run of small Frames.
--
-- A Roblox Frame has no stroke pattern, so a dashed line is a TRANSPARENT
-- container holding one Frame per dash. Only the container is ever
-- repositioned while the line moves; the dashes inside are laid out on span
-- change alone, so a crosshair sweep or an order drag stays at one Position
-- write per line per frame.
--
-- Instance count is the whole cost of this primitive, and it is bounded per
-- line by `poolMax`: past that the PERIOD stretches instead of the pool
-- growing, so the line always reaches its far end and an oversized plot
-- degrades to a sparser pattern rather than to a line that stops halfway.

local DashLine = {}
DashLine.__index = DashLine

export type Config = {
	parent: Instance,
	name: string,
	-- vertical lines are 1px wide and grow down; horizontal ones 1px tall and
	-- grow right. The container is sized to span its parent on the long axis.
	vertical: boolean,
	color: Color3,
	zIndex: number,
	dashLen: number,
	period: number,
	poolMax: number,
}

type Fields = {
	container: Frame,
	dashes: { Frame },
	shown: number,
	vertical: boolean,
	dashLen: number,
	period: number,
	poolMax: number,
	color: Color3,
	-- last span laid out; -1 forces the first layout through
	span: number,
}

export type DashLine = typeof(setmetatable({} :: Fields, DashLine))

function DashLine.new(cfg: Config): DashLine
	local container = Instance.new("Frame")
	container.Name = cfg.name
	container.BorderSizePixel = 0
	container.BackgroundTransparency = 1
	container.Size = if cfg.vertical then UDim2.new(0, 1, 1, 0) else UDim2.new(1, 0, 0, 1)
	container.ZIndex = cfg.zIndex
	container.Visible = false
	container.Parent = cfg.parent

	return setmetatable(
		{
			container = container,
			dashes = {},
			shown = 0,
			vertical = cfg.vertical,
			dashLen = cfg.dashLen,
			period = cfg.period,
			poolMax = cfg.poolMax,
			color = cfg.color,
			span = -1,
		} :: Fields,
		DashLine
	)
end

-- The container is public so the owner can anchor/position it however its own
-- geometry needs; this module only ever touches the dashes inside.
function DashLine.getContainer(self: DashLine): Frame
	return self.container
end

-- Re-cut the run to `span` pixels. Called on resize only — pool growth is a
-- one-off extension, exactly like the candle slots.
function DashLine.layout(self: DashLine, span: number)
	if span == self.span then
		return
	end
	self.span = span
	local period = self.period
	local want = math.max(0, math.ceil(span / period))
	if want > self.poolMax then
		want = self.poolMax
		period = span / self.poolMax
	end
	for i = #self.dashes + 1, want do
		local d = Instance.new("Frame")
		d.Name = "D" .. i
		d.BorderSizePixel = 0
		d.BackgroundColor3 = self.color
		d.ZIndex = 1
		d.Visible = false
		d.Parent = self.container
		self.dashes[i] = d
	end
	for i = 1, want do
		local off = math.round((i - 1) * period)
		local d = self.dashes[i]
		if self.vertical then
			d.Position = UDim2.fromOffset(0, off)
			d.Size = UDim2.fromOffset(1, self.dashLen)
		else
			d.Position = UDim2.fromOffset(off, 0)
			d.Size = UDim2.fromOffset(self.dashLen, 1)
		end
	end
	for k = want + 1, self.shown do
		self.dashes[k].Visible = false
	end
	for k = self.shown + 1, want do
		self.dashes[k].Visible = true
	end
	self.shown = want
end

function DashLine.setColor(self: DashLine, color: Color3)
	if self.color == color then
		return
	end
	self.color = color
	for i = 1, #self.dashes do
		self.dashes[i].BackgroundColor3 = color
	end
end

function DashLine.setVisible(self: DashLine, v: boolean)
	if self.container.Visible ~= v then
		self.container.Visible = v
	end
end

function DashLine.isVisible(self: DashLine): boolean
	return self.container.Visible
end

function DashLine.setPosition(self: DashLine, pos: UDim2)
	if self.container.Position ~= pos then
		self.container.Position = pos
	end
end

return DashLine

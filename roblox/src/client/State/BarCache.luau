--!strict
-- The client's bar model, and the only place decoded bars live on the client.
--
-- No-lookahead is the SERVER's invariant: the Bars remote only ever carries
-- bars the replay clock has revealed, so everything held here is renderable as
-- is. Nothing in this module knows the current time, and nothing may synthesize
-- a bar.
--
-- Aggregation is incremental. A reveal packet only ever extends the last
-- (still-growing) bucket and possibly opens new ones, so an append re-runs the
-- aggregator over that bucket's base bars alone — O(bucket), not O(session),
-- which is what makes 500 bar/s autoplay affordable. A timeframe switch has no
-- such structure and re-aggregates in full.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Aggregate = require(Shared:WaitForChild("Replay"):WaitForChild("Aggregate"))
local BarCodec = require(Shared:WaitForChild("Data"):WaitForChild("BarCodec"))
local Types = require(Shared:WaitForChild("Types"))

type Bar = Types.Bar
type Timeframe = Types.Timeframe

local BarCache = {}
BarCache.__index = BarCache

type Fields = {
	baseSec: number,
	tf: Timeframe,
	base: { Bar },
	candles: { Bar },
	listeners: { () -> () },
}

export type BarCache = typeof(setmetatable({} :: Fields, BarCache))

function BarCache.new(baseSec: number): BarCache
	return setmetatable(
		{
			baseSec = baseSec,
			tf = "1m" :: Timeframe,
			base = {},
			candles = {},
			listeners = {},
		} :: Fields,
		BarCache
	)
end

-- At the base resolution the aggregator returns its INPUT array, so `candles`
-- aliases `base`. Nothing may ever mutate `candles` in place.
local function isPassthrough(self: BarCache): boolean
	return not Types.isSessionTf(self.tf) and Types.TF_SECONDS[self.tf] == self.baseSec
end

local function fire(self: BarCache)
	for _, fn in ipairs(self.listeners) do
		fn()
	end
end

local function rebuildAll(self: BarCache)
	self.candles = Aggregate.aggregate(self.base, self.tf, self.baseSec)
end

-- Index in `base` of the first bar belonging to the LAST aggregated bucket.
-- Bucket starts are monotonic and a bar always maps to a start <= its own t,
-- so any bar with t < that start belongs to an earlier bucket — the backward
-- scan therefore stops after one bucket's worth of bars.
local function tailStart(self: BarCache): number
	local n = #self.candles
	if n == 0 or #self.base == 0 then
		return 1
	end
	local startT = self.candles[n].t
	local i = #self.base
	while i > 1 and self.base[i - 1].t >= startT do
		i -= 1
	end
	return i
end

-- reset=true replaces the whole store (session start / jump / rewind);
-- reset=false appends newly revealed bars.
function BarCache.applyPacket(self: BarCache, packet: buffer, reset: boolean)
	local decoded = BarCodec.decode(packet)
	if reset then
		self.base = decoded
		rebuildAll(self)
	elseif isPassthrough(self) then
		table.move(decoded, 1, #decoded, #self.base + 1, self.base)
		self.candles = self.base
	else
		table.move(decoded, 1, #decoded, #self.base + 1, self.base)
		local from = tailStart(self)
		local slice = table.move(self.base, from, #self.base, 1, table.create(#self.base - from + 1))
		-- the last cached candle is the bucket that may have grown; the slice
		-- carries all of its base bars, so it is rebuilt rather than patched
		if #self.candles > 0 then
			self.candles[#self.candles] = nil
		end
		for _, c in ipairs(Aggregate.aggregate(slice, self.tf, self.baseSec)) do
			table.insert(self.candles, c)
		end
	end
	fire(self)
end

function BarCache.setTimeframe(self: BarCache, tf: Timeframe)
	if tf == self.tf then
		return
	end
	self.tf = tf
	rebuildAll(self)
	fire(self)
end

function BarCache.setBaseSec(self: BarCache, baseSec: number)
	if baseSec == self.baseSec then
		return
	end
	self.baseSec = baseSec
	rebuildAll(self)
	fire(self)
end

function BarCache.getTimeframe(self: BarCache): Timeframe
	return self.tf
end

-- Read-only: the returned array is the live cache, not a copy.
function BarCache.getCandles(self: BarCache): { Bar }
	return self.candles
end

function BarCache.onChanged(self: BarCache, fn: () -> ())
	table.insert(self.listeners, fn)
end

return BarCache

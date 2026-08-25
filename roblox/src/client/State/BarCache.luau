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
--
-- Deep history (META_PLAN §4.4) is a SECOND array at a coarser resolution: 1h
-- bars, all of them closed before the session's first bar, held apart from
-- `base` and spliced in front of the live candles on the timeframes an hourly
-- bar can build. It is not session data — no reset, reveal or rewind may touch
-- it, and only a new history packet replaces it.

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Aggregate = require(Shared:WaitForChild("Replay"):WaitForChild("Aggregate"))
local BarCodec = require(Shared:WaitForChild("Data"):WaitForChild("BarCodec"))
local Protocol = require(Shared:WaitForChild("Net"):WaitForChild("Protocol"))
local Types = require(Shared:WaitForChild("Types"))

type Bar = Types.Bar
type Timeframe = Types.Timeframe

-- Timeframes whose deep history can come from the hourly series. Below 1h an
-- hourly bar cannot be split, so those stay minute-only.
local HOURLY_BACKED: { [Timeframe]: boolean } =
	{ ["1h"] = true, ["4h"] = true, ["1D"] = true, ["1W"] = true, ["1M"] = true }

local BarCache = {}
BarCache.__index = BarCache

type Fields = {
	baseSec: number,
	tf: Timeframe,
	base: { Bar },
	candles: { Bar },
	hist: { Bar }, -- 1h bars, all closed before base[1] opened
	histDerived: { [Timeframe]: { Bar } }, -- aggregate(hist, tf, HISTORY_SEC), cached
	-- Leading candles built from `hist` ALONE. The append path rebuilds the last
	-- bucket from base bars, so it must never reach into these.
	histCount: number,
	-- The history bucket the first live candle shares a start with, kept because
	-- an append rebuilds that bucket from `base` and has to re-merge it.
	seam: Bar?,
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
			hist = {},
			histDerived = {},
			histCount = 0,
			seam = nil,
			listeners = {},
		} :: Fields,
		BarCache
	)
end

-- At the base resolution the aggregator returns its INPUT array, so `candles`
-- aliases `base`. Nothing may ever mutate `candles` in place. A spliced history
-- makes `candles` an array of its own, so the fast path is off while one is in
-- play whatever the resolutions are.
local function isPassthrough(self: BarCache): boolean
	if self.histCount > 0 or self.seam ~= nil then
		return false
	end
	return not Types.isSessionTf(self.tf) and Types.TF_SECONDS[self.tf] == self.baseSec
end

local function fire(self: BarCache)
	for _, fn in ipairs(self.listeners) do
		fn()
	end
end

-- `Aggregate.aggregate` returns its INPUT array when the timeframe already IS
-- the given resolution, so the "1h" entry ALIASES `hist`. Same rule as
-- `candles`: alias, never copy, and never write into what comes back.
local function histCandles(self: BarCache): { Bar }
	local cached = self.histDerived[self.tf]
	if cached ~= nil then
		return cached
	end
	local derived = Aggregate.aggregate(self.hist, self.tf, Protocol.HISTORY_SEC)
	self.histDerived[self.tf] = derived
	return derived
end

-- The join bucket is covered by BOTH series: its opening span is hourly (the
-- history stops a whole hour before the first minute bar) and its tail is
-- minutes. Dropping either side leaves one visibly broken candle at the seam,
-- so they are merged into a NEW bar — writing into `histBucket` would corrupt
-- the cached history aggregate it belongs to.
local function mergeSeam(histBucket: Bar, liveBucket: Bar): Bar
	return {
		t = histBucket.t,
		o = histBucket.o,
		h = math.max(histBucket.h, liveBucket.h),
		l = math.min(histBucket.l, liveBucket.l),
		c = liveBucket.c,
		v = histBucket.v + liveBucket.v,
	}
end

local function rebuildAll(self: BarCache)
	local live = Aggregate.aggregate(self.base, self.tf, self.baseSec)
	self.seam = nil
	self.histCount = 0
	if #self.hist == 0 or not HOURLY_BACKED[self.tf] then
		self.candles = live
		return
	end
	local hist = histCandles(self)
	-- The only cut needed is against the first base bar: everything in `hist`
	-- closed before it (the server asserts that), so unlike the web's version of
	-- this splice there is no replay clock left to clip against — the client has
	-- none and does not need one.
	local limit = if #self.base > 0 then self.base[1].t else math.huge
	-- Binary-searched rather than scanned: bucket starts ascend, so only the
	-- boundary is in question, and a linear pass over a 20k-bar series on every
	-- timeframe switch is exactly what made the web app stall.
	local lo, hi = 1, #hist + 1
	while lo < hi do
		local mid = (lo + hi) // 2
		if hist[mid].t < limit then
			lo = mid + 1
		else
			hi = mid
		end
	end
	local cut = lo - 1
	if cut <= 0 then
		self.candles = live
		return
	end
	local out = table.create(cut + #live)
	table.move(hist, 1, cut, 1, out)
	local lastHistT = hist[cut].t
	local liveFrom = 1
	while liveFrom <= #live and live[liveFrom].t < lastHistT do
		liveFrom += 1 -- the history covers this bucket in full
	end
	self.histCount = cut
	if liveFrom <= #live and live[liveFrom].t == lastHistT then
		out[cut] = mergeSeam(hist[cut], live[liveFrom])
		self.seam = hist[cut]
		self.histCount = cut - 1
		liveFrom += 1
	end
	table.move(live, liveFrom, #live, cut + 1, out)
	self.candles = out
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
-- reset=false appends newly revealed bars. mode = BARS_MODE_HISTORY is neither:
-- it carries the deep hourly series and leaves the session's own bars alone.
function BarCache.applyPacket(self: BarCache, packet: buffer, reset: boolean, mode: string?)
	local decoded = BarCodec.decode(packet)
	if mode == Protocol.BARS_MODE_HISTORY then
		-- REPLACES the stored history. It arrives asynchronously (the server reads
		-- a multi-megabyte key on its own thread), so it may land seconds into a
		-- session — and a session start does NOT clear the previous one, because
		-- the series is the same for every date and the splice re-cuts it against
		-- whatever base bars are held now.
		self.hist = decoded
		table.clear(self.histDerived)
		rebuildAll(self)
		fire(self)
		return
	end
	if reset or #self.base == 0 then
		-- With no base bars there is no live tail to extend, and the history cut is
		-- decided by base[1] — so the first packet of a session always rebuilds.
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
		-- carries all of its base bars, so it is rebuilt rather than patched.
		-- Never past histCount: those candles have no base bars behind them.
		if #self.candles > self.histCount then
			self.candles[#self.candles] = nil
		end
		local seam = self.seam
		for _, c in ipairs(Aggregate.aggregate(slice, self.tf, self.baseSec)) do
			-- The rebuilt bucket can BE the spliced seam, while the live data has
			-- not yet left it; re-merge rather than let the rebuild drop its hourly
			-- half.
			if seam ~= nil and c.t == seam.t then
				table.insert(self.candles, mergeSeam(seam, c))
			else
				table.insert(self.candles, c)
			end
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

-- True while deep history is spliced into `candles`. Its arrival shifts every
-- candle INDEX, and the camera is anchored on indices.
function BarCache.hasHistory(self: BarCache): boolean
	return self.histCount > 0 or self.seam ~= nil
end

-- Close of the newest revealed BASE bar, or nil before the first packet — which
-- at an aggregated timeframe is also the still-growing bucket's close, exactly
-- the price a mark-to-market readout wants. Read off `base` rather than
-- `candles` so a session with no revealed bars yet reports nothing instead of a
-- years-old history close.
function BarCache.getLastClose(self: BarCache): number?
	local last = self.base[#self.base]
	return if last ~= nil then last.c else nil
end

-- Read-only: the returned array is the live 1m cache, not a copy. (Session
-- bars only — never the hourly history; excursion math must not cross into
-- pre-session buckets.)
function BarCache.getBase(self: BarCache): { Bar }
	return self.base
end

function BarCache.onChanged(self: BarCache, fn: () -> ())
	table.insert(self.listeners, fn)
end

return BarCache

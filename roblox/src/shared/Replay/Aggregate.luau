--!strict
-- Pure aggregation: base-resolution bars (already clock-clipped by the bar
-- source) -> any display timeframe. The partially formed current candle falls
-- out naturally: the last bucket simply contains fewer base bars.
--
-- Fixed timeframes are aligned to the 18:00 ET trading-day open (CME ETH
-- convention), so 4h candles run 18:00, 22:00, 02:00, 06:00, 10:00, 14:00 ET.
-- Session timeframes: '1D' = one candle per trading day, '1W' = per trading
-- week (Sunday 18:00 open), '1M' = per calendar month of the trading date.

local Et = require(script.Parent.Parent.Time.Et)
local Types = require(script.Parent.Parent.Types)

type Bar = Types.Bar
type Timeframe = Types.Timeframe

local M = {}

-- A bar belongs to the trading day starting at the most recent 18:00 ET, so a
-- day's bars span up to 24h from its start (23h nominal close, plus the
-- 17:00-17:59 hour that old-era CME sessions traded through).
function M.bucketStart(tSec: number, tf: Timeframe, dayStartHint: number?): number
	if tf == "1W" then
		return Et.tradingWeekStartSec(tSec)
	end
	if tf == "1M" then
		return Et.monthBucketStartSec(tSec)
	end
	local dayStart: number
	if dayStartHint ~= nil and tSec >= dayStartHint and tSec < dayStartHint + 86400 then
		dayStart = dayStartHint
	else
		dayStart = Et.tradingDayStartSec(tSec)
	end
	if tf == "1D" then
		return dayStart
	end
	local dur = Types.TF_SECONDS[tf]
	-- tSec >= dayStart always holds here, so the floor never sees a negative.
	return dayStart + math.floor((tSec - dayStart) / dur) * dur
end

-- First instant after the bucket's nominal close. tSec may be any time inside
-- the bucket. Months are irregular, so this is a function, not a constant.
function M.bucketEnd(tSec: number, tf: Timeframe): number
	local start = M.bucketStart(tSec, tf)
	if tf == "1D" then
		return start + Types.TRADING_DAY_SEC
	end
	if tf == "1W" then
		return start + Types.TRADING_WEEK_SEC
	end
	if tf == "1M" then
		return Et.monthBucketEndSec(start)
	end
	return start + Types.TF_SECONDS[tf]
end

function M.aggregate(base: { Bar }, tf: Timeframe, baseSec: number?): { Bar }
	local bSec = if baseSec == nil then Types.BASE_RESOLUTION_SEC else baseSec
	if not Types.isSessionTf(tf) and Types.TF_SECONDS[tf] == bSec then
		return base
	end
	local weekly = tf == "1W" or tf == "1M"
	local out: { Bar } = {}
	local cur: Bar? = nil
	local dayStart = -1
	local spanEnd = -1 -- 1W/1M: recompute the (expensive) anchor only on bucket exit

	for _, b in ipairs(base) do
		-- Membership is decided by bucket start, never by elapsed duration —
		-- old-era sessions have bars past the nominal 23h close. Nominal ends
		-- are only a fast-path trigger; when exceeded we recompute the true
		-- start, which may resolve to the SAME bucket (17:00-17:59 bars) and
		-- merge.
		local start: number
		if weekly then
			if cur ~= nil and b.t >= cur.t and b.t < spanEnd then
				start = cur.t
			else
				start = M.bucketStart(b.t, tf)
				spanEnd = M.bucketEnd(b.t, tf)
			end
		else
			if b.t >= dayStart + 86400 or b.t < dayStart then
				dayStart = Et.tradingDayStartSec(b.t)
			end
			start = M.bucketStart(b.t, tf, dayStart)
		end
		if cur ~= nil and cur.t == start then
			cur.h = math.max(cur.h, b.h)
			cur.l = math.min(cur.l, b.l)
			cur.c = b.c
			cur.v += b.v
		else
			local nb: Bar = { t = start, o = b.o, h = b.h, l = b.l, c = b.c, v = b.v }
			cur = nb
			table.insert(out, nb)
		end
	end
	return out
end

return M

--!strict
-- All timestamps in the app are epoch seconds UTC. Eastern Time exists only
-- here: session-boundary math and display formatting. Nothing else may do
-- timezone arithmetic.
--
-- Pure arithmetic only — no DateTime/os.date/os.time — so this module runs
-- unchanged outside Roblox (Lune) and stays deterministic on every machine.

local M = {}

-- Howard Hinnant's civil-date algorithms; replaces JS Date/Date.UTC.
-- daysFromCivil is exact for any proleptic Gregorian date; all callers here
-- pass post-1970 dates, so every intermediate below is non-negative.
local function daysFromCivil(y: number, m: number, d: number): number
	local yy = if m <= 2 then y - 1 else y
	local era = math.floor(yy / 400)
	local yoe = yy - era * 400 -- [0, 399]
	local mp = if m > 2 then m - 3 else m + 9 -- [0, 11]
	local doy = math.floor((153 * mp + 2) / 5) + d - 1 -- [0, 365]
	local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy -- [0, 146096]
	return era * 146097 + doe - 719468
end

local function civilFromDays(z: number): (number, number, number)
	local zz = z + 719468
	local era = math.floor(zz / 146097)
	local doe = zz - era * 146097 -- [0, 146096]
	local yoe = math.floor((doe - math.floor(doe / 1460) + math.floor(doe / 36524) - math.floor(doe / 146096)) / 365) -- [0, 399]
	local y = yoe + era * 400
	local doy = doe - (365 * yoe + math.floor(yoe / 4) - math.floor(yoe / 100)) -- [0, 365]
	local mp = math.floor((5 * doy + 2) / 153) -- [0, 11]
	local d = doy - math.floor((153 * mp + 2) / 5) + 1 -- [1, 31]
	local m = if mp < 10 then mp + 3 else mp - 9
	return (if m <= 2 then y + 1 else y), m, d
end

-- 1970-01-01 was a Thursday, so day 0 -> 4. Day numbers here are post-1970
-- (non-negative), so floored vs truncated modulo cannot diverge.
local function weekdayFromDays(days: number): number
	return (days + 4) % 7 -- 0 = Sunday
end

-- ET offset computed arithmetically from the post-2007 US DST rule (2nd
-- Sunday of March 02:00 EST -> 1st Sunday of November 02:00 EDT). All data is
-- 2010+, where this rule is exact. O(1) arithmetic, no locale tables.
local dstBoundsCache: { [number]: { number } } = {} -- year -> {startSec, endSec} in UTC

local function dstBounds(year: number): (number, number)
	local b = dstBoundsCache[year]
	if b == nil then
		-- (7 - weekday) is in [1, 7]: no negative operand reaches the modulo.
		local secondSunMar = 8 + ((7 - weekdayFromDays(daysFromCivil(year, 3, 8))) % 7)
		local firstSunNov = 1 + ((7 - weekdayFromDays(daysFromCivil(year, 11, 1))) % 7)
		b = {
			daysFromCivil(year, 3, secondSunMar) * 86400 + 7 * 3600, -- 02:00 EST = 07:00 UTC
			daysFromCivil(year, 11, firstSunNov) * 86400 + 6 * 3600, -- 02:00 EDT = 06:00 UTC
		}
		dstBoundsCache[year] = b
	end
	return b[1], b[2]
end

-- Offset such that: ET wall-clock (as fake-UTC sec) = UTC sec + offset.
function M.etOffsetSec(tsSec: number): number
	local y: number = civilFromDays(math.floor(tsSec / 86400))
	local startSec, endSec = dstBounds(y)
	return if tsSec >= startSec and tsSec < endSec then -14400 else -18000
end

export type EtParts = { y: number, mo: number, d: number, h: number, mi: number, s: number }

local function parts(tsSec: number): EtParts
	local wall = tsSec + M.etOffsetSec(tsSec)
	local days = math.floor(wall / 86400)
	local rem = wall - days * 86400 -- [0, 86400) by construction
	local y, mo, d = civilFromDays(days)
	return {
		y = y,
		mo = mo,
		d = d,
		h = math.floor(rem / 3600),
		mi = math.floor((rem % 3600) / 60),
		s = math.floor(rem % 60),
	}
end

-- Convert an ET wall-clock time to epoch seconds UTC (DST-correct).
function M.etWallToUtc(y: number, mo: number, d: number, h: number, mi: number?, s: number?): number
	local want = daysFromCivil(y, mo, d) * 86400 + h * 3600 + (mi or 0) * 60 + (s or 0)
	local guess = want
	for _ = 1, 3 do
		local p = parts(guess)
		local shown = daysFromCivil(p.y, p.mo, p.d) * 86400 + p.h * 3600 + p.mi * 60 + p.s
		guess += want - shown
	end
	return guess
end

-- Start (18:00 ET) of the CME trading day containing tsSec.
function M.tradingDayStartSec(tsSec: number): number
	local p = parts(tsSec)
	local todaySix = M.etWallToUtc(p.y, p.mo, p.d, 18)
	if tsSec >= todaySix then
		return todaySix
	end
	local py, pmo, pd = civilFromDays(daysFromCivil(p.y, p.mo, p.d) - 1)
	return M.etWallToUtc(py, pmo, pd, 18)
end

-- Start (Sunday 18:00 ET open) of the trading week containing tsSec.
-- A week's bars run Sun 18:00 -> Fri 17:00; DST transitions (Sunday 2:00 AM)
-- never fall inside that span, so plain day arithmetic is exact.
function M.tradingWeekStartSec(tsSec: number): number
	local dayStart = M.tradingDayStartSec(tsSec)
	local etWeekday = weekdayFromDays(math.floor((dayStart + M.etOffsetSec(dayStart)) / 86400))
	return dayStart - etWeekday * 86400
end

-- Calendar y/m/d of the trading DATE a timestamp belongs to: bars at/after
-- 18:00 ET belong to the NEXT calendar date's trading day.
local function tradingDateParts(tsSec: number): (number, number, number)
	local p = parts(tsSec)
	local days = daysFromCivil(p.y, p.mo, p.d)
	if p.h >= 18 then
		days += 1
	end
	return civilFromDays(days)
end

-- Start of the calendar-month bucket containing tsSec's trading date.
-- Anchored at 18:00 ET on the LAST day of the previous month, because the
-- month's first trading day opens the prior evening — the anchor must be
-- <= every bar in the bucket or the no-lookahead assertion would trip.
function M.monthBucketStartSec(tsSec: number): number
	local y, mo = tradingDateParts(tsSec)
	local ly, lmo, ld = civilFromDays(daysFromCivil(y, mo, 1) - 1)
	return M.etWallToUtc(ly, lmo, ld, 18)
end

-- End of a month bucket = the next month's anchor. startSec must be a value
-- returned by monthBucketStartSec; +35 days always lands inside the next
-- bucket's month regardless of month length.
function M.monthBucketEndSec(startSec: number): number
	return M.monthBucketStartSec(startSec + 35 * 86400)
end

-- The trading DATE (YYYY-MM-DD) a timestamp belongs to.
function M.tradingDateOf(tsSec: number): string
	local y, mo, d = tradingDateParts(tsSec)
	return string.format("%04d-%02d-%02d", y, mo, d)
end

function M.formatET(tsSec: number, withDate: boolean?): string
	local p = parts(tsSec)
	local time = string.format("%02d:%02d", p.h, p.mi)
	if withDate == nil or withDate then
		return string.format("%04d-%02d-%02d %s ET", p.y, p.mo, p.d, time)
	end
	return time
end

return M

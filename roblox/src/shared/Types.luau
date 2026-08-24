--!strict
-- A bar's `t` is its OPEN time, epoch seconds UTC.
-- A bar is "visible" at replay time T iff it has CLOSED: t + duration <= T.

local M = {}

export type Bar = { t: number, o: number, h: number, l: number, c: number, v: number }
export type Timeframe = string

-- Sub-minute timeframes are CUT in this port: there is no 1s base data on the
-- platform (see PORT_PLAN), so the ladder starts at the 1m base resolution.
local TIMEFRAMES: { Timeframe } = { "1m", "2m", "3m", "4m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M" }

-- Session-anchored timeframes have variable/irregular spans (trading day,
-- trading week, calendar month) — everything else is a fixed number of seconds
-- aligned to the 18:00 ET trading-day open.
local SESSION_TFS: { Timeframe } = { "1D", "1W", "1M" }

local TF_SECONDS: { [Timeframe]: number } = {
	["1m"] = 60,
	["2m"] = 120,
	["3m"] = 180,
	["4m"] = 240,
	["5m"] = 300,
	["15m"] = 900,
	["30m"] = 1800,
	["1h"] = 3600,
	["4h"] = 14400,
}

local function isSessionTf(tf: Timeframe): boolean
	return tf == "1D" or tf == "1W" or tf == "1M"
end

-- Timeframes renderable from a given base resolution.
local function availableTimeframes(baseSec: number): { Timeframe }
	local out: { Timeframe } = {}
	for _, tf in ipairs(TIMEFRAMES) do
		local sec = TF_SECONDS[tf]
		if isSessionTf(tf) or (sec ~= nil and sec >= baseSec) then
			table.insert(out, tf)
		end
	end
	return out
end

local RESOLUTION_SECONDS: { [string]: number } = {
	["1s"] = 1,
	["1m"] = 60,
}

M.TIMEFRAMES = TIMEFRAMES
M.SESSION_TFS = SESSION_TFS
M.TF_SECONDS = TF_SECONDS
M.RESOLUTION_SECONDS = RESOLUTION_SECONDS
M.isSessionTf = isSessionTf
M.availableTimeframes = availableTimeframes

M.BASE_RESOLUTION_SEC = 60 -- default; the bar source overrides from the manifest

-- One CME trading day: 18:00 ET -> 17:00 ET next day. DST transitions happen
-- Sunday 2:00 AM ET while the market is closed, so every trading day is
-- exactly 23 hours long. (2010-2015-era data trades into the 17:00-17:59
-- hour, so a day's bars can span up to 24h from its open — bucket membership
-- is therefore always decided by bucket START, never elapsed duration.)
M.TRADING_DAY_SEC = 23 * 3600

-- One trading week: Sunday 18:00 ET open -> Friday 17:00 ET close. DST
-- transitions never fall inside this span (they're Sunday 2:00 AM ET).
M.TRADING_WEEK_SEC = 5 * 86400 - 3600

return M

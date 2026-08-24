--!strict
-- NQ contract math. Instrument-parametric so other symbols can plug in later.

local M = {}

export type Instrument = { tickSize: number, tickValue: number, pointValue: number }

local NQ: Instrument = { tickSize = 0.25, tickValue = 5.0, pointValue = 20.0 }
M.NQ = NQ

-- JS Math.round is half-UP (toward +inf); Luau's math.round is half-away-from-
-- zero. Ported as floor(x + 0.5) so negative half-values match the reference.
local function jsRound(x: number): number
	return math.floor(x + 0.5)
end

-- Contracts trade in 0.1 steps (simulating MNQ: 0.1 NQ = 1 MNQ). Quantities
-- MUST pass through quantizeQty at every accumulation point — float drift
-- (0.1 + 0.2 = 0.30000000000000004) would otherwise break the reducer's
-- `qty == 0` flat detection.
M.QTY_STEP = 0.1

function M.quantizeQty(q: number): number
	return jsRound(q * 10) / 10
end

-- user-facing rounding: nearest 0.1, floor at the 0.1 minimum
function M.roundQty(q: number): number
	return math.max(M.QTY_STEP, M.quantizeQty(q))
end

function M.roundToTick(price: number, tickSize: number?): number
	local ts = if tickSize == nil then NQ.tickSize else tickSize
	return jsRound(price / ts) * ts
end

function M.ptsToUsd(points: number, qty: number, pointValue: number?): number
	local pv = if pointValue == nil then NQ.pointValue else pointValue
	return points * pv * qty
end

function M.fmtPts(points: number): string
	local sign = if points >= 0 then "+" else ""
	return string.format("%s%.2f pts", sign, points)
end

function M.fmtUsd(usd: number): string
	local sign = if usd < 0 then "-" elseif usd > 0 then "+" else ""
	return string.format("%s$%.2f", sign, math.abs(usd))
end

return M

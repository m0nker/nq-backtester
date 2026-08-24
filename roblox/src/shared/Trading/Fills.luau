--!strict
-- Fill simulation — ALL fill assumptions live in this module.
--
-- Rules (v1, documented in the UI):
--  - Market orders fill at the OPEN of the next revealed base bar.
--  - Buy limit fills when the bar trades at/through the level: bar.low <=
--    limit; price = min(bar.open, limit) (gap-through fills better, at open).
--    Sell limit mirrored.
--  - Buy stop triggers on touch: bar.high >= stop; price = max(bar.open,
--    stop) (gap-through fills worse, at open). Sell stop mirrored.
--  - Within one bar, stops are evaluated BEFORE limits (conservative).
--  - If a bracket's stop-loss AND take-profit both trigger in the same base
--    bar, the 1-second data for that minute (when available) is replayed to
--    find which level was touched FIRST; the winner fills at the usual
--    1m-bar price formula. Only when 1s coverage is absent — or both levels
--    are hit inside the same 1s bar — does the conservative default apply:
--    STOP-LOSS honored, fill flagged ambiguousBar.
--  - No partial fills, no commission in v1 (config slot exists).
--
-- This port ships no 1s data, so secondsFor is always nil in game; it stays in
-- the API because the parity fixtures exercise it.

local EventTypes = require(script.Parent.Parent.Events.Types)
local Types = require(script.Parent.Parent.Types)

type Bar = Types.Bar
type Side = EventTypes.Side
type FillKind = EventTypes.FillKind

local M = {}

export type WorkingOrder = {
	id: string,
	side: Side,
	type: "market" | "limit" | "stop",
	qty: number,
	limitPrice: number?,
	stopPrice: number?,
	ocoId: string?,
	reduceOnly: boolean?,
	bracket: EventTypes.BracketSpec?,
}

export type FillIntent = {
	orderId: string,
	side: Side,
	qty: number,
	price: number,
	fillKind: FillKind,
	ambiguousBar: boolean,
}

-- Lazy provider of 1s bars covering [fromTs, toTs); nil = no coverage.
export type SecondsResolver = (fromTs: number, toTs: number) -> { Bar }?

type Trigger = { hit: boolean, price: number, kind: FillKind }

local function triggers(o: WorkingOrder, bar: Bar): Trigger
	if o.type == "market" then
		return { hit = true, price = bar.o, kind = "market_next_open" }
	end
	if o.type == "limit" then
		local lim = o.limitPrice :: number
		if o.side == "buy" and bar.l <= lim then
			return { hit = true, price = math.min(bar.o, lim), kind = "limit_touch" }
		end
		if o.side == "sell" and bar.h >= lim then
			return { hit = true, price = math.max(bar.o, lim), kind = "limit_touch" }
		end
		return { hit = false, price = 0, kind = "limit_touch" }
	end
	local stp = o.stopPrice :: number
	if o.side == "buy" and bar.h >= stp then
		return { hit = true, price = math.max(bar.o, stp), kind = "stop_trigger" }
	end
	if o.side == "sell" and bar.l <= stp then
		return { hit = true, price = math.min(bar.o, stp), kind = "stop_trigger" }
	end
	return { hit = false, price = 0, kind = "stop_trigger" }
end

type Decision = { winnerId: string, ambiguous: boolean }

-- Evaluate one newly revealed base bar against the working orders.
-- Returns fills in execution order. OCO resolution (cancelling siblings) is
-- the caller's job — but same-bar OCO conflicts are resolved HERE: by 1s
-- replay when secondsFor provides data, else SL-first + ambiguous flag.
function M.simulateBar(
	orders: { WorkingOrder },
	bar: Bar,
	secondsFor: SecondsResolver?,
	barDurSec: number?
): { FillIntent }
	local barDur = if barDurSec == nil then 60 else barDurSec
	local fills: { FillIntent } = {}
	local filledOco: { [string]: boolean } = {} -- oco group ids consumed this bar

	-- Decide same-bar stop+limit OCO conflicts up front. Fill PRICES stay at
	-- 1-minute granularity (the usual bar formulas) — the 1s replay only
	-- decides WHICH leg fills.
	local decisions: { [string]: Decision } = {}
	local ocoIds: { string } = {} -- insertion order, so secondsFor is called deterministically
	local byOco: { [string]: { WorkingOrder } } = {}
	for _, o in ipairs(orders) do
		local ocoId = o.ocoId
		if ocoId ~= nil then
			local group = byOco[ocoId]
			if group == nil then
				group = {}
				byOco[ocoId] = group
				table.insert(ocoIds, ocoId)
			end
			table.insert(group :: { WorkingOrder }, o)
		end
	end
	for _, ocoId in ipairs(ocoIds) do
		local group = byOco[ocoId]
		if #group ~= 2 then
			continue
		end
		local stop: WorkingOrder? = nil
		local limit: WorkingOrder? = nil
		for _, o in ipairs(group) do
			if stop == nil and o.type == "stop" then
				stop = o
			end
			if limit == nil and o.type == "limit" then
				limit = o
			end
		end
		-- one guard instead of the TS's two `continue`s; same short-circuit order
		if stop ~= nil and limit ~= nil and triggers(stop, bar).hit and triggers(limit, bar).hit then
			local winnerId = stop.id -- conservative default: SL first
			local ambiguous = true
			local secs = if secondsFor ~= nil then secondsFor(bar.t, bar.t + barDur) else nil
			if secs ~= nil then
				for _, sb in ipairs(secs) do
					local sHit = triggers(stop, sb).hit
					local lHit = triggers(limit, sb).hit
					if not sHit and not lHit then
						continue
					end
					winnerId = if sHit then stop.id else limit.id
					ambiguous = sHit and lHit -- both touched inside one second
					break
				end
				-- neither level touched in the 1s replay (data gap): default stands
			end
			decisions[ocoId] = { winnerId = winnerId, ambiguous = ambiguous }
		end
	end

	-- conservative intrabar ordering: markets, then stops, then limits
	local ordered: { WorkingOrder } = {}
	for _, o in ipairs(orders) do
		if o.type == "market" then
			table.insert(ordered, o)
		end
	end
	for _, o in ipairs(orders) do
		if o.type == "stop" then
			table.insert(ordered, o)
		end
	end
	for _, o in ipairs(orders) do
		if o.type == "limit" then
			table.insert(ordered, o)
		end
	end

	for _, o in ipairs(ordered) do
		local ocoId = o.ocoId
		if ocoId ~= nil and filledOco[ocoId] then
			continue -- sibling already filled this bar
		end
		local decision = if ocoId ~= nil then decisions[ocoId] else nil
		if decision ~= nil and o.id ~= decision.winnerId then
			continue -- lost the same-bar race
		end
		local t = triggers(o, bar)
		if not t.hit then
			continue
		end

		if ocoId ~= nil then
			filledOco[ocoId] = true
		end
		table.insert(fills, {
			orderId = o.id,
			side = o.side,
			qty = o.qty,
			price = t.price,
			fillKind = t.kind,
			ambiguousBar = if decision ~= nil then decision.ambiguous else false,
		})
	end
	return fills
end

return M

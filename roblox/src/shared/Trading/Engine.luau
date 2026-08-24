--!strict
-- Event reducer: fold(events) -> derived trading state. Derived state is
-- never stored; the append-only log is the truth.
--
-- Rewind voiding is DERIVED, not written: a time_rewound event causes every
-- earlier order/fill event with tsMarket after the rewind target to be
-- treated as void. Nothing in the log is mutated — replaying the fold always
-- reproduces the same state, and the voided timeline stays auditable.

local ContractMath = require(script.Parent.ContractMath)
local EventTypes = require(script.Parent.Parent.Events.Types)
local Fills = require(script.Parent.Fills)

type Side = EventTypes.Side
type SessionEvent = EventTypes.SessionEvent
type WorkingOrder = Fills.WorkingOrder

local M = {}

export type Trade = {
	entryTs: number,
	exitTs: number,
	side: Side,
	qty: number, -- max size held during the round trip
	avgEntry: number,
	avgExit: number,
	pnlPts: number,
	pnlUsd: number,
	ambiguous: boolean, -- any constituent fill was on an SL/TP-ambiguous bar
	-- set when the opening fill carried a bracket (enables R-multiples + viewer levels)
	riskPts: number?,
	slPrice: number?,
	tpPrice: number?,
}

export type EngineState = {
	workingOrders: { WorkingOrder },
	position: { qty: number, avgPrice: number }, -- qty signed: + long, - short
	realizedPts: number,
	realizedUsd: number,
	trades: { Trade },
	voidedCount: number,
	startingBalance: number,
}

type OpenTrade = {
	entryTs: number,
	side: Side,
	maxQty: number,
	entrySum: number, -- sum(price*qty) of position-increasing fills
	entryQty: number,
	exitSum: number,
	exitQty: number,
	ambiguous: boolean,
	riskPts: number?,
	slPrice: number?,
	tpPrice: number?,
}

local ORDER_EVENTS: { [string]: boolean } = {
	order_placed = true,
	order_modified = true,
	order_cancelled = true,
	order_filled = true,
}

function M.deriveState(events: { SessionEvent }): EngineState
	-- pass 1: apply rewind voiding
	local accepted: { SessionEvent } = {}
	local voidedCount = 0
	for _, ev in ipairs(events) do
		if ev.type == "time_rewound" then
			local to = (ev.payload :: EventTypes.TimeRewoundPayload).to
			for i = #accepted, 1, -1 do
				if ORDER_EVENTS[accepted[i].type] and accepted[i].tsMarket > to then
					table.remove(accepted, i)
					voidedCount += 1
				end
			end
			continue
		end
		table.insert(accepted, ev)
	end

	-- pass 2: fold
	local state: EngineState = {
		workingOrders = {},
		position = { qty = 0, avgPrice = 0 },
		realizedPts = 0,
		realizedUsd = 0,
		trades = {},
		voidedCount = voidedCount,
		startingBalance = 0,
	}

	-- Insertion-ordered map: the order of `workingOrders` is observable output,
	-- so key order can never come from pairs(). N is tiny; O(n) delete is fine.
	local orderIds: { string } = {}
	local ordersById: { [string]: WorkingOrder } = {}
	local function setOrder(id: string, o: WorkingOrder)
		if ordersById[id] == nil then
			table.insert(orderIds, id)
		end
		ordersById[id] = o
	end
	local function deleteOrder(id: string)
		if ordersById[id] == nil then
			return
		end
		ordersById[id] = nil
		local i = table.find(orderIds, id)
		if i ~= nil then
			table.remove(orderIds, i)
		end
	end

	local open: OpenTrade? = nil

	for _, ev in ipairs(accepted) do
		if ev.type == "session_started" then
			state.startingBalance = (ev.payload :: EventTypes.SessionStartedPayload).startingBalance
		elseif ev.type == "order_placed" then
			local p = ev.payload :: EventTypes.OrderPlacedPayload
			setOrder(p.orderId, {
				id = p.orderId,
				side = p.side,
				type = p.type,
				qty = p.qty,
				limitPrice = p.limitPrice,
				stopPrice = p.stopPrice,
				ocoId = p.ocoId,
				reduceOnly = p.reduceOnly,
				bracket = p.bracket,
			})
		elseif ev.type == "order_modified" then
			local p = ev.payload :: EventTypes.OrderModifiedPayload
			local o = ordersById[p.orderId]
			if o ~= nil then
				for k, v in pairs(p.changes :: { [string]: any }) do
					(o :: any)[k] = v
				end
			end
		elseif ev.type == "order_cancelled" then
			deleteOrder((ev.payload :: EventTypes.OrderCancelledPayload).orderId)
		elseif ev.type == "order_filled" then
			local p = ev.payload :: EventTypes.OrderFilledPayload
			local filledOrder = ordersById[p.orderId]
			deleteOrder(p.orderId)
			local signed = if p.side == "buy" then p.qty else -p.qty
			local pos = state.position

			if pos.qty == 0 or math.sign(pos.qty) == math.sign(signed) then
				-- opening or adding
				if pos.qty == 0 then
					local dir = if p.side == "buy" then 1 else -1
					local bracket = if filledOrder ~= nil then filledOrder.bracket else nil
					-- normalize both bracket forms to risk/SL/TP off the actual fill
					local riskPts: number? = nil
					local slPrice: number? = nil
					local tpPrice: number? = nil
					if bracket ~= nil then
						if bracket.stopPrice ~= nil then
							local risk = (p.price - bracket.stopPrice) * dir
							riskPts = risk
							slPrice = bracket.stopPrice
							if bracket.tpPrice ~= nil then
								tpPrice = bracket.tpPrice -- absolute-TP form: the edge, exactly
							elseif risk > 0 then
								tpPrice = p.price + dir * (bracket.rr :: number) * risk
							else
								tpPrice = nil
							end
						else
							riskPts = bracket.stopLossPts
							slPrice = p.price - dir * (bracket.stopLossPts :: number)
							tpPrice = p.price + dir * (bracket.takeProfitPts :: number)
						end
					end
					open = {
						entryTs = ev.tsMarket,
						side = p.side,
						maxQty = p.qty,
						entrySum = p.price * p.qty,
						entryQty = p.qty,
						exitSum = 0,
						exitQty = 0,
						ambiguous = p.ambiguousBar,
						riskPts = riskPts,
						slPrice = slPrice,
						tpPrice = tpPrice,
					}
				elseif open ~= nil then
					open.entrySum += p.price * p.qty
					open.entryQty += p.qty
					open.maxQty = math.max(open.maxQty, math.abs(pos.qty + signed))
					open.ambiguous = open.ambiguous or p.ambiguousBar
				end
				pos.avgPrice = (pos.avgPrice * math.abs(pos.qty) + p.price * p.qty) / (math.abs(pos.qty) + p.qty)
				pos.qty = ContractMath.quantizeQty(pos.qty + signed)
			else
				-- reducing / closing / reversing
				local closeQty = math.min(math.abs(pos.qty), p.qty)
				local dir = math.sign(pos.qty) -- +1 long
				local pnl = (p.price - pos.avgPrice) * closeQty * dir
				state.realizedPts += pnl
				state.realizedUsd += ContractMath.ptsToUsd(pnl, 1)
				if open ~= nil then
					open.exitSum += p.price * closeQty
					open.exitQty += closeQty
					open.ambiguous = open.ambiguous or p.ambiguousBar
				end
				pos.qty = ContractMath.quantizeQty(pos.qty + signed)

				if math.sign(pos.qty) ~= dir then
					-- flat (or reversed): close the round trip
					if open ~= nil then
						local tradeDir = if open.side == "buy" then 1 else -1
						-- entryQty always equals exitQty here (a round trip closes what
						-- it opened), so USD PnL is exact even with scale-ins/outs.
						table.insert(state.trades, {
							entryTs = open.entryTs,
							exitTs = ev.tsMarket,
							side = open.side,
							qty = open.maxQty,
							avgEntry = open.entrySum / open.entryQty,
							avgExit = open.exitSum / open.exitQty,
							pnlPts = (open.exitSum / open.exitQty - open.entrySum / open.entryQty) * tradeDir,
							pnlUsd = ContractMath.ptsToUsd((open.exitSum - open.entrySum) * tradeDir, 1),
							ambiguous = open.ambiguous,
							riskPts = open.riskPts,
							slPrice = open.slPrice,
							tpPrice = open.tpPrice,
						})
						open = nil
					end
					if pos.qty ~= 0 then
						-- reversal: remainder opens a new trade at this fill price
						pos.avgPrice = p.price
						open = {
							entryTs = ev.tsMarket,
							side = if pos.qty > 0 then "buy" else "sell",
							maxQty = math.abs(pos.qty),
							entrySum = p.price * math.abs(pos.qty),
							entryQty = math.abs(pos.qty),
							exitSum = 0,
							exitQty = 0,
							ambiguous = p.ambiguousBar,
						}
					else
						pos.avgPrice = 0
					end
				end
			end
		end
		-- time/timeframe events don't affect trading state
	end

	local workingOrders: { WorkingOrder } = {}
	for _, id in ipairs(orderIds) do
		table.insert(workingOrders, ordersById[id])
	end
	state.workingOrders = workingOrders
	return state
end

return M

--!strict
-- Event payload shapes. Field names match the TS payloads EXACTLY (camelCase):
-- they are the on-the-wire JSON, and the parity fixtures serialize them.

local M = {}

export type Side = "buy" | "sell"
export type OrderType = "market" | "limit" | "stop"
export type FillKind = "market_next_open" | "limit_touch" | "stop_trigger"
export type CancelReason = "user" | "oco" | "reduce_only_noop" | "position_closed"

-- Bracket attached to an entry order. Three mutually exclusive forms, flattened
-- into one optional-field record (Luau cannot narrow a table-type union):
--  - points: stopLossPts/takeProfitPts, distances from the entry fill price;
--  - absolute stop + rr: SL pinned at stopPrice (bot swing-extreme stops), TP
--    at rr × the realized risk from the ACTUAL fill;
--  - fully absolute: stopPrice + tpPrice, both pinned (mech target-gap trades,
--    where the TP must sit AT the gap edge regardless of entry slip).
-- Discriminate on stopPrice ~= nil, then tpPrice ~= nil.
export type BracketSpec = {
	stopLossPts: number?,
	takeProfitPts: number?,
	stopPrice: number?,
	rr: number?,
	tpPrice: number?,
}

export type SessionStartedPayload = {
	startTs: number,
	endTs: number?,
	startingBalance: number,
	config: { [string]: any },
}

export type TimeRewoundPayload = { from: number, to: number }

export type OrderPlacedPayload = {
	orderId: string,
	side: Side,
	type: OrderType,
	qty: number,
	limitPrice: number?,
	stopPrice: number?,
	bracket: BracketSpec?,
	ocoId: string?, -- sibling order cancelled when this fills
	reduceOnly: boolean?, -- bracket legs never open/extend a position
}

export type OrderModifiedPayload = {
	orderId: string,
	changes: { limitPrice: number?, stopPrice: number?, qty: number? },
}

export type OrderCancelledPayload = { orderId: string, reason: CancelReason }

export type OrderFilledPayload = {
	orderId: string,
	fillId: string,
	side: Side,
	qty: number,
	price: number,
	barTs: number,
	fillKind: FillKind,
	ambiguousBar: boolean, -- bar touched both SL and TP; SL was honored
}

-- New event types can be added freely — the log stores type as text and the
-- payload as an opaque JSON object.
export type SessionEvent = {
	type: string,
	tsMarket: number, -- replay-clock time, epoch seconds UTC
	payload: any,
}

return M

--!strict
-- Client-side mirrors of the server -> client payload shapes. Protocol.luau is
-- FROZEN and documents those shapes only in a comment, so they are re-declared
-- here; a divergence between this file and that comment is a bug in this file.
--
-- Remote payloads arrive untyped, so every handler casts once at the boundary
-- and nothing downstream deals in `any`.

local M = {}

export type Clock = {
	t: number,
	playing: boolean,
	speed: number,
	stepSize: string,
}

export type Position = { qty: number, avgPrice: number }

export type WorkingOrder = {
	id: string,
	side: string,
	type: string,
	qty: number,
	limitPrice: number?,
	stopPrice: number?,
	ocoId: string?,
	reduceOnly: boolean?,
}

-- `trades` mirrors Shared.Trading.Engine.Trade. It stays untyped here so the
-- client does not pull the whole trading engine in for a type it only counts.
export type TradeState = {
	position: Position,
	realizedPts: number,
	realizedUsd: number,
	workingOrders: { WorkingOrder },
	trades: { any },
	voidedCount: number,
	startingBalance: number,
}

export type SessionInfo = {
	availableDates: { string },
	baseSec: number,
	tickSize: number,
	startingBalance: number,
}

-- Client -> server commands are open-shaped: the server validates every field
-- and the client is untrusted, so there is nothing to gain from narrowing here.
export type Cmd = { [string]: any }

return M

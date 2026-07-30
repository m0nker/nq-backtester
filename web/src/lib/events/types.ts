import type { Timeframe } from '../types';

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

// Bracket distances in POINTS from the entry fill price.
export interface BracketSpec {
  stopLossPts: number;
  takeProfitPts: number;
}

export type FillKind = 'market_next_open' | 'limit_touch' | 'stop_trigger';

// Payloads are the on-the-wire JSONB shapes. New event types can be added
// freely — the events table stores type as text + payload as JSONB.
export interface EventPayloads {
  session_started: { startTs: number; endTs: number | null; startingBalance: number; config: Record<string, unknown> };
  time_advanced: { from: number; to: number; mode: 'step' | 'autoplay' | 'jump_forward' };
  time_rewound: { from: number; to: number };
  timeframe_switched: { from: Timeframe; to: Timeframe; instrument?: 'NQ' | 'ES' };
  order_placed: {
    orderId: string;
    side: Side;
    type: OrderType;
    qty: number;
    limitPrice?: number;
    stopPrice?: number;
    bracket?: BracketSpec;
    ocoId?: string; // sibling order cancelled when this fills
    reduceOnly?: boolean; // bracket legs never open/extend a position
  };
  order_modified: { orderId: string; changes: { limitPrice?: number; stopPrice?: number; qty?: number } };
  order_cancelled: { orderId: string; reason: 'user' | 'oco' | 'reduce_only_noop' | 'position_closed' };
  order_filled: {
    orderId: string;
    fillId: string;
    side: Side;
    qty: number;
    price: number;
    barTs: number;
    fillKind: FillKind;
    ambiguousBar: boolean; // bar touched both SL and TP; SL was honored
  };
  position_closed: {
    entryTs: number;
    exitTs: number;
    side: Side; // direction of the round trip
    qty: number; // max size held
    avgEntry: number;
    avgExit: number;
    pnlPts: number;
    pnlUsd: number;
  };
  // ---- bot-mode (strategy engine) events — see STRATEGY_DEFINITIONS.md ----
  // A bias entry's DEATH (price touching `until`) is derived from bars in the
  // engine, like rewind voiding — only set/remove are recorded.
  bias_set: { biasId: string; direction: 'long' | 'short'; until: number };
  bias_removed: { biasId: string };
  candidate_shown: {
    candidateId: string; // = `${ifvg.tf}:${ifvg.formedAt}:${direction}` (dedupe key)
    direction: 'long' | 'short';
    confirmTs: number; // the IFVG inversion close (rule-3 confirmation)
    condition: { tf: Timeframe; top: number; bottom: number; formedAt: number; armedAt: number; bT: number };
    otherConditions: Timeframe[]; // additional armed condition-FVG TFs, if any
    ifvg: { tf: Timeframe; top: number; bottom: number; formedAt: number; bT: number };
    stop: number; // retracement swing low/high (absolute)
    entryEst: number; // last close at confirmation; real entry = next bar's open
    biasId: string; // the live bias entry this aligned with
  };
  decision_made: {
    candidateId: string;
    decision: 'take' | 'marginal' | 'skip' | 'auto'; // 'auto' = bot-takes-everything mode
    notes?: string;
  };
}

export type EventType = keyof EventPayloads;

export interface SessionEvent<T extends EventType = EventType> {
  seq: number;
  type: T;
  tsMarket: number; // replay-clock time, epoch seconds UTC
  tsWall: string; // ISO
  payload: EventPayloads[T];
}

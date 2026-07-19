// Fill simulation — ALL fill assumptions live in this module.
//
// Rules (v1, documented in the UI):
//  - Market orders fill at the OPEN of the next revealed base bar.
//  - Buy limit fills when the bar trades at/through the level: bar.low <=
//    limit; price = min(bar.open, limit) (gap-through fills better, at open).
//    Sell limit mirrored.
//  - Buy stop triggers on touch: bar.high >= stop; price = max(bar.open,
//    stop) (gap-through fills worse, at open). Sell stop mirrored.
//  - Within one bar, stops are evaluated BEFORE limits (conservative).
//  - If a bracket's stop-loss AND take-profit both trigger in the same base
//    bar, the 1-second data for that minute (when available) is replayed to
//    find which level was touched FIRST; the winner fills at the usual
//    1m-bar price formula. Only when 1s coverage is absent — or both levels
//    are hit inside the same 1s bar — does the conservative default apply:
//    STOP-LOSS honored, fill flagged ambiguousBar.
//  - No partial fills, no commission in v1 (config slot exists).

import type { Bar } from '../types';
import type { FillKind, Side } from '../events/types';

export interface WorkingOrder {
  id: string;
  side: Side;
  type: 'market' | 'limit' | 'stop';
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  ocoId?: string;
  reduceOnly?: boolean;
  bracket?: { stopLossPts: number; takeProfitPts: number };
}

export interface FillIntent {
  orderId: string;
  side: Side;
  qty: number;
  price: number;
  fillKind: FillKind;
  ambiguousBar: boolean;
}

function triggers(o: WorkingOrder, bar: Bar): { hit: boolean; price: number; kind: FillKind } {
  if (o.type === 'market') return { hit: true, price: bar.o, kind: 'market_next_open' };
  if (o.type === 'limit') {
    const lim = o.limitPrice!;
    if (o.side === 'buy' && bar.l <= lim) return { hit: true, price: Math.min(bar.o, lim), kind: 'limit_touch' };
    if (o.side === 'sell' && bar.h >= lim) return { hit: true, price: Math.max(bar.o, lim), kind: 'limit_touch' };
    return { hit: false, price: 0, kind: 'limit_touch' };
  }
  const stp = o.stopPrice!;
  if (o.side === 'buy' && bar.h >= stp) return { hit: true, price: Math.max(bar.o, stp), kind: 'stop_trigger' };
  if (o.side === 'sell' && bar.l <= stp) return { hit: true, price: Math.min(bar.o, stp), kind: 'stop_trigger' };
  return { hit: false, price: 0, kind: 'stop_trigger' };
}

// Lazy provider of 1s bars covering [fromTs, toTs); null = no coverage.
export type SecondsResolver = (fromTs: number, toTs: number) => Bar[] | null;

// Evaluate one newly revealed base bar against the working orders.
// Returns fills in execution order. OCO resolution (cancelling siblings) is
// the caller's job — but same-bar OCO conflicts are resolved HERE: by 1s
// replay when secondsFor provides data, else SL-first + ambiguous flag.
export function simulateBar(
  orders: WorkingOrder[],
  bar: Bar,
  secondsFor?: SecondsResolver,
  barDurSec = 60,
): FillIntent[] {
  const fills: FillIntent[] = [];
  const filledOco = new Set<string>(); // oco group ids consumed this bar

  // Decide same-bar stop+limit OCO conflicts up front. Fill PRICES stay at
  // 1-minute granularity (the usual bar formulas) — the 1s replay only
  // decides WHICH leg fills.
  const decisions = new Map<string, { winnerId: string; ambiguous: boolean }>();
  const byOco = new Map<string, WorkingOrder[]>();
  for (const o of orders) {
    if (o.ocoId) (byOco.get(o.ocoId) ?? byOco.set(o.ocoId, []).get(o.ocoId)!).push(o);
  }
  for (const [ocoId, group] of byOco) {
    if (group.length !== 2) continue;
    const stop = group.find((o) => o.type === 'stop');
    const limit = group.find((o) => o.type === 'limit');
    if (!stop || !limit) continue;
    if (!triggers(stop, bar).hit || !triggers(limit, bar).hit) continue;
    let winnerId = stop.id; // conservative default: SL first
    let ambiguous = true;
    const secs = secondsFor?.(bar.t, bar.t + barDurSec);
    if (secs) {
      for (const sb of secs) {
        const sHit = triggers(stop, sb).hit;
        const lHit = triggers(limit, sb).hit;
        if (!sHit && !lHit) continue;
        winnerId = sHit ? stop.id : limit.id;
        ambiguous = sHit && lHit; // both touched inside one second
        break;
      }
      // neither level touched in the 1s replay (data gap): default stands
    }
    decisions.set(ocoId, { winnerId, ambiguous });
  }

  // conservative intrabar ordering: markets, then stops, then limits
  const ordered = [
    ...orders.filter((o) => o.type === 'market'),
    ...orders.filter((o) => o.type === 'stop'),
    ...orders.filter((o) => o.type === 'limit'),
  ];

  for (const o of ordered) {
    if (o.ocoId && filledOco.has(o.ocoId)) continue; // sibling already filled this bar
    const decision = o.ocoId ? decisions.get(o.ocoId) : undefined;
    if (decision && o.id !== decision.winnerId) continue; // lost the same-bar race
    const t = triggers(o, bar);
    if (!t.hit) continue;

    if (o.ocoId) filledOco.add(o.ocoId);
    fills.push({
      orderId: o.id,
      side: o.side,
      qty: o.qty,
      price: t.price,
      fillKind: t.kind,
      ambiguousBar: decision?.ambiguous ?? false,
    });
  }
  return fills;
}

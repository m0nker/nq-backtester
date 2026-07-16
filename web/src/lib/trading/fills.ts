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
//    bar, the STOP-LOSS is honored and the fill is flagged ambiguousBar —
//    1m bars can't order intrabar ticks; this is the conservative default.
//    Second-level data later shrinks this ambiguity.
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

// Evaluate one newly revealed base bar against the working orders.
// Returns fills in execution order. OCO resolution (cancelling siblings) is
// the caller's job — but same-bar OCO conflicts are resolved HERE (SL first).
export function simulateBar(orders: WorkingOrder[], bar: Bar): FillIntent[] {
  const fills: FillIntent[] = [];
  const filledOco = new Set<string>(); // oco group ids consumed this bar

  // conservative intrabar ordering: markets, then stops, then limits
  const ordered = [
    ...orders.filter((o) => o.type === 'market'),
    ...orders.filter((o) => o.type === 'stop'),
    ...orders.filter((o) => o.type === 'limit'),
  ];

  for (const o of ordered) {
    if (o.ocoId && filledOco.has(o.ocoId)) continue; // sibling already filled this bar (SL-first)
    const t = triggers(o, bar);
    if (!t.hit) continue;

    // ambiguity: this order is a limit whose OCO sibling (a stop) also triggers this bar
    let ambiguous = false;
    if (o.ocoId) {
      const sibling = orders.find((s) => s.id !== o.id && s.ocoId === o.ocoId);
      if (sibling && triggers(sibling, bar).hit) ambiguous = true;
      filledOco.add(o.ocoId);
    }

    fills.push({
      orderId: o.id,
      side: o.side,
      qty: o.qty,
      price: t.price,
      fillKind: t.kind,
      ambiguousBar: ambiguous,
    });
  }
  return fills;
}

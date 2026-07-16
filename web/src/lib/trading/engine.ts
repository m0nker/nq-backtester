// Event reducer: fold(events) -> derived trading state. Derived state is
// never stored; the append-only log is the truth.
//
// Rewind voiding is DERIVED, not written: a time_rewound event causes every
// earlier order/fill event with ts_market after the rewind target to be
// treated as void. Nothing in the log is mutated — replaying the fold always
// reproduces the same state, and the voided timeline stays auditable.

import { ptsToUsd } from './contractMath';
import type { WorkingOrder } from './fills';
import type { EventPayloads, SessionEvent, Side } from '../events/types';

export interface Trade {
  entryTs: number;
  exitTs: number;
  side: Side;
  qty: number; // max size held during the round trip
  avgEntry: number;
  avgExit: number;
  pnlPts: number;
  pnlUsd: number;
  ambiguous: boolean; // any constituent fill was on an SL/TP-ambiguous bar
  // set when the opening fill carried a bracket (enables R-multiples + viewer levels)
  riskPts?: number;
  slPrice?: number;
  tpPrice?: number;
}

export interface EngineState {
  workingOrders: WorkingOrder[];
  position: { qty: number; avgPrice: number }; // qty signed: + long, - short
  realizedPts: number;
  realizedUsd: number;
  trades: Trade[];
  voidedCount: number;
  startingBalance: number;
}

interface OpenTrade {
  entryTs: number;
  side: Side;
  maxQty: number;
  entrySum: number; // sum(price*qty) of position-increasing fills
  entryQty: number;
  exitSum: number;
  exitQty: number;
  ambiguous: boolean;
  riskPts?: number;
  slPrice?: number;
  tpPrice?: number;
}

const ORDER_EVENTS = new Set(['order_placed', 'order_modified', 'order_cancelled', 'order_filled']);

export function deriveState(events: SessionEvent[]): EngineState {
  // pass 1: apply rewind voiding
  const accepted: SessionEvent[] = [];
  let voidedCount = 0;
  for (const ev of events) {
    if (ev.type === 'time_rewound') {
      const to = (ev.payload as EventPayloads['time_rewound']).to;
      for (let i = accepted.length - 1; i >= 0; i--) {
        if (ORDER_EVENTS.has(accepted[i].type) && accepted[i].tsMarket > to) {
          accepted.splice(i, 1);
          voidedCount++;
        }
      }
      continue;
    }
    accepted.push(ev);
  }

  // pass 2: fold
  const state: EngineState = {
    workingOrders: [],
    position: { qty: 0, avgPrice: 0 },
    realizedPts: 0,
    realizedUsd: 0,
    trades: [],
    voidedCount,
    startingBalance: 0,
  };
  const orders = new Map<string, WorkingOrder>();
  let open: OpenTrade | null = null;

  for (const ev of accepted) {
    switch (ev.type) {
      case 'session_started': {
        state.startingBalance = (ev.payload as EventPayloads['session_started']).startingBalance;
        break;
      }
      case 'order_placed': {
        const p = ev.payload as EventPayloads['order_placed'];
        orders.set(p.orderId, {
          id: p.orderId,
          side: p.side,
          type: p.type,
          qty: p.qty,
          limitPrice: p.limitPrice,
          stopPrice: p.stopPrice,
          ocoId: p.ocoId,
          reduceOnly: p.reduceOnly,
          bracket: p.bracket,
        });
        break;
      }
      case 'order_modified': {
        const p = ev.payload as EventPayloads['order_modified'];
        const o = orders.get(p.orderId);
        if (o) Object.assign(o, p.changes);
        break;
      }
      case 'order_cancelled': {
        orders.delete((ev.payload as EventPayloads['order_cancelled']).orderId);
        break;
      }
      case 'order_filled': {
        const p = ev.payload as EventPayloads['order_filled'];
        const filledOrder = orders.get(p.orderId);
        orders.delete(p.orderId);
        const signed = p.side === 'buy' ? p.qty : -p.qty;
        const pos = state.position;

        if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signed)) {
          // opening or adding
          if (pos.qty === 0) {
            const dir = p.side === 'buy' ? 1 : -1;
            const bracket = filledOrder?.bracket;
            open = {
              entryTs: ev.tsMarket,
              side: p.side,
              maxQty: p.qty,
              entrySum: p.price * p.qty,
              entryQty: p.qty,
              exitSum: 0,
              exitQty: 0,
              ambiguous: p.ambiguousBar,
              riskPts: bracket?.stopLossPts,
              slPrice: bracket ? p.price - dir * bracket.stopLossPts : undefined,
              tpPrice: bracket ? p.price + dir * bracket.takeProfitPts : undefined,
            };
          } else if (open) {
            open.entrySum += p.price * p.qty;
            open.entryQty += p.qty;
            open.maxQty = Math.max(open.maxQty, Math.abs(pos.qty + signed));
            open.ambiguous ||= p.ambiguousBar;
          }
          pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + p.price * p.qty) / (Math.abs(pos.qty) + p.qty);
          pos.qty += signed;
        } else {
          // reducing / closing / reversing
          const closeQty = Math.min(Math.abs(pos.qty), p.qty);
          const dir = Math.sign(pos.qty); // +1 long
          const pnl = (p.price - pos.avgPrice) * closeQty * dir;
          state.realizedPts += pnl;
          state.realizedUsd += ptsToUsd(pnl, 1);
          if (open) {
            open.exitSum += p.price * closeQty;
            open.exitQty += closeQty;
            open.ambiguous ||= p.ambiguousBar;
          }
          pos.qty += signed;

          if (Math.sign(pos.qty) !== dir) {
            // flat (or reversed): close the round trip
            if (open) {
              const tradeDir = open.side === 'buy' ? 1 : -1;
              // entryQty always equals exitQty here (a round trip closes what
              // it opened), so USD PnL is exact even with scale-ins/outs.
              state.trades.push({
                entryTs: open.entryTs,
                exitTs: ev.tsMarket,
                side: open.side,
                qty: open.maxQty,
                avgEntry: open.entrySum / open.entryQty,
                avgExit: open.exitSum / open.exitQty,
                pnlPts: (open.exitSum / open.exitQty - open.entrySum / open.entryQty) * tradeDir,
                pnlUsd: ptsToUsd((open.exitSum - open.entrySum) * tradeDir, 1),
                ambiguous: open.ambiguous,
                riskPts: open.riskPts,
                slPrice: open.slPrice,
                tpPrice: open.tpPrice,
              });
              open = null;
            }
            if (pos.qty !== 0) {
              // reversal: remainder opens a new trade at this fill price
              pos.avgPrice = p.price;
              open = {
                entryTs: ev.tsMarket,
                side: pos.qty > 0 ? 'buy' : 'sell',
                maxQty: Math.abs(pos.qty),
                entrySum: p.price * Math.abs(pos.qty),
                entryQty: Math.abs(pos.qty),
                exitSum: 0,
                exitQty: 0,
                ambiguous: p.ambiguousBar,
              };
            } else {
              pos.avgPrice = 0;
            }
          }
        }
        break;
      }
      default:
        break; // time/timeframe events don't affect trading state
    }
  }

  state.workingOrders = [...orders.values()];
  return state;
}

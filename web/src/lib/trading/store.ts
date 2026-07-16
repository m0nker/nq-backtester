// Trading store: glues the replay clock to the fill simulator and the event
// log. Every action appends events; all displayed state is derived by the
// reducer. The store itself holds only UI inputs (qty, bracket settings,
// click-to-place mode) and the memoized derived state.

'use client';

import { create } from 'zustand';
import { getBarsInWindow, lastVisibleBar } from '../data/barSource';
import { appendEvent, endSession, getEvents, resumeSession, startSession } from '../events/eventLog';
import type { BracketSpec, OrderType, Side } from '../events/types';
import { useReplay } from '../replay/clock';
import { roundToTick } from './contractMath';
import { deriveState, type EngineState } from './engine';
import { simulateBar, type FillIntent, type WorkingOrder } from './fills';

export type PendingClick = { type: 'limit' | 'stop'; side: Side } | null;

interface TradingState {
  active: boolean;
  derived: EngineState;
  // order-entry UI inputs
  qty: number;
  bracketEnabled: boolean;
  slPts: number;
  tpPts: number;
  pendingClick: PendingClick;

  begin: (opts: { startTs: number; endTs: number | null; startingBalance: number }) => Promise<void>;
  resume: (sessionId: string, events: import('../events/types').SessionEvent[]) => Promise<void>;
  end: () => Promise<void>;
  setQty: (n: number) => void;
  setBracket: (enabled: boolean, slPts?: number, tpPts?: number) => void;
  setPendingClick: (p: PendingClick) => void;

  placeMarket: (side: Side) => void;
  placeAtPrice: (price: number) => void; // consumes pendingClick
  // ProjectX-style position drag: above/below current price decides TP vs SL
  placePositionLeg: (price: number) => void;
  cancelOrder: (orderId: string) => void;
  moveOrder: (orderId: string, price: number) => void;
  flatten: () => void;

  onAdvance: (from: number, to: number, mode: 'step' | 'autoplay') => void;
  onRewind: (from: number, to: number) => void;
}

let nextId = 1;
const oid = () => `o${nextId++}-${Date.now().toString(36)}`;

export const useTrading = create<TradingState>((set, get) => {
  const refresh = () => set({ derived: deriveState(getEvents()) });
  const now = () => useReplay.getState().currentTime ?? 0;

  const place = (
    type: OrderType,
    side: Side,
    qty: number,
    prices: { limitPrice?: number; stopPrice?: number },
    extra?: { ocoId?: string; reduceOnly?: boolean; bracket?: BracketSpec },
  ): string => {
    const orderId = oid();
    appendEvent('order_placed', now(), { orderId, side, type, qty, ...prices, ...extra });
    return orderId;
  };

  // Spawn OCO bracket legs after an entry fill.
  const spawnBracket = (entrySide: Side, qty: number, fillPrice: number, bracket: BracketSpec, ts: number) => {
    const legSide: Side = entrySide === 'buy' ? 'sell' : 'buy';
    const dir = entrySide === 'buy' ? 1 : -1;
    const ocoId = `oco-${oid()}`;
    appendEvent('order_placed', ts, {
      orderId: oid(),
      side: legSide,
      type: 'stop',
      qty,
      stopPrice: roundToTick(fillPrice - dir * bracket.stopLossPts),
      ocoId,
      reduceOnly: true,
    });
    appendEvent('order_placed', ts, {
      orderId: oid(),
      side: legSide,
      type: 'limit',
      qty,
      limitPrice: roundToTick(fillPrice + dir * bracket.takeProfitPts),
      ocoId,
      reduceOnly: true,
    });
  };

  const applyFill = (
    intent: FillIntent,
    order: WorkingOrder,
    barTs: number,
    state: EngineState,
  ): boolean => {
    let qty = intent.qty;
    const pre = state.position.qty;
    if (order.reduceOnly) {
      const opposes = (intent.side === 'buy' && pre < 0) || (intent.side === 'sell' && pre > 0);
      if (!opposes) {
        appendEvent('order_cancelled', barTs, { orderId: intent.orderId, reason: 'reduce_only_noop' });
        return false;
      }
      qty = Math.min(qty, Math.abs(pre));
    }
    appendEvent('order_filled', barTs, {
      orderId: intent.orderId,
      fillId: oid(),
      side: intent.side,
      qty,
      price: intent.price,
      barTs,
      fillKind: intent.fillKind,
      ambiguousBar: intent.ambiguousBar,
    });
    // OCO: cancel the sibling leg
    if (order.ocoId) {
      const sibling = state.workingOrders.find((o) => o.ocoId === order.ocoId && o.id !== order.id);
      if (sibling) appendEvent('order_cancelled', barTs, { orderId: sibling.id, reason: 'oco' });
    }
    // Brackets protect NEW exposure only. A bracketed order that merely
    // closes a position must not spawn legs for a flat book.
    if (order.bracket) {
      const signed = intent.side === 'buy' ? qty : -qty;
      const post = pre + signed;
      const reversed = pre !== 0 && post !== 0 && Math.sign(post) !== Math.sign(pre);
      const increase = reversed ? Math.abs(post) : Math.max(0, Math.abs(post) - Math.abs(pre));
      if (increase > 0) {
        spawnBracket(post > 0 ? 'buy' : 'sell', increase, intent.price, order.bracket, barTs);
      }
    }
    return true;
  };

  // Position-linked cleanup: reduce-only orders exist to protect the current
  // position. When it's gone (flat) or flipped, they cancel automatically.
  const cancelOrphanedLegs = (state: EngineState, ts: number): boolean => {
    const pos = state.position.qty;
    let cancelled = false;
    for (const o of state.workingOrders) {
      if (!o.reduceOnly) continue;
      const valid = (o.side === 'sell' && pos > 0) || (o.side === 'buy' && pos < 0);
      if (!valid) {
        appendEvent('order_cancelled', ts, { orderId: o.id, reason: 'position_closed' });
        cancelled = true;
      }
    }
    return cancelled;
  };

  return {
    active: false,
    derived: deriveState([]),
    qty: 1,
    bracketEnabled: true,
    slPts: 25,
    tpPts: 50,
    pendingClick: null,

    begin: async (opts) => {
      await startSession({ ...opts, config: {} });
      nextId = 1;
      set({ active: true, pendingClick: null });
      refresh();
    },

    resume: async (sessionId, events) => {
      await resumeSession(sessionId, events);
      nextId = events.length + 1; // oid() also embeds wall time, so ids stay unique
      set({ active: true, pendingClick: null });
      refresh();
    },

    end: async () => {
      set({ active: false, pendingClick: null });
      await endSession();
      refresh();
    },

    setQty: (n) => set({ qty: Math.max(1, Math.floor(n) || 1) }),
    setBracket: (enabled, slPts, tpPts) =>
      set((s) => ({ bracketEnabled: enabled, slPts: slPts ?? s.slPts, tpPts: tpPts ?? s.tpPts })),
    setPendingClick: (p) => set({ pendingClick: p }),

    placeMarket: (side) => {
      const { qty, bracketEnabled, slPts, tpPts } = get();
      place('market', side, qty, {}, bracketEnabled ? { bracket: { stopLossPts: slPts, takeProfitPts: tpPts } } : undefined);
      refresh();
    },

    placeAtPrice: (price) => {
      const { pendingClick, qty, bracketEnabled, slPts, tpPts } = get();
      if (!pendingClick) return;
      const p = roundToTick(price);
      const bracket = bracketEnabled ? { bracket: { stopLossPts: slPts, takeProfitPts: tpPts } } : undefined;
      if (pendingClick.type === 'limit') place('limit', pendingClick.side, qty, { limitPrice: p }, bracket);
      else place('stop', pendingClick.side, qty, { stopPrice: p }, bracket);
      set({ pendingClick: null });
      refresh();
    },

    placePositionLeg: (price) => {
      const { derived } = get();
      const pos = derived.position;
      if (pos.qty === 0) return;
      const p = roundToTick(price);
      const last = lastVisibleBar(now())?.c ?? pos.avgPrice;
      const legSide: Side = pos.qty > 0 ? 'sell' : 'buy';
      // long: above market = take-profit (limit), below = stop-loss (stop);
      // short mirrored. Dropping exactly at market defaults to stop.
      const isTp = pos.qty > 0 ? p > last : p < last;
      const type = isTp ? 'limit' : 'stop';
      // The position has ONE stop-loss and ONE take-profit: dragging again
      // MOVES the existing leg (and re-sizes it to the position).
      const existing = derived.workingOrders.find(
        (o) => o.reduceOnly && o.type === type && o.side === legSide,
      );
      if (existing) {
        appendEvent('order_modified', now(), {
          orderId: existing.id,
          changes: isTp
            ? { limitPrice: p, qty: Math.abs(pos.qty) }
            : { stopPrice: p, qty: Math.abs(pos.qty) },
        });
      } else {
        place(type, legSide, Math.abs(pos.qty), isTp ? { limitPrice: p } : { stopPrice: p }, {
          reduceOnly: true,
        });
      }
      refresh();
    },

    cancelOrder: (orderId) => {
      appendEvent('order_cancelled', now(), { orderId, reason: 'user' });
      refresh();
    },

    moveOrder: (orderId, price) => {
      const o = get().derived.workingOrders.find((w) => w.id === orderId);
      if (!o) return;
      const p = roundToTick(price);
      appendEvent('order_modified', now(), {
        orderId,
        changes: o.type === 'limit' ? { limitPrice: p } : { stopPrice: p },
      });
      refresh();
    },

    flatten: () => {
      const st = get().derived;
      for (const o of st.workingOrders) {
        appendEvent('order_cancelled', now(), { orderId: o.id, reason: 'user' });
      }
      if (st.position.qty !== 0) {
        place('market', st.position.qty > 0 ? 'sell' : 'buy', Math.abs(st.position.qty), {}, { reduceOnly: true });
      }
      refresh();
    },

    onAdvance: (from, to, mode) => {
      appendEvent('time_advanced', to, { from, to, mode });
      const newBars = getBarsInWindow(from, to);
      let state = deriveState(getEvents());
      for (const bar of newBars) {
        if (state.workingOrders.length === 0) continue;
        const intents = simulateBar(state.workingOrders, bar);
        if (intents.length === 0) continue;
        let changed = false;
        for (const intent of intents) {
          const order = state.workingOrders.find((o) => o.id === intent.orderId);
          if (!order) continue;
          changed = applyFill(intent, order, bar.t, state) || changed;
          state = deriveState(getEvents()); // fills/cancels affect subsequent intents
        }
        if (cancelOrphanedLegs(state, bar.t)) {
          state = deriveState(getEvents());
          changed = true;
        }
        if (changed) {
          // if the position just went flat, emit the round-trip summary event
          const lastTrade = state.trades[state.trades.length - 1];
          if (lastTrade && state.position.qty === 0 && lastTrade.exitTs === bar.t) {
            appendEvent('position_closed', bar.t, {
              entryTs: lastTrade.entryTs,
              exitTs: lastTrade.exitTs,
              side: lastTrade.side,
              qty: lastTrade.qty,
              avgEntry: lastTrade.avgEntry,
              avgExit: lastTrade.avgExit,
              pnlPts: lastTrade.pnlPts,
              pnlUsd: lastTrade.pnlUsd,
            });
          }
        }
      }
      refresh();
    },

    onRewind: (from, to) => {
      appendEvent('time_rewound', to, { from, to });
      refresh();
    },
  };
});

// Wire the replay clock: advances drive fill simulation, rewinds void.
useReplay.subscribe((s, prev) => {
  const t = useTrading.getState();
  if (!t.active) return;
  if (s.currentTime !== null && prev.currentTime !== null && s.currentTime !== prev.currentTime) {
    if (s.currentTime > prev.currentTime) {
      t.onAdvance(prev.currentTime, s.currentTime, s.playing ? 'autoplay' : 'step');
    } else {
      t.onRewind(prev.currentTime, s.currentTime);
    }
  }
  if (s.timeframe !== prev.timeframe && s.currentTime !== null) {
    appendEvent('timeframe_switched', s.currentTime, { from: prev.timeframe, to: s.timeframe });
  }
});

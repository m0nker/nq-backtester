// NQ contract math. Instrument-parametric so other symbols can plug in later.
export const NQ = { tickSize: 0.25, tickValue: 5.0, pointValue: 20.0 };

// Contracts trade in 0.1 steps (simulating MNQ: 0.1 NQ = 1 MNQ). Quantities
// MUST pass through quantizeQty at every accumulation point — float drift
// (0.1 + 0.2 = 0.30000000000000004) would otherwise break the reducer's
// `qty === 0` flat detection.
export const QTY_STEP = 0.1;
export function quantizeQty(q: number): number {
  return Math.round(q * 10) / 10;
}
// user-facing rounding: nearest 0.1, floor at the 0.1 minimum
export function roundQty(q: number): number {
  return Math.max(QTY_STEP, quantizeQty(q));
}

export function roundToTick(price: number, tickSize = NQ.tickSize): number {
  return Math.round(price / tickSize) * tickSize;
}

export function ptsToUsd(points: number, qty: number, pointValue = NQ.pointValue): number {
  return points * pointValue * qty;
}

export function fmtPts(points: number): string {
  return `${points >= 0 ? '+' : ''}${points.toFixed(2)} pts`;
}

export function fmtUsd(usd: number): string {
  const sign = usd < 0 ? '-' : usd > 0 ? '+' : '';
  return `${sign}$${Math.abs(usd).toFixed(2)}`;
}

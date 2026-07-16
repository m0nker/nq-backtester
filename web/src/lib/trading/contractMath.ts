// NQ contract math. Instrument-parametric so other symbols can plug in later.
export const NQ = { tickSize: 0.25, tickValue: 5.0, pointValue: 20.0 };

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

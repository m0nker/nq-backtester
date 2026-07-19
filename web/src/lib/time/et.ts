// All timestamps in the app are epoch seconds UTC. Eastern Time exists only
// here: session-boundary math and display formatting. Nothing else may do
// timezone arithmetic.

// ET offset computed arithmetically from the post-2007 US DST rule (2nd
// Sunday of March 02:00 EST -> 1st Sunday of November 02:00 EDT). All data is
// 2010+, where this rule is exact — verified against Intl for every hour of
// 2008–2030 (scripts/validate_et_offset.mjs). Intl.formatToParts cost ~35µs
// per call, which made per-bar ET math O(seconds) over the 95k-bar hourly
// history; this is O(1) arithmetic.
const dstBoundsCache = new Map<number, [number, number]>(); // year -> [startSec, endSec) in UTC

function dstBounds(year: number): [number, number] {
  let b = dstBoundsCache.get(year);
  if (!b) {
    const secondSunMar = 8 + ((7 - new Date(Date.UTC(year, 2, 8)).getUTCDay()) % 7);
    const firstSunNov = 1 + ((7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7);
    b = [
      Date.UTC(year, 2, secondSunMar, 7) / 1000, // 02:00 EST = 07:00 UTC
      Date.UTC(year, 10, firstSunNov, 6) / 1000, // 02:00 EDT = 06:00 UTC
    ];
    dstBoundsCache.set(year, b);
  }
  return b;
}

// Offset such that: ET wall-clock (as fake-UTC sec) = UTC sec + offset.
export function etOffsetSec(tsSec: number): number {
  const [start, end] = dstBounds(new Date(tsSec * 1000).getUTCFullYear());
  return tsSec >= start && tsSec < end ? -14_400 : -18_000;
}

function parts(tsSec: number) {
  const d = new Date((tsSec + etOffsetSec(tsSec)) * 1000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

// Convert an ET wall-clock time to epoch seconds UTC (DST-correct).
export function etWallToUtc(y: number, mo: number, d: number, h: number, mi = 0, s = 0): number {
  const want = Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
    guess += want - shown;
  }
  return guess;
}

// Start (18:00 ET) of the CME trading day containing tsSec.
export function tradingDayStartSec(tsSec: number): number {
  const p = parts(tsSec);
  const todaySix = etWallToUtc(p.y, p.mo, p.d, 18);
  if (tsSec >= todaySix) return todaySix;
  const prev = new Date(Date.UTC(p.y, p.mo - 1, p.d) - 86_400_000);
  return etWallToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 18);
}

// Start (Sunday 18:00 ET open) of the trading week containing tsSec.
// A week's bars run Sun 18:00 -> Fri 17:00; DST transitions (Sunday 2:00 AM)
// never fall inside that span, so plain day arithmetic is exact.
export function tradingWeekStartSec(tsSec: number): number {
  const dayStart = tradingDayStartSec(tsSec);
  const etWeekday = new Date((dayStart + etOffsetSec(dayStart)) * 1000).getUTCDay(); // 0 = Sunday
  return dayStart - etWeekday * 86_400;
}

// Start of the calendar-month bucket containing tsSec's trading date.
// Anchored at 18:00 ET on the LAST day of the previous month, because the
// month's first trading day opens the prior evening — the anchor must be
// <= every bar in the bucket or the no-lookahead assertion would trip.
export function monthBucketStartSec(tsSec: number): number {
  const td = tradingDateOf(tsSec);
  const lastPrev = new Date(Date.UTC(+td.slice(0, 4), +td.slice(5, 7) - 1, 0));
  return etWallToUtc(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth() + 1, lastPrev.getUTCDate(), 18);
}

// End of a month bucket = the next month's anchor. startSec must be a value
// returned by monthBucketStartSec; +35 days always lands inside the next
// bucket's month regardless of month length.
export function monthBucketEndSec(startSec: number): number {
  return monthBucketStartSec(startSec + 35 * 86_400);
}

// The trading DATE (YYYY-MM-DD) a timestamp belongs to: bars at/after 18:00 ET
// belong to the NEXT calendar date's trading day.
export function tradingDateOf(tsSec: number): string {
  const p = parts(tsSec);
  let ms = Date.UTC(p.y, p.mo - 1, p.d);
  if (p.h >= 18) ms += 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatET(tsSec: number, withDate = true): string {
  const p = parts(tsSec);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(p.h)}:${pad(p.mi)}`;
  return withDate ? `${p.y}-${pad(p.mo)}-${pad(p.d)} ${time} ET` : time;
}

// lightweight-charts renders times as UTC; shift so the axis shows ET.
export function toChartTime(tsSec: number): number {
  return tsSec + etOffsetSec(tsSec);
}

export function fromChartTime(chartSec: number): number {
  // Offset varies slowly; one correction pass is exact away from transitions,
  // and transitions happen while the market is closed.
  return chartSec - etOffsetSec(chartSec - etOffsetSec(chartSec));
}

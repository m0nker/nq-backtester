// All timestamps in the app are epoch seconds UTC. Eastern Time exists only
// here: session-boundary math and display formatting. Nothing else may do
// timezone arithmetic.

const probe = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function parts(tsSec: number) {
  const p: Record<string, string> = {};
  for (const { type, value } of probe.formatToParts(tsSec * 1000)) p[type] = value;
  return {
    y: +p.year,
    mo: +p.month,
    d: +p.day,
    h: +p.hour % 24, // Intl can emit "24" for midnight
    mi: +p.minute,
    s: +p.second,
  };
}

// Offset such that: ET wall-clock (as fake-UTC ms) = UTC ms + offset.
// Cached per hour bucket; the offset only changes Sundays 2:00 AM ET when the
// market is closed, so hour-granular caching is exact for market data.
const offsetCache = new Map<number, number>();

export function etOffsetSec(tsSec: number): number {
  const key = Math.floor(tsSec / 3600);
  let off = offsetCache.get(key);
  if (off === undefined) {
    const p = parts(tsSec);
    const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
    off = wall - tsSec;
    offsetCache.set(key, off);
  }
  return off;
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

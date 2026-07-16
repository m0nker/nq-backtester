// Pure aggregation: base-resolution bars (already clock-clipped by barSource)
// -> any display timeframe. The partially formed current candle falls out
// naturally: the last bucket simply contains fewer base bars.
//
// Fixed timeframes are aligned to the 18:00 ET trading-day open (CME ETH
// convention), so 4h candles run 18:00, 22:00, 02:00, 06:00, 10:00, 14:00 ET.
// Session timeframes: '1D' = one candle per trading day, '1W' = per trading
// week (Sunday 18:00 open), '1M' = per calendar month of the trading date.

import {
  monthBucketEndSec,
  monthBucketStartSec,
  tradingDayStartSec,
  tradingWeekStartSec,
} from '../time/et';
import {
  BASE_RESOLUTION_SEC,
  TF_SECONDS,
  TRADING_DAY_SEC,
  TRADING_WEEK_SEC,
  isSessionTf,
  type Bar,
  type Timeframe,
} from '../types';

// A bar belongs to the trading day starting at the most recent 18:00 ET, so a
// day's bars span up to 24h from its start (23h nominal close, plus the
// 17:00-17:59 hour that old-era CME sessions traded through).
export function bucketStart(tSec: number, tf: Timeframe, dayStartHint?: number): number {
  if (tf === '1W') return tradingWeekStartSec(tSec);
  if (tf === '1M') return monthBucketStartSec(tSec);
  const dayStart =
    dayStartHint !== undefined && tSec >= dayStartHint && tSec < dayStartHint + 86_400
      ? dayStartHint
      : tradingDayStartSec(tSec);
  if (tf === '1D') return dayStart;
  const dur = TF_SECONDS[tf];
  return dayStart + Math.floor((tSec - dayStart) / dur) * dur;
}

// First instant after the bucket's nominal close. tSec may be any time inside
// the bucket. Months are irregular, so this is a function, not a constant.
export function bucketEnd(tSec: number, tf: Timeframe): number {
  const start = bucketStart(tSec, tf);
  if (tf === '1D') return start + TRADING_DAY_SEC;
  if (tf === '1W') return start + TRADING_WEEK_SEC;
  if (tf === '1M') return monthBucketEndSec(start);
  return start + TF_SECONDS[tf];
}

export function aggregate(base: Bar[], tf: Timeframe, baseSec = BASE_RESOLUTION_SEC): Bar[] {
  if (!isSessionTf(tf) && TF_SECONDS[tf] === baseSec) return base;
  const weekly = tf === '1W' || tf === '1M';
  const out: Bar[] = [];
  let cur: Bar | null = null;
  let dayStart = -1;
  let spanEnd = -1; // 1W/1M: recompute the (expensive) anchor only on bucket exit

  for (const b of base) {
    // Membership is decided by bucket start, never by elapsed duration —
    // old-era sessions have bars past the nominal 23h close. Nominal ends are
    // only a fast-path trigger; when exceeded we recompute the true start,
    // which may resolve to the SAME bucket (17:00-17:59 bars) and merge.
    let start: number;
    if (weekly) {
      if (cur && b.t >= cur.t && b.t < spanEnd) {
        start = cur.t;
      } else {
        start = bucketStart(b.t, tf);
        spanEnd = bucketEnd(b.t, tf);
      }
    } else {
      if (b.t >= dayStart + 86_400 || b.t < dayStart) {
        dayStart = tradingDayStartSec(b.t);
      }
      start = bucketStart(b.t, tf, dayStart);
    }
    if (cur && cur.t === start) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    } else {
      cur = { t: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    }
  }
  return out;
}

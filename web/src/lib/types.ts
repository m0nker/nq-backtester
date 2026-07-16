// A bar's `t` is its OPEN time, epoch seconds UTC.
// A bar is "visible" at replay time T iff it has CLOSED: t + duration <= T.
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// All timeframes the app knows. Sub-minute entries exist so second-level base
// data can be added later without re-architecting: the UI only offers
// timeframes >= the dataset's base resolution (see availableTimeframes).
export const TIMEFRAMES = [
  '15s', '30s', '1m', '2m', '3m', '4m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M',
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

// Session-anchored timeframes have variable/irregular spans (trading day,
// trading week, calendar month) — everything else is a fixed number of seconds
// aligned to the 18:00 ET trading-day open.
export const SESSION_TFS = ['1D', '1W', '1M'] as const;
export type SessionTf = (typeof SESSION_TFS)[number];

export const TF_SECONDS: Record<Exclude<Timeframe, SessionTf>, number> = {
  '15s': 15,
  '30s': 30,
  '1m': 60,
  '2m': 120,
  '3m': 180,
  '4m': 240,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
};

export function isSessionTf(tf: Timeframe): tf is SessionTf {
  return tf === '1D' || tf === '1W' || tf === '1M';
}

// Timeframes renderable from a given base resolution (e.g. 60 for 1m data,
// 1 for future 1s data — which unlocks 15s/30s automatically).
export function availableTimeframes(baseSec: number): Timeframe[] {
  return TIMEFRAMES.filter((tf) => isSessionTf(tf) || TF_SECONDS[tf] >= baseSec);
}

export const RESOLUTION_SECONDS: Record<string, number> = {
  '1s': 1,
  '15s': 15,
  '30s': 30,
  '1m': 60,
};

export const BASE_RESOLUTION_SEC = 60; // default; barSource overrides from the manifest

// One CME trading day: 18:00 ET -> 17:00 ET next day. DST transitions happen
// Sunday 2:00 AM ET while the market is closed, so every trading day is
// exactly 23 hours long. (2010-2015-era data trades into the 17:00-17:59
// hour, so a day's bars can span up to 24h from its open — bucket membership
// is therefore always decided by bucket START, never elapsed duration.)
export const TRADING_DAY_SEC = 23 * 3600;

// One trading week: Sunday 18:00 ET open -> Friday 17:00 ET close. DST
// transitions never fall inside this span (they're Sunday 2:00 AM ET).
export const TRADING_WEEK_SEC = 5 * 86400 - 3600;

export interface DayMeta {
  trading_date: string; // YYYY-MM-DD
  storage_path: string;
  bar_count: number;
  first_ts: string;
  last_ts: string;
  checksum: string | null; // keys the client chunk cache, so re-ingested days invalidate
}

// THE no-lookahead guard, now per-instrument. Each InstrumentSource is the
// ONLY object allowed to hand out its instrument's price data, and every read
// is clipped to the replay clock: a bar is returned only if it has CLOSED
// (t + duration <= upTo).
//
// Three data pools per instrument, all private:
//  - minute:  1m day-chunks in a rolling window around the replay cursor
//             (drives the trading engine and all >=1m timeframes)
//  - seconds: 1s day-chunks in a small window (drives 15s/30s timeframes,
//             only where the dataset has seconds coverage)
//  - hourly:  ONE precomputed full-history 1h series for deep 1h+ history
//
// The module-level function exports delegate to the NQ source so existing
// call sites (clock, trading engine, trade log/viewer) stay unchanged; NQ is
// the traded instrument. Charts address sources[instrument] directly.

import { getDayBars } from './chunkCache';
import { loadManifest } from './manifest';
import { tradingDateOf, tradingDayStartSec } from '../time/et';
import { aggregate, bucketEnd, bucketStart } from '../replay/aggregate';
import { SUPABASE_URL } from '../supabase';
import {
  BASE_RESOLUTION_SEC,
  type Bar,
  type DayMeta,
  type Timeframe,
  TF_SECONDS,
  isSessionTf,
} from '../types';

export type InstrumentId = 'NQ' | 'ES';

const MAX_BASE_BARS = 10_000; // ~7 trading days of 1m
const MAX_SECOND_BARS = 260_000; // ~3 trading days of front-month 1s
const DEFAULT_BACK_DAYS = 6;

export function isSubMinute(tf: Timeframe): boolean {
  return !isSessionTf(tf) && TF_SECONDS[tf] < 60;
}

// Timeframes whose deep history comes from the precomputed hourly series.
const HOURLY_BACKED: ReadonlySet<Timeframe> = new Set(['1h', '4h', '1D', '1W', '1M']);

interface CandleFrame {
  candles: Bar[];
  dirtyFrom: number;
}

interface Dataset {
  resolution: string;
  durSec: number;
  manifest: DayMeta[];
  bars: Bar[];
  loadedIdxs: Set<number>;
  loadedDays: Set<string>;
  maxBars: number;
}

const listeners = new Set<() => void>();
function emitChange() {
  for (const fn of listeners) fn();
}
export function onBarsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class InstrumentSource {
  readonly id: InstrumentId;
  private minute: Dataset;
  private seconds: Dataset;
  private hourly: Bar[] = [];
  private hourlyDerived = new Map<Timeframe, Bar[]>();
  private gen = 0;
  private cc: {
    tf: Timeframe;
    upTo: number;
    baseCount: number;
    lastBaseT: number; // t of bars[baseCount-1] when cached — detects index shifts
    gen: number;
    candles: Bar[];
    dayStart: number;
  } | null = null;

  constructor(id: InstrumentId) {
    this.id = id;
    this.minute = this.emptyDataset('1m', 60, MAX_BASE_BARS);
    this.seconds = this.emptyDataset('1s', 1, MAX_SECOND_BARS);
  }

  private emptyDataset(resolution: string, durSec: number, maxBars: number): Dataset {
    return {
      resolution,
      durSec,
      manifest: [],
      bars: [],
      loadedIdxs: new Set(),
      loadedDays: new Set(),
      maxBars,
    };
  }

  private bump() {
    this.gen++;
    emitChange();
  }

  // MUST be called at every ds.bars mutation, synchronously with the
  // mutation. The incremental candle cache addresses ds.bars by index, so a
  // prepend/trim with a stale gen would make it fold old bars onto the candle
  // tail (out-of-order candles -> chart update() throws). bump() alone is not
  // enough: loadRange bumps only after ALL its day-jobs settle, and an effect
  // can run inside that window (e.g. triggered by the other instrument).
  private invalidate() {
    this.gen++;
  }

  async init(): Promise<DayMeta[]> {
    this.minute.manifest = await loadManifest(this.id, '1m');
    try {
      this.seconds.manifest = await loadManifest(this.id, '1s');
    } catch {
      this.seconds.manifest = [];
    }
    void this.loadHourlyHistory();
    return this.minute.manifest;
  }

  getManifest(): DayMeta[] {
    return this.minute.manifest;
  }

  generation(): number {
    return this.gen;
  }

  private async loadHourlyHistory() {
    try {
      const res = await fetch(
        `${SUPABASE_URL}/storage/v1/object/public/chunks/${this.id}/1h/all.json.gz`,
        { cache: 'no-cache' },
      );
      if (!res.ok) return;
      const stream = res.body!.pipeThrough(new DecompressionStream('gzip'));
      const f = await new Response(stream).json();
      const out: Bar[] = new Array(f.t.length);
      for (let i = 0; i < f.t.length; i++) {
        out[i] = { t: f.t[i], o: f.o[i], h: f.h[i], l: f.l[i], c: f.c[i], v: f.v[i] };
      }
      this.hourly = out;
      this.hourlyDerived.clear();
      this.bump();
    } catch {
      // non-fatal: history stays shallow
    }
  }

  // ------------------------------------------------------------- loading

  private dayIndex(ds: Dataset, tradingDate: string): number {
    let lo = 0,
      hi = ds.manifest.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ds.manifest[mid].trading_date < tradingDate) lo = mid + 1;
      else hi = mid - 1;
    }
    return lo;
  }

  private async loadDay(ds: Dataset, idx: number): Promise<boolean> {
    const meta = ds.manifest[idx];
    if (!meta || ds.loadedDays.has(meta.trading_date)) return false;
    const dayBars = await getDayBars(meta.storage_path, meta.checksum);
    if (ds.loadedDays.has(meta.trading_date)) return false; // raced
    ds.loadedDays.add(meta.trading_date);
    ds.loadedIdxs.add(idx);
    ds.bars = ds.bars.concat(dayBars).sort((a, b) => a.t - b.t);
    this.invalidate();
    return true;
  }

  private trimToCap(ds: Dataset, anchorTs: number) {
    if (ds.bars.length <= ds.maxBars) return;
    const anchorIdx = this.dayIndex(ds, tradingDateOf(anchorTs));
    while (ds.bars.length > ds.maxBars && ds.loadedIdxs.size > 3) {
      const min = Math.min(...ds.loadedIdxs);
      const max = Math.max(...ds.loadedIdxs);
      const dropIdx = anchorIdx - min >= max - anchorIdx ? min : max;
      if (dropIdx === anchorIdx) break;
      const meta = ds.manifest[dropIdx];
      const from = new Date(meta.first_ts).getTime() / 1000;
      const to = new Date(meta.last_ts).getTime() / 1000;
      ds.bars = ds.bars.filter((b) => b.t < from || b.t > to);
      this.invalidate();
      ds.loadedIdxs.delete(dropIdx);
      ds.loadedDays.delete(meta.trading_date);
    }
  }

  private async loadRange(ds: Dataset, from: number, to: number, anchorTs?: number): Promise<boolean> {
    from = Math.max(0, from);
    to = Math.min(ds.manifest.length - 1, to);
    if (from > to) return false;
    const jobs: Promise<boolean>[] = [];
    for (let i = from; i <= to; i++) jobs.push(this.loadDay(ds, i));
    const changed = (await Promise.all(jobs)).some(Boolean);
    if (changed) {
      if (anchorTs !== undefined) this.trimToCap(ds, anchorTs);
      this.bump();
    }
    return changed;
  }

  async ensureLoadedAround(ts: number, back = DEFAULT_BACK_DAYS, ahead = 2): Promise<boolean> {
    const idx = this.dayIndex(this.minute, tradingDateOf(ts));
    const minuteChanged = await this.loadRange(this.minute, idx - back, idx + ahead, ts);
    let secondsChanged = false;
    if (this.hasSecondsAt(ts)) {
      const sIdx = this.dayIndex(this.seconds, tradingDateOf(ts));
      secondsChanged = await this.loadRange(this.seconds, sIdx - 1, sIdx + 1, ts);
    }
    return minuteChanged || secondsChanged;
  }

  async loadOlderDays(sub: boolean, n = 5): Promise<boolean> {
    const ds = sub ? this.seconds : this.minute;
    if (ds.bars.length >= ds.maxBars) return false;
    if (ds.loadedIdxs.size === 0) return false;
    const min = Math.min(...ds.loadedIdxs);
    if (min <= 0) return false;
    return this.loadRange(ds, min - n, min - 1);
  }

  // 1s coverage for the trading day containing ts?
  hasSecondsAt(ts: number): boolean {
    const ds = this.seconds;
    if (ds.manifest.length === 0) return false;
    const td = tradingDateOf(ts);
    const idx = this.dayIndex(ds, td);
    return ds.manifest[idx]?.trading_date === td;
  }

  // ------------------------------------------------------------- reading

  private firstHiddenIndex(ds: Dataset, upTo: number): number {
    let lo = 0,
      hi = ds.bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ds.bars[mid].t + ds.durSec <= upTo) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private dataFor(tf: Timeframe): Dataset {
    return isSubMinute(tf) ? this.seconds : this.minute;
  }

  // All closed MINUTE bars at `upTo` (the engine's fill resolution).
  getVisibleBars(upTo: number): Bar[] {
    const ds = this.minute;
    const out = ds.bars.slice(0, this.firstHiddenIndex(ds, upTo));
    if (process.env.NODE_ENV !== 'production' && out.length) {
      const last = out[out.length - 1];
      if (last.t + ds.durSec > upTo) {
        throw new Error(`LOOKAHEAD VIOLATION: bar ${last.t} not closed at ${upTo}`);
      }
    }
    return out;
  }

  getVisibleCandles(upTo: number, tf: Timeframe): Bar[] {
    const ds = this.dataFor(tf);
    const visible = ds.bars.slice(0, this.firstHiddenIndex(ds, upTo));
    const live = aggregate(visible, tf, ds.durSec);
    if (!HOURLY_BACKED.has(tf) || this.hourly.length === 0) return live;

    let hist = tf === '1h' ? this.hourly : this.hourlyDerived.get(tf);
    if (!hist) {
      hist = aggregate(this.hourly, tf, 3600);
      this.hourlyDerived.set(tf, hist);
    }

    const firstBase = ds.bars.length ? ds.bars[0].t : Infinity;
    const histLimit = live.length ? firstBase : upTo - 3600;
    // Binary-search the cutoff instead of scanning: bucketEnd() does ET math
    // per call, and a linear scan over the full-history series (95k+ bars)
    // took seconds. Ends are monotonic in t, so only the boundary needs it.
    let cut = 0,
      hi2 = hist.length;
    while (cut < hi2) {
      const mid = (cut + hi2) >> 1;
      if (hist[mid].t < histLimit) cut = mid + 1;
      else hi2 = mid;
    }
    while (cut > 0 && bucketEnd(hist[cut - 1].t, tf) > upTo) cut--;
    const out = hist.slice(0, cut);
    let liveFrom = 0;
    const lastHistT = out.length ? out[out.length - 1].t : -Infinity;
    while (liveFrom < live.length && live[liveFrom].t <= lastHistT) liveFrom++;
    return out.concat(live.slice(liveFrom));
  }

  getVisibleCandlesIncremental(upTo: number, tf: Timeframe): CandleFrame {
    const ds = this.dataFor(tf);
    const firstHidden = this.firstHiddenIndex(ds, upTo);
    const cc = this.cc;
    if (
      cc &&
      cc.tf === tf &&
      cc.gen === this.gen &&
      upTo >= cc.upTo &&
      firstHidden >= cc.baseCount &&
      cc.baseCount > 0 &&
      // index still addresses the same bar (no prepend/trim slipped through)
      ds.bars[cc.baseCount - 1]?.t === cc.lastBaseT
    ) {
      let dirtyFrom = cc.candles.length;
      let dayStart = cc.dayStart;
      for (let i = cc.baseCount; i < firstHidden; i++) {
        const b = ds.bars[i];
        if (b.t >= dayStart + 86_400 || b.t < dayStart) dayStart = tradingDayStartSec(b.t);
        const start = bucketStart(b.t, tf, dayStart);
        const lastC = cc.candles[cc.candles.length - 1];
        if (lastC && lastC.t === start) {
          lastC.h = Math.max(lastC.h, b.h);
          lastC.l = Math.min(lastC.l, b.l);
          lastC.c = b.c;
          lastC.v += b.v;
          dirtyFrom = Math.min(dirtyFrom, cc.candles.length - 1);
        } else {
          cc.candles.push({ t: start, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
          dirtyFrom = Math.min(dirtyFrom, cc.candles.length - 1);
        }
      }
      cc.upTo = upTo;
      cc.baseCount = firstHidden;
      cc.lastBaseT = ds.bars[firstHidden - 1]?.t ?? cc.lastBaseT;
      cc.dayStart = dayStart;
      return { candles: cc.candles, dirtyFrom };
    }

    const candles = this.getVisibleCandles(upTo, tf);
    const lastBase = ds.bars[firstHidden - 1];
    this.cc = {
      tf,
      upTo,
      baseCount: firstHidden,
      lastBaseT: lastBase?.t ?? -1,
      gen: this.gen,
      candles,
      dayStart: lastBase ? tradingDayStartSec(lastBase.t) : -1,
    };
    return { candles, dirtyFrom: 0 };
  }

  // Minute bars whose CLOSE falls in (afterTs, upTo] — fill simulation input.
  getBarsInWindow(afterTs: number, upTo: number): Bar[] {
    return this.minute.bars.slice(
      this.firstHiddenIndex(this.minute, afterTs),
      this.firstHiddenIndex(this.minute, upTo),
    );
  }

  async getHistoricalBars(fromTs: number, toTs: number, guardTs: number): Promise<Bar[]> {
    const ds = this.minute;
    const end = Math.min(toTs, guardTs);
    if (end <= fromTs) return [];
    const fromIdx = Math.max(0, this.dayIndex(ds, tradingDateOf(fromTs)) - 1);
    const toIdx = Math.min(ds.manifest.length - 1, this.dayIndex(ds, tradingDateOf(end)));
    const days = await Promise.all(
      ds.manifest.slice(fromIdx, toIdx + 1).map((m) => getDayBars(m.storage_path, m.checksum)),
    );
    const out: Bar[] = [];
    for (const day of days) {
      for (const b of day) {
        if (b.t >= fromTs && b.t + ds.durSec <= end) out.push(b);
      }
    }
    return out;
  }

  // Next hidden bar at the resolution appropriate for a step timeframe.
  nextHiddenBarFor(upTo: number, tf: Timeframe): Bar | null {
    const ds = isSubMinute(tf) && this.hasSecondsAt(upTo) ? this.seconds : this.minute;
    return ds.bars[this.firstHiddenIndex(ds, upTo)] ?? null;
  }

  stepDurFor(tf: Timeframe, upTo: number): number {
    return isSubMinute(tf) && this.hasSecondsAt(upTo) ? 1 : 60;
  }

  nextHiddenBar(upTo: number): Bar | null {
    return this.minute.bars[this.firstHiddenIndex(this.minute, upTo)] ?? null;
  }

  lastVisibleBar(upTo: number): Bar | null {
    return this.minute.bars[this.firstHiddenIndex(this.minute, upTo) - 1] ?? null;
  }

  lastVisibleBarFor(upTo: number, tf: Timeframe): Bar | null {
    const ds = isSubMinute(tf) && this.hasSecondsAt(upTo) ? this.seconds : this.minute;
    return ds.bars[this.firstHiddenIndex(ds, upTo) - 1] ?? null;
  }

  hasDataAfter(upTo: number): boolean {
    if (this.nextHiddenBar(upTo)) return true;
    const last = this.minute.manifest[this.minute.manifest.length - 1];
    return last ? new Date(last.last_ts).getTime() / 1000 + this.minute.durSec > upTo : false;
  }
}

// ----------------------------------------------------------------- registry

export const sources: Record<InstrumentId, InstrumentSource> = {
  NQ: new InstrumentSource('NQ'),
  ES: new InstrumentSource('ES'),
};

// Init both instruments; NQ manifest returned for the start screen. ES init
// failures are non-fatal (its chart just stays empty).
export async function initBarSource(): Promise<DayMeta[]> {
  const [nq] = await Promise.all([
    sources.NQ.init(),
    sources.ES.init().catch(() => []),
  ]);
  return nq;
}

// Load both instruments' windows around ts (start / jump / prefetch).
export async function ensureAllLoadedAround(ts: number, back = DEFAULT_BACK_DAYS, ahead = 2): Promise<boolean> {
  const results = await Promise.allSettled([
    sources.NQ.ensureLoadedAround(ts, back, ahead),
    sources.ES.ensureLoadedAround(ts, back, ahead),
  ]);
  return results.some((r) => r.status === 'fulfilled' && r.value);
}

// Both instruments have 1s coverage for the trading day of ts?
export function secondsAvailableAt(ts: number): boolean {
  return sources.NQ.hasSecondsAt(ts) && sources.ES.hasSecondsAt(ts);
}

// ---------------------------------------------------- NQ-delegate exports
// (existing call sites — clock, trading engine, trade log/viewer — use these)

export function getBaseResolutionSec(): number {
  return BASE_RESOLUTION_SEC;
}
export function getManifest(): DayMeta[] {
  return sources.NQ.getManifest();
}
export function ensureLoadedAround(ts: number, back = DEFAULT_BACK_DAYS, ahead = 2): Promise<boolean> {
  return ensureAllLoadedAround(ts, back, ahead);
}
export function loadOlderDays(n = 5): Promise<boolean> {
  return sources.NQ.loadOlderDays(false, n);
}
export function getVisibleBars(upTo: number): Bar[] {
  return sources.NQ.getVisibleBars(upTo);
}
export function getVisibleCandles(upTo: number, tf: Timeframe): Bar[] {
  return sources.NQ.getVisibleCandles(upTo, tf);
}
export function getVisibleCandlesIncremental(upTo: number, tf: Timeframe): CandleFrame {
  return sources.NQ.getVisibleCandlesIncremental(upTo, tf);
}
export function getBarsInWindow(afterTs: number, upTo: number): Bar[] {
  return sources.NQ.getBarsInWindow(afterTs, upTo);
}
export function getHistoricalBars(fromTs: number, toTs: number, guardTs: number): Promise<Bar[]> {
  return sources.NQ.getHistoricalBars(fromTs, toTs, guardTs);
}
export function nextHiddenBar(upTo: number): Bar | null {
  return sources.NQ.nextHiddenBar(upTo);
}
export function lastVisibleBar(upTo: number): Bar | null {
  return sources.NQ.lastVisibleBar(upTo);
}
export function hasDataAfter(upTo: number): boolean {
  return sources.NQ.hasDataAfter(upTo);
}

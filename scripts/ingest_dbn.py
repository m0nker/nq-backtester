# Multi-instrument ingest: builds continuous front-month series for NQ and ES
# from Databento per-contract DBN files (+ the legacy NQ 1m CSV), and uploads
# day-chunks (1m and 1s) + full-history hourly aggregates to Supabase.
#
# Continuous-contract construction (proper, per-contract source):
#  - outright contracts only (spreads filtered out)
#  - front month per trading day = highest daily volume, never rolling to an
#    earlier expiry than the current front
#  - roll gap = median(new_front - old_front) over overlapping bar timestamps
#    on the day BEFORE the roll (both contracts trade simultaneously, so the
#    calendar spread is measured, not guessed)
#  - difference back-adjustment: bars before a roll shift by the sum of all
#    later gaps; the latest contract's prices stay real
#
# Legacy NQ CSV (vendor-spliced continuous, 2010..2025-03): sanitized (the
# 100x week), internally adjusted at its midnight-UTC vendor splices, then
# anchored to the DBN continuous via a seam gap measured over their overlap
# window (both on the same contract, 2025-03-03..07).
#
# Memory-bounded: DBN files are decoded twice (pass 1 learns the roll
# schedule + per-day front; pass 2 emits adjusted chunks one day at a time).
#
# Usage: python scripts/ingest_dbn.py [--skip-upload]

import gzip
import hashlib
import json
import re
import statistics
import sys
import threading
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import zstandard
from databento_dbn import DBNDecoder, Metadata, OHLCVMsg

ET = ZoneInfo("America/New_York")
UTC = timezone.utc

SUPABASE_URL = "https://hvsmxueyhrtbwfcrqncb.supabase.co"
SUPABASE_KEY = "sb_publishable_GFAjoK3lOJlxOBZe_kPuow_HxrKDZ0k"

NQ_CSV = r"C:\backtester\NQ_1min.csv"
NQ_1S = r"C:\backtester\newdata\GLBX-20260714-5J7TRQDWKM\glbx-mdp3-20250301-20260713.ohlcv-1s.dbn.zst"
ES_1S = r"C:\backtester\newdata\GLBX-20260714-MMGXWVJED3\glbx-mdp3-20250601-20260713.ohlcv-1s.dbn.zst"
ES_1M = r"C:\backtester\newdata\GLBX-20260714-WANQ6YK797\glbx-mdp3-20150606-20250602.ohlcv-1m.dbn.zst"

OUTRIGHT_RE = re.compile(r"^(NQ|ES)[FGHJKMNQUVXZ]\d{1,2}$")
PX = 1e-9  # DBN fixed-precision price scale
SKIP_UPLOAD = "--skip-upload" in sys.argv

# ---------------------------------------------------------------- time utils

_td_cache: dict = {}

def trading_date(ts: int) -> date:
    """CME trading date for an epoch-second UTC timestamp (18:00 ET boundary)."""
    key = ts // 3600
    hit = _td_cache.get(key)
    if hit is None:
        local = datetime.fromtimestamp(key * 3600, UTC).astimezone(ET)
        hit = local.date() + timedelta(days=1) if local.hour >= 18 else local.date()
        _td_cache[key] = hit
    return hit

def r4(x: float) -> float:
    return round(x * 4) / 4

# ------------------------------------------------------------ DBN streaming

def dbn_stream(path):
    """Yields Metadata first, then OHLCVMsg records."""
    dctx = zstandard.ZstdDecompressor()
    decoder = DBNDecoder()
    with open(path, "rb") as fh:
        with dctx.stream_reader(fh) as reader:
            while True:
                chunk = reader.read(1 << 20)
                if not chunk:
                    break
                decoder.write(chunk)
                for rec in decoder.decode():
                    yield rec

def outright_iids(meta: Metadata, prefix: str):
    out = {}
    for symbol, intervals in meta.mappings.items():
        if not OUTRIGHT_RE.match(symbol) or not symbol.startswith(prefix):
            continue
        for iv in intervals:
            out[int(iv["symbol"])] = symbol
    return out

def day_buckets(path, prefix):
    """(trading_day, {symbol: [(ts,o,h,l,c,v)...]}) in chronological order."""
    stream = dbn_stream(path)
    meta = next(stream)
    assert isinstance(meta, Metadata)
    iids = outright_iids(meta, prefix)
    cur_day = None
    bucket = defaultdict(list)
    for rec in stream:
        if not isinstance(rec, OHLCVMsg):
            continue
        sym = iids.get(rec.instrument_id)
        if sym is None:
            continue
        ts = rec.ts_event // 1_000_000_000
        d = trading_date(ts)
        if cur_day is not None and d != cur_day:
            yield cur_day, bucket
            bucket = defaultdict(list)
        cur_day = d
        bucket[sym].append(
            (ts, rec.open * PX, rec.high * PX, rec.low * PX, rec.close * PX, rec.volume)
        )
    if cur_day is not None and bucket:
        yield cur_day, bucket

def aggregate_minutes(bars):
    out = []
    cur = None
    for ts, o, h, l, c, v in bars:
        m = ts - ts % 60
        if cur is not None and cur[0] == m:
            if h > cur[2]:
                cur[2] = h
            if l < cur[3]:
                cur[3] = l
            cur[4] = c
            cur[5] += v
        else:
            if cur is not None:
                out.append(tuple(cur))
            cur = [m, o, h, l, c, v]
    if cur is not None:
        out.append(tuple(cur))
    return out

# ------------------------------------------------- pass 1: rolls + fronts

def expiry_key(symbol: str, day: date):
    """(year, month) expiry order, resolving single-digit years near `day`."""
    month_codes = "FGHJKMNQUVXZ"
    m = month_codes.index(symbol[2]) + 1
    y = int(symbol[3:])
    base = day.year - 1
    while base % 10 != y % 10:
        base += 1
    return (base, m)

def scan_rolls(day_iter, minute_level, collect_overlap_days=None):
    """Pass 1. Returns (rolls [(ts,gap)], front_by_day {day: symbol},
    overlap {ts: close} for the requested days of the continuous front)."""
    front = None
    prev_closes = {}
    rolls = []
    front_by_day = {}
    overlap = {}
    for day, bucket in day_iter:
        if minute_level:
            bucket = {s: aggregate_minutes(b) for s, b in bucket.items()}
        volumes = {s: sum(b[5] for b in bars) for s, bars in bucket.items() if bars}
        if not volumes:
            continue
        best = max(volumes, key=lambda s: volumes[s])
        if front is None:
            front = best
        elif best != front and expiry_key(best, day) > expiry_key(front, day):
            old_c = prev_closes.get(front, {})
            new_c = prev_closes.get(best, {})
            common = set(old_c) & set(new_c)
            gap = None
            if len(common) >= 5:
                gap = statistics.median(new_c[t] - old_c[t] for t in common)
            else:
                oc = {b[0]: b[4] for b in bucket.get(front, [])}
                nc = {b[0]: b[4] for b in bucket.get(best, [])}
                common2 = set(oc) & set(nc)
                if common2:
                    gap = statistics.median(nc[t] - oc[t] for t in common2)
            if gap is not None:
                rolls.append((bucket[best][0][0], r4(gap)))
                front = best
        front_by_day[day] = front
        if collect_overlap_days and day in collect_overlap_days:
            fb = bucket.get(front, [])
            for b in (aggregate_minutes(fb) if not minute_level else fb):
                overlap[b[0]] = b[4]
        prev_closes = {s: {b[0]: b[4] for b in bars} for s, bars in bucket.items()}
    return rolls, front_by_day, overlap

# ----------------------------------------------------------------- offsets

class OffsetLookup:
    """Suffix-sum roll offsets: offset(ts) = sum of gaps of rolls with ts_roll > ts."""

    def __init__(self, rolls):
        self.rolls = sorted(rolls)
        self.suffix = [0.0] * (len(self.rolls) + 1)
        for i in range(len(self.rolls) - 1, -1, -1):
            self.suffix[i] = self.suffix[i + 1] + self.rolls[i][1]

    def at(self, ts):
        lo, hi = 0, len(self.rolls)
        while lo < hi:
            mid = (lo + hi) // 2
            if ts >= self.rolls[mid][0]:
                lo = mid + 1
            else:
                hi = mid
        return self.suffix[lo]

def adjust(bars, offsets):
    out = []
    for ts, o, h, l, c, v in bars:
        off = offsets.at(ts)
        if off == 0:
            out.append((ts, o, h, l, c, v))
        else:
            out.append((ts, r4(o + off), r4(h + off), r4(l + off), r4(c + off), v))
    return out

# ------------------------------------------------------------------- upload

pool = ThreadPoolExecutor(max_workers=8)
pending = []
pending_lock = threading.Lock()
upload_errors = []

def http(method, url, body=None, headers=None, retries=4):
    hdrs = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    hdrs.update(headers or {})
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
            with urllib.request.urlopen(req, timeout=90) as resp:
                return resp.read()
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))

def upload_async(path, gz):
    if SKIP_UPLOAD:
        return
    def job():
        try:
            http(
                "POST",
                f"{SUPABASE_URL}/storage/v1/object/chunks/{path}",
                gz,
                {"Content-Type": "application/gzip", "x-upsert": "true"},
            )
        except Exception as e:
            upload_errors.append((path, str(e)))
    with pending_lock:
        # backpressure: cap the queue
        while len([f for f in pending if not f.done()]) > 64:
            time.sleep(0.05)
        pending.append(pool.submit(job))

meta_rows = []

def emit_day(instrument, res, day, bars, hourly_sink=None):
    payload = {
        "instrument": instrument,
        "tradingDate": day.isoformat(),
        "resolution": res,
        "schemaVersion": 1,
        "t": [b[0] for b in bars],
        "o": [b[1] for b in bars],
        "h": [b[2] for b in bars],
        "l": [b[3] for b in bars],
        "c": [b[4] for b in bars],
        "v": [b[5] for b in bars],
    }
    gz = gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), 6)
    path = f"{instrument}/{res}/{day.isoformat()}.json.gz"
    upload_async(path, gz)
    meta_rows.append(
        {
            "instrument_id": instrument,
            "trading_date": day.isoformat(),
            "resolution": res,
            "bar_count": len(bars),
            "first_ts": datetime.fromtimestamp(bars[0][0], UTC).isoformat(),
            "last_ts": datetime.fromtimestamp(bars[-1][0], UTC).isoformat(),
            "storage_path": path,
            "byte_size": len(gz),
            "checksum": hashlib.md5(gz).hexdigest(),
        }
    )
    if hourly_sink is not None:
        fold_hourly(hourly_sink, day, bars)
    if len(meta_rows) >= 400:
        flush_meta()

def flush_meta():
    global meta_rows
    batch, meta_rows = meta_rows, []
    if batch and not SKIP_UPLOAD:
        http(
            "POST",
            f"{SUPABASE_URL}/rest/v1/dataset_days",
            json.dumps(batch).encode(),
            {
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
        )

_day_start_cache: dict = {}

def fold_hourly(sink, day, bars):
    ds = _day_start_cache.get(day)
    if ds is None:
        open_dt = datetime(day.year, day.month, day.day, 18, tzinfo=ET) - timedelta(days=1)
        ds = int(open_dt.timestamp())
        _day_start_cache[day] = ds
    for ts, o, h, l, c, v in bars:
        b = ts - (ts - ds) % 3600
        cur = sink[-1] if sink else None
        if cur is not None and cur[0] == b:
            if h > cur[2]:
                cur[2] = h
            if l < cur[3]:
                cur[3] = l
            cur[4] = c
            cur[5] += v
        else:
            sink.append([b, o, h, l, c, v])

def upload_hourly(instrument, sink):
    payload = {
        "instrument": instrument,
        "resolution": "1h",
        "schemaVersion": 1,
        "t": [b[0] for b in sink],
        "o": [b[1] for b in sink],
        "h": [b[2] for b in sink],
        "l": [b[3] for b in sink],
        "c": [b[4] for b in sink],
        "v": [b[5] for b in sink],
    }
    gz = gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), 6)
    if not SKIP_UPLOAD:
        http(
            "POST",
            f"{SUPABASE_URL}/storage/v1/object/chunks/{instrument}/1h/all.json.gz",
            gz,
            {"Content-Type": "application/gzip", "x-upsert": "true"},
        )
    print(f"  {instrument}/1h: {len(sink)} bars, {len(gz)/1048576:.2f} MB gz")

def drain_uploads():
    with pending_lock:
        futures = list(pending)
        pending.clear()
    for f in futures:
        f.result()
    flush_meta()

# ------------------------------------------------------------ legacy NQ CSV

def legacy_rows():
    """Sanitized legacy rows, streaming."""
    with open(NQ_CSV, "r") as fh:
        next(fh)
        last_ts = 0
        for line in fh:
            p = line.rstrip("\n").split(",")
            if len(p) != 7:
                continue
            local = datetime(
                int(p[0][:4]), int(p[0][5:7]), int(p[0][8:10]),
                int(p[1][:2]), int(p[1][3:5]), tzinfo=ET,
            )
            ts = int(local.timestamp())
            if ts <= last_ts:
                continue
            last_ts = ts
            o, h, l, c = float(p[2]), float(p[3]), float(p[4]), float(p[5])
            v = int(float(p[6]))
            if h >= 50000:  # the known 100x week
                o, h, l, c = o / 100, h / 100, l / 100, c / 100
            yield (ts, o, h, l, c, v)

def legacy_pass1(dbn_overlap):
    """Detect vendor splices; measure seam diffs against the DBN overlap map.
    Returns (splices, seam_diffs, last_trading_day)."""
    by_quarter = {}
    seam_diffs = []
    prev = None
    last_day = None
    for bar in legacy_rows():
        if prev is not None and bar[0] - prev[0] <= 300 and bar[0] // 86400 != prev[0] // 86400:
            d = datetime.fromtimestamp(bar[0], UTC)
            if d.month in (3, 6, 9, 12) and 5 <= d.day <= 20:
                q = (d.year, d.month)
                jump = bar[1] - prev[4]
                if q not in by_quarter or abs(jump) > abs(by_quarter[q][1]):
                    by_quarter[q] = (bar[0], jump)
        if bar[0] in dbn_overlap:
            seam_diffs.append((bar[0], dbn_overlap[bar[0]] - bar[4]))
        prev = bar
        last_day = trading_date(bar[0])
    return sorted(by_quarter.values()), seam_diffs, last_day

# ------------------------------------------------------------------ NQ flow

def build_nq():
    print("== NQ pass 1: DBN rolls ==", flush=True)
    t0 = time.time()
    # overlap window: first four trading days of March 2025 (pre-roll)
    overlap_days = {date(2025, 3, 3), date(2025, 3, 4), date(2025, 3, 5), date(2025, 3, 6)}
    rolls, front_by_day, overlap = scan_rolls(
        day_buckets(NQ_1S, "NQ"), minute_level=False, collect_overlap_days=overlap_days
    )
    print(f"  {len(rolls)} rolls in DBN, {len(overlap)} overlap minutes, {time.time()-t0:.0f}s")
    for ts, gap in rolls:
        print(f"    roll {datetime.fromtimestamp(ts, UTC).date()} gap {gap:+.2f}")

    print("== NQ pass 1b: legacy splices + seam ==", flush=True)
    splices, seam_diffs, legacy_end = legacy_pass1(overlap)
    print(f"  {len(splices)} vendor splices, legacy ends {legacy_end}")

    # legacy internal adjustment anchors to its own final segment; the vendor
    # splice offsets apply only within legacy
    legacy_internal = OffsetLookup(splices)
    # seam gap: DBN(front, raw) - legacy(internally adjusted) over the overlap.
    # legacy_pass1 compared RAW legacy closes; correct each diff by legacy's
    # internal offset at that ts.
    corrected = [d - legacy_internal.at(ts) for ts, d in seam_diffs]
    seam_gap = r4(statistics.median(corrected)) if corrected else 0.0
    print(f"  seam gap {seam_gap:+.2f} over {len(corrected)} minutes")

    # seam timestamp: first DBN bar after legacy end
    seam_day = next(d for d in sorted(front_by_day) if d > legacy_end)
    seam_ts = int(datetime(seam_day.year, seam_day.month, seam_day.day, 18, tzinfo=ET)
                  .timestamp()) - 86400  # start of seam trading day (18:00 ET prior)

    # combined rolls seen by LEGACY bars: its own splices + seam + all DBN
    # rolls at/after... DBN rolls BEFORE the seam also shift legacy (they moved
    # the continuous to a newer contract than legacy's final segment).
    legacy_rolls = list(splices) + [(seam_ts, seam_gap)] + [
        (max(ts, seam_ts), g) for ts, g in rolls
    ]
    legacy_offsets = OffsetLookup(legacy_rolls)
    dbn_offsets = OffsetLookup(rolls)

    print("== NQ emit: legacy 1m ==", flush=True)
    hourly = []
    cur_day, cur_bars = None, []
    n = 0
    for bar in legacy_rows():
        d = trading_date(bar[0])
        if cur_day is not None and d != cur_day:
            emit_day("NQ", "1m", cur_day, adjust(cur_bars, legacy_offsets), hourly)
            n += 1
            if n % 400 == 0:
                print(f"  legacy {n} days (latest {cur_day})", flush=True)
            cur_bars = []
        cur_day = d
        cur_bars.append(bar)
    if cur_bars:
        emit_day("NQ", "1m", cur_day, adjust(cur_bars, legacy_offsets), hourly)
        n += 1
    print(f"  legacy days: {n}")

    print("== NQ pass 2: DBN emit ==", flush=True)
    n = 0
    for day, bucket in day_buckets(NQ_1S, "NQ"):
        if day <= legacy_end:
            continue
        front = front_by_day.get(day)
        if front is None or front not in bucket:
            continue
        bars_1s = adjust(bucket[front], dbn_offsets)
        emit_day("NQ", "1s", day, bars_1s)
        emit_day("NQ", "1m", day, aggregate_minutes(bars_1s), hourly)
        n += 1
        if n % 50 == 0:
            print(f"  DBN {n} days (latest {day})", flush=True)
    print(f"  DBN days: {n}")
    upload_hourly("NQ", hourly)
    drain_uploads()

# ------------------------------------------------------------------ ES flow

def build_es():
    print("== ES pass 1: rolls (1m file) ==", flush=True)
    cutoff = date(2025, 5, 31)

    def es_day_iter_pass1():
        for day, bucket in day_buckets(ES_1M, "ES"):
            if day >= cutoff:
                break
            yield day, bucket
        for day, bucket in day_buckets(ES_1S, "ES"):
            if day < cutoff:
                continue
            yield day, {s: aggregate_minutes(b) for s, b in bucket.items()}

    rolls, front_by_day, _ = scan_rolls(es_day_iter_pass1(), minute_level=False)
    print(f"  {len(rolls)} rolls")
    for ts, gap in rolls[-6:]:
        print(f"    roll {datetime.fromtimestamp(ts, UTC).date()} gap {gap:+.2f}")
    offsets = OffsetLookup(rolls)

    print("== ES pass 2: emit ==", flush=True)
    hourly = []
    n = 0
    for day, bucket in day_buckets(ES_1M, "ES"):
        if day >= cutoff:
            break
        front = front_by_day.get(day)
        if front is None or front not in bucket:
            continue
        emit_day("ES", "1m", day, adjust(bucket[front], offsets), hourly)
        n += 1
        if n % 400 == 0:
            print(f"  ES 1m {n} days (latest {day})", flush=True)
    for day, bucket in day_buckets(ES_1S, "ES"):
        if day < cutoff:
            continue
        front = front_by_day.get(day)
        if front is None or front not in bucket:
            continue
        bars_1s = adjust(bucket[front], offsets)
        emit_day("ES", "1s", day, bars_1s)
        emit_day("ES", "1m", day, aggregate_minutes(bars_1s), hourly)
        n += 1
        if n % 50 == 0:
            print(f"  ES {n} days (latest {day})", flush=True)
    print(f"  ES days: {n}")
    upload_hourly("ES", hourly)
    drain_uploads()

# --------------------------------------------------------------------- main

if __name__ == "__main__":
    t0 = time.time()
    build_nq()
    build_es()
    if upload_errors:
        print(f"UPLOAD ERRORS: {len(upload_errors)}")
        for p, e in upload_errors[:10]:
            print(" ", p, e)
        sys.exit(1)
    print(f"done in {time.time() - t0:.0f}s")

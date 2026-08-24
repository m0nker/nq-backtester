// Golden-fixture dumper for the TypeScript -> Luau engine port.
//
// Run: `npx tsx roblox/tools/dumpFixtures.ts` with cwd = repo root.
//
// Every `expected` value here is RECORDED by calling the live web engine, never
// hand-computed — the fixtures are a snapshot of TS behavior, so any web-side
// engine change must be followed by a regeneration + parity rerun.
//
// Determinism is mandatory (the output is committed and diffed): the only
// entropy source is a seeded mulberry32. No Date.now, no Math.random.
//
// Rojo maps each .json to a ModuleScript and Script.Source caps at 200k chars,
// so every file is asserted under MAX_FIXTURE_CHARS. If an assert fires, shrink
// the scenario — never raise the cap.
//
// The Luau port has no 1s data and therefore no '15s'/'30s' timeframes; no case
// may reference them.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  etOffsetSec,
  etWallToUtc,
  monthBucketEndSec,
  monthBucketStartSec,
  tradingDateOf,
  tradingDayStartSec,
  tradingWeekStartSec,
} from '../../web/src/lib/time/et';
import { aggregate } from '../../web/src/lib/replay/aggregate';
import { ptsToUsd, quantizeQty, roundToTick } from '../../web/src/lib/trading/contractMath';
import { simulateBar, type FillIntent, type WorkingOrder } from '../../web/src/lib/trading/fills';
import { deriveState } from '../../web/src/lib/trading/engine';
import type { Bar, Timeframe } from '../../web/src/lib/types';
import type { BracketSpec, EventType, SessionEvent } from '../../web/src/lib/events/types';

const MAX_FIXTURE_CHARS = 120_000;

const ROOT = process.cwd();
if (!existsSync(join(ROOT, 'roblox', 'tools', 'dumpFixtures.ts'))) {
  throw new Error(`run from the repo root (cwd is ${ROOT})`);
}
const OUT_DIR = join(ROOT, 'roblox', 'tests', 'fixtures');

const written: Array<[string, number]> = [];

function writeFixture(name: string, value: unknown): void {
  const json = JSON.stringify(value);
  if (json.length >= MAX_FIXTURE_CHARS) {
    throw new Error(`${name}.json is ${json.length} chars (cap ${MAX_FIXTURE_CHARS}) — shrink the scenario`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.json`), json, 'utf8');
  written.push([`${name}.json`, json.length]);
}

// ---------------------------------------------------------------------------
// deterministic PRNG + synthetic bar generation
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type CompactBar = [number, number, number, number, number, number];

function enc(b: Bar): CompactBar {
  return [b.t, b.o, b.h, b.l, b.c, b.v];
}

// Random walk anchored to the tick grid so serialized prices stay short and the
// Luau side sees the same exact doubles.
function makeWalker(rnd: () => number, start: number) {
  let close = roundToTick(start);
  return (t: number): Bar => {
    const o = close;
    const next = roundToTick(o + (rnd() - 0.5) * 6);
    const h = roundToTick(Math.max(o, next) + rnd() * 3);
    const l = roundToTick(Math.min(o, next) - rnd() * 3);
    close = next;
    return { t, o, h, l, c: next, v: 100 + Math.floor(rnd() * 900) };
  };
}

// ---------------------------------------------------------------------------
// Et.json
// ---------------------------------------------------------------------------

// The post-2007 US DST rule, duplicated here only to GENERATE probe instants
// (et.ts stays the sole authority for the recorded answers).
function dstTransitions(year: number): [number, number] {
  const secondSunMar = 8 + ((7 - new Date(Date.UTC(year, 2, 8)).getUTCDay()) % 7);
  const firstSunNov = 1 + ((7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7);
  return [Date.UTC(year, 2, secondSunMar, 7) / 1000, Date.UTC(year, 10, firstSunNov, 6) / 1000];
}

type OffsetCase = [number, number, number, number, number, string];

function offsetCase(ts: number): OffsetCase {
  return [
    ts,
    etOffsetSec(ts),
    tradingDayStartSec(ts),
    tradingWeekStartSec(ts),
    monthBucketStartSec(ts),
    tradingDateOf(ts),
  ];
}

function dumpEt(): void {
  const rnd = mulberry32(0x5eed_01);
  const probes: number[] = [];

  for (let year = 2009; year <= 2027; year++) {
    const [spring, fall] = dstTransitions(year);
    for (const anchor of [spring, fall]) {
      for (const d of [-90_000, -3600, -1, 0, 1, 3600, 90_000]) probes.push(anchor + d);
    }
    const jan = Date.UTC(year, 0, 1) / 1000;
    const span = Date.UTC(year + 1, 0, 1) / 1000 - jan;
    for (let i = 0; i < 6; i++) probes.push(jan + Math.floor(rnd() * span));
  }

  // 18:00 ET rollover: the instant before the open belongs to the PREVIOUS
  // trading day, the instant at/after it to the next one.
  const rolloverDates: Array<[number, number, number]> = [
    [2010, 1, 4],
    [2013, 6, 12],
    [2016, 11, 6], // fall-back Sunday
    [2020, 3, 8], // spring-forward Sunday
    [2024, 12, 31],
    [2027, 7, 15],
  ];
  for (const [y, mo, d] of rolloverDates) {
    const open = etWallToUtc(y, mo, d, 18);
    probes.push(open - 1, open, open + 1);
  }

  // Sunday-evening opens (start of a trading WEEK).
  for (const y of [2011, 2015, 2019, 2023, 2026]) {
    for (const mo of [3, 7, 11]) {
      const firstSun = 1 + ((7 - new Date(Date.UTC(y, mo - 1, 1)).getUTCDay()) % 7);
      probes.push(etWallToUtc(y, mo, firstSun, 18));
    }
  }

  const offsetCases = probes.map(offsetCase);

  const wallProbes: Array<[number, number, number, number, number, number]> = [
    [2010, 1, 1, 0, 0, 0],
    [2015, 3, 1, 9, 30, 0],
    [2018, 11, 20, 18, 0, 0],
    [2020, 6, 15, 12, 30, 15],
    [2026, 12, 31, 23, 59, 59],
    [2013, 2, 28, 17, 0, 0],
    [2024, 2, 29, 6, 45, 30],
    // spring-forward day 2021-03-14: 02:00-02:59 ET does not exist
    [2021, 3, 14, 1, 59, 59],
    [2021, 3, 14, 2, 0, 0],
    [2021, 3, 14, 2, 30, 0],
    [2021, 3, 14, 2, 59, 59],
    [2021, 3, 14, 3, 0, 0],
    [2021, 3, 14, 18, 0, 0],
    [2016, 3, 13, 2, 15, 0],
    // fall-back day 2021-11-07: 01:00-01:59 ET happens twice
    [2021, 11, 7, 0, 59, 59],
    [2021, 11, 7, 1, 0, 0],
    [2021, 11, 7, 1, 30, 0],
    [2021, 11, 7, 1, 59, 59],
    [2021, 11, 7, 2, 0, 0],
    [2021, 11, 7, 18, 0, 0],
    [2016, 11, 6, 1, 15, 0],
    [2009, 3, 8, 2, 30, 0],
    [2027, 11, 7, 1, 30, 0],
  ];
  const wallToUtc = wallProbes.map(([y, mo, d, h, mi, s]) => [y, mo, d, h, mi, s, etWallToUtc(y, mo, d, h, mi, s)]);

  const monthEnd: Array<[number, number]> = [];
  let idx = 0;
  for (let y = 2010; y <= 2026; y++) {
    for (let mo = 1; mo <= 12; mo++, idx++) {
      if (idx % 7 !== 0) continue;
      const start = monthBucketStartSec(etWallToUtc(y, mo, 15, 12));
      monthEnd.push([start, monthBucketEndSec(start)]);
    }
  }

  writeFixture('Et', { offsetCases, wallToUtc, monthEnd });
}

// ---------------------------------------------------------------------------
// Aggregate.json
// ---------------------------------------------------------------------------

interface AggScenario {
  name: string;
  baseSec: number;
  bars: CompactBar[];
  results: Record<string, CompactBar[]>;
}

function scenario(name: string, baseSec: number, bars: Bar[], tfs: Timeframe[]): AggScenario {
  const results: Record<string, CompactBar[]> = {};
  for (const tf of tfs) results[tf] = aggregate(bars, tf, baseSec).map(enc);
  return { name, baseSec, bars: bars.map(enc), results };
}

function dumpAggregate(): void {
  const rnd = mulberry32(0xa66_2023);
  const scenarios: AggScenario[] = [];

  // modernDay: one 23h session, 1m base. Sampled in 5-bar clusters so 2m/5m/15m
  // buckets each merge several bars; three clusters are dropped outright to
  // simulate halts. Sampling (not the full 1380 bars) is what keeps the file
  // inside the Script.Source budget.
  {
    const open = etWallToUtc(2023, 9, 19, 18);
    const walk = makeWalker(rnd, 15_240);
    const halted = new Set([20, 46, 70]);
    const bars: Bar[] = [];
    for (let block = 0; block < 92; block++) {
      if (block % 4 === 3 || halted.has(block)) continue;
      for (let j = 0; j < 5; j++) bars.push(walk(open + (block * 15 + j) * 60));
    }
    scenarios.push(scenario('modernDay', 60, bars, ['1m', '2m', '5m', '15m', '1h', '4h', '1D']));
  }

  // oldEraSpill: 2010-2015-era sessions traded through 17:00-17:59 ET, i.e.
  // PAST the nominal 23h close. Those bars must merge back into the same day /
  // 4h bucket rather than opening a new one.
  {
    const open = etWallToUtc(2012, 6, 12, 18);
    const walk = makeWalker(rnd, 2_640);
    const bars: Bar[] = [];
    for (let i = 0; i < 144; i++) bars.push(walk(open + i * 600));
    scenarios.push(scenario('oldEraSpill', 600, bars, ['1h', '4h', '1D']));
  }

  // weekMonth: 5m base, Sun 18:00 ET through Wed — the Tue 18:00 session's
  // trading date is June 1, so the span crosses a month bucket inside one
  // trading week.
  {
    const walk = makeWalker(rnd, 4_610);
    const bars: Bar[] = [];
    for (const [y, mo, d] of [
      [2016, 5, 29],
      [2016, 5, 30],
      [2016, 5, 31],
    ]) {
      const open = etWallToUtc(y, mo, d, 18);
      for (let i = 0; i < 92; i++) bars.push(walk(open + i * 900));
    }
    scenarios.push(scenario('weekMonth', 300, bars, ['1D', '1W', '1M']));
  }

  // dstWeek: sessions either side of the 2021-03-14 spring-forward. The
  // transition falls in the Fri-close/Sun-open gap, so trading days stay 23h
  // and the week boundary must land on the Sunday open.
  {
    const walk = makeWalker(rnd, 13_100);
    const bars: Bar[] = [];
    for (const [y, mo, d] of [
      [2021, 3, 10],
      [2021, 3, 11],
      [2021, 3, 14],
      [2021, 3, 15],
    ]) {
      const open = etWallToUtc(y, mo, d, 18);
      for (let i = 0; i < 46; i++) bars.push(walk(open + i * 1800));
    }
    scenarios.push(scenario('dstWeek', 60, bars, ['1h', '1D', '1W']));
  }

  writeFixture('Aggregate', { scenarios });
}

// ---------------------------------------------------------------------------
// Fills.json
// ---------------------------------------------------------------------------

interface FillCaseSpec {
  name: string;
  orders: WorkingOrder[];
  bar: Bar;
  barDurSec?: number;
  seconds?: Bar[];
}

interface FillCase {
  name: string;
  orders: WorkingOrder[];
  bar: CompactBar;
  barDurSec: number;
  seconds: CompactBar[] | null;
  expected: FillIntent[];
}

function bar(t: number, o: number, h: number, l: number, c: number, v = 1000): Bar {
  return { t, o, h, l, c, v };
}

function dumpFills(): void {
  const T = 1_700_000_000;
  const specs: FillCaseSpec[] = [];

  const push = (s: FillCaseSpec) => specs.push(s);
  const wide = bar(T, 100, 105, 95, 102);
  const gapDown = bar(T, 94, 99, 92, 96);
  const gapUp = bar(T, 107, 110, 104, 108);

  push({ name: 'market_buy_next_open', orders: [{ id: 'm1', side: 'buy', type: 'market', qty: 1 }], bar: wide });
  push({ name: 'market_sell_next_open', orders: [{ id: 'm2', side: 'sell', type: 'market', qty: 2 }], bar: wide });

  push({
    name: 'buy_limit_touch',
    orders: [{ id: 'l1', side: 'buy', type: 'limit', qty: 1, limitPrice: 97 }],
    bar: wide,
  });
  push({
    name: 'buy_limit_gap_through_fills_at_open',
    orders: [{ id: 'l2', side: 'buy', type: 'limit', qty: 1, limitPrice: 97 }],
    bar: gapDown,
  });
  push({
    name: 'buy_limit_no_touch',
    orders: [{ id: 'l3', side: 'buy', type: 'limit', qty: 1, limitPrice: 90 }],
    bar: wide,
  });
  push({
    name: 'sell_limit_touch',
    orders: [{ id: 'l4', side: 'sell', type: 'limit', qty: 1, limitPrice: 103 }],
    bar: wide,
  });
  push({
    name: 'sell_limit_gap_through_fills_at_open',
    orders: [{ id: 'l5', side: 'sell', type: 'limit', qty: 1, limitPrice: 103 }],
    bar: gapUp,
  });
  push({
    name: 'sell_limit_no_touch',
    orders: [{ id: 'l6', side: 'sell', type: 'limit', qty: 1, limitPrice: 110 }],
    bar: wide,
  });

  push({
    name: 'buy_stop_trigger',
    orders: [{ id: 's1', side: 'buy', type: 'stop', qty: 1, stopPrice: 103 }],
    bar: wide,
  });
  push({
    name: 'buy_stop_gap_through_fills_worse_at_open',
    orders: [{ id: 's2', side: 'buy', type: 'stop', qty: 1, stopPrice: 103 }],
    bar: gapUp,
  });
  push({
    name: 'buy_stop_no_trigger',
    orders: [{ id: 's3', side: 'buy', type: 'stop', qty: 1, stopPrice: 110 }],
    bar: wide,
  });
  push({
    name: 'sell_stop_trigger',
    orders: [{ id: 's4', side: 'sell', type: 'stop', qty: 1, stopPrice: 97 }],
    bar: wide,
  });
  push({
    name: 'sell_stop_gap_through_fills_worse_at_open',
    orders: [{ id: 's5', side: 'sell', type: 'stop', qty: 1, stopPrice: 97 }],
    bar: gapDown,
  });
  push({
    name: 'sell_stop_no_trigger',
    orders: [{ id: 's6', side: 'sell', type: 'stop', qty: 1, stopPrice: 90 }],
    bar: wide,
  });

  push({
    name: 'exact_touch_at_high_and_low',
    orders: [
      { id: 'e1', side: 'buy', type: 'limit', qty: 1, limitPrice: 95 },
      { id: 'e2', side: 'sell', type: 'limit', qty: 1, limitPrice: 105 },
      { id: 'e3', side: 'buy', type: 'stop', qty: 1, stopPrice: 105 },
      { id: 'e4', side: 'sell', type: 'stop', qty: 1, stopPrice: 95 },
    ],
    bar: wide,
  });

  push({
    name: 'ordering_markets_then_stops_then_limits',
    orders: [
      { id: 'o_lim', side: 'buy', type: 'limit', qty: 1, limitPrice: 97 },
      { id: 'o_mkt', side: 'buy', type: 'market', qty: 1 },
      { id: 'o_stp', side: 'buy', type: 'stop', qty: 1, stopPrice: 103 },
    ],
    bar: wide,
  });
  push({
    name: 'non_oco_stop_and_limit_both_hit',
    orders: [
      { id: 'n_lim', side: 'sell', type: 'limit', qty: 1, limitPrice: 103 },
      { id: 'n_stp', side: 'sell', type: 'stop', qty: 1, stopPrice: 97 },
    ],
    bar: wide,
  });

  // Long bracket: SL = sell stop below, TP = sell limit above, one OCO group.
  const longBracket = (): WorkingOrder[] => [
    { id: 'tp', side: 'sell', type: 'limit', qty: 1, limitPrice: 103, ocoId: 'g1', reduceOnly: true },
    { id: 'sl', side: 'sell', type: 'stop', qty: 1, stopPrice: 97, ocoId: 'g1', reduceOnly: true },
  ];

  push({ name: 'oco_both_hit_no_seconds_sl_wins_ambiguous', orders: longBracket(), bar: wide });

  push({
    name: 'oco_seconds_tp_touches_first',
    orders: longBracket(),
    bar: wide,
    seconds: [
      bar(T, 100, 100.5, 99.5, 100.25, 5),
      bar(T + 1, 100.25, 101, 100, 100.75, 5),
      bar(T + 2, 100.75, 103.5, 100.5, 103.25, 7), // limit level touched
      bar(T + 3, 103.25, 104, 96, 96.5, 9),
    ],
  });
  push({
    name: 'oco_seconds_sl_touches_first',
    orders: longBracket(),
    bar: wide,
    seconds: [
      bar(T, 100, 100.5, 99.5, 100.25, 5),
      bar(T + 1, 100.25, 100.75, 96.5, 96.75, 8), // stop level touched
      bar(T + 2, 96.75, 104, 96.5, 103.5, 9),
    ],
  });
  push({
    name: 'oco_seconds_both_in_same_second_sl_wins_ambiguous',
    orders: longBracket(),
    bar: wide,
    seconds: [
      bar(T, 100, 100.5, 99.5, 100.25, 5),
      bar(T + 1, 100.25, 104, 96, 102, 20), // both levels inside one second
      bar(T + 2, 102, 102.5, 101.5, 102, 5),
    ],
  });
  push({
    name: 'oco_seconds_gap_neither_level_default_stands',
    orders: longBracket(),
    bar: wide,
    seconds: [
      bar(T, 100, 100.5, 99.5, 100.25, 5),
      bar(T + 1, 100.25, 101, 99, 99.5, 5),
      bar(T + 2, 99.5, 102.5, 98, 102, 5),
    ],
  });
  push({
    name: 'oco_seconds_empty_window_default_stands',
    orders: longBracket(),
    bar: wide,
    seconds: [bar(T + 600, 100, 104, 96, 100, 5)], // outside [t, t+dur)
  });
  push({
    name: 'oco_seconds_boundary_is_exclusive',
    orders: longBracket(),
    bar: wide,
    seconds: [
      bar(T, 100, 100.5, 99.5, 100.25, 5),
      bar(T + 60, 100.25, 104, 100, 103.5, 9), // at toTs — must NOT decide the race
    ],
  });
  push({
    name: 'oco_bar_dur_300_widens_seconds_window',
    orders: longBracket(),
    bar: wide,
    barDurSec: 300,
    seconds: [
      bar(T, 100, 100.5, 99.5, 100.25, 5),
      bar(T + 60, 100.25, 104, 100, 103.5, 9), // now inside the window
    ],
  });

  push({
    name: 'oco_only_stop_hit_not_ambiguous',
    orders: longBracket(),
    bar: bar(T, 100, 101, 95, 96),
  });
  push({
    name: 'oco_only_limit_hit_not_ambiguous',
    orders: longBracket(),
    bar: bar(T, 100, 105, 99, 104),
  });
  push({
    name: 'oco_group_of_three_no_decision',
    orders: [
      { id: 't3a', side: 'sell', type: 'limit', qty: 1, limitPrice: 103, ocoId: 'g3' },
      { id: 't3b', side: 'sell', type: 'stop', qty: 1, stopPrice: 97, ocoId: 'g3' },
      { id: 't3c', side: 'sell', type: 'limit', qty: 1, limitPrice: 104, ocoId: 'g3' },
    ],
    bar: wide,
  });
  push({
    name: 'oco_two_limits_no_stop_no_decision',
    orders: [
      { id: 'tl1', side: 'sell', type: 'limit', qty: 1, limitPrice: 103, ocoId: 'g4' },
      { id: 'tl2', side: 'sell', type: 'limit', qty: 1, limitPrice: 104, ocoId: 'g4' },
    ],
    bar: wide,
  });
  push({
    name: 'oco_group_of_one_fills_normally',
    orders: [{ id: 'single', side: 'sell', type: 'stop', qty: 1, stopPrice: 97, ocoId: 'g5' }],
    bar: wide,
  });

  // Short bracket mirrors the long one: SL = buy stop above, TP = buy limit below.
  push({
    name: 'short_bracket_oco_both_hit_sl_wins',
    orders: [
      { id: 's_tp', side: 'buy', type: 'limit', qty: 1, limitPrice: 97, ocoId: 'g6', reduceOnly: true },
      { id: 's_sl', side: 'buy', type: 'stop', qty: 1, stopPrice: 103, ocoId: 'g6', reduceOnly: true },
    ],
    bar: wide,
  });
  push({
    name: 'two_independent_oco_groups_same_bar',
    orders: [
      { id: 'a_tp', side: 'sell', type: 'limit', qty: 1, limitPrice: 103, ocoId: 'gA' },
      { id: 'a_sl', side: 'sell', type: 'stop', qty: 1, stopPrice: 97, ocoId: 'gA' },
      { id: 'b_tp', side: 'buy', type: 'limit', qty: 2, limitPrice: 96, ocoId: 'gB' },
      { id: 'b_sl', side: 'buy', type: 'stop', qty: 2, stopPrice: 104, ocoId: 'gB' },
    ],
    bar: wide,
  });
  push({
    name: 'two_oco_groups_seconds_decide_one_each_way',
    orders: [
      { id: 'c_tp', side: 'sell', type: 'limit', qty: 1, limitPrice: 103, ocoId: 'gC' },
      { id: 'c_sl', side: 'sell', type: 'stop', qty: 1, stopPrice: 97, ocoId: 'gC' },
      { id: 'd_tp', side: 'buy', type: 'limit', qty: 1, limitPrice: 96, ocoId: 'gD' },
      { id: 'd_sl', side: 'buy', type: 'stop', qty: 1, stopPrice: 104, ocoId: 'gD' },
    ],
    bar: wide,
    seconds: [
      bar(T, 100, 100.5, 99.5, 100.25, 5),
      bar(T + 1, 100.25, 103.5, 100, 103.25, 9), // gC: limit first; gD: stop not yet
      bar(T + 2, 103.25, 104.5, 95.5, 96, 12),
    ],
  });

  push({
    name: 'no_orders',
    orders: [],
    bar: wide,
  });
  push({
    name: 'nothing_triggers',
    orders: [
      { id: 'x1', side: 'buy', type: 'limit', qty: 1, limitPrice: 80 },
      { id: 'x2', side: 'sell', type: 'limit', qty: 1, limitPrice: 120 },
      { id: 'x3', side: 'buy', type: 'stop', qty: 1, stopPrice: 120 },
      { id: 'x4', side: 'sell', type: 'stop', qty: 1, stopPrice: 80 },
    ],
    bar: wide,
  });
  push({
    name: 'fractional_qty_and_bracket_passthrough',
    orders: [
      {
        id: 'br',
        side: 'buy',
        type: 'market',
        qty: 0.3,
        bracket: { stopLossPts: 5, takeProfitPts: 10 } as BracketSpec,
      },
    ],
    bar: wide,
  });

  const cases: FillCase[] = specs.map((s) => {
    const barDurSec = s.barDurSec ?? 60;
    const secondsFor = s.seconds
      ? (from: number, to: number) => s.seconds!.filter((b) => b.t >= from && b.t < to)
      : undefined;
    return {
      name: s.name,
      orders: s.orders,
      bar: enc(s.bar),
      barDurSec,
      seconds: s.seconds ? s.seconds.map(enc) : null,
      expected: simulateBar(s.orders, s.bar, secondsFor, barDurSec),
    };
  });

  writeFixture('Fills', { cases });
}

// ---------------------------------------------------------------------------
// Engine.json
// ---------------------------------------------------------------------------

// deriveState only reads type/tsMarket/payload; seq/tsWall are log metadata and
// are omitted from the fixtures so the Luau side has nothing dead to carry.
interface WireEvent {
  type: EventType;
  tsMarket: number;
  payload: unknown;
}

function ev(type: EventType, tsMarket: number, payload: unknown): WireEvent {
  return { type, tsMarket, payload };
}

function started(ts: number, balance = 50_000): WireEvent {
  return ev('session_started', ts, { startTs: ts, endTs: null, startingBalance: balance, config: {} });
}

let orderSeq = 0;
function placed(
  ts: number,
  o: { id: string; side: 'buy' | 'sell'; type: 'market' | 'limit' | 'stop'; qty: number } & Partial<{
    limitPrice: number;
    stopPrice: number;
    bracket: BracketSpec;
    ocoId: string;
    reduceOnly: boolean;
  }>,
): WireEvent {
  return ev('order_placed', ts, {
    orderId: o.id,
    side: o.side,
    type: o.type,
    qty: o.qty,
    ...(o.limitPrice !== undefined ? { limitPrice: o.limitPrice } : {}),
    ...(o.stopPrice !== undefined ? { stopPrice: o.stopPrice } : {}),
    ...(o.bracket !== undefined ? { bracket: o.bracket } : {}),
    ...(o.ocoId !== undefined ? { ocoId: o.ocoId } : {}),
    ...(o.reduceOnly !== undefined ? { reduceOnly: o.reduceOnly } : {}),
  });
}

function filled(
  ts: number,
  orderId: string,
  side: 'buy' | 'sell',
  qty: number,
  price: number,
  ambiguousBar = false,
): WireEvent {
  orderSeq++;
  return ev('order_filled', ts, {
    orderId,
    fillId: `f${orderSeq}`,
    side,
    qty,
    price,
    barTs: ts,
    fillKind: 'market_next_open',
    ambiguousBar,
  });
}

function dumpEngine(): void {
  const T = 1_700_000_000;
  const cases: Array<{ name: string; events: WireEvent[] }> = [];
  const add = (name: string, events: WireEvent[]) => cases.push({ name, events });

  add('long_open_close_profit', [
    started(T),
    placed(T + 60, { id: 'o1', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 120, 'o1', 'buy', 1, 100),
    placed(T + 180, { id: 'o2', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 240, 'o2', 'sell', 1, 105),
  ]);

  add('short_open_close_loss', [
    started(T, 25_000),
    placed(T + 60, { id: 'o1', side: 'sell', type: 'market', qty: 2 }),
    filled(T + 120, 'o1', 'sell', 2, 100),
    placed(T + 180, { id: 'o2', side: 'buy', type: 'market', qty: 2 }),
    filled(T + 240, 'o2', 'buy', 2, 103.25),
  ]);

  add('scale_in_then_scale_out', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 120, 'a', 'buy', 1, 100),
    placed(T + 180, { id: 'b', side: 'buy', type: 'market', qty: 2 }),
    filled(T + 240, 'b', 'buy', 2, 103),
    placed(T + 300, { id: 'c', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 360, 'c', 'sell', 1, 105),
    placed(T + 420, { id: 'd', side: 'sell', type: 'market', qty: 2 }),
    filled(T + 480, 'd', 'sell', 2, 110),
  ]);

  add('reversal_closes_and_reopens_remainder', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 2 }),
    filled(T + 120, 'a', 'buy', 2, 100),
    placed(T + 180, { id: 'b', side: 'sell', type: 'market', qty: 3 }),
    filled(T + 240, 'b', 'sell', 3, 105),
    placed(T + 300, { id: 'c', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 360, 'c', 'buy', 1, 103),
  ]);

  add('bracket_stop_price_rr_form', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1, bracket: { stopPrice: 95, rr: 2 } }),
    filled(T + 120, 'a', 'buy', 1, 100.5),
    placed(T + 180, { id: 'b', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 240, 'b', 'sell', 1, 111.5),
  ]);

  add('bracket_stop_price_absolute_tp_form', [
    started(T),
    placed(T + 60, { id: 'a', side: 'sell', type: 'market', qty: 1, bracket: { stopPrice: 106, tpPrice: 88 } }),
    filled(T + 120, 'a', 'sell', 1, 100.25),
    placed(T + 180, { id: 'b', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 240, 'b', 'buy', 1, 88),
  ]);

  add('bracket_points_form', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1, bracket: { stopLossPts: 5, takeProfitPts: 10 } }),
    filled(T + 120, 'a', 'buy', 1, 100.5),
    placed(T + 180, { id: 'b', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 240, 'b', 'sell', 1, 110.5),
  ]);

  // Stop on the wrong side of the entry: risk <= 0, so the rr form yields no TP.
  add('bracket_rr_nonpositive_risk_drops_tp', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1, bracket: { stopPrice: 102, rr: 2 } }),
    filled(T + 120, 'a', 'buy', 1, 100),
    placed(T + 180, { id: 'b', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 240, 'b', 'sell', 1, 101),
  ]);

  add('order_modified_changes_limit_price', [
    started(T),
    placed(T + 60, { id: 'k1', side: 'buy', type: 'limit', qty: 1, limitPrice: 97 }),
    placed(T + 65, { id: 'k2', side: 'sell', type: 'stop', qty: 1, stopPrice: 90 }),
    ev('order_modified', T + 120, { orderId: 'k1', changes: { limitPrice: 96.25, qty: 2 } }),
    ev('order_modified', T + 130, { orderId: 'k2', changes: { stopPrice: 91.5 } }),
    ev('order_modified', T + 140, { orderId: 'ghost', changes: { limitPrice: 1 } }),
  ]);

  add('order_cancelled_mid_list_preserves_order', [
    started(T),
    placed(T + 10, { id: 'w1', side: 'buy', type: 'limit', qty: 1, limitPrice: 90 }),
    placed(T + 20, { id: 'w2', side: 'buy', type: 'limit', qty: 1, limitPrice: 91 }),
    placed(T + 30, { id: 'w3', side: 'buy', type: 'limit', qty: 1, limitPrice: 92 }),
    placed(T + 40, { id: 'w4', side: 'buy', type: 'limit', qty: 1, limitPrice: 93 }),
    ev('order_cancelled', T + 50, { orderId: 'w2', reason: 'user' }),
    placed(T + 60, { id: 'w5', side: 'buy', type: 'limit', qty: 1, limitPrice: 94 }),
    ev('order_cancelled', T + 70, { orderId: 'ghost', reason: 'user' }),
  ]);

  // Re-placing a LIVE id must keep its slot; re-placing a cancelled id appends.
  add('reused_order_ids_keep_or_append_slot', [
    started(T),
    placed(T + 10, { id: 'r1', side: 'buy', type: 'limit', qty: 1, limitPrice: 90 }),
    placed(T + 20, { id: 'r2', side: 'buy', type: 'limit', qty: 1, limitPrice: 91 }),
    placed(T + 30, { id: 'r3', side: 'buy', type: 'limit', qty: 1, limitPrice: 92 }),
    placed(T + 40, { id: 'r1', side: 'sell', type: 'limit', qty: 3, limitPrice: 120 }),
    ev('order_cancelled', T + 50, { orderId: 'r2', reason: 'oco' }),
    placed(T + 60, { id: 'r2', side: 'sell', type: 'stop', qty: 1, stopPrice: 80 }),
  ]);

  add('time_rewound_voids_later_orders_and_fills', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 120, 'a', 'buy', 1, 100),
    placed(T + 180, { id: 'b', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 240, 'b', 'sell', 1, 105),
    placed(T + 300, { id: 'c', side: 'buy', type: 'limit', qty: 1, limitPrice: 99 }),
    ev('time_rewound', T + 400, { from: T + 400, to: T + 150 }),
    placed(T + 200, { id: 'd', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 260, 'd', 'sell', 1, 108),
  ]);

  add('time_rewound_before_any_trade', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 120, 'a', 'buy', 1, 100),
    ev('time_advanced', T + 130, { from: T + 120, to: T + 130, mode: 'step' }),
    ev('time_rewound', T + 140, { from: T + 130, to: T + 30 }),
    ev('timeframe_switched', T + 150, { from: '1m', to: '5m' }),
  ]);

  add('ambiguous_bar_propagates_into_trade', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 120, 'a', 'buy', 1, 100),
    placed(T + 180, { id: 'b', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 240, 'b', 'sell', 1, 95, true),
    placed(T + 300, { id: 'c', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 360, 'c', 'buy', 1, 95),
    placed(T + 420, { id: 'd', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 480, 'd', 'sell', 1, 96),
  ]);

  // Seven 0.1-lot adds then one 0.7 exit: exercises quantizeQty at every
  // accumulation point (0.1+0.2 float drift would break flat detection).
  add('fractional_qty_quantize_to_flat', [
    started(T),
    ...Array.from({ length: 7 }, (_, i) => [
      placed(T + 60 + i * 20, { id: `q${i}`, side: 'buy' as const, type: 'market' as const, qty: 0.1 }),
      filled(T + 70 + i * 20, `q${i}`, 'buy', 0.1, 100 + i * 0.25),
    ]).flat(),
    placed(T + 300, { id: 'qx', side: 'sell', type: 'market', qty: 0.7 }),
    filled(T + 320, 'qx', 'sell', 0.7, 101.75),
  ]);

  add('multiple_sequential_round_trips', [
    started(T),
    placed(T + 60, { id: 'a1', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 70, 'a1', 'buy', 1, 100),
    placed(T + 80, { id: 'a2', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 90, 'a2', 'sell', 1, 102.5),
    placed(T + 100, { id: 'b1', side: 'sell', type: 'market', qty: 2 }),
    filled(T + 110, 'b1', 'sell', 2, 102.5),
    placed(T + 120, { id: 'b2', side: 'buy', type: 'market', qty: 2 }),
    filled(T + 130, 'b2', 'buy', 2, 101),
    placed(T + 140, { id: 'c1', side: 'buy', type: 'market', qty: 0.5 }),
    filled(T + 150, 'c1', 'buy', 0.5, 101),
    placed(T + 160, { id: 'c2', side: 'sell', type: 'market', qty: 0.5 }),
    filled(T + 170, 'c2', 'sell', 0.5, 99.75),
  ]);

  add('partial_reduce_keeps_trade_open', [
    started(T),
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 3 }),
    filled(T + 70, 'a', 'buy', 3, 100),
    placed(T + 80, { id: 'b', side: 'sell', type: 'market', qty: 1 }),
    filled(T + 90, 'b', 'sell', 1, 104),
    placed(T + 100, { id: 'c', side: 'buy', type: 'market', qty: 1 }),
    filled(T + 110, 'c', 'buy', 1, 102),
    placed(T + 120, { id: 'w', side: 'sell', type: 'limit', qty: 3, limitPrice: 130 }),
  ]);

  add('no_session_started_zero_balance', [
    placed(T + 60, { id: 'a', side: 'buy', type: 'market', qty: 1, ocoId: 'g1', reduceOnly: true }),
    placed(T + 65, { id: 'b', side: 'sell', type: 'stop', qty: 1, stopPrice: 90, ocoId: 'g1' }),
  ]);

  const out = cases.map((c) => ({
    name: c.name,
    events: c.events,
    expected: (() => {
      const s = deriveState(c.events as unknown as SessionEvent[]);
      return {
        position: s.position,
        realizedPts: s.realizedPts,
        realizedUsd: s.realizedUsd,
        startingBalance: s.startingBalance,
        voidedCount: s.voidedCount,
        workingOrderIds: s.workingOrders.map((o) => o.id),
        // Ordered full orders too: order_modified is otherwise unobservable
        // through the recorded state.
        workingOrders: s.workingOrders,
        trades: s.trades,
      };
    })(),
  }));

  writeFixture('Engine', { cases: out });
}

// ---------------------------------------------------------------------------
// ContractMath.json
// ---------------------------------------------------------------------------

function dumpContractMath(): void {
  const rnd = mulberry32(0xc0_ffee);

  const quantizeIn = [
    0, 0.1, 0.2, 0.1 + 0.2, 0.7, 0.1 * 3, 1, 1.04, 1.05, 1.06, -0.1, -0.15, -1.25, 2.449999999999999,
    0.30000000000000004, 12.34, 99.99, -0.05, 0.049999, 1e-9, 123456.78,
  ];
  const roundIn = [
    0, 0.1, 0.12, 0.125, 0.13, 0.375, 100, 100.1, 100.124, 100.125, 100.13, -0.125, -100.37, 23456.11, 23456.13,
    23456.375, 1.0000000000000002, 5.999999999999999, -0.0001, 987654.32,
  ];
  const ptsIn: Array<[number, number]> = [
    [0, 1],
    [1, 1],
    [-1, 1],
    [0.25, 1],
    [0.25, 0.1],
    [5.5, 2],
    [-3.75, 0.3],
    [10, 0.1],
    [100, 7],
    [0.1 + 0.2, 1],
    [1234.5678, 1],
    [-0.05, 20],
  ];
  for (let i = 0; i < 8; i++) ptsIn.push([Math.round((rnd() * 200 - 100) * 100) / 100, Math.round(rnd() * 100) / 10]);

  writeFixture('ContractMath', {
    quantize: quantizeIn.map((x) => [x, quantizeQty(x)]),
    roundToTick: roundIn.map((x) => [x, roundToTick(x)]),
    ptsToUsd: ptsIn.map(([p, q]) => [p, q, ptsToUsd(p, q)]),
  });
}

// ---------------------------------------------------------------------------

dumpEt();
dumpAggregate();
dumpFills();
dumpEngine();
dumpContractMath();

for (const [name, len] of written) {
  console.log(`${name.padEnd(18)} ${String(len).padStart(7)} chars`);
}
console.log(`wrote ${written.length} fixtures to ${OUT_DIR}`);

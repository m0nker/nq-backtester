// Unit-check the draws-on-liquidity core (web/src/lib/concepts/liquidity.ts):
// level detection, sweep arming, the two timer rules, terminal invalidation.
// Run from repo root: node scripts/test_liquidity.mjs
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const test = `
import {
  foldSweep, freshSweepState, isArmed, levelLifespanSec, levelsAt, matchSweepTriggers,
  sweptSet, triggerWindowSec,
  type ArmedSweep, type DOLLevel, type LevelDataSource, type SweepRules, type SweepState,
} from './src/lib/concepts/liquidity';
import type { FVG } from './src/lib/concepts/fvg';
import { etWallToUtc } from './src/lib/time/et';
import type { Bar, Timeframe } from './src/lib/types';

const bar = (t: number, o: number, h: number, l: number, c: number): Bar => ({ t, o, h, l, c, v: 1 });
const w = (h: number, mi = 0) => etWallToUtc(2025, 1, 2, h, mi); // an EST trading day
const prev = (h: number, mi = 0) => etWallToUtc(2025, 1, 1, h, mi);

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (ok ? '' : ' -> got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
  if (!ok) failures++;
}

const RULES = (p: Partial<SweepRules> = {}): SweepRules => ({
  invalidationPts: 40, maxCandles: 6, maxMinutes: 20, slowestTriggerSec: 300, ...p,
});
const lvl = (p: Partial<DOLLevel> = {}): DOLLevel => ({
  id: 'london:sellside:2025-01-02', kind: 'london', side: 'sellside',
  price: 21900, formedAt: w(5), label: 'LDN L', ...p,
});

// ---- the two timer rules (the user's worked examples) ----
// 6 candles: 15s -> 1m30s, 1m -> 6m, 3m -> 18m (under the 20m cap), 5m -> 30m
// but CAPPED at 20m, i.e. only 4 of its candles.
{
  const r = RULES();
  check('timer-15s', triggerWindowSec(r, 15), 90);
  check('timer-1m', triggerWindowSec(r, 60), 360);
  check('timer-3m-uncapped', triggerWindowSec(r, 180), 1080); // 6*3 = 18m < 20m
  check('timer-5m-capped', triggerWindowSec(r, 300), 1200);   // 30m -> 20m cap
  check('timer-5m-candles-left', triggerWindowSec(r, 300) / 300, 4); // "after the 4th 5m inversion"
  // the cap is what kills the level as a whole (slowest enabled TF = 5m)
  check('lifespan-capped', levelLifespanSec(r), 1200);
  // with only fast TFs enabled the level dies sooner
  check('lifespan-fast-only', levelLifespanSec(RULES({ slowestTriggerSec: 60 })), 360);
  // a generous cap leaves the candle rule in charge
  check('timer-no-cap-binding', triggerWindowSec(RULES({ maxMinutes: 600 }), 300), 1800);
}

// ---- arming: first raid beyond the level, inside the band ----
{
  const L = lvl();
  const bars = [
    bar(w(9, 30), 21950, 21960, 21910, 21940), // above the level — no sweep
    bar(w(9, 31), 21940, 21945, 21895, 21930), // takes 21900 -> sweep
  ];
  const s = foldSweep(L, freshSweepState(L), bars, RULES(), w(9, 32));
  check('arms-on-raid', [s.sweptAt, s.deadAt, s.wm], [w(9, 31), null, 21895]);
  check('is-armed', isArmed(s), true);
  // a raid that never reaches the level does nothing
  const none = foldSweep(L, freshSweepState(L), [bars[0]], RULES(), w(9, 31));
  check('no-raid-no-arm', [none.sweptAt, none.wm], [null, 21900]);
  // buyside mirror
  const B = lvl({ id: 'nyam:buyside:x', side: 'buyside', price: 22000, label: 'NYAM H' });
  const up = foldSweep(B, freshSweepState(B), [bar(w(9, 31), 21990, 22005, 21985, 22000)], RULES(), w(9, 32));
  check('buyside-arms', [up.sweptAt, up.wm], [w(9, 31), 22005]);
}

// ---- TIMER death: no inversion inside the lifespan -> dead, terminal ----
{
  const L = lvl();
  const swept = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21940, 21945, 21895, 21930)], RULES(), w(9, 32));
  // 20m cap from 09:31 -> dies 09:51
  const late = foldSweep(L, swept, [bar(w(9, 55), 21930, 21935, 21925, 21930)], RULES(), w(9, 56));
  check('timer-kills', [late.sweptAt, late.deadAt], [w(9, 31), w(9, 31) + 1200]);
  check('timer-not-armed', isArmed(late), false);
  // still inside the window -> alive
  const early = foldSweep(L, swept, [bar(w(9, 40), 21930, 21935, 21925, 21930)], RULES(), w(9, 41));
  check('timer-alive-inside', isArmed(early), true);
  // TERMINAL: a deeper raid after death does NOT re-arm
  const deeper = foldSweep(L, late, [bar(w(10, 10), 21930, 21935, 21880, 21890)], RULES(), w(10, 11));
  check('no-rearm-after-timer', [deeper.sweptAt, deeper.deadAt !== null], [w(9, 31), true]);
  // time passing with NO new bars still kills it (now argument)
  const byClock = foldSweep(L, swept, [], RULES(), w(10, 30));
  check('timer-kills-without-bars', byClock.deadAt, w(9, 31) + 1200);
}

// ---- DISTANCE death: strays out of the +-band, either way ----
{
  const L = lvl();
  const swept = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21940, 21945, 21895, 21930)], RULES(), w(9, 32));
  const away = foldSweep(L, swept, [bar(w(9, 35), 21930, 21980, 21925, 21975)], RULES(), w(9, 36)); // +80 above
  check('distance-away-kills', away.deadAt, w(9, 35));
  const beyond = foldSweep(L, swept, [bar(w(9, 35), 21895, 21900, 21830, 21840)], RULES(), w(9, 36)); // -70 below
  check('distance-beyond-kills', beyond.deadAt, w(9, 35));
  const inside = foldSweep(L, swept, [bar(w(9, 35), 21930, 21935, 21870, 21930)], RULES(), w(9, 36));
  check('inside-band-survives', isArmed(inside), true);
  // TERMINAL here too
  const retry = foldSweep(L, beyond, [bar(w(9, 40), 21890, 21899, 21885, 21895)], RULES(), w(9, 41));
  check('no-rearm-after-distance', isArmed(retry), false);
  // a raid that opens ALREADY out of band never arms in the first place
  const far = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21930, 21935, 21820, 21830)], RULES(), w(9, 32));
  check('out-of-band-never-arms', far.sweptAt, null);
}

// ---- one arm per level, ever (no re-arm even while alive) ----
{
  const L = lvl();
  const s1 = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21940, 21945, 21895, 21930)], RULES(), w(9, 32));
  const s2 = foldSweep(L, s1, [bar(w(9, 33), 21930, 21935, 21885, 21930)], RULES(), w(9, 34));
  check('sweptAt-is-first-raid', s2.sweptAt, w(9, 31));
  check('watermark-tracks-deepest', s2.wm, 21885);
}

// ---- matchSweepTriggers: per-TF deadline decides, not just the level ----
const mkGap = (p: Partial<FVG> & Pick<FVG, 'tf' | 'dir' | 'top' | 'bottom' | 'formedAt'>): FVG => ({
  aT: p.formedAt - 180, bT: p.formedAt - 120, tappedAt: null, fillPct: 0,
  invertedAt: null, expiredAt: null, ...p,
});
const bars1m = [
  bar(w(9, 30), 21950, 21960, 21945, 21950),
  bar(w(9, 31), 21950, 21955, 21880, 21900), // the raid; low 21880 = the stop
  bar(w(9, 33), 21900, 21930, 21895, 21925),
  bar(w(9, 35), 21925, 21940, 21920, 21938), // last close before a 9:36 confirm
];
const sweep = (p: Partial<ArmedSweep> = {}): ArmedSweep =>
  ({ level: lvl(), sweptAt: w(9, 31), deadAt: null, ...p });
const trigAt = (tf: Timeframe, min: number) =>
  mkGap({ tf, dir: 'bear', top: 21930, bottom: 21925, formedAt: w(9, 32), invertedAt: w(9, min) });
const mBase = {
  sweeps: [sweep()], rules: RULES(), bars1m, fired: new Set<string>(),
  window: { startSec: 0, endSec: 86_340 },
};

{
  const c = matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)] });
  check('sweep-long-happy', c.length, 1);
  check('sweep-candidate-shape',
    [c[0].direction, c[0].stop, c[0].entryEst, c[0].dol?.label, c[0].dol?.side, c[0].ifvg.tf],
    ['long', 21880, 21938, 'LDN L', 'sellside', '1m']);
  check('no-bias-needed', c[0].biasId, undefined);
}
// sellside sweep hunts LONGS only: a bull gap inverting bearishly finds nothing
check('sellside-wont-short',
  matchSweepTriggers({ ...mBase, triggers: [{ ...trigAt('1m', 36), dir: 'bull' as const }] }).length, 0);
// buyside sweep hunts SHORTS
{
  const B = sweep({ level: lvl({ id: 'nyam:buyside:x', side: 'buyside', price: 21990, label: 'NYAM H' }) });
  const c = matchSweepTriggers({ ...mBase, sweeps: [B], triggers: [{ ...trigAt('1m', 36), dir: 'bull' as const }] });
  check('buyside-shorts', [c.length, c[0]?.direction], [1, 'short']);
}
// PER-TF deadline: from a 09:31 sweep, a 1m trigger has 6m (until 09:37)
check('1m-inside-deadline', matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 37)] }).length, 1);
check('1m-past-deadline', matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 38)] }).length, 0);
// ...while a 5m trigger gets the full 20m cap (until 09:51)
check('5m-inside-cap', matchSweepTriggers({ ...mBase, triggers: [trigAt('5m', 50)] }).length, 1);
check('5m-past-cap', matchSweepTriggers({ ...mBase, triggers: [trigAt('5m', 52)] }).length, 0);
// 15s gets 90s (until 09:32:30)
check('15s-inside-deadline', matchSweepTriggers({ ...mBase, triggers: [trigAt('15s', 32)] }).length, 1);
check('15s-past-deadline', matchSweepTriggers({ ...mBase, triggers: [trigAt('15s', 33)] }).length, 0);
// a sweep that later died still validates an inversion that beat the death
check('confirm-before-death-ok',
  matchSweepTriggers({ ...mBase, sweeps: [sweep({ deadAt: w(9, 37) })], triggers: [trigAt('1m', 36)] }).length, 1);
check('confirm-after-death-rejected',
  matchSweepTriggers({ ...mBase, sweeps: [sweep({ deadAt: w(9, 34) })], triggers: [trigAt('1m', 36)] }).length, 0);
// inversion BEFORE the sweep never counts
check('confirm-before-sweep',
  matchSweepTriggers({ ...mBase, sweeps: [sweep({ sweptAt: w(9, 40) })], triggers: [trigAt('1m', 36)] }).length, 0);
// most recent qualifying raid is the primary
{
  const older = sweep({ level: lvl({ id: 'pd:sellside:x', kind: 'pd', price: 21890, label: 'PDL' }), sweptAt: w(9, 30) });
  const c = matchSweepTriggers({ ...mBase, sweeps: [older, sweep()], triggers: [trigAt('1m', 36)] });
  check('primary-most-recent', c[0].dol?.label, 'LDN L');
}
// execution window still gates
check('sweep-outside-window',
  matchSweepTriggers({ ...mBase, window: { startSec: 10 * 3600, endSec: 11 * 3600 }, triggers: [trigAt('1m', 36)] }).length, 0);
// filled-gap veto still applies
{
  const blocker = mkGap({ tf: '5m', dir: 'bear', top: 21940, bottom: 21920, formedAt: w(9, 20), tappedAt: w(9, 33) });
  check('sweep-veto-higher-filled',
    matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], blockers: [blocker] }).length, 0);
}
check('sweep-fired-dedupe',
  matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], fired: new Set(['1m:' + w(9, 32) + ':long']) }).length, 0);

// ---- level catalog: session windows pick the most recent COMPLETED one ----
{
  // London 02:00-05:00 ET on Jan 2: high 22050 / low 21850
  const bars: Bar[] = [];
  for (let t = prev(20); t < prev(24); t += 60) bars.push(bar(t, 21500, 21600, 21400, 21500)); // asia (Jan 1)
  for (let t = w(2); t < w(5); t += 60) bars.push(bar(t, 21900, 21950, 21900, 21900));
  bars.push(bar(w(3), 21900, 22050, 21850, 21900)); // the london extremes
  bars.sort((a, b) => a.t - b.t);
  const src: LevelDataSource = {
    barsInWindow: (a, b) => bars.filter((x) => x.t + 60 > a && x.t + 60 <= b),
    candles: () => [], // no 1D/1W/swing fixtures here
  };
  const levels = levelsAt(src, w(9), 101); // distinct gen busts the module cache
  // hour cache: same hour + same gen returns the identical array (checked
  // before any other call — the cache holds a single entry by design)
  check('level-cache-hits', levelsAt(src, w(9, 45), 101) === levels, true);
  const london = levels.filter((l) => l.kind === 'london');
  check('london-window', [london.length, london[0].side, london[0].price, london[1].price],
    [2, 'buyside', 22050, 21850]);
  check('london-formedAt-is-window-end', london[0].formedAt, w(5));
  // Jan 2's london has closed, so asia falls back to Jan 1 evening
  const asia = levels.filter((l) => l.kind === 'asia');
  check('asia-falls-back-a-day', [asia.length, asia[0].price, asia[1].price], [2, 21600, 21400]);
  // BEFORE london closes, it isn't a level yet (no Jan 1 london bars fixtured)
  check('incomplete-window-skipped', levelsAt(src, w(4), 102).filter((l) => l.kind === 'london').length, 0);

  // swept flags (display): price traded below the london low after it formed
  const withRaid = [...bars, bar(w(9, 31), 21900, 21910, 21840, 21860)];
  const src2: LevelDataSource = {
    barsInWindow: (a, b) => withRaid.filter((x) => x.t + 60 > a && x.t + 60 <= b),
    candles: () => [],
  };
  const swept = sweptSet(levelsAt(src2, w(10), 103), src2, w(10));
  check('swept-set-low', swept.has('london:sellside:2025-01-02'), true);
  check('swept-set-high-untouched', swept.has('london:buyside:2025-01-02'), false);
}

if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
console.log('ALL LIQUIDITY TESTS PASS');
`;
const tmp = path.join(here, '..', 'web', '_liquidity_test.ts');
writeFileSync(tmp, test);
try {
  const out = execSync('npx --yes tsx ./_liquidity_test.ts', { cwd: path.join(here, '..', 'web'), encoding: 'utf8' });
  console.log(out);
} finally {
  execSync(process.platform === 'win32' ? 'del _liquidity_test.ts' : 'rm _liquidity_test.ts', { cwd: path.join(here, '..', 'web') });
}

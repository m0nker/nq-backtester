// Unit-check the draws-on-liquidity core (web/src/lib/concepts/liquidity.ts):
// level detection, sweep arming/RE-arming, the two timer rules, invalidation
// (a death stands only until the next qualifying raid), trigger matching.
// Run from repo root: node scripts/test_liquidity.mjs
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const test = `
import {
  DEFAULT_TARGET_GAP_MAX_AGE_MINUTES, MECH_TRIGGER_TFS, TARGET_TFS, foldSweep, freshSweepState,
  isArmed, levelLifespanSec, levelsAt, matchSweepTriggers, pickTarget, sweptSet, triggerWindowSec,
  type ArmedSweep, type DOLLevel, type LevelDataSource, type SweepRules, type SweepState,
} from './src/lib/concepts/liquidity';
import type { TriggerOutcome } from './src/lib/concepts/engine';
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

// resweepWindowSec = 30m (the shipped default) — every fixture below keeps its
// raids inside it unless the test is specifically about the window expiring.
const RULES = (p: Partial<SweepRules> = {}): SweepRules => ({
  invalidationPts: 40, maxCandles: 6, maxMinutes: 20, slowestTriggerSec: 300,
  resweepWindowSec: 1800, ...p,
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

// ---- TIMER death: no inversion inside the lifespan -> dead until re-swept ----
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
  // revised 2026-08-12: a deeper qualifying raid RE-ARMS a timed-out level
  // (RETIMED 2026-08-12 from 10:10 to 09:58 — the resweep window now expires
  // 30m after the FIRST sweep at 09:31, and this test is about the TIMER)
  const deeper = foldSweep(L, late, [bar(w(9, 58), 21930, 21935, 21880, 21890)], RULES(), w(9, 59));
  check('rearms-after-timer-death', [deeper.sweptAt, deeper.deadAt, deeper.firstSweptAt],
    [w(9, 58), null, w(9, 31)]);
  check('rearmed-is-armed', isArmed(deeper), true);
  // ...but only a DEEPER one: a shallower raid leaves the death standing
  const shallow = foldSweep(L, late, [bar(w(9, 58), 21930, 21935, 21897, 21930)], RULES(), w(9, 59));
  check('shallow-raid-no-rearm', [shallow.sweptAt, shallow.deadAt], [w(9, 31), w(9, 31) + 1200]);
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
  // revised 2026-08-12: a run AWAY from the level kills the arming, and a
  // later deeper raid inside the band re-arms it
  const again = foldSweep(L, away, [bar(w(9, 45), 21930, 21935, 21875, 21890)], RULES(), w(9, 46));
  check('rearms-after-distance-death', [again.sweptAt, again.deadAt], [w(9, 45), null]);
  // a BREAKOUT is the death that stays dead: the watermark is now farther
  // than invalidationPts from the level, so no deeper raid can qualify again
  const retry = foldSweep(L, beyond, [bar(w(9, 40), 21890, 21899, 21885, 21895)], RULES(), w(9, 41));
  check('breakout-shallower-no-rearm', isArmed(retry), false);
  const retryDeep = foldSweep(L, beyond, [bar(w(9, 40), 21830, 21835, 21810, 21815)], RULES(), w(9, 41));
  check('breakout-deeper-no-rearm', [retryDeep.sweptAt, isArmed(retryDeep)], [w(9, 31), false]);
  // a raid that opens ALREADY out of band never arms in the first place
  const far = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21930, 21935, 21820, 21830)], RULES(), w(9, 32));
  check('out-of-band-never-arms', far.sweptAt, null);
  // and it can never arm afterwards either — shallower prints are inside the
  // watermark, deeper ones are even farther outside the band
  const afterBreak = foldSweep(L, far, [
    bar(w(9, 35), 21870, 21880, 21865, 21875), // back inside the band, above the wm
    bar(w(9, 40), 21870, 21875, 21810, 21815), // deeper, but 90 pts past the level
  ], RULES(), w(9, 41));
  check('breakout-never-arms-later', afterBreak.sweptAt, null);
}

// ---- a deeper raid while ARMED restarts the clock (revised 2026-08-12) ----
{
  const L = lvl();
  const s1 = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21940, 21945, 21895, 21930)], RULES(), w(9, 32));
  const s2 = foldSweep(L, s1, [bar(w(9, 33), 21930, 21935, 21885, 21930)], RULES(), w(9, 34));
  check('resweep-moves-sweptAt', [s2.sweptAt, s2.deadAt], [w(9, 33), null]);
  // the resweep window's anchor stays on the FIRST raid, not the latest
  check('firstSweptAt-anchors-first-raid', [s1.firstSweptAt, s2.firstSweptAt], [w(9, 31), w(9, 31)]);
  check('watermark-tracks-deepest', s2.wm, 21885);
  // the 20m cap now runs from 09:33, not 09:31: alive at 09:52, dead at 09:54
  check('deadline-restarts', isArmed(foldSweep(L, s2, [], RULES(), w(9, 52))), true);
  check('deadline-restarts-death', foldSweep(L, s2, [], RULES(), w(9, 54)).deadAt, w(9, 33) + 1200);
}

// ---- RESWEEP VALIDITY WINDOW (added 2026-08-12) ----
// After the FIRST sweep the level is a valid DOL for resweepWindowSec; past
// that a deeper qualifying raid no longer re-arms it, only deepens its wm.
{
  const L = lvl();
  const first = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21940, 21945, 21895, 21930)], RULES(), w(9, 32));
  check('window-first-sweep-anchors', [first.sweptAt, first.firstSweptAt], [w(9, 31), w(9, 31)]);
  // inside the 30m window (09:31 -> 10:01): a deeper raid re-arms as before
  const inside = foldSweep(L, first, [bar(w(9, 51), 21930, 21935, 21885, 21930)], RULES(), w(9, 52));
  check('window-inside-rearms', [inside.sweptAt, inside.deadAt, inside.firstSweptAt],
    [w(9, 51), null, w(9, 31)]);
  // OUTSIDE it: sweptAt/deadAt frozen, but the watermark still advances (a
  // breakout has to be able to retire the level even after the window)
  const late = foldSweep(L, first, [bar(w(10, 5), 21930, 21935, 21875, 21930)], RULES(), w(10, 6));
  check('window-outside-no-rearm', [late.sweptAt, late.firstSweptAt], [w(9, 31), w(9, 31)]);
  check('window-outside-advances-wm', late.wm, 21875);
  // (the arming from 09:31 is long dead on the 20m cap by 10:06 — the point
  // is that the 10:05 raid did not revive it)
  check('window-outside-still-dead', [isArmed(late), late.deadAt], [false, w(9, 31) + 1200]);
  // the boundary is inclusive
  const edge = foldSweep(L, first, [bar(w(10, 1), 21930, 21935, 21885, 21930)], RULES(), w(10, 2));
  check('window-boundary-inclusive', edge.sweptAt, w(10, 1));
  const past = foldSweep(L, first, [bar(w(10, 2), 21930, 21935, 21885, 21930)], RULES(), w(10, 3));
  check('window-boundary-exclusive-after', past.sweptAt, w(9, 31));

  // ANCHORED AT THE FIRST SWEEP, not the latest: t0 = 09:31, resweep at
  // 09:51 (inside), a third deeper raid at 10:11 — only 20m after the LAST
  // re-arm but 40m after the first, so it must NOT re-arm.
  const third = foldSweep(L, inside, [bar(w(10, 11), 21930, 21935, 21870, 21930)], RULES(), w(10, 12));
  check('window-anchored-at-first-not-latest', [third.sweptAt, third.firstSweptAt, third.wm],
    [w(9, 51), w(9, 31), 21870]);
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
// PRIMARY = the most EXTREME matched draw (revised 2026-08-12, supersedes
// "most recent raid"): a leg that ran through LDN H into PDH is a raid on PDH.
{
  // (a) two BUYSIDE levels swept on the SAME bar -> the higher one is the play
  //     (the user's live case: LDN H 29427.75 run through into PDH 29479.50)
  const ldnH = sweep({ level: lvl({ id: 'london:buyside:x', side: 'buyside', price: 29427.75, label: 'LDN H' }) });
  const pdH = sweep({ level: lvl({ id: 'pd:buyside:x', kind: 'pd', side: 'buyside', price: 29479.5, label: 'PDH' }) });
  const up = [
    bar(w(9, 30), 29400, 29410, 29395, 29405),
    bar(w(9, 31), 29405, 29500, 29400, 29450), // the raid through both; high = the stop
    bar(w(9, 35), 29450, 29455, 29430, 29440),
  ];
  const c = matchSweepTriggers({
    ...mBase, bars1m: up, sweeps: [ldnH, pdH],
    triggers: [{ ...trigAt('1m', 36), dir: 'bull' as const }],
  });
  check('primary-most-extreme-buyside', [c.length, c[0].dol?.label, c[0].direction], [1, 'PDH', 'short']);
  // order in the array must not decide it
  const rev = matchSweepTriggers({
    ...mBase, bars1m: up, sweeps: [pdH, ldnH],
    triggers: [{ ...trigAt('1m', 36), dir: 'bull' as const }],
  });
  check('primary-extreme-order-independent', rev[0].dol?.label, 'PDH');
}
{
  // (b) SELLSIDE, swept at different times: the London low at 09:30, then PDL
  //     BELOW it at 09:31 with no trigger in between -> PDL is the condition
  //     (this is the case the old most-recent rule happened to get right, and
  //     it stays right — but now because PDL is the LOWER level)
  const pdl = sweep({ level: lvl({ id: 'pd:sellside:x', kind: 'pd', price: 21890, label: 'PDL' }), sweptAt: w(9, 31) });
  const ldn = sweep({ sweptAt: w(9, 30) }); // LDN L at 21900
  const c = matchSweepTriggers({ ...mBase, sweeps: [ldn, pdl], triggers: [trigAt('1m', 36)] });
  check('primary-most-extreme-sellside', c[0].dol?.label, 'PDL');
  // ...and the LOWER level wins even when the shallower one was swept LATER
  const lateLdn = sweep({ sweptAt: w(9, 33) });
  check('primary-extreme-beats-recency',
    matchSweepTriggers({ ...mBase, sweeps: [lateLdn, pdl], triggers: [trigAt('1m', 36)] })[0].dol?.label, 'PDL');
}
{
  // (c) selection runs over the MATCHED set only: an extreme level that is
  //     dead (or out of deadline) never wins — the nearer valid one is used
  const deadPdl = sweep({
    level: lvl({ id: 'pd:sellside:x', kind: 'pd', price: 21890, label: 'PDL' }), deadAt: w(9, 34),
  });
  check('primary-extreme-must-be-matched',
    matchSweepTriggers({ ...mBase, sweeps: [deadPdl, sweep()], triggers: [trigAt('1m', 36)] })[0].dol?.label, 'LDN L');
  const stalePdl = sweep({
    level: lvl({ id: 'pd:sellside:x', kind: 'pd', price: 21890, label: 'PDL' }), sweptAt: w(9, 20),
  }); // 09:20 + 6m (1m deadline) = 09:26 < the 09:36 confirm
  check('primary-extreme-past-deadline-skipped',
    matchSweepTriggers({ ...mBase, sweeps: [stalePdl, sweep()], triggers: [trigAt('1m', 36)] })[0].dol?.label, 'LDN L');
}
// execution window still gates
check('sweep-outside-window',
  matchSweepTriggers({ ...mBase, window: { startSec: 10 * 3600, endSec: 11 * 3600 }, triggers: [trigAt('1m', 36)] }).length, 0);
// filled-gap veto still applies
{
  const blocker = mkGap({ tf: '5m', dir: 'bear', top: 21940, bottom: 21920, formedAt: w(9, 20), tappedAt: w(9, 33) });
  check('sweep-veto-higher-filled',
    matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], blockers: [blocker] }).length, 0);
  // a blocker a resweep retired stops vetoing (same machinery as the FVG bot)
  check('sweep-cleared-blocker-passes',
    matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], blockers: [blocker],
      clearedBlockers: new Set(['5m:' + w(9, 20)]) }).length, 1);
  // diagnostics: the veto names the timeframe that owns the move
  const dVeto: TriggerOutcome[] = [];
  matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], blockers: [blocker], diag: dVeto });
  check('diag-vetoed', [dVeto.length, dVeto[0].result, dVeto[0].blockedBy], [1, 'vetoed', '5m']);
}
// diagnostics: a timing miss reports 'no-sweep', a clean match 'candidate'
{
  const dMiss: TriggerOutcome[] = [];
  matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 38)], diag: dMiss });
  check('diag-no-sweep', [dMiss.length, dMiss[0].result], [1, 'no-sweep']);
  const dOk: TriggerOutcome[] = [];
  matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], diag: dOk });
  check('diag-candidate', [dOk.length, dOk[0].result], [1, 'candidate']);
  const dDupe: TriggerOutcome[] = [];
  matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], fired: new Set(['1m:' + w(9, 32) + ':long']), diag: dDupe });
  check('diag-duplicate', [dDupe.length, dDupe[0].result], [1, 'duplicate']);
  const dWin: TriggerOutcome[] = [];
  matchSweepTriggers({ ...mBase, window: { startSec: 10 * 3600, endSec: 11 * 3600 }, triggers: [trigAt('1m', 36)], diag: dWin });
  check('diag-window', [dWin.length, dWin[0].result], [1, 'window']);
}
// the mech model's trigger scan set — no sub-minute TFs
check('mech-trigger-tfs', MECH_TRIGGER_TFS, ['1m', '2m', '3m', '4m', '5m']);

// ---- MECH 2 (added 2026-08-12): Infinity timers + in-session arming ----
// Its rules object is the same shape with the two timers at Infinity, so
// triggerWindowSec/levelLifespanSec are Infinity and the DISTANCE rule in
// foldSweep is the only death.
const M2 = (p: Partial<SweepRules> = {}): SweepRules =>
  RULES({ maxCandles: Number.POSITIVE_INFINITY, maxMinutes: Number.POSITIVE_INFINITY, ...p });
{
  // (JSON.stringify(Infinity) is "null", so compare identity explicitly)
  check('m2-window-infinite', triggerWindowSec(M2(), 60) === Number.POSITIVE_INFINITY, true);
  check('m2-lifespan-infinite', levelLifespanSec(M2()) === Number.POSITIVE_INFINITY, true);
  // (a) no PER-ARMING timer: within the resweep window, hours of clock alone
  // can't kill a mech-2 arming the way the mech model's 20m cap would — but
  // the RESWEEP WINDOW is the level's whole tradeable lifetime (revised
  // 2026-08-12, user edge case: a 09:56 arming must not back a 12:04
  // trigger), so past firstSweptAt + window the arming dies AT the window end
  const L = lvl();
  const swept = foldSweep(L, freshSweepState(L), [bar(w(9, 31), 21940, 21945, 21895, 21930)], M2(), w(9, 32));
  const hoursLater = foldSweep(L, swept, [bar(w(12, 0), 21930, 21935, 21925, 21930)], M2(), w(13, 0));
  check('m2-arming-dies-at-window-end', [hoursLater.sweptAt, hoursLater.deadAt], [w(9, 31), w(10, 1)]);
  check('m2-clock-kills-at-window-end-only', foldSweep(L, swept, [], M2(), w(16, 0)).deadAt, w(10, 1));
  check('m2-alive-inside-window', foldSweep(L, swept, [], M2(), w(9, 55)).deadAt, null);
  check('m2-late-trigger-matches',
    matchSweepTriggers({ ...mBase, rules: M2(), triggers: [trigAt('1m', 59)] }).length, 1);
  // ...while mech-model's 1m deadline (6m from 09:31) rejects the same one
  check('mech-late-trigger-rejected',
    matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 59)] }).length, 0);
  // the DISTANCE rule still kills under Infinity timers
  const away = foldSweep(L, swept, [bar(w(9, 35), 21930, 21980, 21925, 21975)], M2(), w(9, 36));
  check('m2-distance-still-kills', away.deadAt, w(9, 35));
  const beyond = foldSweep(L, swept, [bar(w(9, 35), 21895, 21900, 21830, 21840)], M2(), w(9, 36));
  check('m2-breakout-still-kills', beyond.deadAt, w(9, 35));
  // ...and a deeper qualifying raid still re-arms after a distance death
  const again = foldSweep(L, away, [bar(w(9, 45), 21930, 21935, 21875, 21890)], M2(), w(9, 46));
  check('m2-rearms-after-distance-death', [again.sweptAt, again.deadAt], [w(9, 45), null]);
  // the RESWEEP WINDOW is NOT a timer, so mech-2 honours it too: a finite
  // window applies even under Infinity maxCandles/maxMinutes
  const m2Late = foldSweep(L, swept, [bar(w(10, 5), 21930, 21935, 21875, 21930)], M2(), w(10, 6));
  check('m2-window-outside-no-rearm', [m2Late.sweptAt, m2Late.firstSweptAt, m2Late.wm],
    [w(9, 31), w(9, 31), 21875]);
  // ...and the original arming is dead too — the window end is terminal for
  // the whole level (revised 2026-08-12)
  check('m2-window-outside-arming-dead', [isArmed(m2Late), m2Late.deadAt], [false, w(10, 1)]);
  const m2Inside = foldSweep(L, swept, [bar(w(9, 55), 21930, 21935, 21875, 21930)], M2(), w(9, 56));
  check('m2-window-inside-rearms', [m2Inside.sweptAt, m2Inside.firstSweptAt], [w(9, 55), w(9, 31)]);
}
// (b) armFromSessionOpen: only a sweep at/after 09:30 ET of the
// CONFIRMATION's trading day can back a candidate
{
  const m2Base = { ...mBase, rules: M2(), armFromSessionOpen: true };
  check('m2-in-session-sweep-accepted',
    matchSweepTriggers({ ...m2Base, triggers: [trigAt('1m', 36)] }).length, 1);
  const overnight = [sweep({ sweptAt: w(3, 15) })]; // 03:15 ET raid, still armed
  check('m2-premarket-sweep-rejected',
    matchSweepTriggers({ ...m2Base, sweeps: overnight, triggers: [trigAt('1m', 36)] }).length, 0);
  // the same overnight sweep IS accepted without the flag (mech-model)
  check('m2-premarket-ok-without-flag',
    matchSweepTriggers({ ...mBase, rules: M2(), sweeps: overnight, triggers: [trigAt('1m', 36)] }).length, 1);
  // a stale overnight sweep reads as 'no-sweep' in diag — by design
  const dPre: TriggerOutcome[] = [];
  matchSweepTriggers({ ...m2Base, sweeps: overnight, triggers: [trigAt('1m', 36)], diag: dPre });
  check('m2-premarket-diag-no-sweep', [dPre.length, dPre[0].result], [1, 'no-sweep']);
  // 09:29:xx is still out (the boundary is 09:30 sharp, inclusive)
  check('m2-0929-rejected',
    matchSweepTriggers({ ...m2Base, sweeps: [sweep({ sweptAt: w(9, 29) })], triggers: [trigAt('1m', 36)] }).length, 0);
  check('m2-0930-accepted',
    matchSweepTriggers({ ...m2Base, sweeps: [sweep({ sweptAt: w(9, 30) })], triggers: [trigAt('1m', 36)] }).length, 1);
  // (d) RESWEEP BOOKKEEPING under mech-2's rules: the shared cleared-blocker
  // machinery must work here exactly as it does for the FVG bot — a blocker
  // a resweep retired stops vetoing (it re-arms as a blocker upstream, once
  // price penetrates it deeper than it had been filled).
  const blocker = mkGap({ tf: '5m', dir: 'bear', top: 21940, bottom: 21920, formedAt: w(9, 20), tappedAt: w(9, 33) });
  check('m2-veto-higher-filled',
    matchSweepTriggers({ ...m2Base, triggers: [trigAt('1m', 36)], blockers: [blocker] }).length, 0);
  check('m2-cleared-blocker-passes',
    matchSweepTriggers({ ...m2Base, triggers: [trigAt('1m', 36)], blockers: [blocker],
      clearedBlockers: new Set(['5m:' + w(9, 20)]) }).length, 1);
}
// (c) an OVERNIGHT raid's watermark forces the in-session raid to go deeper
// before it can (re)arm — the exact analog of the FVG bot's "a premarket push
// sets the level an in-session tap must beat".
// (RETIMED 2026-08-12: the premarket raid was at 06:15, which the 30m resweep
// window now puts far out of reach of the 09:35 in-session one. Moved to
// 09:20 — still premarket, so the armFromSessionOpen assertions below are
// unchanged, but inside the window so the re-arm is what's being tested.)
{
  const L = lvl(); // formedAt = 05:00 (London close), so the raid is at 09:20
  const overnight = foldSweep(L, freshSweepState(L), [bar(w(9, 20), 21920, 21925, 21885, 21915)], M2(), w(9, 21));
  check('m2-overnight-sets-watermark', [overnight.sweptAt, overnight.wm], [w(9, 20), 21885]);
  // an in-session raid that only reaches 21890 is INSIDE the overnight
  // watermark: sweptAt does not move, so there is still no in-session sweep
  const shallow = foldSweep(L, overnight, [bar(w(9, 35), 21930, 21935, 21890, 21930)], M2(), w(9, 36));
  check('m2-shallow-in-session-no-rearm', shallow.sweptAt, w(9, 20));
  check('m2-shallow-still-rejected',
    matchSweepTriggers({ ...mBase, rules: M2(), armFromSessionOpen: true,
      sweeps: [sweep({ sweptAt: shallow.sweptAt! })], triggers: [trigAt('1m', 40)] }).length, 0);
  // beating it re-arms, and the fresh sweptAt is in-session -> tradeable
  const deeper = foldSweep(L, overnight, [bar(w(9, 35), 21930, 21935, 21880, 21930)], M2(), w(9, 36));
  check('m2-deeper-in-session-rearms', [deeper.sweptAt, deeper.deadAt, deeper.wm], [w(9, 35), null, 21880]);
  check('m2-deeper-now-tradeable',
    matchSweepTriggers({ ...mBase, rules: M2(), armFromSessionOpen: true,
      sweeps: [sweep({ sweptAt: deeper.sweptAt! })], triggers: [trigAt('1m', 40)] }).length, 1);
}
check('sweep-fired-dedupe',
  matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], fired: new Set(['1m:' + w(9, 32) + ':long']) }).length, 0);

// ---- the unfilled 5m/15m TARGET (user spec 2026-08-12) ----
// Both mech bots REQUIRE one: an UNFILLED 5m/15m gap of the OPPOSITE polarity,
// formed inside the age window, whose NEAR edge is on the profit side. TP is
// that edge; the closest valid edge across both TFs wins. No target -> no
// candidate ('no-target'). mBase's long fixture confirms at 09:36 with
// entryEst 21938, so a long's targets are BEAR gaps with bottom > 21938.
check('target-tfs', TARGET_TFS, ['5m', '15m']);
check('target-default-age', DEFAULT_TARGET_GAP_MAX_AGE_MINUTES, 60);
{
  const tgt = (tf: Timeframe, top: number, bottom: number, mi: number, p: Partial<FVG> = {}) =>
    mkGap({ tf, dir: 'bear' as const, top, bottom, formedAt: w(9, mi), ...p });
  const t5 = tgt('5m', 21980, 21960, 30); // edge 21960
  const t15 = tgt('15m', 21970, 21950, 25); // edge 21950 — closer to 21938
  const t5near = tgt('5m', 21962, 21945, 32); // edge 21945 — closest of all
  const AGE = 3600;
  const pick = (gaps: FVG[], direction: 'long' | 'short' = 'long', entry = 21938, maxAgeSec = AGE) =>
    pickTarget({ gaps, direction, entry, at: w(9, 36), maxAgeSec });

  // (a) closest edge wins ACROSS timeframes, in either array order
  check('target-closest-across-tfs', [pick([t5, t15])?.tf, pick([t5, t15])?.tp], ['15m', 21950]);
  check('target-closest-order-independent', pick([t15, t5])?.tf, '15m');
  check('target-5m-can-beat-15m', [pick([t5near, t15])?.tf, pick([t5near, t15])?.tp], ['5m', 21945]);
  // (b) closest among two gaps on the SAME timeframe
  check('target-closest-same-tf', pick([t5, t5near])?.tp, 21945);
  // (c) a tapped / mitigated gap is disqualified outright
  check('target-tapped-excluded', pick([{ ...t15, tappedAt: w(9, 30) }, t5])?.tf, '5m');
  check('target-tapped-later-still-ok', pick([{ ...t15, tappedAt: w(9, 50) }, t5])?.tf, '15m');
  check('target-inverted-excluded', pick([{ ...t15, invertedAt: w(9, 34) }, t5])?.tf, '5m');
  check('target-expired-excluded', pick([{ ...t15, expiredAt: w(9, 34) }, t5])?.tf, '5m');
  // (d) age cutoff: a gap formed before confirmTs - maxAge is out
  const stale = mkGap({ tf: '15m', dir: 'bear' as const, top: 21970, bottom: 21950, formedAt: w(8, 0) });
  check('target-too-old-excluded', pick([stale, t5])?.tf, '5m');
  check('target-age-boundary-inclusive', pick([tgt('15m', 21970, 21950, 30)], 'long', 21938, 360)?.tf, '15m');
  check('target-age-boundary-past', pick([tgt('15m', 21970, 21950, 29)], 'long', 21938, 360), null);
  check('target-formed-after-confirm-excluded', pick([tgt('15m', 21970, 21950, 40)]), null);
  // (e) the edge must be on the PROFIT side of the entry
  check('target-below-entry-excluded', pick([tgt('5m', 21935, 21900, 30)]), null);
  check('target-edge-at-entry-excluded', pick([tgt('5m', 21960, 21938, 30)]), null);
  // (f) wrong polarity / wrong timeframe never qualify
  check('target-wrong-polarity-excluded', pick([{ ...t15, dir: 'bull' as const }]), null);
  check('target-wrong-tf-excluded', pick([tgt('30m', 21970, 21950, 25)]), null);
  // (g) SHORT mirror: bull gaps, TP at the TOP, closest below the entry
  {
    const b30 = mkGap({ tf: '5m', dir: 'bull' as const, top: 21930, bottom: 21900, formedAt: w(9, 30) });
    const b15 = mkGap({ tf: '15m', dir: 'bull' as const, top: 21910, bottom: 21880, formedAt: w(9, 30) });
    check('target-short-picks-top-edge', [pick([b15, b30], 'short')?.tf, pick([b15, b30], 'short')?.tp], ['5m', 21930]);
    check('target-short-above-entry-excluded',
      pick([mkGap({ tf: '5m', dir: 'bull' as const, top: 21950, bottom: 21940, formedAt: w(9, 30) })], 'short'), null);
  }

  // (h) end to end through matchSweepTriggers
  const tOpts = (gaps: FVG[]) => ({ gaps, maxAgeSec: AGE });
  {
    const c = matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], targets: tOpts([t5, t15]) });
    check('target-candidate-carries-edge',
      [c.length, c[0].target?.tf, c[0].target?.tp, c[0].target?.formedAt], [1, '15m', 21950, w(9, 25)]);
  }
  // no valid target -> NO candidate, reported as 'no-target'
  {
    const dNone: TriggerOutcome[] = [];
    const c = matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], targets: tOpts([]), diag: dNone });
    check('no-target-no-candidate', [c.length, dNone[0].result], [0, 'no-target']);
    const dOld: TriggerOutcome[] = [];
    matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)], targets: tOpts([stale]), diag: dOld });
    check('no-target-when-only-stale', dOld[0].result, 'no-target');
  }
  // omitting the option leaves the old behaviour (and the FVG bot) untouched
  check('targets-optional', matchSweepTriggers({ ...mBase, triggers: [trigAt('1m', 36)] })[0].target, undefined);
}

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

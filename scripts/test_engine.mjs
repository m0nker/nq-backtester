// Unit-check the candidate engine core (web/src/lib/concepts/engine.ts)
// against STRATEGY_DEFINITIONS.md §3. Run from repo root: node scripts/test_engine.mjs
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const test = `
import {
  armingRef, biasAliveAt, firstInsidePrint, gapKey, inExecutionWindow, isFullyMitigated, matchTriggers, penetratedBeyond, penetrationOf, refBreached, resweepBreached, resweepRef, scanForTap, sessionOpenOf, sizeContracts, standingVeto, updateBiasDeaths, updateClearedBlockers, wouldInvert,
  type BiasEntry, type TriggerOutcome,
} from './src/lib/concepts/engine';
import type { FVG } from './src/lib/concepts/fvg';
import { etWallToUtc } from './src/lib/time/et';

const bar = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c, v: 1 });
const w = (h: number, mi: number) => etWallToUtc(2025, 1, 2, h, mi); // an EST trading day

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (ok ? '' : ' -> got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
  if (!ok) failures++;
}

// ---- bias deaths ----
{
  const biases: BiasEntry[] = [
    { id: 'L', direction: 'long', until: 22000, setTs: w(9, 25), deadAt: null },
    { id: 'S', direction: 'short', until: 21000, setTs: w(9, 25), deadAt: null },
  ];
  // bar BEFORE setTs touches 22000 — must not kill; later bar does
  updateBiasDeaths(biases, [
    bar(w(9, 20), 21500, 22050, 21480, 21500),
    bar(w(9, 40), 21500, 21990, 21400, 21950),
    bar(w(9, 50), 21950, 22001, 21900, 21990),
  ]);
  check('bias-long-touch', [biases[0].deadAt, biases[1].deadAt], [w(9, 50), null]); // independent lifetimes
  check('bias-alive-at', [biasAliveAt(biases[0], w(9, 45)), biasAliveAt(biases[0], w(9, 55))], [true, false]);
}

// ---- execution window (EST day) ----
check('window-bounds', [
  inExecutionWindow(w(9, 29)), inExecutionWindow(w(9, 30)),
  inExecutionWindow(w(11, 0)), inExecutionWindow(w(11, 1)),
], [false, true, true, false]);
// custom window: 10:00-14:30
{
  const win = { startSec: 10 * 3600, endSec: 14 * 3600 + 30 * 60 };
  check('custom-window', [
    inExecutionWindow(w(9, 45), win), inExecutionWindow(w(10, 0), win),
    inExecutionWindow(w(14, 30), win), inExecutionWindow(w(14, 31), win),
  ], [false, true, true, false]);
}

// ---- first inside print (tap = strictly inside; edge touch is not a tap) ----
{
  const bars = [bar(w(9, 30), 105.5, 106, 105, 105.5), bar(w(9, 31), 105.5, 106, 104.9, 105.2)];
  check('edge-touch-skipped', firstInsidePrint(bars, 105, 100, w(9, 0))?.t, w(9, 31));
  check('fromTs-respected', firstInsidePrint(bars, 105, 100, w(9, 31))?.t, w(9, 31));
  check('nothing-inside', firstInsidePrint([bars[0]], 105, 100, w(9, 0)), null);
}

// ---- matchTriggers: the 3 core rules assembled ----
// Long template: bull 15m condition [21900..21950] armed 9:35; retrace low
// 21880 at 9:40; bear 1m trigger gap [21925..21935] inverts (1m close above
// 21935) at 9:46; long bias live. 1m bars 9:30..9:45.
const mkGap = (p: Partial<FVG> & Pick<FVG, 'tf' | 'dir' | 'top' | 'bottom' | 'formedAt'>): FVG => ({
  aT: p.formedAt - 180, bT: p.formedAt - 120, tappedAt: null, fillPct: 0,
  invertedAt: null, expiredAt: null, ...p,
});
const bias = (id: string, direction: 'long' | 'short', until: number, setMin: number): BiasEntry =>
  ({ id, direction, until, setTs: w(9, setMin), deadAt: null });

const bars1m = [
  bar(w(9, 30), 21960, 21970, 21955, 21960),
  bar(w(9, 35), 21950, 21955, 21940, 21945), // taps the condition
  bar(w(9, 40), 21945, 21945, 21880, 21890), // swing low 21880
  bar(w(9, 45), 21890, 21940, 21885, 21938), // last close before confirm = 21938
];
const condition = mkGap({ tf: '15m', dir: 'bull', top: 21950, bottom: 21900, formedAt: w(9, 30) });
const trigger = mkGap({ tf: '1m', dir: 'bear', top: 21935, bottom: 21925, formedAt: w(9, 43), invertedAt: w(9, 46) });
const base = {
  triggers: [trigger],
  conditions: [{ gap: condition, armedAt: w(9, 35) }],
  biases: [bias('L1', 'long', 22100, 25)],
  bars1m,
  fired: new Set<string>(),
};

{
  const c = matchTriggers(base);
  check('happy-path-long', c.length, 1);
  check('candidate-shape', [c[0].direction, c[0].stop, c[0].entryEst, c[0].condition.tf, c[0].ifvg.tf, c[0].biasId],
    ['long', 21880, 21938, '15m', '1m', 'L1']);
}
// rule 1: no live bias of the right direction -> nothing
check('no-bias', matchTriggers({ ...base, biases: [bias('S1', 'short', 21000, 25)] }).length, 0);
check('bias-dead-before-confirm', matchTriggers({ ...base, biases: [{ ...bias('L1', 'long', 22100, 25), deadAt: w(9, 44) }] }).length, 0);
check('bias-set-after-confirm', matchTriggers({ ...base, biases: [bias('L1', 'long', 22100, 50)] }).length, 0);
// rule 2 invalidation: condition inverted/expired BEFORE the confirmation
check('condition-inverted-first', matchTriggers({ ...base, conditions: [{ gap: { ...condition, invertedAt: w(9, 45) }, armedAt: w(9, 35) }] }).length, 0);
check('condition-inverts-later-ok', matchTriggers({ ...base, conditions: [{ gap: { ...condition, invertedAt: w(10, 30) }, armedAt: w(9, 35) }] }).length, 1);
check('condition-expired-first', matchTriggers({ ...base, conditions: [{ gap: { ...condition, expiredAt: w(9, 45) }, armedAt: w(9, 35) }] }).length, 0);
check('armed-after-confirm', matchTriggers({ ...base, conditions: [{ gap: condition, armedAt: w(9, 50) }] }).length, 0);
// wrong-direction condition (bear gap can't condition a long)
check('condition-direction', matchTriggers({ ...base, conditions: [{ gap: { ...condition, dir: 'bear' as const }, armedAt: w(9, 35) }] }).length, 0);
// window: confirmation outside 9:30-11:00 ET
check('outside-window', matchTriggers({ ...base, triggers: [{ ...trigger, invertedAt: w(11, 5) }] }).length, 0);
// dedupe: already fired
check('fired-dedupe', matchTriggers({ ...base, fired: new Set(['1m:' + w(9, 43) + ':long']) }).length, 0);
// per-session window flows through matchTriggers: a 9:46 confirm dies under a 10:00+ window
check('match-custom-window', matchTriggers({ ...base, window: { startSec: 10 * 3600, endSec: 11 * 3600 } }).length, 0);
// primary = highest TF among matched conditions; others recorded
{
  const c5 = mkGap({ tf: '5m', dir: 'bull', top: 21948, bottom: 21910, formedAt: w(9, 32) });
  const c = matchTriggers({ ...base, conditions: [{ gap: c5, armedAt: w(9, 34) }, { gap: condition, armedAt: w(9, 35) }] });
  check('primary-highest-tf', [c[0].condition.tf, c[0].otherConditions], ['15m', ['5m']]);
}
// short mirror: bull 1m trigger inverted bearishly + short bias + bear condition
{
  const sBars = [
    bar(w(9, 30), 21900, 21910, 21895, 21900),
    bar(w(9, 35), 21905, 21960, 21900, 21955), // rally into the bear condition, swing high 21960 later
    bar(w(9, 40), 21955, 21990, 21950, 21985),
    bar(w(9, 45), 21985, 21988, 21930, 21935),
  ];
  const sCond = mkGap({ tf: '30m', dir: 'bear', top: 22000, bottom: 21950, formedAt: w(9, 30) });
  const sTrig = mkGap({ tf: '1m', dir: 'bull', top: 21980, bottom: 21970, formedAt: w(9, 43), invertedAt: w(9, 46) });
  const c = matchTriggers({
    triggers: [sTrig],
    conditions: [{ gap: sCond, armedAt: w(9, 35) }],
    biases: [bias('S1', 'short', 21800, 25)],
    bars1m: sBars,
    fired: new Set<string>(),
  });
  check('short-mirror', [c[0]?.direction, c[0]?.stop, c[0]?.entryEst], ['short', 21990, 21935]);
}
// degenerate geometry: swing "low" above the estimated entry -> skipped
{
  const badBars = [bar(w(9, 35), 21950, 21955, 21945, 21950), bar(w(9, 45), 21950, 21952, 21948, 21900)];
  check('degenerate-stop', matchTriggers({ ...base, bars1m: badBars }).length, 0);
}

// ---- session-tap rule: the arming tap must be at/after 09:30 ET of the
// confirmation's trading day ----
check('session-open-morning', sessionOpenOf(w(9, 50)), w(9, 30));
check('session-open-evening-rolls', sessionOpenOf(w(19, 0)), etWallToUtc(2025, 1, 3, 9, 30)); // 19:00 belongs to the NEXT trading day
check('premarket-tap-rejected', matchTriggers({ ...base, conditions: [{ gap: condition, armedAt: w(9, 15) }] }).length, 0);
check('prior-day-tap-rejected', matchTriggers({ ...base, conditions: [{ gap: condition, armedAt: etWallToUtc(2025, 1, 1, 9, 40) }] }).length, 0);
check('tap-at-open-ok', matchTriggers({ ...base, conditions: [{ gap: condition, armedAt: w(9, 30) }] }).length, 1);

// ---- fill-watermark tap scan (bearish 1h 25500-26000, the motivating case) ----
const wmBase = { dir: 'bear' as const, top: 26000, bottom: 25500, fromTs: w(5, 0), armFromTs: w(9, 30) };
// 1. premarket 8am push to 25700 sets the watermark; 09:30 print to 25600 does NOT arm
{
  const scan = scanForTap({ ...wmBase, bars: [
    bar(w(8, 0), 25000, 25700, 24800, 24800),  // fills to 25700, out of session
    bar(w(9, 30), 25400, 25600, 25350, 25550), // back inside but SHALLOWER
  ] });
  check('shallow-revisit-no-arm', [scan.armedBar, scan.watermark], [null, 25700]);
}
// 2. a later in-session print above 25700 arms (and advances the watermark)
{
  const scan = scanForTap({ ...wmBase, bars: [
    bar(w(8, 0), 25000, 25700, 24800, 24800),
    bar(w(9, 30), 25400, 25600, 25350, 25550),
    bar(w(9, 40), 25550, 25710, 25500, 25650),
  ] });
  check('beyond-watermark-arms', [scan.armedBar?.t, scan.watermark], [w(9, 40), 25710]);
}
// 3. a DEEPER premarket print raises the bar for the session: 9:15 to 25800 -> 9:40's 25710 no longer qualifies
{
  const scan = scanForTap({ ...wmBase, bars: [
    bar(w(8, 0), 25000, 25700, 24800, 24800),
    bar(w(9, 15), 25600, 25800, 25550, 25750),
    bar(w(9, 40), 25550, 25710, 25500, 25650),
  ] });
  check('premarket-raises-bar', [scan.armedBar, scan.watermark], [null, 25800]);
}
// 4. virgin gap: watermark starts at the near edge — any strictly-inside in-session print arms
{
  const scan = scanForTap({ ...wmBase, bars: [bar(w(9, 35), 25400, 25501, 25350, 25450)] });
  check('virgin-gap-arms', [scan.armedBar?.t, scan.watermark], [w(9, 35), 25501]);
  const edge = scanForTap({ ...wmBase, bars: [bar(w(9, 35), 25400, 25500, 25350, 25450)] });
  check('virgin-edge-touch-no-arm', [edge.armedBar, edge.watermark], [null, 25500]);
}
// 5. fully filled gap (watermark at the far edge) can never arm again
{
  const scan = scanForTap({ ...wmBase, watermark: 26000, bars: [bar(w(9, 35), 25900, 26100, 25800, 26050)] });
  check('full-fill-never-arms', scan.armedBar, null);
}
// 6. carry-over watermark across incremental scans behaves like one long scan
{
  const first = scanForTap({ ...wmBase, bars: [bar(w(8, 0), 25000, 25700, 24800, 24800)] });
  const second = scanForTap({ ...wmBase, watermark: first.watermark, bars: [bar(w(9, 40), 25550, 25710, 25500, 25650)] });
  check('incremental-carryover', [second.armedBar?.t, second.watermark], [w(9, 40), 25710]);
}
// 7. bullish mirror: gap 21900-21950 filled down to 21920 premarket; in-session must print BELOW 21920
{
  const bull = { dir: 'bull' as const, top: 21950, bottom: 21900, fromTs: w(5, 0), armFromTs: w(9, 30) };
  const shallow = scanForTap({ ...bull, bars: [
    bar(w(8, 0), 21960, 21980, 21920, 21970),
    bar(w(9, 35), 21945, 21950, 21925, 21940),
  ] });
  check('bull-shallow-no-arm', [shallow.armedBar, shallow.watermark], [null, 21920]);
  const deep = scanForTap({ ...bull, bars: [
    bar(w(8, 0), 21960, 21980, 21920, 21970),
    bar(w(9, 35), 21945, 21950, 21915, 21940),
  ] });
  check('bull-deeper-arms', [deep.armedBar?.t, deep.watermark], [w(9, 35), 21915]);
}
// 8. alreadyArmed: watermark advances but nothing arms
{
  const scan = scanForTap({ ...wmBase, alreadyArmed: true, bars: [bar(w(9, 40), 25550, 25710, 25500, 25650)] });
  check('already-armed-watermark-only', [scan.armedBar, scan.watermark], [null, 25710]);
}

// ---- fully mitigated (the user's motivating case, 2026-07-30) ----
// bullish 1h gap 25800-26000; next candle OHLC 26100/26200/25700/26100 trades
// through the WHOLE zone -> fully mitigated; the traversing bar never arms.
{
  const bull = { dir: 'bull' as const, top: 26000, bottom: 25800, fromTs: w(5, 0), armFromTs: w(9, 30) };
  const scan = scanForTap({ ...bull, bars: [bar(w(9, 35), 26100, 26200, 25700, 26100)] });
  check('traverse-bar-never-arms', [scan.armedBar, scan.watermark], [null, 25800]);
  check('traverse-is-mitigated', isFullyMitigated('bull', scan.watermark, 26000, 25800), true);
  // a bar landing exactly ON the far edge also mitigates (fill = low <= bottom)
  const edge = scanForTap({ ...bull, bars: [bar(w(9, 35), 26100, 26200, 25800, 26100)] });
  check('edge-traverse-no-arm', [edge.armedBar, isFullyMitigated('bull', edge.watermark, 26000, 25800)], [null, true]);
  // partial tap arms, LATER traverse mitigates — scan reports both; the store drops the arm
  const seq = scanForTap({ ...bull, bars: [
    bar(w(9, 35), 26050, 26100, 25900, 26050), // arms (stays inside)
    bar(w(9, 40), 26050, 26100, 25700, 26000), // traverses -> mitigated
  ] });
  check('arm-then-traverse', [seq.armedBar?.t, isFullyMitigated('bull', seq.watermark, 26000, 25800)], [w(9, 35), true]);
  // partial print still arms normally and is NOT mitigated
  const part = scanForTap({ ...bull, bars: [bar(w(9, 35), 26050, 26100, 25900, 26050)] });
  check('partial-still-arms', [part.armedBar?.t, isFullyMitigated('bull', part.watermark, 26000, 25800)], [w(9, 35), false]);
}
// bear mirror: gap 25500-25700 (bear fills upward toward top); full up-traverse never arms
{
  const bearM = { dir: 'bear' as const, top: 25700, bottom: 25500, fromTs: w(5, 0), armFromTs: w(9, 30) };
  const scan = scanForTap({ ...bearM, bars: [bar(w(9, 35), 25400, 25800, 25350, 25450)] });
  check('bear-traverse-never-arms', [scan.armedBar, isFullyMitigated('bear', scan.watermark, 25700, 25500)], [null, true]);
}

// ---- arming invalidation reference (the user's leg-low illustrations) ----
{
  // bear condition: leg falls to 7260.25 (the low), rallies into the gap;
  // ref = lowest low from candle A through the arming tap
  const legBars = [
    bar(w(9, 30), 7350, 7355, 7300, 7305), // candle A area
    bar(w(9, 35), 7305, 7310, 7260.25, 7270), // THE low
    bar(w(9, 40), 7270, 7317.25, 7268, 7315), // rally into the gap (the tap)
  ];
  check('ref-is-leg-low', armingRef(legBars, 'bear', w(9, 30), w(9, 40)), 7260.25);
  check('ref-window-respected', armingRef(legBars, 'bear', w(9, 40), w(9, 40)), 7268);
  // ANY print strictly below — a wick counts; an exact touch does not
  check('wick-below-breaches', refBreached('bear', 7260.25, bar(w(9, 45), 7270, 7272, 7260, 7271)), true);
  check('exact-touch-no-breach', refBreached('bear', 7260.25, bar(w(9, 45), 7270, 7272, 7260.25, 7271)), false);
  // bull mirror: taking the pre-tap HIGH invalidates
  check('bull-ref-is-leg-high', armingRef(legBars, 'bull', w(9, 30), w(9, 40)), 7355);
  check('bull-wick-above-breaches', refBreached('bull', 7355, bar(w(9, 45), 7350, 7355.25, 7340, 7350)), true);
  // empty window -> unbreachable sentinel
  check('empty-ref-unbreachable', refBreached('bear', armingRef([], 'bear', 0, 0), bar(w(9, 45), 1, 2, 0.5, 1)), false);
}

// ---- risk sizing (0.1-contract steps, min 0.1; % uses CURRENT balance) ----
const R = (mode: 'contracts' | 'percent' | 'usd', v: number) =>
  ({ mode, contracts: mode === 'contracts' ? v : 1, percent: mode === 'percent' ? v : 1, usd: mode === 'usd' ? v : 500 });
// the user's worked example: 1% of $50k = $500; 20-pt stop = $400/contract -> 1.25 -> 1.3
check('size-percent-example', sizeContracts(R('percent', 1), 20, 50_000), 1.3);
check('size-percent-current-balance', sizeContracts(R('percent', 1), 20, 60_000), 1.5); // 600/400
check('size-usd', sizeContracts(R('usd', 100), 25, 50_000), 0.2); // 100/(25*20)
check('size-min-floor', sizeContracts(R('usd', 10), 100, 50_000), 0.1); // 0.005 -> floor 0.1
check('size-constant-rounds', sizeContracts(R('contracts', 1.25), 999, 0), 1.3);
// 0 = CANNOT size (was 0.1, which hid these cases behind a real-looking trade)
check('size-zero-stop-guard', sizeContracts(R('usd', 500), 0, 50_000), 0);
check('size-negative-stop-guard', sizeContracts(R('usd', 500), -5, 50_000), 0);
// blown account: a non-positive balance must stop trading, not floor to 0.1.
// This is what turned one -98,789 loss into a tail of tiny 0.1-lot trades.
check('size-blown-account', sizeContracts(R('percent', 1), 50, -55_000), 0);
check('size-zero-balance', sizeContracts(R('percent', 1), 50, 0), 0);
// the incident itself: a 0.25-pt stop with a $436 budget asked for 87 lots
check('size-degenerate-stop-is-huge', sizeContracts(R('percent', 1), 0.25, 43_617), 87.2);

// ---- filled-gap veto: ANY filled same-or-higher gap suppresses a lower-TF
// inversion (overlap NOT required — tightened by user after an adjacent
// filled 2m failed to veto a 1m); lower/unfilled/inverted/expired never block ----
// base trigger: bear 1m [21925..21935] inverting at 9:46
const blockGap = (tf: '15s' | '30s' | '1m' | '2m' | '5m', patch: Partial<FVG> = {}) =>
  mkGap({ tf, dir: 'bear', top: 21940, bottom: 21920, formedAt: w(9, 20), tappedAt: w(9, 40), ...patch });
check('higher-filled-blocks', matchTriggers({ ...base, blockers: [blockGap('5m')] }).length, 0);
check('same-tf-filled-blocks', matchTriggers({ ...base, blockers: [blockGap('1m')] }).length, 0);
check('unfilled-no-block', matchTriggers({ ...base, blockers: [blockGap('5m', { tappedAt: null })] }).length, 1);
check('tapped-late-no-block', matchTriggers({ ...base, blockers: [blockGap('5m', { tappedAt: w(9, 50) })] }).length, 1);
check('already-inverted-no-block', matchTriggers({ ...base, blockers: [blockGap('5m', { invertedAt: w(9, 40) })] }).length, 1);
check('expired-no-block', matchTriggers({ ...base, blockers: [blockGap('5m', { expiredAt: w(9, 40) })] }).length, 1);
check('non-overlapping-still-blocks', matchTriggers({ ...base, blockers: [blockGap('5m', { top: 21990, bottom: 21960 })] }).length, 0);
check('adjacent-still-blocks', matchTriggers({ ...base, blockers: [blockGap('2m', { top: 21960, bottom: 21935 })] }).length, 0);
check('wrong-dir-no-block', matchTriggers({ ...base, blockers: [blockGap('5m', { dir: 'bull' as const })] }).length, 1);
check('trigger-not-self-blocked', matchTriggers({ ...base, blockers: [trigger] }).length, 1);
// lower TF never blocks: a 5m trigger fires through a filled overlapping 1m
{
  const trig5 = mkGap({ tf: '5m', dir: 'bear', top: 21935, bottom: 21925, formedAt: w(9, 30), invertedAt: w(9, 46) });
  const c = matchTriggers({ ...base, triggers: [trig5], blockers: [blockGap('1m')] });
  check('lower-filled-never-blocks', c.length, 1);
}
// 15s trigger obeys the same rule: blocked by a filled overlapping 1m
{
  const trig15s = mkGap({ tf: '15s', dir: 'bear', top: 21933, bottom: 21928, formedAt: w(9, 43), invertedAt: w(9, 46) });
  check('15s-blocked-by-1m', matchTriggers({ ...base, triggers: [trig15s], blockers: [blockGap('1m')] }).length, 0);
  check('15s-fires-alone', matchTriggers({ ...base, triggers: [trig15s] }).length, 1);
}

// ---- trigger diagnostics: every rejection reports WHY (drives the scope panel) ----
{
  const run = (opts: Parameters<typeof matchTriggers>[0]) => {
    const diag: TriggerOutcome[] = [];
    matchTriggers({ ...opts, diag });
    return diag.map((d) => [d.result, d.blockedBy ?? null]);
  };
  check('diag-candidate', run(base), [['candidate', null]]);
  check('diag-duplicate', run({ ...base, fired: new Set(['1m:' + w(9, 43) + ':long']) }), [['duplicate', null]]);
  check('diag-window', run({ ...base, triggers: [{ ...trigger, invertedAt: w(11, 5) }] }), [['window', null]]);
  check('diag-vetoed-names-blocker', run({ ...base, blockers: [blockGap('5m')] }), [['vetoed', '5m']]);
  check('diag-no-bias', run({ ...base, biases: [bias('S1', 'short', 21000, 25)] }), [['no-bias', null]]);
  check('diag-no-condition', run({ ...base, conditions: [{ gap: condition, armedAt: w(9, 50) }] }), [['no-condition', null]]);
  check('diag-geometry', run({ ...base, bars1m: [bar(w(9, 35), 21950, 21955, 21945, 21950), bar(w(9, 45), 21950, 21952, 21948, 21900)] }), [['geometry', null]]);
  // diagnostics are opt-in: omitting the sink changes nothing
  check('diag-optional', matchTriggers(base).length, 1);
}

// ---- standing veto: the block is visible BEFORE anything inverts ----
{
  const filled5m = blockGap('5m'); // bear, tapped 9:40, still active
  // a LONG comes from a BEAR gap inverting, so a filled bear gap blocks longs
  check('standing-veto-blocks-lower', standingVeto('1m', 'bear', [filled5m], w(9, 45)), '5m');
  check('standing-veto-same-tf-blocks', standingVeto('5m', 'bear', [filled5m], w(9, 45)), '5m');
  check('standing-veto-higher-unblocked', standingVeto('15m', 'bear', [filled5m], w(9, 45)), null);
  check('standing-veto-other-dir-clear', standingVeto('1m', 'bull', [filled5m], w(9, 45)), null);
  check('standing-veto-unfilled-clear', standingVeto('1m', 'bear', [blockGap('5m', { tappedAt: null })], w(9, 45)), null);
  check('standing-veto-before-tap-clear', standingVeto('1m', 'bear', [filled5m], w(9, 30)), null);
  check('standing-veto-inverted-clear', standingVeto('1m', 'bear', [blockGap('5m', { invertedAt: w(9, 42) })], w(9, 45)), null);
  check('standing-veto-expired-clear', standingVeto('1m', 'bear', [blockGap('5m', { expiredAt: w(9, 42) })], w(9, 45)), null);
}

// ---- resweep: the arming TAP's own extreme, and clearing blockers ----
{
  // bull condition: price dips IN to arm, so the tap's LOW is the reference
  const tap = bar(w(9, 35), 21950, 21955, 21940, 21945);
  check('resweep-ref-bull-is-tap-low', resweepRef(tap, 'bull'), 21940);
  check('resweep-ref-bear-is-tap-high', resweepRef(tap, 'bear'), 21955);
  // breach = a print back THROUGH it (a wick counts); an exact touch does not
  check('resweep-bull-below-breaches', resweepBreached('bull', 21940, bar(w(9, 40), 21945, 21946, 21939.75, 21944)), true);
  check('resweep-bull-touch-no-breach', resweepBreached('bull', 21940, bar(w(9, 40), 21945, 21946, 21940, 21944)), false);
  check('resweep-bear-above-breaches', resweepBreached('bear', 21955, bar(w(9, 40), 21950, 21955.25, 21949, 21951)), true);
  // it is a DIFFERENT level from armingRef, and points the other way
  const leg = [bar(w(9, 30), 21990, 22000, 21960, 21965), tap];
  check('resweep-vs-arming-ref', [armingRef(leg, 'bull', w(9, 30), w(9, 35)), resweepRef(tap, 'bull')], [22000, 21940]);
}

// ---- cleared blockers stop vetoing ----
{
  const blocked = matchTriggers({ ...base, blockers: [blockGap('5m')] });
  check('veto-active-before-resweep', blocked.length, 0);
  const cleared = matchTriggers({
    ...base,
    blockers: [blockGap('5m')],
    clearedBlockers: new Set([gapKey(blockGap('5m'))]),
  });
  check('cleared-blocker-lets-trigger-through', cleared.length, 1);
  // clearing an UNRELATED gap changes nothing
  check('unrelated-clear-still-vetoed', matchTriggers({
    ...base, blockers: [blockGap('5m')], clearedBlockers: new Set(['5m:999']),
  }).length, 0);
  // the standing veto agrees with the match-time veto
  const pool = [blockGap('5m')];
  check('standing-veto-respects-cleared', [
    standingVeto('1m', 'bear', pool, w(9, 45)),
    standingVeto('1m', 'bear', pool, w(9, 45), new Set([gapKey(pool[0])])),
  ], ['5m', null]);
}

// ---- cleared-blocker bookkeeping: a resweep retires only vetoes that were
// standing BEFORE it (user decision 2026-08-12) ----
//
// THE BUG THIS FIXES (user-reported, live): the old botStore.onAdvance ran the
// retire-on-resweep step LAST and unconditionally, marking each blocker with
// its penetration AS OF THE END OF THE ADVANCE. One candle that simultaneously
// (a) reswept a draw, (b) tapped deeper into a standing trigger-TF blocker and
// (c) inverted a trigger therefore retired that blocker with a mark that
// already included its own fresh tap — the resweep-clear beat the tap and the
// trigger fired. Case 'resweep-same-bar-tap-holds-veto' below is exactly that
// candle: OLD semantics produced { '5m:<9:20>': 21932 } (cleared, veto off);
// the new rule produces {} (veto holds).
{
  const blk = mkGap({ tf: '5m', dir: 'bear', top: 21940, bottom: 21920, formedAt: w(9, 20), tappedAt: w(9, 25) });
  const key = gapKey(blk); // '5m:<9:20>'
  const shallow = bar(w(9, 25), 21918, 21925, 21915, 21920); // penetrates to 21925
  const deepPre = bar(w(9, 38), 21920, 21932, 21915, 21930); // deeper, BEFORE the resweep
  const atRes = bar(w(9, 40), 21920, 21932, 21915, 21930); // deeper, ON the resweep bar
  const shallowRes = bar(w(9, 40), 21920, 21922, 21915, 21918); // resweep bar, no deeper tap
  const afterRes = bar(w(9, 42), 21920, 21934, 21915, 21930); // deeper, AFTER the resweep
  const bearResweep = [{ dir: 'bear' as const, at: w(9, 40) }];
  const run = (o: Partial<Parameters<typeof updateClearedBlockers>[0]>) =>
    updateClearedBlockers({ cleared: {}, pool: [blk], resweeps: [], bars: [], now: w(9, 45), ...o });

  // the raw penetration helpers
  check('penetration-bear-is-highest-high', penetrationOf(blk, [shallow, deepPre]), 21932);
  check('penetration-empty-is-near-edge', penetrationOf(blk, []), 21920);
  check('penetration-bull-is-lowest-low',
    penetrationOf(mkGap({ tf: '5m', dir: 'bull', top: 21940, bottom: 21920, formedAt: w(9, 20) }), [shallow, deepPre]), 21915);
  check('penetrated-beyond', [penetratedBeyond(blk, 21925, [deepPre]), penetratedBeyond(blk, 21932, [deepPre])], [true, false]);

  // (a) staled by a resweep with NO later penetration -> cleared, marked at
  //     the penetration standing before the resweep bar
  check('resweep-clears-standing-veto',
    run({ resweeps: bearResweep, bars: [shallow, shallowRes] }), { [key]: 21925 });
  // (b) THE SCREENSHOT CASE: the resweep bar ITSELF taps deeper -> veto holds
  check('resweep-same-bar-tap-holds-veto',
    run({ resweeps: bearResweep, bars: [shallow, atRes] }), {});
  // ...and a deeper tap on a LATER bar of the same advance holds it too
  check('resweep-later-tap-holds-veto',
    run({ resweeps: bearResweep, bars: [shallow, shallowRes, afterRes] }), {});
  // (c) penetration BEFORE the resweep bar only -> cleared, marked at it
  check('resweep-earlier-tap-still-clears',
    run({ resweeps: bearResweep, bars: [shallow, deepPre, shallowRes] }), { [key]: 21932 });
  // (d) a cleared blocker price later drives deeper into -> RE-ARMED (dropped)
  check('cleared-blocker-rearms-on-deeper',
    run({ cleared: { [key]: 21925 }, bars: [bar(w(9, 44), 21920, 21930, 21915, 21925)] }), {});
  check('cleared-blocker-survives-shallower',
    run({ cleared: { [key]: 21925 }, bars: [bar(w(9, 44), 21920, 21924, 21915, 21922)] }), { [key]: 21925 });
  // an entry whose gap left the pool is dropped
  check('cleared-entry-dropped-with-gap', run({ cleared: { [key]: 21925 }, pool: [] }), {});
  // an already-cleared blocker keeps its OLD mark; the resweep doesn't re-mark it
  check('resweep-keeps-existing-mark',
    run({ cleared: { [key]: 21930 }, resweeps: bearResweep, bars: [shallow, shallowRes] }), { [key]: 21930 });
  // LATEST resweep of the direction dates the cut: the 09:38 tap is before the
  // 09:40 raid, so it belongs to the retired veto rather than re-establishing it
  check('resweep-latest-time-wins',
    run({ resweeps: [{ dir: 'bear' as const, at: w(9, 35) }, ...bearResweep], bars: [shallow, deepPre, shallowRes] }),
    { [key]: 21932 });
  // only gaps IN PLAY are retired, and only of the reswept direction
  check('untapped-blocker-not-retired',
    run({ pool: [{ ...blk, tappedAt: null }], resweeps: bearResweep, bars: [shallow, shallowRes] }), {});
  check('inverted-blocker-not-retired',
    run({ pool: [{ ...blk, invertedAt: w(9, 30) }], resweeps: bearResweep, bars: [shallow, shallowRes] }), {});
  check('expired-blocker-not-retired',
    run({ pool: [{ ...blk, expiredAt: w(9, 30) }], resweeps: bearResweep, bars: [shallow, shallowRes] }), {});
  check('other-direction-not-retired',
    run({ pool: [{ ...blk, dir: 'bull' as const }], resweeps: bearResweep, bars: [shallow, shallowRes] }), {});
  // pre-formation bars never count toward the mark (each gap is clipped to its life)
  check('pre-formation-bars-ignored',
    run({ resweeps: bearResweep, bars: [bar(w(9, 0), 21990, 22000, 21980, 21990), shallow, shallowRes] }),
    { [key]: 21925 });
  // bars after the "now" bound are ignored
  check('bars-after-now-ignored',
    run({ resweeps: bearResweep, bars: [shallow, shallowRes, afterRes], now: w(9, 41) }), { [key]: 21925 });
}

// ---- fully mitigated gaps stay usable as conditions (2026-08-06) ----
// What disqualifies a condition is price sitting on its INVERTING side when
// the trigger fires, not whether a wick already took the whole zone.
{
  check('would-invert-bull', [
    wouldInvert('bull', 21899, 21950, 21900), // below the bottom -> would invert
    wouldInvert('bull', 21900, 21950, 21900), // exactly on it -> no
    wouldInvert('bull', 21925, 21950, 21900), // inside the zone -> no
    wouldInvert('bull', 22600, 21950, 21900), // far above -> no
  ], [true, false, false, false]);
  check('would-invert-bear', [
    wouldInvert('bear', 21951, 21950, 21900),
    wouldInvert('bear', 21950, 21950, 21900),
    wouldInvert('bear', 21000, 21950, 21900),
  ], [true, false, false]);

  // the user's worked example, scaled to this fixture: a bull condition
  // 21900-21950 whose zone was fully wicked through but never closed
  // through. entryEst here is 21938 (inside), so the long still stands.
  check('fully-mitigated-condition-still-works', matchTriggers({
    ...base, conditions: [{ gap: { ...condition, fillPct: 1 }, armedAt: w(9, 35) }],
  }).length, 1);

  // price BELOW the gap's bottom at the trigger -> a close there would
  // invert it, so it cannot be the condition
  {
    const lowBars = [
      bar(w(9, 30), 21960, 21970, 21955, 21960),
      bar(w(9, 35), 21950, 21955, 21940, 21945),
      bar(w(9, 40), 21945, 21945, 21860, 21870),
      bar(w(9, 45), 21870, 21880, 21860, 21870), // last close 21870 < bottom 21900
    ];
    const diag = [];
    check('price-on-inverting-side-rejected',
      matchTriggers({ ...base, bars1m: lowBars, diag }).length, 0);
    check('rejection-reads-no-condition', diag.map((d) => d.result), ['no-condition']);
  }
  // a bear condition mirrors: price above its top disqualifies it
  {
    const sCond = mkGap({ tf: '30m', dir: 'bear', top: 21930, bottom: 21900, formedAt: w(9, 30) });
    const sTrig = mkGap({ tf: '1m', dir: 'bull', top: 21980, bottom: 21970, formedAt: w(9, 43), invertedAt: w(9, 46) });
    const sBars = [
      bar(w(9, 30), 21900, 21910, 21895, 21900),
      bar(w(9, 35), 21905, 21960, 21900, 21955),
      bar(w(9, 45), 21955, 21990, 21950, 21985), // last close 21985 > top 21930
    ];
    check('bear-condition-price-above-top-rejected', matchTriggers({
      triggers: [sTrig], conditions: [{ gap: sCond, armedAt: w(9, 35) }],
      biases: [bias('S1', 'short', 21800, 25)], bars1m: sBars, fired: new Set(),
    }).length, 0);
  }
}

if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
console.log('ALL ENGINE TESTS PASS');
`;
const tmp = path.join(here, '..', 'web', '_engine_test.ts');
writeFileSync(tmp, test);
try {
  const out = execSync('npx --yes tsx ./_engine_test.ts', { cwd: path.join(here, '..', 'web'), encoding: 'utf8' });
  console.log(out);
} finally {
  execSync(process.platform === 'win32' ? 'del _engine_test.ts' : 'rm _engine_test.ts', { cwd: path.join(here, '..', 'web') });
}

// Unit-check FVG detection/lifecycle in web/src/lib/concepts/fvg.ts against
// STRATEGY_DEFINITIONS.md. Run from repo root: node scripts/test_fvg.mjs
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const test = `
import { computeFVGs, statusOf } from './src/lib/concepts/fvg';

const bar = (t: number, o: number, h: number, l: number, c: number) => ({ t, o, h, l, c, v: 1 });

let failures = 0;
function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + (ok ? '' : ' -> got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
  if (!ok) failures++;
}

// Base bullish pattern on 1m: A high=100, C low=105 -> zone [100,105]
const A = bar(0, 99, 100, 98, 99.5);
const B = bar(60, 100, 106, 99.9, 105.5);
const C = bar(120, 105.2, 107, 105, 106.5);

// 1. formation + geometry
{
  const g = computeFVGs([A, B, C], '1m', 180);
  check('bull-detected', g.length, 1);
  check('bull-zone', [g[0].dir, g[0].bottom, g[0].top], ['bull', 100, 105]);
  check('bull-times', [g[0].aT, g[0].bT, g[0].formedAt], [0, 60, 180]);
  check('fresh-state', [g[0].tappedAt, g[0].fillPct, g[0].invertedAt], [null, 0, null]);
}
// 2. no gap when C.low == A.high (touching, no void)
check('no-gap-touch', computeFVGs([A, B, bar(120, 105, 107, 100, 106.5)], '1m', 180).length, 0);
// 3. partial candle C never forms a gap (C closes at 180)
check('partial-C', computeFVGs([A, B, C], '1m', 179).length, 0);
// 4. bearish mirror: A low=100, C high=95 -> zone [95,100]
{
  const g = computeFVGs([bar(0, 101, 102, 100, 100.5), bar(60, 100, 100.1, 94, 94.5), bar(120, 94.8, 95, 93, 93.5)], '1m', 180);
  check('bear-zone', [g[0]?.dir, g[0]?.bottom, g[0]?.top], ['bear', 95, 100]);
}
// 5. exact boundary touch is NOT a tap; a print strictly inside IS
{
  const touch = computeFVGs([A, B, C, bar(180, 106, 106.5, 105, 106)], '1m', 240)[0];
  check('edge-touch-no-tap', touch.tappedAt, null);
  const tap = computeFVGs([A, B, C, bar(180, 106, 106.5, 104.9, 106)], '1m', 240)[0];
  check('inside-print-taps', tap.tappedAt, 180);
  check('tap-fill-pct', Math.round(tap.fillPct * 1000), Math.round(((105 - 104.9) / 5) * 1000));
}
// 6. full wick-through: fillPct 1, still NOT inverted (close back above)
{
  const g = computeFVGs([A, B, C, bar(180, 106, 106.5, 99, 105.5)], '1m', 240)[0];
  check('wick-through-fill', [g.fillPct, g.invertedAt], [1, null]);
}
// 7. inversion: own-TF close strictly beyond far edge; close AT edge is not
{
  const inv = computeFVGs([A, B, C, bar(180, 105, 105.5, 99, 99.5)], '1m', 240)[0];
  check('close-through-inverts', inv.invertedAt, 240);
  const at = computeFVGs([A, B, C, bar(180, 105, 105.5, 99, 100)], '1m', 240)[0];
  check('close-at-edge-not-inverted', at.invertedAt, null);
}
// 8. the partial last candle taps (prints are real) but cannot invert (no close yet)
{
  const g = computeFVGs([A, B, C, bar(180, 105, 105.5, 99, 99.5)], '1m', 210)[0];
  check('partial-taps-not-inverts', [g.tappedAt, g.fillPct, g.invertedAt], [180, 1, null]);
}
// 9. gap-over inversion: candle entirely below the zone, no print inside, still inverts by close
{
  const g = computeFVGs([A, B, C, bar(180, 98, 98.5, 97, 97.5)], '1m', 240)[0];
  check('gap-over-inverts', [g.tappedAt, g.fillPct, g.invertedAt], [null, 0, 240]);
}
// 10. bear inversion mirror: close strictly above the top
{
  const g = computeFVGs(
    [bar(0, 101, 102, 100, 100.5), bar(60, 100, 100.1, 94, 94.5), bar(120, 94.8, 95, 93, 93.5), bar(180, 95, 100.6, 94.9, 100.5)],
    '1m', 240,
  )[0];
  check('bear-close-above-inverts', g.invertedAt, 240);
}
// 11. candle C's own boundary low is not a tap of its own gap
{
  const g = computeFVGs([A, B, C], '1m', 180)[0];
  check('C-not-self-tap', g.tappedAt, null);
}
// 12. lookback: pattern completing before the scan window is not detected;
//     a pattern whose A/B lie before the window but C inside IS detected
{
  const flat = (t: number) => bar(t, 106, 106.6, 105.9, 106.2); // stays above the zone: no taps, no new gaps
  const series = [A, B, C, flat(180), flat(240), flat(300), flat(360), flat(420)];
  check('lookback-excludes', computeFVGs(series, '1m', 480, { lookbackCandles: 5 }).length, 0);
  check('lookback-boundary', computeFVGs(series, '1m', 480, { lookbackCandles: 6 }).length, 1);
}

// ---- 25-candle expiry (gap's C is at index 2; age of index i = i - 2) ----
const flat = (t: number) => bar(t, 106, 106.6, 105.9, 106.2); // parks above the zone
const flats = (n: number) => Array.from({ length: n }, (_, k) => flat(180 + k * 60));

// 13. alive at age 25, expired once a 26th candle exists
{
  const alive = computeFVGs([A, B, C, ...flats(25)], '1m', 28 * 60)[0]; // last idx 27
  check('age-25-still-alive', alive.expiredAt, null);
  const dead = computeFVGs([A, B, C, ...flats(26)], '1m', 29 * 60)[0]; // idx 28 = age 26
  check('age-26-expired', dead.expiredAt, 1680);
}
// 14. an over-age candle's prints no longer count for anything
{
  const g = computeFVGs([A, B, C, ...flats(25), bar(1680, 106, 106.5, 104, 106)], '1m', 29 * 60)[0];
  check('expired-print-ignored', [g.tappedAt, g.fillPct, g.expiredAt], [null, 0, 1680]);
}
// 15. inversion at exactly age 25 still counts
{
  const g = computeFVGs([A, B, C, ...flats(24), bar(1620, 105, 105.5, 99, 99.5)], '1m', 28 * 60)[0];
  check('invert-at-age-25', [g.invertedAt, g.expiredAt], [1680, null]);
}
// 16. a would-be inversion at age 26 loses to expiry
{
  const g = computeFVGs([A, B, C, ...flats(25), bar(1680, 105, 105.5, 99, 99.5)], '1m', 29 * 60)[0];
  check('invert-too-late', [g.invertedAt, g.expiredAt], [null, 1680]);
}
// 17. status vocabulary: unfilled (never tapped) / filled (tapped) / inverted
{
  const fresh = computeFVGs([A, B, C], '1m', 180)[0];
  const tapped = computeFVGs([A, B, C, bar(180, 106, 106.5, 104.9, 106)], '1m', 240)[0];
  const inv = computeFVGs([A, B, C, bar(180, 105, 105.5, 99, 99.5)], '1m', 240)[0];
  check('status-vocab', [statusOf(fresh), statusOf(tapped), statusOf(inv)], ['unfilled', 'filled', 'inverted']);
}
// 18. maxAgeCandles is configurable
{
  const g = computeFVGs([A, B, C, ...flats(4)], '1m', 8 * 60, { maxAgeCandles: 3 })[0];
  check('max-age-option', g.expiredAt, 180 + 3 * 60);
}

if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
console.log('ALL FVG TESTS PASS');
`;
const tmp = path.join(here, '..', 'web', '_fvg_test.ts');
writeFileSync(tmp, test);
try {
  const out = execSync('npx --yes tsx ./_fvg_test.ts', { cwd: path.join(here, '..', 'web'), encoding: 'utf8' });
  console.log(out);
} finally {
  execSync(process.platform === 'win32' ? 'del _fvg_test.ts' : 'rm _fvg_test.ts', { cwd: path.join(here, '..', 'web') });
}

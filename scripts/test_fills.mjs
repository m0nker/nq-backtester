// Unit-check the same-bar SL/TP sequencing in web/src/lib/trading/fills.ts.
// Run from repo root: node scripts/test_fills.mjs  (uses tsx to load TS)
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const test = `
import { simulateBar } from './src/lib/trading/fills';

// long 1 @ 20000: SL sell-stop 19990, TP sell-limit 20010, OCO pair
const orders = [
  { id: 'sl', side: 'sell', type: 'stop', qty: 1, stopPrice: 19990, ocoId: 'g', reduceOnly: true },
  { id: 'tp', side: 'sell', type: 'limit', qty: 1, limitPrice: 20010, ocoId: 'g', reduceOnly: true },
];
// one minute bar touching BOTH levels
const bar = { t: 60000, o: 20000, h: 20012, l: 19988, c: 20005, v: 100 };

const sec = (points) => (from, to) => {
  if (from !== 60000 || to !== 60060) throw new Error('bad 1s window: ' + from + '..' + to);
  return points;
};
const sbar = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });

let failures = 0;
function check(name, fills, wantId, wantAmbiguous) {
  const ok = fills.length === 1 && fills[0].orderId === wantId && fills[0].ambiguousBar === wantAmbiguous;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + name + ' -> ' + JSON.stringify(fills.map(f => ({ id: f.orderId, amb: f.ambiguousBar, px: f.price }))));
  if (!ok) failures++;
}

// 1. no resolver: legacy SL-first + ambiguous
check('no-resolver', simulateBar(orders, bar), 'sl', true);
// 2. resolver returns null (no coverage): same
check('no-coverage', simulateBar(orders, bar, () => null), 'sl', true);
// 3. 1s shows TP touched first: TP wins, unambiguous
check('tp-first', simulateBar(orders, bar, sec([
  sbar(60000, 20000, 20005, 20000, 20004),
  sbar(60010, 20004, 20011, 20003, 20009), // touches TP 20010
  sbar(60030, 20009, 20009, 19987, 19990), // later touches SL
])), 'tp', false);
// 4. 1s shows SL touched first: SL wins, unambiguous
check('sl-first', simulateBar(orders, bar, sec([
  sbar(60000, 20000, 20001, 19995, 19996),
  sbar(60010, 19996, 19996, 19989, 19992), // touches SL 19990
  sbar(60030, 19992, 20012, 19992, 20010),
])), 'sl', false);
// 5. both inside one second: SL wins, ambiguous
check('same-second', simulateBar(orders, bar, sec([
  sbar(60000, 20000, 20011, 19989, 20000),
])), 'sl', true);
// 6. 1s gap, neither touched: SL-first + ambiguous stands
check('1s-gap', simulateBar(orders, bar, sec([
  sbar(60000, 20000, 20003, 19999, 20001),
])), 'sl', true);
// 7. only TP triggers on the minute bar: no decision path, plain fill
const tpOnly = { t: 60000, o: 20000, h: 20012, l: 19995, c: 20005, v: 100 };
check('tp-only', simulateBar(orders, tpOnly, () => { throw new Error('resolver must not be called'); }), 'tp', false);
// 8. fill price stays the 1m formula even when 1s decides (TP wins, bar opened below limit -> fills AT limit)
const r = simulateBar(orders, bar, sec([sbar(60010, 20004, 20011, 20003, 20009)]));
if (r[0].price !== 20010) { console.log('FAIL tp-price ' + r[0].price); failures++; } else console.log('ok   tp-price 20010 (1m formula)');

if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
console.log('ALL FILL TESTS PASS');
`;
import { writeFileSync } from 'node:fs';
const tmp = path.join(here, '..', 'web', '_fills_test.ts');
writeFileSync(tmp, test);
try {
  const out = execSync('npx --yes tsx ./_fills_test.ts', { cwd: path.join(here, '..', 'web'), encoding: 'utf8' });
  console.log(out);
} finally {
  execSync(process.platform === 'win32' ? 'del _fills_test.ts' : 'rm _fills_test.ts', { cwd: path.join(here, '..', 'web') });
}

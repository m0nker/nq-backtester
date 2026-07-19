// Verify the arithmetic US-DST ET offset in web/src/lib/time/et.ts matches
// Intl.DateTimeFormat for every hour of 2008-01-01 .. 2030-01-01.
// Usage: node scripts/validate_et_offset.mjs

const probe = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function intlOffsetSec(tsSec) {
  const p = {};
  for (const { type, value } of probe.formatToParts(tsSec * 1000)) p[type] = value;
  const wall =
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000;
  return wall - tsSec;
}

const dstBoundsCache = new Map();
function dstBounds(year) {
  let b = dstBoundsCache.get(year);
  if (!b) {
    const secondSunMar = 8 + ((7 - new Date(Date.UTC(year, 2, 8)).getUTCDay()) % 7);
    const firstSunNov = 1 + ((7 - new Date(Date.UTC(year, 10, 1)).getUTCDay()) % 7);
    b = [Date.UTC(year, 2, secondSunMar, 7) / 1000, Date.UTC(year, 10, firstSunNov, 6) / 1000];
    dstBoundsCache.set(year, b);
  }
  return b;
}
function fastOffsetSec(tsSec) {
  const [start, end] = dstBounds(new Date(tsSec * 1000).getUTCFullYear());
  return tsSec >= start && tsSec < end ? -14_400 : -18_000;
}

const from = Date.UTC(2008, 0, 1) / 1000;
const to = Date.UTC(2030, 0, 1) / 1000;
let bad = 0;
for (let ts = from; ts < to; ts += 3600) {
  if (intlOffsetSec(ts) !== fastOffsetSec(ts)) {
    console.log(`MISMATCH at ${new Date(ts * 1000).toISOString()}: intl=${intlOffsetSec(ts)} fast=${fastOffsetSec(ts)}`);
    if (++bad > 10) process.exit(1);
  }
}
// also probe every minute within ±3h of each transition for exactness
for (let y = 2008; y < 2030; y++) {
  for (const b of dstBounds(y)) {
    for (let ts = b - 3 * 3600; ts <= b + 3 * 3600; ts += 60) {
      if (intlOffsetSec(ts) !== fastOffsetSec(ts)) {
        console.log(`MISMATCH near transition ${new Date(ts * 1000).toISOString()}`);
        if (++bad > 10) process.exit(1);
      }
    }
  }
}
console.log(bad === 0 ? 'ET OFFSET OK (2008-2030, hourly + transition minutes)' : `${bad} mismatches`);

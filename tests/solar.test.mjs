// Solar and lunar position, checked against published almanac values.
//   node tests/solar.test.mjs
//
// Reference figures come from the NOAA Solar Calculator and the US Naval
// Observatory. Tolerances are deliberately tight (a few tenths of a degree for
// the sun): if this drifts, shadows point the wrong way everywhere on Earth.

import assert from 'node:assert/strict';
import * as S from '../src/gfx/solar.js';

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  try { fn(); passed++; out.push(`  ok  ${name}`); }
  catch (e) { failed++; out.push(`FAIL  ${name}\n        ${e.message}`); }
}

test('Julian day matches known epochs', () => {
  assert.ok(Math.abs(S.julianDay(new Date('2000-01-01T12:00:00Z')) - 2451545.0) < 1e-6);
  assert.ok(Math.abs(S.julianDay(new Date('2026-09-03T00:00:00Z')) - 2461286.5) < 1e-6);
});

test('solar noon at Greenwich on the equinox puts the sun due south', () => {
  // 2026-03-20, London. Solar noon is near 12:07 UTC; the sun should be almost
  // exactly due south at an elevation of roughly 90 - latitude.
  const d = new Date('2026-03-20T12:07:00Z');
  const p = S.solarPosition(d, 51.4779, -0.0015);
  assert.ok(Math.abs(p.azimuth - 180) < 1.0, `azimuth ${p.azimuth.toFixed(2)}`);
  assert.ok(Math.abs(p.elevation - 38.5) < 1.2, `elevation ${p.elevation.toFixed(2)}`);
});

test('summer solstice noon at the Tropic of Cancer is overhead', () => {
  // On 21 June the subsolar point is at +23.44 deg. At that latitude, at local
  // solar noon, the sun should be within a degree of the zenith.
  const d = new Date('2026-06-21T12:00:00Z');
  const p = S.solarPosition(d, 23.44, 0);
  assert.ok(p.elevation > 89.0, `elevation ${p.elevation.toFixed(2)}`);
  assert.ok(Math.abs(p.declination - 23.44) < 0.15, `declination ${p.declination.toFixed(3)}`);
});

test('declination swings through the year as it should', () => {
  const jun = S.solarPosition(new Date('2026-06-21T12:00:00Z'), 0, 0).declination;
  const dec = S.solarPosition(new Date('2026-12-21T12:00:00Z'), 0, 0).declination;
  const mar = S.solarPosition(new Date('2026-03-20T12:00:00Z'), 0, 0).declination;
  assert.ok(Math.abs(jun - 23.44) < 0.15, `june ${jun.toFixed(3)}`);
  assert.ok(Math.abs(dec + 23.44) < 0.15, `december ${dec.toFixed(3)}`);
  assert.ok(Math.abs(mar) < 0.6, `march equinox ${mar.toFixed(3)}`);
});

test('the equation of time has the right shape', () => {
  // Roughly +14 min in mid-February, -16 min in early November, zero mid-April.
  const feb = S.solarPosition(new Date('2026-02-11T12:00:00Z'), 0, 0).eqTime;
  const nov = S.solarPosition(new Date('2026-11-03T12:00:00Z'), 0, 0).eqTime;
  assert.ok(feb < -13 && feb > -15, `february ${feb.toFixed(2)} min`);
  assert.ok(nov > 16 && nov < 17, `november ${nov.toFixed(2)} min`);
});

test('New York midsummer afternoon puts the sun in the west', () => {
  // 2026-06-21 20:00 UTC = 16:00 EDT. Sun well up and clearly west of south.
  const p = S.solarPosition(new Date('2026-06-21T20:00:00Z'), 40.7128, -74.0060);
  assert.ok(p.elevation > 30 && p.elevation < 55, `elevation ${p.elevation.toFixed(1)}`);
  assert.ok(p.azimuth > 240 && p.azimuth < 275, `azimuth ${p.azimuth.toFixed(1)}`);
});

test('Sydney in January has the noon sun in the north', () => {
  // Southern hemisphere: the midday sun is north, not south.
  const p = S.solarPosition(new Date('2026-01-15T01:00:00Z'), -33.8688, 151.2093);
  assert.ok(p.elevation > 70, `elevation ${p.elevation.toFixed(1)}`);
  assert.ok(p.azimuth < 60 || p.azimuth > 300, `azimuth ${p.azimuth.toFixed(1)} should be northerly`);
});

test('Nairobi at equinox noon is nearly straight overhead', () => {
  const p = S.solarPosition(new Date('2026-03-20T09:30:00Z'), -1.2921, 36.8219);
  assert.ok(p.elevation > 86, `elevation ${p.elevation.toFixed(1)}`);
});

test('refraction lifts the sun near the horizon', () => {
  // At the moment of geometric sunset the sun appears about half a degree up.
  const d = new Date('2026-03-20T18:10:00Z');
  const p = S.solarPosition(d, 51.4779, -0.0015);
  assert.ok(p.elevation > p.trueElevation, 'apparent elevation exceeds true');
  assert.ok(p.elevation - p.trueElevation > 0.3, `refraction only ${(p.elevation - p.trueElevation).toFixed(3)} deg`);
  // High in the sky, refraction is negligible.
  const noon = S.solarPosition(new Date('2026-06-21T12:00:00Z'), 23.44, 0);
  assert.ok(noon.elevation - noon.trueElevation < 0.02);
});

test('sunrise and sunset land at the right times in London', () => {
  // 2026-06-21 London: sunrise about 03:43 UTC, sunset about 20:21 UTC.
  const rs = S.sunriseSunset(new Date('2026-06-21T12:00:00Z'), 51.4779, -0.0015);
  assert.ok(rs.polar === null);
  assert.ok(Math.abs(rs.sunrise - 3.72) < 0.15, `sunrise ${rs.sunrise.toFixed(3)}h`);
  assert.ok(Math.abs(rs.sunset - 20.35) < 0.15, `sunset ${rs.sunset.toFixed(3)}h`);
  assert.ok(rs.sunset - rs.sunrise > 16.4, 'a long midsummer day');
});

test('the polar circles are handled, not fudged', () => {
  const midnightSun = S.sunriseSunset(new Date('2026-06-21T12:00:00Z'), 78.22, 15.65); // Svalbard
  assert.equal(midnightSun.polar, 'day', 'midnight sun in June');
  assert.equal(midnightSun.sunrise, null);

  const polarNight = S.sunriseSunset(new Date('2026-12-21T12:00:00Z'), 78.22, 15.65);
  assert.equal(polarNight.polar, 'night', 'polar night in December');

  // And the sun really does stay up all day there in June.
  let minElev = 99;
  for (let h = 0; h < 24; h++) {
    const p = S.solarPosition(new Date(Date.UTC(2026, 5, 21, h)), 78.22, 15.65);
    minElev = Math.min(minElev, p.elevation);
  }
  assert.ok(minElev > 0, `sun dipped to ${minElev.toFixed(2)} deg`);
});

test('the sun rises in the east and sets in the west', () => {
  const lat = 40, lon = 0;
  const morning = S.solarPosition(new Date('2026-03-20T07:00:00Z'), lat, lon);
  const evening = S.solarPosition(new Date('2026-03-20T17:00:00Z'), lat, lon);
  assert.ok(morning.azimuth > 70 && morning.azimuth < 130, `morning ${morning.azimuth.toFixed(1)}`);
  assert.ok(evening.azimuth > 230 && evening.azimuth < 290, `evening ${evening.azimuth.toFixed(1)}`);
});

test('azimuth advances monotonically through the day', () => {
  let prev = -1, wraps = 0;
  for (let m = 0; m < 24 * 60; m += 10) {
    const p = S.solarPosition(new Date(Date.UTC(2026, 5, 21, 0, m)), 45, 0);
    if (prev >= 0 && p.azimuth < prev) wraps++;
    prev = p.azimuth;
  }
  assert.ok(wraps <= 1, `azimuth reversed ${wraps} times; should wrap at most once`);
});

test('direction vector uses the game axes', () => {
  const north = S.azElToDirection(0, 0);
  const east = S.azElToDirection(90, 0);
  const up = S.azElToDirection(0, 90);
  assert.ok(north.z < -0.99 && Math.abs(north.x) < 1e-9, 'north is -z');
  assert.ok(east.x > 0.99 && Math.abs(east.z) < 1e-9, 'east is +x');
  assert.ok(up.y > 0.99, 'zenith is +y');
  for (const v of [north, east, up]) {
    assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) - 1) < 1e-9, 'unit length');
  }
});

test('moon position is plausible and phases cycle', () => {
  const p = S.lunarPosition(new Date('2026-09-03T22:00:00Z'), 51.48, 0);
  assert.ok(p.elevation >= -90 && p.elevation <= 90);
  assert.ok(p.azimuth >= 0 && p.azimuth < 360);
  assert.ok(p.phase >= 0 && p.phase <= 1);
  // Over a synodic month the illuminated fraction should reach both extremes.
  let mn = 1, mx = 0;
  for (let d = 0; d < 30; d++) {
    const ph = S.lunarPosition(new Date(Date.UTC(2026, 0, 1 + d)), 0, 0).phase;
    mn = Math.min(mn, ph); mx = Math.max(mx, ph);
  }
  assert.ok(mn < 0.08, `never new: min ${mn.toFixed(3)}`);
  assert.ok(mx > 0.92, `never full: max ${mx.toFixed(3)}`);
});

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

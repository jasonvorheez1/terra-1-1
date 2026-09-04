// Node-runnable checks for the pure geometry/geodesy/data layers.
//   node tests/geo.test.mjs
// Nothing here touches the DOM or the network, so it runs headless in CI.

import assert from 'node:assert/strict';
import * as U from '../src/core/util.js';
import * as R from '../src/core/rng.js';
import * as P from '../src/geo/projection.js';
import * as N from '../src/geo/nasa.js';
import { NDVI_LUT } from '../data/ndvi-lut.js';

let passed = 0, failed = 0;
const groups = [];
function test(name, fn) {
  try { fn(); passed++; groups.push(['  ok  ', name]); }
  catch (e) { failed++; groups.push(['FAIL  ', `${name}\n        ${e.message}`]); }
}

// --- util ------------------------------------------------------------------

test('clamp / lerp / smoothstep', () => {
  assert.equal(U.clamp(5, 0, 3), 3);
  assert.equal(U.lerp(0, 10, 0.25), 2.5);
  assert.equal(U.smoothstep(0.5), 0.5);
  assert.equal(U.smoothstep(-1), 0);
});

test('angleDelta wraps the short way', () => {
  assert.ok(Math.abs(U.angleDelta(3.0, -3.0) - 0.2831853) < 1e-5);
  assert.ok(Math.abs(U.angleDelta(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
});

test('parseLatLon accepts decimal and DMS', () => {
  assert.deepEqual(U.parseLatLon('48.8584, 2.2945'), [48.8584, 2.2945]);
  assert.deepEqual(U.parseLatLon('48.8584 2.2945'), [48.8584, 2.2945]);
  const dms = U.parseLatLon(`48°51'30.2"N 2°17'40.2"E`);
  assert.ok(Math.abs(dms[0] - 48.8584) < 1e-3 && Math.abs(dms[1] - 2.2945) < 1e-3);
  assert.equal(U.parseLatLon('nowhere'), null);
  assert.equal(U.parseLatLon('200, 400'), null, 'out-of-range rejected');
});

test('mergeKnown only copies known keys', () => {
  const dst = { a: 1, nested: { b: 2 } };
  U.mergeKnown(dst, { a: 9, nested: { b: 8 }, unknown: 5 });
  assert.deepEqual(dst, { a: 9, nested: { b: 8 } });
});

// --- rng -------------------------------------------------------------------

test('rng is deterministic for a seed', () => {
  const a = R.makeRng(1234), b = R.makeRng(1234);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());
});

test('rng streams differ between seeds', () => {
  assert.notEqual(R.makeRng(1)(), R.makeRng(2)());
});

test('noise2 stays in a sane range and is continuous', () => {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < 30000; i++) {
    const v = R.noise2(i * 0.137, i * 0.071, 7);
    mn = Math.min(mn, v); mx = Math.max(mx, v);
  }
  assert.ok(mn > -1.2 && mx < 1.2, `range ${mn}..${mx}`);
  const a = R.noise2(10.0, 4.0, 1), b = R.noise2(10.001, 4.0, 1);
  assert.ok(Math.abs(a - b) < 0.02, 'noise is continuous');
});

test('fbm2 is roughly zero-mean', () => {
  let s = 0;
  for (let i = 0; i < 8000; i++) s += R.fbm2(i * 0.011, i * 0.017, 5);
  assert.ok(Math.abs(s / 8000) < 0.1);
});

test('weighted picks respect weights', () => {
  const rng = R.makeRng(99);
  const items = [{ id: 'a', w: 9 }, { id: 'b', w: 1 }];
  let a = 0;
  for (let i = 0; i < 4000; i++) if (rng.weighted(items).id === 'a') a++;
  assert.ok(a > 3400 && a < 3800, `got ${a}/4000`);
});

// --- projection ------------------------------------------------------------

test('local projection matches haversine within 1 m over 1.3 km', () => {
  const p = new P.Projection(48.8584, 2.2945);
  const l = p.toLocal(48.8684, 2.3045);
  const planar = Math.hypot(l.x, l.z);
  const geodesic = P.haversine(48.8584, 2.2945, 48.8684, 2.3045);
  assert.ok(Math.abs(planar - geodesic) < 1, `${planar} vs ${geodesic}`);
});

test('projection round-trips exactly', () => {
  for (const [lat, lon] of [[48.85, 2.29], [-33.86, 151.2], [64.14, -21.94], [1.35, 103.8]]) {
    const p = new P.Projection(lat, lon);
    const l = p.toLocal(lat + 0.02, lon - 0.03);
    const g = p.toGeo(l.x, l.z);
    assert.ok(Math.abs(g.lat - (lat + 0.02)) < 1e-9);
    assert.ok(Math.abs(g.lon - (lon - 0.03)) < 1e-9);
  }
});

test('north is -z and east is +x', () => {
  const p = new P.Projection(0, 0);
  assert.ok(p.toLocal(1, 0).z < 0, 'north maps to -z');
  assert.ok(p.toLocal(0, 1).x > 0, 'east maps to +x');
});

test('tile maths round-trips', () => {
  const z = 14, lat = 48.8584, lon = 2.2945;
  const tx = P.lonToTileX(lon, z), ty = P.latToTileY(lat, z);
  assert.ok(Math.abs(P.tileXToLon(tx, z) - lon) < 1e-9);
  assert.ok(Math.abs(P.tileYToLat(ty, z) - lat) < 1e-7);
});

test('zoomForResolution picks a fine enough zoom', () => {
  const z = P.zoomForResolution(48.86, 10);
  assert.ok(P.metresPerPixel(48.86, z) <= 10);
  assert.ok(P.metresPerPixel(48.86, z - 1) > 10);
});

test('padBBox grows by the requested metres', () => {
  const bb = { south: 48.85, north: 48.87, west: 2.28, east: 2.31 };
  const p = P.padBBox(bb, 500);
  const grew = P.haversine(bb.north, bb.west, p.north, bb.west);
  assert.ok(Math.abs(grew - 500) < 5, `grew ${grew}`);
});

test('bearing points the right way', () => {
  assert.ok(Math.abs(P.bearing(0, 0, 1, 0) - 0) < 0.1, 'due north');
  assert.ok(Math.abs(P.bearing(0, 0, 0, 1) - 90) < 0.1, 'due east');
  assert.ok(Math.abs(P.bearing(0, 0, -1, 0) - 180) < 0.1, 'due south');
});

// --- NASA NDVI + biomes ----------------------------------------------------

test('NDVI colour inversion recovers palette values', () => {
  assert.ok(N.colourToNdvi(0, 24, 1, 255) > 0.9, 'darkest green is high NDVI');
  assert.ok(N.colourToNdvi(241, 236, 236, 255) < 0.05, 'pale is near zero');
  assert.equal(N.colourToNdvi(0, 54, 0, 0), null, 'transparent is no-data');
  assert.equal(N.colourToNdvi(255, 0, 255, 255), null, 'off-palette is no-data');
});

test('every LUT colour inverts back to its own NDVI value', async () => {
  // Round-trip the whole published palette, not just a couple of samples.
  let worst = 0;
  for (let i = 0; i < NDVI_LUT.length / 4; i++) {
    const r = NDVI_LUT[i * 4], g = NDVI_LUT[i * 4 + 1];
    const b = NDVI_LUT[i * 4 + 2], want = NDVI_LUT[i * 4 + 3];
    const got = N.colourToNdvi(r, g, b, 255);
    assert.ok(got !== null, `entry ${i} (${r},${g},${b}) inverted to no-data`);
    worst = Math.max(worst, Math.abs(got - want));
  }
  assert.ok(worst < 1e-9, `worst round-trip error ${worst}`);
  assert.ok(N.colourToNdvi(0, 36, 0, 255) > N.colourToNdvi(0, 54, 0, 255),
            'darker green reads as more vegetation');
});

test('treeline altitude matches observed values', () => {
  const cases = [[0, 3900, 4300], [20, 3400, 4000], [46, 1900, 2400],
                 [60, 1000, 1400], [68, 550, 900]];
  for (const [lat, lo, hi] of cases) {
    const t = N.treelineAltitude(lat);
    assert.ok(t >= lo && t <= hi, `treeline at ${lat} deg was ${Math.round(t)}, want ${lo}-${hi}`);
  }
});

test('MODIS date snapping lands on the 16-day grid and in the past', () => {
  for (const d of ['2026-09-03', '2024-06-20', '2021-01-02', '2019-12-30']) {
    const iso = N.snapToNdviPeriod(new Date(d));
    const dt = new Date(iso + 'T00:00:00Z');
    const jan1 = Date.UTC(dt.getUTCFullYear(), 0, 1);
    const doy = (dt.getTime() - jan1) / 86400000;
    assert.equal(doy % 16, 0, `${iso} is on the grid`);
    assert.ok(Date.now() - dt.getTime() > 29 * 86400000, `${iso} is old enough to exist`);
  }
});

test('biome classifier matches known places', () => {
  assert.equal(N.classifyBiome(-3.1, 80, 0.85).id, 'tropicalRainforest');
  assert.equal(N.classifyBiome(25, 300, 0.06).id, 'desert');
  assert.equal(N.classifyBiome(60.2, 15, 0.55).id, 'borealConifer');
  assert.equal(N.classifyBiome(46, 3000, 0.2).id, 'alpine');
  assert.equal(N.classifyBiome(78, 20, 0.05).id, 'polar');
  assert.equal(N.classifyBiome(37.98, 100, 0.25).id, 'mediterranean');
});

test('seasons invert across the equator', () => {
  const julyNorth = N.seasonalPhase(new Date('2026-07-15'), 60);
  const janNorth = N.seasonalPhase(new Date('2026-01-15'), 60);
  const julySouth = N.seasonalPhase(new Date('2026-07-15'), -33);
  assert.ok(julyNorth > 0.9, `july north ${julyNorth}`);
  assert.ok(janNorth < 0.1, `jan north ${janNorth}`);
  assert.ok(julySouth < 0.5, `july south ${julySouth}`);
  const tropics = N.seasonalPhase(new Date('2026-01-15'), 2);
  assert.ok(tropics > 0.6, 'tropics stay green year round');
});

// --- report ----------------------------------------------------------------

for (const [status, name] of groups) console.log(`${status}${name}`);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

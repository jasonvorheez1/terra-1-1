// Live end-to-end check: fetch real OSM data, extract features, validate the
// vertical profiles for tunnels and bridges against synthetic terrain.
//   node tests/osm.integration.mjs
// Hits the network, so it is kept out of the unit suites.

import assert from 'node:assert/strict';
import { Projection } from '../src/geo/projection.js';
import { RegionLoader, OsmData, overpass } from '../src/geo/overpass.js';
import { extractFeatures, assignEntrances, verticalProfile, stepProfile } from '../src/world/features.js';
import { polylineLength } from '../src/world/geometry.js';
import { roadSpec } from '../src/world/osm-tags.js';

// Node's fetch sends a UA that some Overpass front ends reject with 406, and
// browsers do not have that problem. Patch one in for the test run only.
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: { 'User-Agent': 'EarthWalk/0.1 (integration test)', ...(init.headers || {}) },
});

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n        ${e.message}`); }
}

const PLACES = [
  { name: 'Paris - Ile de la Cite (bridges over the Seine)', lat: 48.8556, lon: 2.3450 },
  { name: 'Manhattan - Midtown (dense towers)', lat: 40.7549, lon: -73.9840 },
  { name: 'Grandview, Missouri (suburban coverage)', lat: 38.88985, lon: -94.53131 },
];

for (const place of PLACES) {
  console.log(`\n=== ${place.name} ===`);
  const projection = new Projection(place.lat, place.lon);
  const loader = new RegionLoader({ sizeM: 900, marginM: 150 });

  const t0 = Date.now();
  const region = loader.request(projection, 0, 0);
  await region.structurePromise;
  const tStruct = Date.now() - t0;

  if (region.failed) {
    console.log(`  SKIP: Overpass unavailable (${region.failed.message})`);
    continue;
  }
  await region.detailPromise;
  const tTotal = Date.now() - t0;

  console.log(`  fetched in ${tStruct}ms (structure) / ${tTotal}ms (total) via ${overpass.lastGood}`);
  console.log(`  raw: ${JSON.stringify(region.data.stats)}`);

  const t1 = Date.now();
  const fs = extractFeatures(region.data, projection);
  assignEntrances(fs);
  const tExtract = Date.now() - t1;

  console.log(`  extracted in ${tExtract}ms:`,
    `${fs.buildings.length} buildings, ${fs.buildingParts.length} parts,`,
    `${fs.roads.length} roads, ${fs.rails.length} rails,`,
    `${fs.waterAreas.length} water, ${fs.landcover.length} landcover,`,
    `${fs.barriers.length} barriers, ${fs.trees.length} trees,`,
    `${fs.props.length} props, ${fs.pois.length} POIs`);

  check('produced buildings with positive height', () => {
    assert.ok(fs.buildings.length > 10, `only ${fs.buildings.length} buildings`);
    for (const b of fs.buildings) {
      assert.ok(b.heights.top > 0 && b.heights.top < 900, `bad height ${b.heights.top}`);
      assert.ok(b.heights.wallTop <= b.heights.top);
      assert.ok(b.heights.base < b.heights.top);
      assert.ok(b.ring.length >= 3);
      assert.ok(b.area > 0);
    }
  });

  check('every building got a door', () => {
    const without = fs.buildings.filter((b) => !b.door);
    assert.ok(without.length === 0, `${without.length} of ${fs.buildings.length} have no door`);
  });

  check('doors sit on the building outline', () => {
    for (const b of fs.buildings.slice(0, 200)) {
      const d = b.door;
      const bb = b.bounds;
      assert.ok(d.x >= bb.minX - 0.6 && d.x <= bb.maxX + 0.6, 'door x inside bounds');
      assert.ok(d.z >= bb.minZ - 0.6 && d.z <= bb.maxZ + 0.6, 'door z inside bounds');
      const nl = Math.hypot(d.nx, d.nz);
      assert.ok(Math.abs(nl - 1) < 1e-6, `door normal not unit: ${nl}`);
    }
  });

  check('roads have geometry and resolved widths', () => {
    assert.ok(fs.roads.length > 10, `only ${fs.roads.length} roads`);
    for (const r of fs.roads) {
      assert.ok(r.pts.length >= 2);
      assert.ok(r.spec.width >= 0.8 && r.spec.width <= 60, `width ${r.spec.width}`);
      for (let i = 1; i < r.pts.length; i++) {
        const seg = Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
        assert.ok(seg <= 9.001, `segment ${seg} exceeds resample limit`);
      }
    }
  });

  const bridges = fs.roads.concat(fs.rails).filter((r) => r.spec.bridge);
  const tunnels = fs.roads.concat(fs.rails).filter((r) => r.spec.tunnel);
  console.log(`  structures: ${bridges.length} bridges, ${tunnels.length} tunnels`);

  // Synthetic terrain: a hill in the middle so "bored tunnel" logic can fire,
  // plus flat ground elsewhere so "cut" and "flyover" logic can fire too.
  const hill = (x, z) => 40 * Math.exp(-((x * x + z * z) / (2 * 180 * 180)));
  const flat = () => 12;

  check('bridge decks clear the ground beneath them', () => {
    if (!bridges.length) { console.log('        (no bridges here, skipped)'); return; }
    for (const b of bridges) {
      const prof = verticalProfile(b.pts, flat, b.spec, b.endsAtGrade);
      assert.ok(['span', 'flyover'].includes(prof.kind), `kind ${prof.kind}`);
      let minGap = Infinity;
      for (let i = 0; i < b.pts.length; i++) {
        if (prof.shape[i] < 0.999) continue;          // on a ramp, not the deck
        minGap = Math.min(minGap, prof.heights[i] - prof.ground[i]);
      }
      if (isFinite(minGap)) {
        assert.ok(minGap >= prof.clearance - 1e-4,
                  `deck only ${minGap.toFixed(2)}m above flat ground, want ${prof.clearance}`);
      }
    }
  });

  check('bridge ends meet the ground so you can walk on', () => {
    if (!bridges.length) return;
    for (const b of bridges) {
      const prof = verticalProfile(b.pts, flat, b.spec, b.endsAtGrade);
      const n = prof.heights.length;
      // Only an end that actually meets street level has to reach street level;
      // a deck continuing onto another deck is meant to stay up.
      if (b.endsAtGrade[0]) {
        assert.ok(Math.abs(prof.heights[0] - prof.ground[0]) < 0.01,
                  `start floats ${(prof.heights[0] - prof.ground[0]).toFixed(2)}m`);
      }
      if (b.endsAtGrade[1]) {
        assert.ok(Math.abs(prof.heights[n - 1] - prof.ground[n - 1]) < 0.01,
                  `end floats ${(prof.heights[n - 1] - prof.ground[n - 1]).toFixed(2)}m`);
      }
    }
  });

  check('tunnels stay under the ground', () => {
    if (!tunnels.length) { console.log('        (no tunnels here, skipped)'); return; }
    for (const t of tunnels) {
      if (t.spec.tunnel === 'building_passage') continue;
      const prof = verticalProfile(t.pts, flat, t.spec, t.endsAtGrade);
      let minCover = Infinity;
      for (let i = 0; i < t.pts.length; i++) {
        if (prof.shape[i] < 0.999) continue;
        minCover = Math.min(minCover, prof.ground[i] - prof.heights[i]);
      }
      if (isFinite(minCover)) {
        assert.ok(minCover >= prof.clearance - 1e-4,
                  `only ${minCover.toFixed(2)}m of ground above the tunnel, want ${prof.clearance}`);
      }
    }
  });

  check('a tunnel through a hill runs level instead of digging', () => {
    // Synthesise a way straight through the hill and confirm the profile
    // reads as bored (follows the portal-to-portal line) not cut.
    const through = [];
    for (let i = 0; i <= 20; i++) through.push([-500 + i * 50, 0]);
    const spec = roadSpec({ highway: 'primary', tunnel: 'yes' });
    const prof = verticalProfile(through, hill, spec);
    assert.equal(prof.kind, 'bored', `expected bored, got ${prof.kind}`);
    const mid = Math.floor(through.length / 2);
    assert.ok(prof.ground[mid] - prof.heights[mid] > 20,
              'the hill should tower over the roadway at mid-span');
    assert.ok(Math.abs(prof.heights[0] - prof.ground[0]) < 0.01, 'portal is at grade');
  });

  check('an urban underpass on flat ground digs a dip', () => {
    const line = [];
    for (let i = 0; i <= 12; i++) line.push([-120 + i * 20, 300]);
    const spec = roadSpec({ highway: 'primary', tunnel: 'yes' });
    const prof = verticalProfile(line, flat, spec);
    assert.equal(prof.kind, 'cut', `expected cut, got ${prof.kind}`);
    const mid = Math.floor(line.length / 2);
    assert.ok(prof.ground[mid] - prof.heights[mid] >= prof.clearance - 1e-4,
              `dip only ${(prof.ground[mid] - prof.heights[mid]).toFixed(2)}m`);
  });

  check('a flyover over flat ground humps up', () => {
    const line = [];
    for (let i = 0; i <= 12; i++) line.push([-120 + i * 20, -300]);
    const spec = roadSpec({ highway: 'motorway', bridge: 'yes' });
    const prof = verticalProfile(line, flat, spec);
    assert.equal(prof.kind, 'flyover');
    const mid = Math.floor(line.length / 2);
    assert.ok(prof.heights[mid] - prof.ground[mid] >= prof.clearance - 1e-4,
              `hump only ${(prof.heights[mid] - prof.ground[mid]).toFixed(2)}m`);
  });

  check('deeper layers go deeper', () => {
    const line = [];
    for (let i = 0; i <= 12; i++) line.push([-120 + i * 20, 600]);
    const shallow = verticalProfile(line, flat, roadSpec({ highway: 'primary', tunnel: 'yes', layer: '-1' }));
    const deep = verticalProfile(line, flat, roadSpec({ highway: 'primary', tunnel: 'yes', layer: '-3' }));
    const mid = Math.floor(line.length / 2);
    assert.ok(deep.heights[mid] < shallow.heights[mid] - 5,
              `layer -3 (${deep.heights[mid].toFixed(1)}) not deeper than -1 (${shallow.heights[mid].toFixed(1)})`);
  });

  check('grade roads follow terrain exactly', () => {
    const line = [];
    for (let i = 0; i <= 20; i++) line.push([-500 + i * 50, 0]);
    const prof = verticalProfile(line, hill, roadSpec({ highway: 'residential' }));
    assert.equal(prof.kind, 'grade');
    for (let i = 0; i < line.length; i++) {
      assert.ok(Math.abs(prof.heights[i] - prof.ground[i]) < 1e-9);
    }
  });

  check('steps get a plausible tread and riser', () => {
    const stepWays = fs.roads.filter((r) => r.spec.steps);
    const line = [[0, 0], [0, 4]];
    const heights = [0, 2.4];
    const p = stepProfile(line, heights, roadSpec({ highway: 'steps' }));
    assert.ok(p.count >= 2 && p.count <= 400, `count ${p.count}`);
    assert.ok(Math.abs(p.rise) > 0.05 && Math.abs(p.rise) < 0.35, `riser ${p.rise}`);
    assert.ok(p.treadDepth > 0.05, `tread ${p.treadDepth}`);
    if (stepWays.length) console.log(`        (${stepWays.length} real staircases in this region)`);
  });

  check('landcover polygons are ordered for overlap', () => {
    for (const lc of fs.landcover) {
      assert.ok(typeof lc.spec.z === 'number');
      assert.ok(lc.ring.length >= 3);
    }
  });

  check('features are never emitted twice', () => {
    const seen = new Set();
    const all = [...fs.buildings, ...fs.roads, ...fs.landcover, ...fs.waterAreas];
    for (const f of all) {
      const k = f.source || `x${f.id}`;
      assert.ok(!seen.has(k), `duplicate ${k}`);
      seen.add(k);
    }
  });

  // Sample of what came out, so a human can eyeball plausibility.
  const tall = fs.buildings.slice().sort((a, b) => b.heights.top - a.heights.top).slice(0, 3);
  for (const b of tall) {
    console.log(`        tallest: ${(b.name || '(unnamed)').slice(0, 34).padEnd(34)}` +
                ` ${b.heights.top.toFixed(0)}m / ${b.levels} levels / ${b.kind}`);
  }
  const named = fs.roads.filter((r) => r.name);
  console.log(`        ${named.length} named roads, e.g. ${named.slice(0, 3).map((r) => r.name).join(' | ')}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

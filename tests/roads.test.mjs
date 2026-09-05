import assert from 'node:assert/strict';
import {
  junctionSetback, trimPolylineProfile, splitPolylineProfileAtJunctions,
  drivingSideForCountry, roadMarkingLayout, shouldBuildSidewalk,
} from '../src/world/road-layout.js';
import { FeatureSet, assignRoadJunctionPatches } from '../src/world/features.js';
import { buildParkingMarkings } from '../src/world/build/ground.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n        ${e.message}`); }
}

test('junction setback clears half the intersecting carriageway', () => {
  assert.ok(junctionSetback({ width: 12 }, 'marking') > 6);
  assert.ok(junctionSetback({ width: 12 }, 'sidewalk') >
            junctionSetback({ width: 12 }, 'marking'));
});

test('polyline/profile trimming interpolates both position and height', () => {
  const out = trimPolylineProfile([[0, 0], [10, 0], [20, 0]], [0, 10, 20], 4, 3);
  assert.deepEqual(out.pts, [[4, 0], [10, 0], [17, 0]]);
  assert.deepEqual(out.heights, [4, 10, 17]);
});

test('over-trimming refuses degenerate junction geometry', () => {
  const out = trimPolylineProfile([[0, 0], [4, 0]], [0, 0], 3, 3);
  assert.equal(out.pts.length, 0);
});

test('interior junctions split kerbs and paint on both sides', () => {
  const out = splitPolylineProfileAtJunctions(
    [[0, 0], [10, 0], [20, 0]], [0, 0, 0], [[10, 0]], 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].pts, [[0, 0], [8, 0]]);
  assert.deepEqual(out[1].pts, [[12, 0], [20, 0]]);
});

test('two-way North American roads get yellow centre paint', () => {
  const lines = roadMarkingLayout({ markings: true, lanes: 2, width: 7, oneway: false }, 'southwest');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].colour, 0xf2c94c);
  assert.equal(lines[0].offset, 0);
});

test('four-lane roads get outer separators and a double centre line', () => {
  const lines = roadMarkingLayout({ markings: true, lanes: 4, width: 14, oneway: false }, 'northAmerica');
  assert.equal(lines.filter((l) => l.kind === 'lane-solid').length, 2);
  assert.equal(lines.filter((l) => l.kind === 'lane-dashed').length, 2);
});

test('country codes select left- and right-driving traffic without city rules', () => {
  assert.equal(drivingSideForCountry('JP'), 'left');
  assert.equal(drivingSideForCountry('au'), 'left');
  assert.equal(drivingSideForCountry('GB'), 'left');
  assert.equal(drivingSideForCountry('US'), 'right');
  assert.equal(drivingSideForCountry('FR'), 'right');
  assert.equal(drivingSideForCountry(null), 'right');
});

test('asymmetric directional centre lines mirror with the driving side', () => {
  const spec = {
    markings: true, lanes: 4, lanesForward: 3, lanesBackward: 1,
    lanesBothWays: 0, width: 13.6, oneway: false,
  };
  const right = roadMarkingLayout(spec, 'northAmerica', 'right')
    .filter((line) => line.kind === 'lane-solid');
  const left = roadMarkingLayout(spec, 'eastAsia', 'left')
    .filter((line) => line.kind === 'lane-solid');
  assert.equal(right.length, 2);
  assert.equal(left.length, 2);
  assert.ok(right.every((line) => line.offset > 0));
  assert.ok(left.every((line) => line.offset < 0));
});

test('a shared centre turn lane gets one boundary on each side', () => {
  const lines = roadMarkingLayout({
    markings: true, lanes: 4, lanesForward: 2, lanesBackward: 1,
    lanesBothWays: 1, width: 13.4, oneway: false,
  }, 'northAmerica');
  assert.equal(lines.length, 3);
  assert.equal(lines.filter((l) => l.kind === 'lane-solid').length, 2);
  assert.equal(lines.filter((l) => l.kind === 'lane-dashed').length, 1);
  assert.notEqual(lines[0].offset, lines[1].offset);
});

test('asymmetric shared turn lanes also mirror in left-driving countries', () => {
  const spec = {
    markings: true, lanes: 5, lanesForward: 3, lanesBackward: 1,
    lanesBothWays: 1, width: 16.8, oneway: false,
  };
  const right = roadMarkingLayout(spec, 'northAmerica', 'right')
    .filter((line) => line.kind === 'lane-solid').map((line) => line.offset);
  const left = roadMarkingLayout(spec, 'eastAsia', 'left')
    .filter((line) => line.kind === 'lane-solid').map((line) => line.offset);
  const mirrored = right.map((offset) => -offset).reverse();
  assert.equal(left.length, mirrored.length);
  assert.ok(left.every((offset, i) => Math.abs(offset - mirrored[i]) < 1e-9));
});

test('a one-lane road has no invented centre line', () => {
  assert.deepEqual(roadMarkingLayout({ markings: true, lanes: 1, width: 4, oneway: true }), []);
});

test('North American side streets need mapped evidence for sidewalks', () => {
  assert.equal(shouldBuildSidewalk({
    sidewalk: true, sidewalkTagged: false, highway: 'residential',
  }, 'northAmerica'), false);
  assert.equal(shouldBuildSidewalk({
    sidewalk: true, sidewalkTagged: true, highway: 'residential',
  }, 'northAmerica'), true);
  assert.equal(shouldBuildSidewalk({
    sidewalk: true, sidewalkTagged: false, highway: 'primary',
  }, 'southwest'), true);
});

test('one incident road owns one shared junction patch', () => {
  const fs = new FeatureSet();
  const spec = (priority, width) => ({
    bridge: null, tunnel: null, covered: false, layer: 0, width,
    cls: { priority },
  });
  fs.roads.push(
    { source: 'minor', spec: spec(4, 6), junctions: [{ ref: 7, x: 0, z: 0 }] },
    { source: 'major', spec: spec(7, 12), junctions: [{ ref: 7, x: 0, z: 0 }] },
  );
  assert.equal(assignRoadJunctionPatches(fs), 1);
  assert.equal(fs.roads[0].junctionPatches.length, 0);
  assert.equal(fs.roads[1].junctionPatches.length, 1);
  assert.ok(fs.roads[1].junctionPatches[0].radius > 6);
});

test('surface parking receives aligned bay paint and sparse parked cars', () => {
  const accumulators = new Map();
  const multi = {
    for(key) {
      if (!accumulators.has(key)) {
        accumulators.set(key, { quads: 0, addQuad() { this.quads++; } });
      }
      return accumulators.get(key);
    },
  };
  let collisions = 0;
  const collide = { rotatedBox() { collisions++; } };
  const ctx = {
    detail: 'high', terrainAt: () => 0,
    settings: { graphics: { propDensity: 3 } },
    materials: { markings: () => ({}), solid: () => ({}) },
  };
  const lc = {
    id: 'parking-test', area: 720,
    ring: [[-18, -10], [18, -10], [18, 10], [-18, 10]], holes: [],
    tags: { amenity: 'parking', parking: 'surface' },
  };
  const markings = buildParkingMarkings(lc, ctx, multi, 0.08, collide);
  assert.ok(markings >= 10, `only ${markings} bay separators`);
  assert.ok(accumulators.get('markings:parking-bays').quads >= markings);
  assert.ok((accumulators.get('solid')?.quads || 0) > 0, 'no parked cars were emitted');
  assert.ok(collisions > 0, 'parked cars have no collision');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

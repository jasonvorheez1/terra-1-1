// Procedural floor plans: are they valid buildings you could actually walk
// around, on every footprint shape OSM will throw at us?
//   node tests/interior.test.mjs

import assert from 'node:assert/strict';
import * as FP from '../src/interior/floorplan.js';
import { buildingHeights, buildingClass } from '../src/world/osm-tags.js';
import { doorOnRing } from '../src/world/features.js';
import { centroid, area, pointInPolygon } from '../src/world/geometry.js';
import { makeRng } from '../src/core/rng.js';

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  try { fn(); passed++; out.push(`  ok  ${name}`); }
  catch (e) { failed++; out.push(`FAIL  ${name}\n        ${e.message}`); }
}

/** Build the minimal building record the generator needs. */
function makeBuilding(ring, tags, id = 1) {
  const a = area(ring);
  const heights = buildingHeights(tags, a, makeRng(id));
  const c = centroid(ring);
  const b = {
    id, source: `way/${id}`, ring, holes: [], area: a, tags, heights,
    centroid: c, kind: heights.cls.kind, levels: heights.levels,
    name: tags.name || null,
  };
  b.door = doorOnRing(ring, c, [c[0], c[1] - 1000]);
  return b;
}

const rect = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];
const lShape = (s) => [[0, 0], [s, 0], [s, s * 0.45], [s * 0.45, s * 0.45], [s * 0.45, s], [0, s]];
const rotated = (ring, ang) => ring.map(([x, z]) => [
  x * Math.cos(ang) - z * Math.sin(ang), x * Math.sin(ang) + z * Math.cos(ang)]);

// --- basics ----------------------------------------------------------------

test('a simple house generates a viable plan', () => {
  const b = makeBuilding(rect(10, 8), { building: 'house', 'building:levels': '2' });
  const plan = FP.generateInterior(b);
  assert.ok(plan.viable, plan.reason);
  assert.equal(plan.floors.length, 2);
  assert.ok(plan.floors[0].rooms.length >= 2, `only ${plan.floors[0].rooms.length} rooms`);
});

test('a cupboard-sized footprint is refused rather than faked', () => {
  const plan = FP.generateInterior(makeBuilding(rect(1.6, 1.4), { building: 'shed' }));
  assert.equal(plan.viable, false);
  assert.ok(plan.reason);
});

test('generation is deterministic for a given building', () => {
  const mk = () => FP.generateInterior(makeBuilding(rect(14, 11), { building: 'house', 'building:levels': '2' }, 4242));
  const a = mk(), b = mk();
  assert.equal(a.floors.length, b.floors.length);
  for (let f = 0; f < a.floors.length; f++) {
    assert.equal(a.floors[f].rooms.length, b.floors[f].rooms.length);
    for (let i = 0; i < a.floors[f].rooms.length; i++) {
      const ra = a.floors[f].rooms[i], rb = b.floors[f].rooms[i];
      assert.equal(ra.type, rb.type);
      assert.ok(Math.abs(ra.u0 - rb.u0) < 1e-12 && Math.abs(ra.v1 - rb.v1) < 1e-12);
    }
  }
});

test('different buildings get different plans', () => {
  const a = FP.generateInterior(makeBuilding(rect(14, 11), { building: 'house' }, 1));
  const b = FP.generateInterior(makeBuilding(rect(14, 11), { building: 'house' }, 2));
  const sameCount = a.floors[0].rooms.length === b.floors[0].rooms.length;
  const sameFirst = a.floors[0].rooms[0].u1 === b.floors[0].rooms[0].u1;
  assert.ok(!(sameCount && sameFirst), 'two different buildings produced identical plans');
});

// --- structural validity ---------------------------------------------------

test('rooms never overlap each other', () => {
  const kinds = ['house', 'apartments', 'office', 'retail', 'school', 'hotel'];
  for (const kind of kinds) {
    const plan = FP.generateInterior(makeBuilding(rect(26, 18), { building: kind, 'building:levels': '3' }, 7));
    assert.ok(plan.viable, kind);
    for (const floor of plan.floors) {
      for (let i = 0; i < floor.rooms.length; i++) {
        for (let j = i + 1; j < floor.rooms.length; j++) {
          const a = floor.rooms[i], b = floor.rooms[j];
          const overlapU = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
          const overlapV = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
          assert.ok(overlapU <= 0.02 || overlapV <= 0.02,
            `${kind}: ${a.type} and ${b.type} overlap by ${overlapU.toFixed(2)}x${overlapV.toFixed(2)}`);
        }
      }
    }
  }
});

test('every room has a usable size', () => {
  const plan = FP.generateInterior(makeBuilding(rect(24, 16), { building: 'apartments', 'building:levels': '4' }, 11));
  for (const floor of plan.floors) {
    for (const r of floor.rooms) {
      assert.ok(r.width > 0.9 && r.depth > 0.9, `${r.type} is ${r.width.toFixed(2)}x${r.depth.toFixed(2)}`);
      assert.ok(r.area > 1.2, `${r.type} has area ${r.area.toFixed(2)}`);
    }
  }
});

test('every room on every floor is reachable from the entrance', () => {
  const cases = [
    [rect(12, 9), { building: 'house', 'building:levels': '2' }],
    [rect(30, 20), { building: 'office', 'building:levels': '4' }],
    [rect(22, 14), { building: 'apartments', 'building:levels': '5' }],
    [rect(40, 26), { building: 'retail' }],
    [lShape(18), { building: 'house', 'building:levels': '2' }],
    [rect(9, 26), { building: 'terrace', 'building:levels': '3' }],
  ];
  for (const [ring, tags] of cases) {
    const plan = FP.generateInterior(makeBuilding(ring, tags, 99));
    assert.ok(plan.viable, `${tags.building} not viable`);
    for (const floor of plan.floors) {
      const reached = FP.reachableRooms(floor);
      const total = floor.rooms.length;
      assert.equal(reached.size, total,
        `${tags.building} floor ${floor.level}: only ${reached.size} of ${total} rooms reachable`);
    }
  }
});

test('doors sit on a wall the two rooms actually share', () => {
  const plan = FP.generateInterior(makeBuilding(rect(28, 19), { building: 'office', 'building:levels': '3' }, 5));
  for (const floor of plan.floors) {
    for (const d of floor.doors) {
      const a = floor.rooms[d.a], b = floor.rooms[d.b];
      const shared = FP.sharedWall(a, b);
      assert.ok(shared, `door between ${a.type} and ${b.type} has no shared wall`);
      assert.equal(shared.axis, d.axis);
      assert.ok(Math.abs(shared.at - d.at) < 0.03);
      assert.ok(d.centre >= shared.lo && d.centre <= shared.hi, 'door centre outside the shared span');
      assert.ok(d.width >= 0.6, `door only ${d.width.toFixed(2)}m wide`);
    }
  }
});

test('rooms stay inside the building footprint', () => {
  const ring = lShape(20);
  const b = makeBuilding(ring, { building: 'house', 'building:levels': '2' }, 21);
  const plan = FP.generateInterior(b);
  assert.ok(plan.viable);
  for (const floor of plan.floors) {
    for (const r of floor.rooms) {
      // The room centre must be inside the (inset) footprint, in local space.
      assert.ok(pointInPolygon(plan.localRing, plan.localHoles, r.cu, r.cv),
        `${r.type} centre is outside the footprint`);
    }
  }
});

test('an L-shaped plan does not fill the notch', () => {
  const ring = lShape(22);
  const plan = FP.generateInterior(makeBuilding(ring, { building: 'house', 'building:levels': '2' }, 31));
  let inNotch = 0;
  for (const r of plan.floors[0].rooms) {
    if (!pointInPolygon(plan.localRing, plan.localHoles, r.cu, r.cv)) inNotch++;
  }
  assert.equal(inNotch, 0, `${inNotch} rooms landed outside the L`);
});

// --- programme -------------------------------------------------------------

test('buildings that need corridors get them', () => {
  for (const kind of ['apartments', 'office', 'school', 'hotel']) {
    const plan = FP.generateInterior(makeBuilding(rect(34, 22), { building: kind, 'building:levels': '3' }, 8));
    const hasCorridor = plan.floors.some((f) => f.rooms.some((r) => r.type === 'corridor'));
    assert.ok(hasCorridor, `${kind} has no corridor on any floor`);
  }
});

test('a house does not get an office corridor', () => {
  const plan = FP.generateInterior(makeBuilding(rect(11, 9), { building: 'house', 'building:levels': '2' }, 3));
  const corridors = plan.floors[0].rooms.filter((r) => r.type === 'corridor');
  assert.equal(corridors.length, 0);
});

test('multi-storey buildings get a stair shaft in the same place on each floor', () => {
  const plan = FP.generateInterior(makeBuilding(rect(20, 15), { building: 'apartments', 'building:levels': '4' }, 13));
  assert.ok(plan.stairs, 'no stair shaft reserved');
  const shafts = plan.floors.map((f) => f.stairRoom).filter(Boolean);
  assert.equal(shafts.length, plan.floors.length, 'a floor is missing its stairwell');
  for (const s of shafts) {
    assert.ok(Math.abs(s.u0 - shafts[0].u0) < 1e-9 && Math.abs(s.v0 - shafts[0].v0) < 1e-9,
      'stairwells do not line up between floors');
  }
});

test('a single-storey building needs no stairs', () => {
  const plan = FP.generateInterior(makeBuilding(rect(14, 10), { building: 'retail', 'building:levels': '1' }, 17));
  assert.equal(plan.stairs, null);
});

test('the ground floor programme differs from the floors above', () => {
  const plan = FP.generateInterior(makeBuilding(rect(24, 16), { building: 'hotel', 'building:levels': '4' }, 23));
  const ground = new Set(plan.floors[0].rooms.map((r) => r.type));
  const upper = new Set(plan.floors[2].rooms.map((r) => r.type));
  assert.ok(ground.has('lobby') || ground.has('bar') || ground.has('corridor'), 'no public ground floor');
  assert.ok(upper.has('hotelroom') || upper.has('corridor'), 'no guest rooms upstairs');
});

test('a big shop gets one big room, not thirty small ones', () => {
  const plan = FP.generateInterior(makeBuilding(rect(45, 30), { building: 'retail' }, 29));
  const biggest = plan.floors[0].rooms.reduce((m, r) => Math.max(m, r.area), 0);
  assert.ok(biggest > 120, `largest room only ${biggest.toFixed(0)} m2`);
});

test('ceiling heights are habitable and fit inside the storey', () => {
  for (const kind of ['house', 'office', 'retail', 'worship', 'industrial']) {
    const plan = FP.generateInterior(makeBuilding(rect(26, 18), { building: kind, 'building:levels': '2' }, 33));
    if (!plan.viable) continue;
    assert.ok(plan.ceiling >= 2.0, `${kind} ceiling ${plan.ceiling}`);
    assert.ok(plan.ceiling < plan.floorHeight, `${kind} ceiling exceeds its storey height`);
  }
});

// --- robustness ------------------------------------------------------------

test('rotated footprints get rooms square to their own walls', () => {
  const plan = FP.generateInterior(makeBuilding(rotated(rect(18, 12), 0.7), { building: 'house', 'building:levels': '2' }, 41));
  assert.ok(plan.viable);
  // The frame should have picked up the rotation, and rooms are axis-aligned
  // within it, which is the whole point of working in the OBB.
  const ang = Math.abs(((plan.frame.angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
  assert.ok(Math.abs(ang - 0.7) < 1e-6 || Math.abs(ang - (0.7 % (Math.PI / 2))) < 1e-6,
    `frame angle ${plan.frame.angle}`);
  for (const r of plan.floors[0].rooms) assert.ok(r.width > 0 && r.depth > 0);
});

test('hundreds of random footprints all produce valid plans', () => {
  const rng = makeRng(2026);
  const kinds = Object.keys(FP.PROGRAMS);
  let viable = 0, tested = 0;
  for (let i = 0; i < 300; i++) {
    const w = rng.range(4, 60), d = rng.range(4, 45);
    const n = rng.int(4, 9);
    // A convex-ish blob, which is what most real footprints reduce to.
    const ring = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      ring.push([Math.cos(a) * w * rng.range(0.4, 0.5), Math.sin(a) * d * rng.range(0.4, 0.5)]);
    }
    const kind = kinds[rng.int(0, kinds.length - 1)];
    const b = makeBuilding(ring, { building: kind === 'generic' ? 'yes' : kind, 'building:levels': String(rng.int(1, 6)) }, 1000 + i);
    tested++;
    let plan;
    assert.doesNotThrow(() => { plan = FP.generateInterior(b); }, `threw on ${kind} ${w.toFixed(0)}x${d.toFixed(0)}`);
    if (!plan.viable) continue;
    viable++;
    for (const floor of plan.floors) {
      assert.ok(floor.rooms.length > 0, 'floor with no rooms');
      const reached = FP.reachableRooms(floor);
      assert.equal(reached.size, floor.rooms.length,
        `${kind}: ${floor.rooms.length - reached.size} unreachable rooms`);
    }
  }
  assert.ok(viable / tested > 0.75, `only ${viable}/${tested} footprints were viable`);
  out.push(`        (${viable}/${tested} random footprints viable)`);
});

test('degenerate footprints do not crash the generator', () => {
  const cases = [
    [[[0, 0], [1, 0], [1, 1]], { building: 'house' }],
    [[[0, 0], [40, 0], [40, 0.8], [0, 0.8]], { building: 'house' }],
    [[[0, 0], [0, 0], [10, 0], [10, 10], [0, 10]], { building: 'office' }],
  ];
  for (const [ring, tags] of cases) {
    assert.doesNotThrow(() => FP.generateInterior(makeBuilding(ring, tags, 55)));
  }
});

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

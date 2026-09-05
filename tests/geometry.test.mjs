// Checks for the 2D polygon engine: triangulation, offsetting, ring assembly.
//   node tests/geometry.test.mjs

import assert from 'node:assert/strict';
import * as G from '../src/world/geometry.js';
import { makeRng } from '../src/core/rng.js';

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  try { fn(); passed++; out.push(`  ok  ${name}`); }
  catch (e) { failed++; out.push(`FAIL  ${name}\n        ${e.stack.split('\n').slice(0, 3).join('\n        ')}`); }
}

const square = (s = 10) => [[0, 0], [s, 0], [s, s], [0, s]];
const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];

/** Sum the area of every triangle a triangulation produced. */
function triangulatedArea(outer, holes) {
  const { vertices, indices } = G.triangulate(outer, holes);
  let a = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ax = vertices[indices[i] * 2], az = vertices[indices[i] * 2 + 1];
    const bx = vertices[indices[i + 1] * 2], bz = vertices[indices[i + 1] * 2 + 1];
    const cx = vertices[indices[i + 2] * 2], cz = vertices[indices[i + 2] * 2 + 1];
    a += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return a;
}

// --- measures --------------------------------------------------------------

test('area, winding and centroid', () => {
  assert.equal(G.area(square(10)), 100);
  assert.ok(!G.isClockwise(square(10)) || G.isClockwise(square(10)), 'winding is defined');
  const cw = square(10).slice().reverse();
  assert.notEqual(G.isClockwise(square(10)), G.isClockwise(cw), 'reversing flips winding');
  const c = G.centroid(square(10));
  assert.ok(Math.abs(c[0] - 5) < 1e-9 && Math.abs(c[1] - 5) < 1e-9);
});

test('centroid of an L-shape is inside its bounding box but off-centre', () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const c = G.centroid(L);
  assert.ok(c[0] > 0 && c[0] < 10 && c[1] > 0 && c[1] < 10);
  assert.ok(c[0] < 5 && c[1] < 5, 'mass sits toward the corner');
});

test('pointInRing and pointInPolygon with holes', () => {
  const outer = square(10);
  const hole = [[3, 3], [7, 3], [7, 7], [3, 7]];
  assert.ok(G.pointInRing(outer, 5, 5));
  assert.ok(!G.pointInRing(outer, 15, 5));
  assert.ok(!G.pointInPolygon(outer, [hole], 5, 5), 'inside the hole is outside');
  assert.ok(G.pointInPolygon(outer, [hole], 1, 1), 'the ring between is inside');
});

test('perimeter and distanceToRing', () => {
  assert.equal(G.perimeter(square(10)), 40);
  assert.ok(Math.abs(G.distanceToRing(square(10), 5, 5) - 5) < 1e-9);
  assert.ok(Math.abs(G.distanceToRing(square(10), 1, 5) - 1) < 1e-9);
});

// --- cleaning and simplification ------------------------------------------

test('cleanRing drops duplicates and the closing vertex', () => {
  const r = G.cleanRing([[0, 0], [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  assert.equal(r.length, 4);
});

test('simplify removes collinear noise but keeps corners', () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push([i, Math.sin(i * 0.02) * 0.05]);
  const s = G.simplify(line, 0.5);
  assert.ok(s.length < 8, `kept ${s.length} of 101`);
  assert.deepEqual(s[0], line[0]);
  assert.deepEqual(s[s.length - 1], line[line.length - 1]);

  const corner = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
  const sc = G.simplify(corner, 0.5);
  assert.equal(sc.length, 3, 'the corner survives');
});

test('simplify never destroys a closed ring', () => {
  const s = G.simplify(square(10), 100, true);
  assert.ok(s.length >= 3, `got ${s.length}`);
});

// --- triangulation ---------------------------------------------------------

test('triangulating a square conserves area', () => {
  assert.ok(Math.abs(triangulatedArea(square(10)) - 100) < 1e-6);
});

test('triangulating a concave L conserves area', () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  assert.ok(Math.abs(triangulatedArea(L) - G.area(L)) < 1e-6, `${triangulatedArea(L)} vs ${G.area(L)}`);
});

test('triangulating with a hole conserves area', () => {
  const outer = square(10);
  const hole = [[3, 3], [7, 3], [7, 7], [3, 7]];
  const want = 100 - 16;
  const got = triangulatedArea(outer, [hole]);
  assert.ok(Math.abs(got - want) < 1e-6, `${got} vs ${want}`);
});

test('triangulating with two holes conserves area', () => {
  const outer = square(20);
  const h1 = [[2, 2], [6, 2], [6, 6], [2, 6]];
  const h2 = [[12, 12], [18, 12], [18, 18], [12, 18]];
  const want = 400 - 16 - 36;
  const got = triangulatedArea(outer, [h1, h2]);
  assert.ok(Math.abs(got - want) < 1e-6, `${got} vs ${want}`);
});

test('winding of the input does not change the result', () => {
  const ccw = square(10);
  const cw = square(10).slice().reverse();
  assert.ok(Math.abs(triangulatedArea(ccw) - triangulatedArea(cw)) < 1e-6);
});

test('triangulation handles many random star-shaped polygons', () => {
  const rng = makeRng(4242);
  let worst = 0;
  for (let t = 0; t < 300; t++) {
    const n = rng.int(3, 24);
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = rng.range(3, 14);
      ring.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const want = G.area(ring);
    const got = triangulatedArea(ring);
    worst = Math.max(worst, Math.abs(got - want) / Math.max(1, want));
  }
  assert.ok(worst < 1e-6, `worst relative area error ${worst}`);
});

test('triangulation produces the expected triangle count', () => {
  // A simple polygon with n vertices always yields n-2 triangles.
  for (const n of [3, 4, 5, 8, 17]) {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push([Math.cos(a) * 10, Math.sin(a) * 10]);
    }
    const { indices } = G.triangulate(ring);
    assert.equal(indices.length / 3, n - 2, `n=${n}`);
  }
});

test('degenerate input is handled without throwing', () => {
  assert.equal(G.triangulate([]).indices.length, 0);
  assert.equal(G.triangulate([[0, 0], [1, 1]]).indices.length, 0);
  assert.equal(G.triangulate([[0, 0], [1, 0], [2, 0]]).indices.length, 0, 'collinear has no area');
  assert.equal(G.triangulate([[0, 0], [0, 0], [0, 0]]).indices.length, 0);
});

// --- offsetting ------------------------------------------------------------

test('insetting a square shrinks it by the right amount', () => {
  const inner = G.insetRing(square(10), 1);
  assert.ok(inner, 'inset produced a ring');
  const b = G.bounds(inner);
  assert.ok(Math.abs(b.width - 8) < 1e-6, `width ${b.width}`);
  assert.ok(Math.abs(b.depth - 8) < 1e-6, `depth ${b.depth}`);
});

test('offsetting outward grows a square', () => {
  const outer = G.offsetRing(square(10), 2);
  const b = G.bounds(outer);
  assert.ok(Math.abs(b.width - 14) < 1e-6, `width ${b.width}`);
});

test('inset works regardless of input winding', () => {
  const a = G.insetRing(square(10), 1);
  const b = G.insetRing(square(10).slice().reverse(), 1);
  assert.ok(Math.abs(G.area(a) - G.area(b)) < 1e-6);
  assert.ok(Math.abs(G.area(a) - 64) < 1e-6, `area ${G.area(a)}`);
});

test('over-inset collapses to null instead of inverting', () => {
  assert.equal(G.insetRing(square(4), 5), null);
  assert.equal(G.insetRing(square(4), 2.1), null);
});

test('miter limit tames acute spikes', () => {
  const spike = [[0, 0], [40, 0.4], [80, 0], [80, 20], [0, 20]];
  const off = G.offsetRing(spike, 2);
  assert.ok(off, 'produced a ring');
  const b = G.bounds(off);
  assert.ok(b.width < 200, `spike blew up to ${b.width}`);
});

test('inset keeps every point inside the original', () => {
  const rng = makeRng(7);
  const ring = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r = rng.range(18, 25);
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const inner = G.insetRing(ring, 1.5);
  assert.ok(inner);
  for (const p of inner) assert.ok(G.pointInRing(ring, p[0], p[1]), `point ${p} escaped`);
  assert.ok(G.area(inner) < G.area(ring));
});

// --- oriented bounds -------------------------------------------------------

test('OBB of an axis-aligned rectangle matches its AABB', () => {
  const ob = G.orientedBounds(rect(20, 8));
  const dims = [ob.width, ob.depth].sort((a, b) => a - b);
  assert.ok(Math.abs(dims[0] - 8) < 1e-6 && Math.abs(dims[1] - 20) < 1e-6, `${ob.width}x${ob.depth}`);
  assert.ok(Math.abs(ob.cx - 10) < 1e-6 && Math.abs(ob.cz - 4) < 1e-6);
});

test('OBB follows a rotated rectangle', () => {
  const ang = 0.6;
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const r = rect(20, 8).map(([x, z]) => [x * ca - z * sa, x * sa + z * ca]);
  const ob = G.orientedBounds(r);
  const dims = [ob.width, ob.depth].sort((a, b) => a - b);
  assert.ok(Math.abs(dims[0] - 8) < 1e-6 && Math.abs(dims[1] - 20) < 1e-6,
            `rotated OBB came out ${ob.width}x${ob.depth}`);
  const axisAngle = Math.atan2(ob.axisX[1], ob.axisX[0]);
  const rel = Math.abs(((axisAngle - ang) % (Math.PI / 2) + Math.PI) % (Math.PI / 2));
  assert.ok(rel < 1e-6 || Math.abs(rel - Math.PI / 2) < 1e-6, `axis off by ${rel}`);
});

test('convex hull of a point cloud is convex and contains everything', () => {
  const rng = makeRng(11);
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push([rng.range(-10, 10), rng.range(-10, 10)]);
  const hull = G.convexHull(pts);
  assert.ok(hull.length >= 3);
  for (const p of pts) {
    assert.ok(G.pointInRing(hull, p[0], p[1]) || G.distanceToRing(hull, p[0], p[1]) < 1e-6,
              `point ${p} outside hull`);
  }
});

// --- polylines -------------------------------------------------------------

test('resample bounds segment length without moving the ends', () => {
  const line = [[0, 0], [100, 0]];
  const r = G.resample(line, 8);
  assert.ok(r.length >= 13, `got ${r.length}`);
  assert.deepEqual(r[0], [0, 0]);
  assert.deepEqual(r[r.length - 1], [100, 0]);
  for (let i = 1; i < r.length; i++) {
    assert.ok(Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]) <= 8 + 1e-9);
  }
});

test('ribbon keeps its width along a straight line', () => {
  const { left, right } = G.ribbon([[0, 0], [10, 0], [20, 0]], 6);
  for (let i = 0; i < left.length; i++) {
    assert.ok(Math.abs(Math.hypot(left[i][0] - right[i][0], left[i][1] - right[i][1]) - 6) < 1e-6);
  }
});

test('ribbon keeps its width through a right-angle corner', () => {
  const { left, right } = G.ribbon([[0, 0], [10, 0], [10, 10]], 4);
  const w = Math.hypot(left[1][0] - right[1][0], left[1][1] - right[1][1]);
  assert.ok(w > 4 && w < 6.5, `mitred corner width ${w}`);
});

test('ribbon miter cannot grow a long spike at a hairpin', () => {
  const pts = [[0, 0], [10, 0], [0.2, 1]];
  const edges = G.ribbon(pts, 10);
  const reach = Math.max(
    Math.hypot(edges.left[1][0] - 10, edges.left[1][1]),
    Math.hypot(edges.right[1][0] - 10, edges.right[1][1]));
  assert.ok(reach <= 10.001, `miter reaches ${reach.toFixed(2)}m from a 10m-wide road`);
});

test('ribbonToRing produces a ring of the right area', () => {
  const ring = G.ribbonToRing([[0, 0], [50, 0]], 8);
  assert.ok(Math.abs(G.area(ring) - 400) < 1e-6, `area ${G.area(ring)}`);
});

test('smoothPolyline rounds corners without drifting', () => {
  const s = G.smoothPolyline([[0, 0], [10, 0], [10, 10]], 2);
  assert.ok(s.length > 3);
  assert.deepEqual(s[0], [0, 0]);
  assert.deepEqual(s[s.length - 1], [10, 10]);
});

// --- multipolygon assembly -------------------------------------------------

test('assembleRings stitches shuffled, reversed fragments', () => {
  // A 10x10 square split into 4 pieces, shuffled and some reversed.
  const frags = [
    [[10, 0], [10, 10]],
    [[0, 0], [10, 0]],
    [[0, 10], [0, 0]],
    [[0, 10], [10, 10]].slice().reverse(),
  ];
  const rings = G.assembleRings(frags);
  assert.equal(rings.length, 1, `got ${rings.length} rings`);
  assert.ok(Math.abs(G.area(rings[0]) - 100) < 1e-6, `area ${G.area(rings[0])}`);
});

test('assembleRings keeps separate loops apart', () => {
  const frags = [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]],
  ];
  const rings = G.assembleRings(frags);
  assert.equal(rings.length, 2);
});

test('classifyRings nests holes and re-promotes islands', () => {
  const outer = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const hole = [[20, 20], [80, 20], [80, 80], [20, 80]];
  const island = [[40, 40], [60, 40], [60, 60], [40, 60]];
  const polys = G.classifyRings([outer, hole, island]);
  assert.equal(polys.length, 2, 'the island becomes its own shell');
  const shell = polys.find((p) => G.area(p.outer) > 5000);
  assert.equal(shell.holes.length, 1, 'the lake is a hole in the land');
  const isle = polys.find((p) => G.area(p.outer) < 5000);
  assert.equal(isle.holes.length, 0);
  // And the whole thing triangulates to land area = 10000 - 3600 + 400.
  let total = triangulatedArea(shell.outer, shell.holes) + triangulatedArea(isle.outer, isle.holes);
  assert.ok(Math.abs(total - (10000 - 3600 + 400)) < 1e-6, `total ${total}`);
});

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

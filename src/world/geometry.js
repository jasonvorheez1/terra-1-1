// 2D polygon and polyline geometry.
//
// Everything the world builder needs to turn OSM rings into meshes: robust
// triangulation with holes (ear clipping over a doubly linked list, in the
// style of Mapbox's earcut), polygon offsetting for wall thickness and
// sidewalks, oriented bounding boxes for interior layout, and polyline
// resampling for roads.
//
// Points are `[x, z]` pairs in local metres. Rings are arrays of points with
// no repeated closing vertex.

import { clamp } from '../core/util.js';

export const EPS = 1e-9;

// --- basic measures --------------------------------------------------------

/**
 * Twice the signed area (shoelace).
 *
 * Game space is +x east, +z south, so looking down at the world from above is
 * like looking at a screen with z increasing downward. In that frame this sum
 * is POSITIVE for a ring wound clockwise as seen from above. Two things depend
 * on knowing that exactly: `offsetRing` picks its outward normal from it, and
 * the ear clipper needs shells and holes wound opposite ways.
 */
export function signedArea2(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  }
  return s;
}

export const signedArea = (ring) => signedArea2(ring) / 2;
export const area = (ring) => Math.abs(signedArea(ring));

/** True when the ring reads clockwise looking down at the world from above. */
export const isClockwise = (ring) => signedArea2(ring) > 0;

/** Area of a polygon with holes. */
export function polygonArea(outer, holes) {
  let a = area(outer);
  if (holes) for (const h of holes) a -= area(h);
  return Math.max(0, a);
}

export function perimeter(ring, closed = true) {
  let p = 0;
  for (let i = 1; i < ring.length; i++) p += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  if (closed && ring.length > 2) {
    p += Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]);
  }
  return p;
}

/** Area-weighted centroid; falls back to the vertex mean for degenerate rings. */
export function centroid(ring) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
    a += f;
  }
  if (Math.abs(a) < EPS) {
    let sx = 0, sz = 0;
    for (const p of ring) { sx += p[0]; sz += p[1]; }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function bounds(ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, minZ, maxX, maxZ, width: maxX - minX, depth: maxZ - minZ };
}

/** Even-odd ray crossing test. Points exactly on an edge may go either way. */
export function pointInRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1];
    const xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(outer, holes, x, z) {
  if (!pointInRing(outer, x, z)) return false;
  if (holes) for (const h of holes) if (pointInRing(h, x, z)) return false;
  return true;
}

/** Closest point on segment ab to p, as `[x, z, t]` with t in [0, 1]. */
export function closestPointOnSegment(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < EPS) return [ax, az, 0];
  let t = ((px - ax) * dx + (pz - az) * dz) / len2;
  t = clamp(t, 0, 1);
  return [ax + dx * t, az + dz * t, t];
}

/** Shortest distance from a point to a ring's boundary. */
export function distanceToRing(ring, x, z) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const c = closestPointOnSegment(ring[j][0], ring[j][1], ring[i][0], ring[i][1], x, z);
    const d = Math.hypot(c[0] - x, c[1] - z);
    if (d < best) best = d;
  }
  return best;
}

// --- cleaning --------------------------------------------------------------

/** Drop repeated and collinear-to-within-tolerance vertices. */
export function cleanRing(ring, tol = 0.01) {
  if (!ring || ring.length < 3) return ring ? ring.slice() : [];
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) out.push([p[0], p[1]]);
  }
  // A ring handed to us closed: drop the duplicated final vertex.
  while (out.length > 1 &&
         Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= tol) {
    out.pop();
  }
  return out;
}

/**
 * Douglas-Peucker simplification. Cuts vertex counts on hand-traced OSM
 * coastlines and forests by 60-90% with no visible change, which is the single
 * biggest lever on triangle count for the land-cover pass.
 */
export function simplify(points, tolerance = 0.5, closed = false) {
  if (points.length <= 2) return points.slice();
  const pts = closed ? points.concat([points[0]]) : points;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;

  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = -1, index = -1;
    const ax = pts[first][0], az = pts[first][1];
    const bx = pts[last][0], bz = pts[last][1];
    for (let i = first + 1; i < last; i++) {
      const c = closestPointOnSegment(ax, az, bx, bz, pts[i][0], pts[i][1]);
      const d = Math.hypot(c[0] - pts[i][0], c[1] - pts[i][1]);
      if (d > maxD) { maxD = d; index = i; }
    }
    if (maxD > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  if (closed) out.pop();
  return out.length >= (closed ? 3 : 2) ? out : points.slice();
}

// --- triangulation ---------------------------------------------------------
//
// Ear clipping over a circular doubly linked list. Holes are eliminated first
// by bridging each one to the outer ring, which turns the whole thing into a
// single simple polygon that ear clipping can chew through.

class Node2 {
  constructor(i, x, z) {
    this.i = i; this.x = x; this.z = z;
    this.prev = null; this.next = null;
    this.steiner = false;
  }
}

function insertNode(i, x, z, last) {
  const n = new Node2(i, x, z);
  if (!last) { n.prev = n; n.next = n; }
  else { n.next = last.next; n.prev = last; last.next.prev = n; last.next = n; }
  return n;
}

function removeNode(n) {
  n.next.prev = n.prev;
  n.prev.next = n.next;
}

/**
 * Build a circular linked list from a flat coordinate range, forcing a winding.
 *
 * The ear clipper below only ever accepts a triangle whose cross product is
 * negative, so shells must be linked one way and holes the other. `clockwise`
 * true means "the winding whose shoelace sum is positive" - see signedArea2.
 */
function linkedList(coords, start, end, clockwise) {
  let last = null;
  if (clockwise === (signedArea2Flat(coords, start, end) > 0)) {
    for (let i = start; i < end; i += 2) last = insertNode(i, coords[i], coords[i + 1], last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertNode(i, coords[i], coords[i + 1], last);
  }
  if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
  return last;
}

function signedArea2Flat(coords, start, end) {
  let s = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) {
    s += (coords[j] - coords[i]) * (coords[i + 1] + coords[j + 1]);
  }
  return s;
}

const equals = (a, b) => a.x === b.x && a.z === b.z;

function cross(px, pz, qx, qz, rx, rz) {
  return (qz - pz) * (rx - qx) - (qx - px) * (rz - qz);
}

/** Is the triangle (a, b, c) a valid ear of the polygon `a` belongs to? */
function isEar(ear) {
  const a = ear.prev, b = ear, c = ear.next;
  if (cross(a.x, a.z, b.x, b.z, c.x, c.z) >= 0) return false;   // reflex
  let p = ear.next.next;
  while (p !== ear.prev) {
    if (pointInTriangle(a.x, a.z, b.x, b.z, c.x, c.z, p.x, p.z) &&
        cross(p.prev.x, p.prev.z, p.x, p.z, p.next.x, p.next.z) >= 0) return false;
    p = p.next;
  }
  return true;
}

export function pointInTriangle(ax, az, bx, bz, cx, cz, px, pz) {
  return (cx - px) * (az - pz) - (ax - px) * (cz - pz) >= 0 &&
         (ax - px) * (bz - pz) - (bx - px) * (az - pz) >= 0 &&
         (bx - px) * (cz - pz) - (cx - px) * (bz - pz) >= 0;
}

function earcutLinked(ear, triangles, pass = 0) {
  if (!ear) return;
  let stop = ear;
  let prev, next;
  let guard = 0;
  const maxIter = 100000;

  while (ear.prev !== ear.next && guard++ < maxIter) {
    prev = ear.prev;
    next = ear.next;

    if (isEar(ear)) {
      triangles.push(prev.i / 2, ear.i / 2, next.i / 2);
      removeNode(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }

    ear = next;

    if (ear === stop) {
      // No ear found on a full lap: relax and try harder.
      if (pass === 0) {
        earcutLinked(filterPoints(ear), triangles, 1);
      } else if (pass === 1) {
        ear = cureLocalIntersections(filterPoints(ear), triangles);
        earcutLinked(ear, triangles, 2);
      } else if (pass === 2) {
        splitEarcut(ear, triangles);
      }
      break;
    }
  }
}

function filterPoints(start, end) {
  if (!start) return start;
  if (!end) end = start;
  let p = start, again;
  let guard = 0;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) ||
        cross(p.prev.x, p.prev.z, p.x, p.z, p.next.x, p.next.z) === 0)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while ((again || p !== end) && guard++ < 100000);
  return end;
}

/** Remove self-intersections by clipping the offending triangle away. */
function cureLocalIntersections(start, triangles) {
  let p = start;
  let guard = 0;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i / 2, p.i / 2, b.i / 2);
      removeNode(p);
      removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start && guard++ < 100000);
  return filterPoints(p);
}

/** Last resort: cut the polygon in two at a valid diagonal and recurse. */
function splitEarcut(start, triangles) {
  let a = start;
  let guard = 0;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next);
        c = filterPoints(c, c.next);
        earcutLinked(a, triangles, 0);
        earcutLinked(c, triangles, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start && guard++ < 100000);
}

function isValidDiagonal(a, b) {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
         locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b);
}

function sign(n) { return n > 0 ? 1 : n < 0 ? -1 : 0; }

function intersects(p1, q1, p2, q2) {
  const o1 = sign(cross(p1.x, p1.z, q1.x, q1.z, p2.x, p2.z));
  const o2 = sign(cross(p1.x, p1.z, q1.x, q1.z, q2.x, q2.z));
  const o3 = sign(cross(p2.x, p2.z, q2.x, q2.z, p1.x, p1.z));
  const o4 = sign(cross(p2.x, p2.z, q2.x, q2.z, q1.x, q1.z));
  if (o1 !== o2 && o3 !== o4) return true;
  return false;
}

function intersectsPolygon(a, b) {
  let p = a;
  let guard = 0;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i &&
        intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a && guard++ < 100000);
  return false;
}

function locallyInside(a, b) {
  return cross(a.prev.x, a.prev.z, a.x, a.z, a.next.x, a.next.z) < 0
    ? cross(a.x, a.z, b.x, b.z, a.next.x, a.next.z) >= 0 && cross(a.x, a.z, a.prev.x, a.prev.z, b.x, b.z) >= 0
    : cross(a.x, a.z, b.x, b.z, a.prev.x, a.prev.z) < 0 || cross(a.x, a.z, a.next.x, a.next.z, b.x, b.z) < 0;
}

function middleInside(a, b) {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, pz = (a.z + b.z) / 2;
  let guard = 0;
  do {
    if (((p.z > pz) !== (p.next.z > pz)) && p.next.z !== p.z &&
        px < ((p.next.x - p.x) * (pz - p.z)) / (p.next.z - p.z) + p.x) inside = !inside;
    p = p.next;
  } while (p !== a && guard++ < 100000);
  return inside;
}

function splitPolygon(a, b) {
  const a2 = new Node2(a.i, a.x, a.z);
  const b2 = new Node2(b.i, b.x, b.z);
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

/** Bridge every hole into the outer ring so one linked list covers the lot. */
function eliminateHoles(coords, holeIndices, outerNode) {
  const queue = [];
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i];
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] : coords.length;
    const list = linkedList(coords, start, end, false);
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x);
  for (const hole of queue) outerNode = eliminateHole(hole, outerNode);
  return outerNode;
}

function eliminateHole(hole, outerNode) {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next);
}

/** Cast a ray right from the hole's leftmost point to find a visible vertex. */
function findHoleBridge(hole, outerNode) {
  let p = outerNode;
  const hx = hole.x, hz = hole.z;
  let qx = -Infinity, m = null;
  let guard = 0;
  do {
    if (hz <= p.z && hz >= p.next.z && p.next.z !== p.z) {
      const x = p.x + ((hz - p.z) * (p.next.x - p.x)) / (p.next.z - p.z);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m;
      }
    }
    p = p.next;
  } while (p !== outerNode && guard++ < 100000);
  if (!m) return null;

  // Among vertices inside the ray-cast triangle, take the one at the best angle.
  const stop = m;
  const mx = m.x, mz = m.z;
  let tanMin = Infinity;
  p = m;
  guard = 0;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTriangle(hz < mz ? hx : qx, hz, mx, mz, hz < mz ? qx : hx, hz, p.x, p.z)) {
      const tan = Math.abs(hz - p.z) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin && (p.x > m.x || sectorContainsSector(m, p))))) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop && guard++ < 100000);
  return m;
}

function sectorContainsSector(m, p) {
  return cross(m.prev.x, m.prev.z, m.x, m.z, p.prev.x, p.prev.z) < 0 &&
         cross(p.next.x, p.next.z, m.x, m.z, m.next.x, m.next.z) < 0;
}

function getLeftmost(start) {
  let p = start, leftmost = start;
  let guard = 0;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.z < leftmost.z)) leftmost = p;
    p = p.next;
  } while (p !== start && guard++ < 100000);
  return leftmost;
}

/**
 * Triangulate a polygon with optional holes.
 *
 * Returns `{ vertices: Float64Array of [x, z] pairs, indices: Uint32Array }`
 * where indices are triples into `vertices`.
 */
export function triangulate(outer, holes = null) {
  const cleanOuter = cleanRing(outer);
  if (cleanOuter.length < 3) return { vertices: new Float64Array(0), indices: new Uint32Array(0) };

  const cleanHoles = [];
  if (holes) {
    for (const h of holes) {
      const c = cleanRing(h);
      if (c.length >= 3) cleanHoles.push(c);
    }
  }

  let n = cleanOuter.length;
  for (const h of cleanHoles) n += h.length;
  const coords = new Float64Array(n * 2);
  let k = 0;
  for (const p of cleanOuter) { coords[k++] = p[0]; coords[k++] = p[1]; }
  const holeIndices = [];
  for (const h of cleanHoles) {
    holeIndices.push(k);
    for (const p of h) { coords[k++] = p[0]; coords[k++] = p[1]; }
  }

  const outerLen = cleanOuter.length * 2;
  let node = linkedList(coords, 0, outerLen, true);
  const triangles = [];
  if (!node || node.next === node.prev) {
    return { vertices: coords, indices: new Uint32Array(0) };
  }
  if (holeIndices.length) node = eliminateHoles(coords, holeIndices, node);
  earcutLinked(node, triangles);

  return { vertices: coords, indices: Uint32Array.from(triangles) };
}

// --- offsetting ------------------------------------------------------------

/**
 * Offset a closed ring by `d` metres (positive grows, negative shrinks).
 *
 * Miters are clamped so a sharp spike does not fire a vertex off to infinity,
 * which is what makes this safe on the very acute corners OSM building traces
 * are full of. Returns null if the ring collapses.
 */
export function offsetRing(ring, d, miterLimit = 3.5) {
  const r = cleanRing(ring);
  const n = r.length;
  if (n < 3) return null;
  // Work in the clockwise-from-above winding, the one where (ez, -ex) is the
  // outward normal, so a positive `d` always grows the ring.
  const cw = isClockwise(r);
  const src = cw ? r : r.slice().reverse();
  const out = [];

  for (let i = 0; i < n; i++) {
    const prev = src[(i - 1 + n) % n];
    const cur = src[i];
    const next = src[(i + 1) % n];

    let e1x = cur[0] - prev[0], e1z = cur[1] - prev[1];
    let e2x = next[0] - cur[0], e2z = next[1] - cur[1];
    const l1 = Math.hypot(e1x, e1z), l2 = Math.hypot(e2x, e2z);
    if (l1 < EPS || l2 < EPS) continue;
    e1x /= l1; e1z /= l1; e2x /= l2; e2z /= l2;

    // Outward normal of each incident edge, for the clockwise-from-above winding.
    const n1x = e1z, n1z = -e1x;
    const n2x = e2z, n2z = -e2x;

    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push([cur[0] + n1x * d, cur[1] + n1z * d]); continue; }
    mx /= ml; mz /= ml;
    // Miter length grows as the corner sharpens; cap it.
    let scale = 1 / Math.max(0.15, mx * n1x + mz * n1z);
    scale = Math.min(scale, miterLimit);
    out.push([cur[0] + mx * d * scale, cur[1] + mz * d * scale]);
  }

  if (out.length < 3) return null;

  // Detect collapse. Insetting a 4 m square by 2.1 m produces a small square
  // that is still wound the same way and still sits inside the original, so
  // neither a winding test nor a containment test catches it. What does catch
  // it is that every edge has reversed direction: the shape has passed through
  // itself. Drop the vertices whose edges flipped and keep whatever survives,
  // which is what lets a concave footprint inset cleanly even when one narrow
  // spur of it collapses.
  const flipped = new Uint8Array(out.length);
  let flipCount = 0;
  for (let i = 0; i < out.length; i++) {
    const j = (i + 1) % out.length;
    const oldX = src[j][0] - src[i][0], oldZ = src[j][1] - src[i][1];
    const newX = out[j][0] - out[i][0], newZ = out[j][1] - out[i][1];
    if (oldX * newX + oldZ * newZ < 0) {
      flipped[i] = flipped[j] = 1;
      flipCount++;
    }
  }
  let result = out;
  if (flipCount > 0) {
    if (flipCount > out.length * 0.5) return null;      // mostly collapsed
    result = out.filter((_, i) => !flipped[i]);
    if (result.length < 3) return null;
  }

  if (area(result) < 1e-4) return null;
  if (d < 0 && area(result) >= area(r)) return null;
  if (d > 0 && area(result) <= area(r)) return null;
  return cw ? result : result.reverse();
}

/** Shrink a ring inward by `d` metres. Convenience wrapper for readability. */
export const insetRing = (ring, d, miterLimit) => offsetRing(ring, -Math.abs(d), miterLimit);

// --- oriented bounding box -------------------------------------------------

/**
 * Minimum-area oriented bounding box via rotating calipers over the convex
 * hull. Interior generation needs this: it lays rooms out along a building's
 * own axes rather than along north, so a diagonal terrace still gets
 * rectangular rooms parallel to its walls.
 */
export function orientedBounds(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) {
    const b = bounds(ring);
    return {
      angle: 0, cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2,
      width: Math.max(b.width, 0.01), depth: Math.max(b.depth, 0.01),
      axisX: [1, 0], axisZ: [0, 1],
    };
  }
  let best = null;
  for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
    const ex = hull[i][0] - hull[j][0], ez = hull[i][1] - hull[j][1];
    const len = Math.hypot(ex, ez);
    if (len < EPS) continue;
    const ux = ex / len, uz = ez / len;      // edge direction
    const vx = -uz, vz = ux;                 // perpendicular
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = p[0] * ux + p[1] * uz;
      const pv = p[0] * vx + p[1] * vz;
      if (pu < minU) minU = pu;
      if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv;
      if (pv > maxV) maxV = pv;
    }
    const w = maxU - minU, d = maxV - minV;
    const a = w * d;
    if (!best || a < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = {
        area: a,
        angle: Math.atan2(uz, ux),
        cx: ux * cu + vx * cv,
        cz: uz * cu + vz * cv,
        width: w, depth: d,
        axisX: [ux, uz], axisZ: [vx, vz],
      };
    }
  }
  if (!best) {
    const b = bounds(ring);
    return {
      angle: 0, cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2,
      width: Math.max(b.width, 0.01), depth: Math.max(b.depth, 0.01),
      axisX: [1, 0], axisZ: [0, 1],
    };
  }
  return best;
}

/** Andrew's monotone chain convex hull. */
export function convexHull(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// --- polylines -------------------------------------------------------------

/** Total length of an open polyline. */
export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/**
 * Insert extra vertices so no segment is longer than `maxSeg`.
 * Roads need this to follow terrain instead of cutting through hills.
 */
export function resample(pts, maxSeg = 8) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(1, Math.ceil(len / maxSeg));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Chaikin corner cutting, for rounding sharp OSM road corners. */
export function smoothPolyline(pts, iterations = 1, closed = false) {
  let cur = pts.map((p) => [p[0], p[1]]);
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) break;
    const next = [];
    if (!closed) next.push(cur[0]);
    const n = cur.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) next.push(cur[n - 1]);
    cur = next;
  }
  return cur;
}

/**
 * Per-vertex outward normals for a polyline, mitred at joins so a constant
 * width ribbon keeps its width around corners instead of pinching.
 */
export function polylineNormals(pts, closed = false) {
  const n = pts.length;
  const normals = new Array(n);
  for (let i = 0; i < n; i++) {
    let dxA = 0, dzA = 0, dxB = 0, dzB = 0;
    if (i > 0 || closed) {
      const p = pts[(i - 1 + n) % n];
      dxA = pts[i][0] - p[0]; dzA = pts[i][1] - p[1];
      const l = Math.hypot(dxA, dzA) || 1; dxA /= l; dzA /= l;
    }
    if (i < n - 1 || closed) {
      const q = pts[(i + 1) % n];
      dxB = q[0] - pts[i][0]; dzB = q[1] - pts[i][1];
      const l = Math.hypot(dxB, dzB) || 1; dxB /= l; dzB /= l;
    }
    if (!dxA && !dzA) { dxA = dxB; dzA = dzB; }
    if (!dxB && !dzB) { dxB = dxA; dzB = dzA; }
    // Normal of each incident edge, then a mitred average.
    const n1x = dzA, n1z = -dxA;
    const n2x = dzB, n2z = -dxB;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { normals[i] = [n2x, n2z, 1]; continue; }
    mx /= ml; mz /= ml;
    // A near-reversal otherwise creates a four-half-width needle. Two is the
    // conventional miter limit: a right-angle corner still meets exactly,
    // while hairpins stop producing road triangles tens of metres long.
    const scale = Math.min(2, 1 / Math.max(0.25, mx * n1x + mz * n1z));
    normals[i] = [mx, mz, scale];
  }
  return normals;
}

/**
 * Turn a polyline into a constant-width ribbon: returns left and right edge
 * rings. Used for roads, rivers, walls and sidewalks.
 */
export function ribbon(pts, width, closed = false) {
  const half = width / 2;
  const normals = polylineNormals(pts, closed);
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const [nx, nz, s] = normals[i];
    left.push([pts[i][0] + nx * half * s, pts[i][1] + nz * half * s]);
    right.push([pts[i][0] - nx * half * s, pts[i][1] - nz * half * s]);
  }
  return { left, right };
}

/** Convert a ribbon to a closed ring, ready for triangulation. */
export function ribbonToRing(pts, width) {
  const { left, right } = ribbon(pts, width);
  return left.concat(right.reverse());
}

// --- multipolygon assembly -------------------------------------------------

/**
 * Stitch loose OSM way fragments into closed rings.
 *
 * Multipolygon relations hand you member ways in arbitrary order and
 * direction, frequently split mid-ring. This walks the fragments joining
 * endpoints until each ring closes.
 */
export function assembleRings(fragments, tolerance = 0.05) {
  const open = fragments.filter((f) => f && f.length >= 2).map((f) => f.map((p) => [p[0], p[1]]));
  const rings = [];
  const tol2 = tolerance * tolerance;
  const near = (a, b) => {
    const dx = a[0] - b[0], dz = a[1] - b[1];
    return dx * dx + dz * dz <= tol2;
  };

  while (open.length) {
    let cur = open.pop();
    if (near(cur[0], cur[cur.length - 1])) {
      cur.pop();
      if (cur.length >= 3) rings.push(cur);
      continue;
    }
    let extended = true;
    let guard = 0;
    while (extended && guard++ < 10000) {
      extended = false;
      for (let i = 0; i < open.length; i++) {
        const f = open[i];
        const head = cur[0], tail = cur[cur.length - 1];
        if (near(tail, f[0])) { cur = cur.concat(f.slice(1)); open.splice(i, 1); extended = true; break; }
        if (near(tail, f[f.length - 1])) { cur = cur.concat(f.slice(0, -1).reverse()); open.splice(i, 1); extended = true; break; }
        if (near(head, f[f.length - 1])) { cur = f.slice(0, -1).concat(cur); open.splice(i, 1); extended = true; break; }
        if (near(head, f[0])) { cur = f.slice(1).reverse().concat(cur); open.splice(i, 1); extended = true; break; }
      }
      if (cur.length >= 4 && near(cur[0], cur[cur.length - 1])) break;
    }
    if (cur.length >= 4 && near(cur[0], cur[cur.length - 1])) {
      cur.pop();
      rings.push(cur);
    } else if (cur.length >= 3) {
      rings.push(cur);       // unclosed but usable; treat as an implicit ring
    }
  }
  return rings;
}

/**
 * Sort assembled rings into outer shells and the holes inside them.
 * Returns `[{ outer, holes }]`.
 */
export function classifyRings(rings, taggedOuter = null, taggedInner = null) {
  const items = rings.map((r) => ({ ring: r, a: area(r), b: bounds(r) })).filter((i) => i.a > 1e-6);
  items.sort((x, y) => y.a - x.a);

  const outerSet = taggedOuter ? new Set(taggedOuter) : null;
  const innerSet = taggedInner ? new Set(taggedInner) : null;

  const polys = [];
  for (const item of items) {
    // A ring tagged `inner`, or one contained by an existing shell, is a hole.
    let host = null;
    for (const p of polys) {
      const c = centroid(item.ring);
      if (pointInRing(p.outer, c[0], c[1])) { host = p; break; }
    }
    const forcedInner = innerSet && innerSet.has(item.ring);
    const forcedOuter = outerSet && outerSet.has(item.ring);
    if (host && !forcedOuter && (forcedInner || !host.holeOf)) {
      // Only nest one level: a ring inside a hole is a new shell (an island).
      let inHole = false;
      for (const h of host.holes) {
        const c = centroid(item.ring);
        if (pointInRing(h, c[0], c[1])) { inHole = true; break; }
      }
      if (inHole) polys.push({ outer: item.ring, holes: [] });
      else host.holes.push(item.ring);
    } else {
      polys.push({ outer: item.ring, holes: [] });
    }
  }
  return polys;
}

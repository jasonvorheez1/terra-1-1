// Geometry accumulation.
//
// Chunk building is fundamentally "append a few million vertices, then hand
// three.js one buffer per material". These accumulators do that with plain
// arrays and no intermediate objects, and the per-material grouping is what
// collapses a chunk full of buildings into a handful of draw calls.

import * as THREE from 'three';
import { triangulate, signedArea2 } from '../geometry.js';

/**
 * Subdivide a triangulation until it follows the ground beneath it.
 *
 * A polygon is draped by sampling the ground at its vertices, and an OSM ring
 * only has vertices along its boundary - never inside it - so ear clipping
 * spans the interior with a few long triangles that cut straight across
 * whatever the terrain does underneath. Measured in Central Park, a grass
 * polygon sat 2.75 m above the ground it was supposed to be lying on. These
 * surfaces carry no collision, so you walk through the visible ground on the
 * way down to the real one, and being front-facing they disappear when seen
 * from below: a sheet hanging in the air that you fall straight through.
 *
 * The split is driven by how far the ground actually departs from the triangle
 * rather than by edge length alone. Subdividing everything to a fixed size
 * costs the same on a flat lawn as on a hillside and took land cover to 750k
 * triangles a scene; measuring the sag at each candidate midpoint spends the
 * triangles only where the ground bends. `maxEdge` remains as a ceiling, since
 * the per-vertex colour wander needs vertices to vary across even when the
 * ground is level.
 *
 * Midpoints are shared between the triangles either side of an edge, so the
 * result stays watertight - splitting each triangle alone would crack the
 * seams open. The vertex cap guards against a pathological ring.
 */
function subdivide(vertices, indices, { heightFn, tolerance = 0.15, minEdge = 2, maxEdge = 32 }) {
  const verts = Array.from(vertices);
  let tris = Array.from(indices);
  const MAX_VERTS = 20000;
  const mids = new Map();
  const heights = [];
  const heightAt = (i) => {
    let h = heights[i];
    if (h === undefined) { h = heightFn(verts[i * 2], verts[i * 2 + 1]); heights[i] = h; }
    return h;
  };
  const midpoint = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let m = mids.get(key);
    if (m === undefined) {
      m = verts.length / 2;
      verts.push((verts[a * 2] + verts[b * 2]) / 2, (verts[a * 2 + 1] + verts[b * 2 + 1]) / 2);
      mids.set(key, m);
    }
    return m;
  };
  // How badly a straight edge misses the ground at its midpoint, and how long
  // it is. An edge shorter than minEdge is left alone however much it sags:
  // past that point the terrain has no more detail to offer.
  const edgeError = (a, b) => {
    const ax = verts[a * 2], az = verts[a * 2 + 1];
    const bx = verts[b * 2], bz = verts[b * 2 + 1];
    const len = Math.hypot(ax - bx, az - bz);
    if (len < minEdge) return 0;
    if (len > maxEdge) return Infinity;
    const sag = Math.abs(heightFn((ax + bx) / 2, (az + bz) / 2) - (heightAt(a) + heightAt(b)) / 2);
    return sag > tolerance ? sag : 0;
  };
  for (let pass = 0; pass < 14; pass++) {
    let split = false;
    const next = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b = tris[i + 1], c = tris[i + 2];
      const eab = edgeError(a, b), ebc = edgeError(b, c), eca = edgeError(c, a);
      if ((eab === 0 && ebc === 0 && eca === 0) || verts.length / 2 >= MAX_VERTS) {
        next.push(a, b, c);
        continue;
      }
      // Split the worst edge only. Later passes reach the rest, and bisecting
      // one edge at a time keeps the triangles from degenerating into slivers.
      split = true;
      if (eab >= ebc && eab >= eca) { const m = midpoint(a, b); next.push(a, m, c, m, b, c); }
      else if (ebc >= eca) { const m = midpoint(b, c); next.push(b, m, a, m, c, a); }
      else { const m = midpoint(c, a); next.push(c, m, b, m, a, b); }
    }
    tris = next;
    if (!split) break;
  }
  return { vertices: verts, indices: tris };
}

export class MeshAccumulator {
  constructor(hasUv = true, hasColor = true) {
    this.positions = [];
    this.normals = [];
    this.uvs = hasUv ? [] : null;
    this.colors = hasColor ? [] : null;
    this.indices = [];
    this.count = 0;
  }

  get isEmpty() { return this.indices.length === 0; }

  vertex(x, y, z, nx, ny, nz, u, v, r, g, b) {
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    if (this.uvs) this.uvs.push(u, v);
    if (this.colors) this.colors.push(r, g, b);
    return this.count++;
  }

  tri(a, b, c) { this.indices.push(a, b, c); }
  quad(a, b, c, d) { this.indices.push(a, b, c, a, c, d); }

  /**
   * A flat quad from four corners, with the normal derived from the winding.
   * `uv` is `[u0, v0, u1, v1]` mapped across the quad.
   */
  addQuad(p0, p1, p2, p3, uv, colour) {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const [r, g, b] = colour;
    const [u0, v0, u1, v1] = uv;
    const i0 = this.vertex(p0[0], p0[1], p0[2], nx, ny, nz, u0, v0, r, g, b);
    const i1 = this.vertex(p1[0], p1[1], p1[2], nx, ny, nz, u1, v0, r, g, b);
    const i2 = this.vertex(p2[0], p2[1], p2[2], nx, ny, nz, u1, v1, r, g, b);
    const i3 = this.vertex(p3[0], p3[1], p3[2], nx, ny, nz, u0, v1, r, g, b);
    this.quad(i0, i1, i2, i3);
  }

  /**
   * Triangulate a horizontal polygon at height `y`.
   * `heightFn(x, z)` may override the height per vertex, which is how sloped
   * roofs and terrain-following ground are built from the same code.
   */
  addPolygon(ring, holes, y, colour, {
    uvScale = 0.25, uvScaleV = null, faceUp = true, heightFn = null,
    normalFn = null, uvOrigin = [0, 0], colourFn = null, drape = null,
  } = {}) {
    // A separate V scale lets a surface be mapped into someone else's texture
    // space - a roof into the chunk's aerial photograph, say, where V runs the
    // other way from world Z.
    const vScale = uvScaleV === null ? uvScale : uvScaleV;
    let { vertices, indices } = triangulate(ring, holes);
    if (!indices.length) return 0;
    // Draping is only as good as the polygon's own vertices, so give a big
    // one some interior points before sampling the ground.
    if (drape && heightFn) ({ vertices, indices } = subdivide(vertices, indices, { heightFn, ...drape }));
    const [r, g, b] = colour;
    const base = this.count;
    const n = vertices.length / 2;
    for (let i = 0; i < n; i++) {
      const x = vertices[i * 2], z = vertices[i * 2 + 1];
      const vy = heightFn ? heightFn(x, z) : y;
      let nx = 0, ny = faceUp ? 1 : -1, nz = 0;
      if (normalFn) { const nn = normalFn(x, z); nx = nn[0]; ny = nn[1]; nz = nn[2]; }
      // A colour per vertex lets a large area vary across itself. The texture
      // can only repeat, so without this a park is one flat green however big
      // it is, and the tiling is the only thing telling you it has any size.
      const [vr, vg, vb] = colourFn ? colourFn(x, z, r, g, b) : [r, g, b];
      this.vertex(x, vy, z, nx, ny, nz,
                  (x - uvOrigin[0]) * uvScale, (z - uvOrigin[1]) * vScale, vr, vg, vb);
    }
    // The ear clipper winds its triangles for a clockwise-from-above ring,
    // which gives a geometric normal pointing DOWN. WebGL treats
    // counter-clockwise as front-facing, so emitting that order directly makes
    // every roof and every patch of grass a back face: lit from underneath,
    // and therefore black. Reverse it so the winding agrees with the +Y normal
    // we just stored.
    for (let i = 0; i < indices.length; i += 3) {
      if (faceUp) this.tri(base + indices[i + 2], base + indices[i + 1], base + indices[i]);
      else this.tri(base + indices[i], base + indices[i + 1], base + indices[i + 2]);
    }
    return indices.length / 3;
  }

  /** Merge another accumulator's contents into this one. */
  append(other) {
    const base = this.count;
    for (let i = 0; i < other.positions.length; i++) this.positions.push(other.positions[i]);
    for (let i = 0; i < other.normals.length; i++) this.normals.push(other.normals[i]);
    if (this.uvs && other.uvs) for (let i = 0; i < other.uvs.length; i++) this.uvs.push(other.uvs[i]);
    if (this.colors && other.colors) for (let i = 0; i < other.colors.length; i++) this.colors.push(other.colors[i]);
    for (let i = 0; i < other.indices.length; i++) this.indices.push(base + other.indices[i]);
    this.count += other.count;
  }

  /** Recompute smooth normals by area-weighted averaging. */
  smoothNormals() {
    const n = this.count;
    const acc = new Float32Array(n * 3);
    const p = this.positions;
    for (let i = 0; i < this.indices.length; i += 3) {
      const a = this.indices[i], b = this.indices[i + 1], c = this.indices[i + 2];
      const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
      const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
      const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      // Cross product magnitude is twice the triangle area, so the sum is
      // already area weighted.
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const idx of [a, b, c]) {
        acc[idx * 3] += nx; acc[idx * 3 + 1] += ny; acc[idx * 3 + 2] += nz;
      }
    }
    for (let i = 0; i < n; i++) {
      const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
      this.normals[i * 3] = acc[i * 3] / l;
      this.normals[i * 3 + 1] = acc[i * 3 + 1] / l;
      this.normals[i * 3 + 2] = acc[i * 3 + 2] / l;
    }
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    if (this.uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (this.colors) g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    // 16-bit indices where they fit; saves a good deal of GPU memory.
    const IndexArray = this.count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IndexArray(this.indices), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * A set of accumulators keyed by material, so a caller can just say "put this
 * triangle on the brick material" and get one merged mesh per material at the
 * end.
 */
export class MultiMesh {
  constructor() {
    this.groups = new Map();     // key -> { material, acc }
  }

  for(key, material, hasUv = true, hasColor = true) {
    let g = this.groups.get(key);
    if (!g) {
      g = { material, acc: new MeshAccumulator(hasUv, hasColor) };
      this.groups.set(key, g);
    }
    return g.acc;
  }

  /** Build one Mesh per non-empty group. */
  build({ castShadow = true, receiveShadow = true, smooth = false } = {}) {
    const meshes = [];
    for (const [key, g] of this.groups) {
      if (g.acc.isEmpty) continue;
      if (smooth) g.acc.smoothNormals();
      const mesh = new THREE.Mesh(g.acc.toGeometry(), g.material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = receiveShadow;
      mesh.name = key;
      mesh.matrixAutoUpdate = false;
      meshes.push(mesh);
    }
    return meshes;
  }

  get triangleCount() {
    let n = 0;
    for (const g of this.groups.values()) n += g.acc.indices.length / 3;
    return n;
  }
}

/** Convert a 0xRRGGBB int to a linear-space `[r, g, b]` triple. */
const colourCache = new Map();
export function colourToLinear(hex) {
  let c = colourCache.get(hex);
  if (c) return c;
  // THREE.ColorManagement is on by default from r155, so `new Color(hex)` has
  // already taken the hex as sRGB and stored it in the linear working space.
  // Converting again applied the transfer function twice and left every
  // vertex-coloured surface in the world between six and thirteen times too
  // dark - which is not a lighting problem, however much it looks like one.
  const col = new THREE.Color(hex);
  c = [col.r, col.g, col.b];
  colourCache.set(hex, c);
  return c;
}

/** Multiply a linear colour triple by a scalar, for shading variation. */
export function shade(rgb, k) {
  return [Math.min(1, rgb[0] * k), Math.min(1, rgb[1] * k), Math.min(1, rgb[2] * k)];
}

/**
 * Clip a polygon to the half-plane `nx*x + nz*z <= d` (Sutherland-Hodgman).
 * Roof ridges are built by clipping a footprint on both sides of the ridge
 * line, which is what lets a gable sit on a footprint that is not a rectangle.
 */
export function clipHalfPlane(ring, nx, nz, d) {
  const out = [];
  const n = ring.length;
  if (n < 3) return out;
  for (let i = 0; i < n; i++) {
    const cur = ring[i];
    const prev = ring[(i - 1 + n) % n];
    const dCur = nx * cur[0] + nz * cur[1] - d;
    const dPrev = nx * prev[0] + nz * prev[1] - d;
    const curIn = dCur <= 0;
    const prevIn = dPrev <= 0;
    if (curIn !== prevIn) {
      const t = dPrev / (dPrev - dCur);
      out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
    }
    if (curIn) out.push([cur[0], cur[1]]);
  }
  return out;
}

/** Ensure a ring is wound clockwise-from-above, the convention everywhere here. */
export function ensureClockwise(ring) {
  return signedArea2(ring) > 0 ? ring : ring.slice().reverse();
}

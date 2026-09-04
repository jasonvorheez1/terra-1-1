// Collision geometry.
//
// Collision is triangle-exact, not a proxy: the same walls, kerbs, stairs,
// bridge parapets and tunnel linings you can see are the ones you bump into.
// Everything solid in a chunk is accumulated into one indexed triangle soup and
// handed to three-mesh-bvh, which builds a bounding volume hierarchy over it.
// The character controller then does a capsule-vs-BVH sweep, so a 14 cm kerb
// is a 14 cm step and a doorway is exactly as wide as it looks.

import * as THREE from 'three';
import { MeshBVH, computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { triangulate } from '../world/geometry.js';

// Install the BVH accelerators once, globally.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Accumulates solid triangles. Positions only - collision does not care about
 * normals or UVs, and leaving them out roughly halves the memory a chunk's
 * collision mesh costs.
 */
export class CollisionBuilder {
  constructor() {
    this.positions = [];
    this.indices = [];
    this.count = 0;
    // Surface tags let footsteps know what they are landing on. One entry per
    // triangle, parallel to the index buffer.
    this.surfaces = [];
    this.currentSurface = 0;
  }

  get isEmpty() { return this.indices.length === 0; }
  get triangleCount() { return this.indices.length / 3; }

  /** Tag every triangle added from here on with a surface id. */
  surface(id) { this.currentSurface = id | 0; return this; }

  vertex(x, y, z) {
    this.positions.push(x, y, z);
    return this.count++;
  }

  tri(a, b, c) {
    this.indices.push(a, b, c);
    this.surfaces.push(this.currentSurface);
  }

  /** Two triangles from four corners, each `[x, y, z]`. */
  quad(p0, p1, p2, p3) {
    const a = this.vertex(p0[0], p0[1], p0[2]);
    const b = this.vertex(p1[0], p1[1], p1[2]);
    const c = this.vertex(p2[0], p2[1], p2[2]);
    const d = this.vertex(p3[0], p3[1], p3[2]);
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** A strip between two parallel polylines of `[x, y, z]` points. */
  strip(left, right) {
    const n = Math.min(left.length, right.length);
    for (let i = 0; i < n - 1; i++) {
      this.quad(left[i], right[i], right[i + 1], left[i + 1]);
    }
  }

  /**
   * A vertical wall along a 2D polyline. `heights` gives the base height at
   * each point; the wall runs from `base` to `base + height` above that.
   */
  wall(pts, heights, base, height) {
    const n = Math.min(pts.length, heights.length);
    for (let i = 0; i < n - 1; i++) {
      const y0 = heights[i] + base, y1 = heights[i + 1] + base;
      this.quad(
        [pts[i][0], y0, pts[i][1]],
        [pts[i + 1][0], y1, pts[i + 1][1]],
        [pts[i + 1][0], y1 + height, pts[i + 1][1]],
        [pts[i][0], y0 + height, pts[i][1]]);
    }
  }

  /** A closed vertical loop, for building footprints and barriers. */
  loop(ring, baseY, topY, closed = true) {
    const n = ring.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const ay = typeof baseY === 'function' ? baseY(a[0], a[1]) : baseY;
      const by = typeof baseY === 'function' ? baseY(b[0], b[1]) : baseY;
      const at = typeof topY === 'function' ? topY(a[0], a[1]) : topY;
      const bt = typeof topY === 'function' ? topY(b[0], b[1]) : topY;
      this.quad([a[0], ay, a[1]], [b[0], by, b[1]], [b[0], bt, b[1]], [a[0], at, a[1]]);
    }
  }

  /** A horizontal triangulated surface - floors, roofs, water beds. */
  polygon(ring, holes, y, heightFn = null) {
    const { vertices, indices } = triangulate(ring, holes);
    if (!indices.length) return;
    const base = this.count;
    for (let i = 0; i < vertices.length / 2; i++) {
      const x = vertices[i * 2], z = vertices[i * 2 + 1];
      this.vertex(x, heightFn ? heightFn(x, z) : y, z);
    }
    for (let i = 0; i < indices.length; i += 3) {
      this.tri(base + indices[i], base + indices[i + 1], base + indices[i + 2]);
    }
  }

  /** An axis-aligned box, for piers, props and furniture. */
  box(cx, cy, cz, w, h, d) {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);   // top
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]);   // bottom
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
    this.quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
    this.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  }

  /** A box rotated about the vertical axis. */
  rotatedBox(cx, cy, cz, w, h, d, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const hw = w / 2, hd = d / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    const corner = (sx, sz) => [cx + sx * hw * c - sz * hd * s, 0, cz + sx * hw * s + sz * hd * c];
    const p00 = corner(-1, -1), p10 = corner(1, -1), p11 = corner(1, 1), p01 = corner(-1, 1);
    const at = (p, y) => [p[0], y, p[2]];
    this.quad(at(p00, y1), at(p10, y1), at(p11, y1), at(p01, y1));
    this.quad(at(p01, y0), at(p11, y0), at(p10, y0), at(p00, y0));
    this.quad(at(p00, y0), at(p10, y0), at(p10, y1), at(p00, y1));
    this.quad(at(p11, y0), at(p01, y0), at(p01, y1), at(p11, y1));
    this.quad(at(p01, y0), at(p00, y0), at(p00, y1), at(p01, y1));
    this.quad(at(p10, y0), at(p11, y0), at(p11, y1), at(p10, y1));
  }

  /** A vertical cylinder, for posts, lamp columns and tree trunks. */
  cylinder(cx, cy, cz, radius, height, sides = 6) {
    const y0 = cy, y1 = cy + height;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius, z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius, z1 = cz + Math.sin(a1) * radius;
      this.quad([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]);
    }
  }

  /**
   * Build the BVH. Returns null when nothing solid was added, which is the
   * normal case for a chunk of open water or empty countryside.
   */
  build(name = 'collider') {
    if (this.isEmpty) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    const IndexArray = this.count > 65535 ? Uint32Array : Uint16Array;
    geo.setIndex(new THREE.BufferAttribute(new IndexArray(this.indices), 1));
    geo.computeBoundingBox();
    // SAH splits cost a little more to build and pay for themselves many times
    // over in query time, and this is queried five times per frame.
    geo.boundsTree = new MeshBVH(geo, { strategy: 1, maxLeafTris: 8 });
    const mesh = new THREE.Mesh(geo);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrixWorld(true);
    mesh.userData.surfaces = Uint8Array.from(this.surfaces);
    return mesh;
  }

  reset() {
    this.positions.length = 0;
    this.indices.length = 0;
    this.surfaces.length = 0;
    this.count = 0;
  }
}

/** Surface ids, used to pick footstep sounds from the triangle you are on. */
export const SURFACE_IDS = {
  concrete: 0, stone: 1, gravel: 2, dirt: 3, grass: 4,
  sand: 5, wood: 6, metal: 7, snow: 8, water: 9, carpet: 10, tile: 11,
};
export const SURFACE_NAMES = Object.keys(SURFACE_IDS);

/**
 * The set of collision meshes the controller currently tests against.
 *
 * Colliders live in named layers, and only one layer is active at a time. That
 * is what makes interior cells cheap: step through a door and the entire
 * outdoor world - hundreds of thousands of triangles across dozens of BVHs -
 * stops being consulted at all, and the controller is testing against one
 * building's worth of geometry instead.
 */
export class CollisionWorld {
  constructor() {
    this.layers = new Map([['world', new Map()], ['interior', new Map()]]);
    this.active = 'world';
    this.version = 0;
  }

  /** The colliders currently being tested against. */
  get colliders() { return this.layers.get(this.active); }

  layer(name) {
    if (!this.layers.has(name)) this.layers.set(name, new Map());
    return this.layers.get(name);
  }

  /** Switch which layer the controller collides with. */
  useLayer(name) {
    this.layer(name);
    this.active = name;
    this.version++;
  }

  set(key, mesh, layerName = 'world') {
    const layer = this.layer(layerName);
    const old = layer.get(key);
    if (old) this.dispose(old);
    if (mesh) layer.set(key, mesh);
    else layer.delete(key);
    this.version++;
  }

  remove(key, layerName = 'world') {
    const layer = this.layer(layerName);
    const old = layer.get(key);
    if (old) { this.dispose(old); layer.delete(key); this.version++; }
  }

  dispose(mesh) {
    if (mesh.geometry) {
      if (mesh.geometry.disposeBoundsTree) mesh.geometry.disposeBoundsTree();
      mesh.geometry.dispose();
    }
  }

  /** Empty one layer, or every layer when no name is given. */
  clear(layerName = null) {
    const names = layerName ? [layerName] : [...this.layers.keys()];
    for (const name of names) {
      const layer = this.layers.get(name);
      if (!layer) continue;
      for (const m of layer.values()) this.dispose(m);
      layer.clear();
    }
    this.version++;
  }

  /** Colliders whose bounds overlap a world-space box. */
  near(box, out = []) {
    out.length = 0;
    for (const m of this.colliders.values()) {
      const bb = m.geometry.boundingBox;
      if (!bb) continue;
      if (bb.max.x < box.min.x || bb.min.x > box.max.x) continue;
      if (bb.max.y < box.min.y || bb.min.y > box.max.y) continue;
      if (bb.max.z < box.min.z || bb.min.z > box.max.z) continue;
      out.push(m);
    }
    return out;
  }

  /**
   * Total collision triangles. Cached against `version`, because the HUD asks
   * for this every frame and walking the whole collider set to answer it is a
   * scan of every chunk in the world for a number that only changes when one
   * is added or removed.
   */
  get triangleCount() {
    if (this._triCountAt === this.version && this._triCountLayer === this.active) {
      return this._triCount;
    }
    let n = 0;
    for (const m of this.colliders.values()) {
      if (m.geometry.index) n += m.geometry.index.count / 3;
    }
    this._triCount = n;
    this._triCountAt = this.version;
    this._triCountLayer = this.active;
    return n;
  }

  /**
   * Raycast against everything. Returns the nearest hit, or null.
   * Used for the interact prompt and for dropping the player onto the ground.
   */
  raycast(origin, direction, maxDistance = 100) {
    const raycaster = new THREE.Raycaster(origin, direction, 0, maxDistance);
    raycaster.firstHitOnly = true;
    let best = null;
    for (const m of this.colliders.values()) {
      const hits = raycaster.intersectObject(m, false);
      if (hits.length && (!best || hits[0].distance < best.distance)) {
        best = hits[0];
        best.collider = m;
      }
    }
    return best;
  }

  /** Height of the highest solid surface under a point, or null. */
  groundHeight(x, z, fromY = 5000, maxDrop = 10000) {
    const hit = this.raycast(
      new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0), maxDrop);
    return hit ? hit.point.y : null;
  }
}

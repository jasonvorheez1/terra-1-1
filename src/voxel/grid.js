// Sparse voxel storage, and the rule that turns real terrain into blocks.
//
// The grid is anchored to the same local metre coordinates the walking world
// uses, one block per metre, so a block at (x, z) sits exactly where the
// polygon terrain does. That is the whole point of the mode: it is not a
// generated world that resembles Earth, it is the elevation data you were
// already standing on, quantised.

import { AIR, BLOCKS, isSolid } from './blocks.js';

const WOOD = 7, LEAVES = 8;

export const CHUNK = 16;              // blocks across, in x and z

/**
 * How tall the world is, in blocks.
 *
 * A single global floor keeps neighbouring chunks index-aligned, which makes
 * the face-culling lookup across a chunk boundary a plain array index instead
 * of a coordinate transform. The floor is set once when the mode starts, from
 * the terrain under the player, so the band follows the landscape you are
 * actually in rather than sea level - at 4,000 m in the Andes a sea-level band
 * would be entirely underground.
 */
export const HEIGHT = 160;
export const FLOOR_BELOW_SPAWN = 48;  // blocks of rock beneath you at the start

const IDX = (lx, ly, lz) => (ly * CHUNK + lz) * CHUNK + lx;

export const chunkKey = (cx, cz) => cx + ',' + cz;
export const chunkOf = (bx) => Math.floor(bx / CHUNK);

export class VoxelChunk {
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.data = new Uint8Array(CHUNK * CHUNK * HEIGHT);
    this.generated = false;
    this.dirty = true;            // needs a mesh
    this.empty = true;            // nothing but air, so meshing can skip it
    this.mesh = null;
    this.glassMesh = null;
    this.collider = null;
  }

  get(lx, ly, lz) { return this.data[IDX(lx, ly, lz)]; }
  set(lx, ly, lz, id) { this.data[IDX(lx, ly, lz)] = id; }
}

export class VoxelGrid {
  constructor(sampler) {
    this.sampler = sampler;
    this.chunks = new Map();
    // Player edits, kept apart from the generated rock so a chunk can be
    // thrown away and rebuilt without losing what you dug or built. Indexed by
    // chunk as well as by block, because generation has to apply the edits for
    // one chunk and scanning every edit ever made to find them turns chunk
    // loading into O(everything you have built).
    this.edits = new Map();               // "x,y,z" -> id, the save format
    this.editsByChunk = new Map();        // chunk key -> Map of the same
    // Blocks written by generation into a chunk that does not exist yet - a
    // tree near a seam whose canopy reaches next door. Applied when that chunk
    // is generated, then dropped. Not player edits, so they are not saved.
    this.pendingByChunk = new Map();
    this.baseY = 0;
  }

  editKey(x, y, z) { return x + ',' + y + ',' + z; }

  bucket(map, cx, cz) {
    const key = chunkKey(cx, cz);
    let m = map.get(key);
    if (!m) { m = new Map(); map.set(key, m); }
    return m;
  }

  chunk(cx, cz) { return this.chunks.get(chunkKey(cx, cz)) || null; }

  /** The chunk at these block coordinates, generated on demand. */
  ensure(cx, cz) {
    const key = chunkKey(cx, cz);
    let c = this.chunks.get(key);
    if (!c) { c = new VoxelChunk(cx, cz); this.chunks.set(key, c); }
    if (!c.generated) this.generate(c);
    return c;
  }

  /** Block id at world block coordinates. Outside the vertical band is air. */
  get(x, y, z) {
    const j = y - this.baseY;
    if (j < 0 || j >= HEIGHT) return AIR;
    const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(z)));
    if (!c || !c.generated) return AIR;
    return c.get(x - c.cx * CHUNK, j, z - c.cz * CHUNK);
  }

  /**
   * Write a block and remember it as an edit.
   *
   * Returns the chunks whose meshes are now stale: the one holding the block,
   * plus any neighbour it shares a face with, since a block removed at a chunk
   * seam uncovers a face belonging to the chunk next door.
   */
  set(x, y, z, id, { record = true } = {}) {
    const j = y - this.baseY;
    if (j < 0 || j >= HEIGHT) return [];
    const cx = chunkOf(x), cz = chunkOf(z);
    const c = this.chunk(cx, cz);
    if (!c || !c.generated) return [];
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    if (c.get(lx, j, lz) === id) return [];
    c.set(lx, j, lz, id);
    if (id !== AIR) c.empty = false;
    if (record) {
      const k = this.editKey(x, y, z);
      this.edits.set(k, id);
      this.bucket(this.editsByChunk, cx, cz).set(k, id);
    }

    const touched = [c];
    c.dirty = true;
    const edge = (ncx, ncz) => {
      const n = this.chunk(ncx, ncz);
      if (n && n.generated) { n.dirty = true; touched.push(n); }
    };
    if (lx === 0) edge(cx - 1, cz);
    if (lx === CHUNK - 1) edge(cx + 1, cz);
    if (lz === 0) edge(cx, cz - 1);
    if (lz === CHUNK - 1) edge(cx, cz + 1);
    return touched;
  }

  /**
   * Highest solid block in a column, or null if the column is empty.
   *
   * `standable` skips the canopy. Leaves are solid - you can walk along a
   * branch - but the highest solid block in a wood is a leaf five metres up,
   * so spawning on "the surface" without this drops you into a treetop.
   */
  surfaceY(x, z, { standable = false } = {}) {
    const c = this.chunks.get(chunkKey(chunkOf(x), chunkOf(z)));
    if (!c || !c.generated) return null;
    const lx = x - c.cx * CHUNK, lz = z - c.cz * CHUNK;
    for (let j = HEIGHT - 1; j >= 0; j--) {
      const id = c.get(lx, j, lz);
      if (!isSolid(id)) continue;
      if (standable && (id === LEAVES || id === WOOD)) continue;
      return this.baseY + j;
    }
    return null;
  }

  // --- generation ----------------------------------------------------------

  /**
   * Turn one chunk of real terrain into blocks.
   *
   * Every column asks the same elevation sampler the walking world uses, so
   * the block surface lands on the polygon surface to within the half metre
   * that rounding to a grid costs. Below the surface is the usual soil profile
   * rather than solid rock all the way down, because the first thing anyone
   * does in this mode is dig a hole and look at the wall of it.
   */
  generate(c) {
    const s = this.sampler;
    const originX = c.cx * CHUNK, originZ = c.cz * CHUNK;
    const data = c.data;
    data.fill(AIR);
    let empty = true;

    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const bx = originX + lx, bz = originZ + lz;
        const col = s.column(bx, bz);
        const topJ = Math.min(HEIGHT - 1, Math.floor(col.height) - this.baseY);
        if (topJ < 0) continue;

        for (let j = 0; j <= topJ; j++) {
          let id;
          const depth = topJ - j;
          if (depth === 0) id = col.surface;
          else if (depth <= col.soilDepth) id = col.soil;
          else id = s.oreAt(bx, this.baseY + j, bz, depth) || 1;   // stone, or a seam in it
          data[IDX(lx, j, lz)] = id;
        }
        empty = false;

        // Standing water fills from the bed up to the level the polygon world
        // put the surface at, so a lake is a lake rather than a dry basin.
        if (col.waterY !== null) {
          const wTop = Math.min(HEIGHT - 1, Math.floor(col.waterY) - this.baseY);
          for (let j = topJ + 1; j <= wTop; j++) data[IDX(lx, j, lz)] = 13;
        }
      }
    }

    c.generated = true;
    c.empty = empty;
    c.dirty = true;

    // Trees are placed after the ground so a trunk can sit on the block it
    // grew from, and they are allowed to cross a chunk edge - the neighbour
    // may not exist yet, so those blocks are written through the edit map,
    // which is applied to every chunk as it generates.
    s.decorate(this, c, originX, originZ);

    const apply = (map, drop) => {
      const m = map.get(c.key);
      if (!m) return;
      for (const [key, id] of m) {
        const p = key.split(',');
        const j = +p[1] - this.baseY;
        if (j < 0 || j >= HEIGHT) continue;
        data[IDX(+p[0] - originX, j, +p[2] - originZ)] = id;
        if (id !== AIR) c.empty = false;
      }
      if (drop) map.delete(c.key);
    };
    // Spill-over from a neighbour's trees first, then player edits, which win
    // over anything generated - including a tree that grew where you had
    // already cleared the ground.
    apply(this.pendingByChunk, true);
    apply(this.editsByChunk, false);
  }

  /**
   * Write a block during generation without recording it as a player edit.
   * Used by trees, which may reach into a chunk that has not been made yet;
   * those are held until it is.
   */
  place(x, y, z, id) {
    const j = y - this.baseY;
    if (j < 0 || j >= HEIGHT) return;
    const cx = chunkOf(x), cz = chunkOf(z);
    const c = this.chunk(cx, cz);
    if (c && c.generated) {
      const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
      if (c.get(lx, j, lz) === AIR) {
        c.set(lx, j, lz, id);
        c.empty = false;
        c.dirty = true;
      }
      return;
    }
    this.bucket(this.pendingByChunk, cx, cz).set(this.editKey(x, y, z), id);
  }

  dispose() {
    this.chunks.clear();
  }
}

/** Deterministic 3D hash, for ore veins. */
export function hash3(x, y, z, salt = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 1103515245 + (z | 0) * 668265263 + salt * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic hash for scattering, so a chunk regenerates identically. */
export function hash2(x, z, salt = 0) {
  let h = (x | 0) * 374761393 + (z | 0) * 668265263 + salt * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export { BLOCKS };

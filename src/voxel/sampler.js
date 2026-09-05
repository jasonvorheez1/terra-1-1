// What the real world is made of, expressed in blocks.
//
// Everything here reads the same sources the walking world does - the
// elevation tiles, the biome classification, the OSM footprints - so the voxel
// terrain is the same landscape rather than a lookalike generated from noise.

import { pointInRing, bounds } from '../world/geometry.js';
import { CHUNK, hash2, hash3 } from './grid.js';

const STONE = 1, DIRT = 2, GRASS = 3, SAND = 4, GRAVEL = 5, SNOW = 6;
const WOOD = 7, LEAVES = 8, PLANKS = 9, COBBLE = 10, BRICK = 11, GLASS = 12;
const CONCRETE = 14, ASPHALT = 15, CLAY = 16;

const TREE_CELL = 5;                 // metres between candidate trunks

const COAL = 17, IRON = 18, COPPER = 19, GOLD = 20;

/**
 * Where each ore lives, and how much of it there is.
 *
 * `from` and `to` are metres below the surface rather than absolute height, so
 * a seam follows the terrain: dig into the side of a hill and you find the
 * same coal you would have found straight down. `rate` is the chance a
 * four-metre cell holds a vein at all; `fill` is how solidly that cell fills
 * in. Two numbers rather than one, so ore comes in pockets you can follow
 * instead of single blocks dusted through the rock.
 */
const ORES = [
  { id: COAL,   from: 5,  to: 90,  rate: 0.055, fill: 0.42, salt: 71 },
  { id: COPPER, from: 12, to: 90,  rate: 0.030, fill: 0.36, salt: 73 },
  { id: IRON,   from: 20, to: 110, rate: 0.026, fill: 0.34, salt: 79 },
  { id: GOLD,   from: 46, to: 130, rate: 0.011, fill: 0.28, salt: 83 },
];
const ORE_CELL = 4;

/**
 * Ground cover for a biome, before slope and altitude have their say.
 *
 * `trees` is the chance any one column starts a tree. It reads low because a
 * tree is not one block: a canopy is five metres across, so 0.013 in
 * broadleaf woodland already puts a trunk every eight metres or so and the
 * crowns touch. At the 0.05 it started from, Central Park meshed into a solid
 * ceiling of leaves you could not see the ground through.
 */
const SURFACE = {
  desert: { surface: SAND, soil: SAND, trees: 0.0012 },
  savanna: { surface: GRASS, soil: DIRT, trees: 0.0030 },
  mediterranean: { surface: GRASS, soil: DIRT, trees: 0.0060 },
  temperateGrass: { surface: GRASS, soil: DIRT, trees: 0.0040 },
  temperateBroadleaf: { surface: GRASS, soil: DIRT, trees: 0.0130 },
  borealConifer: { surface: GRASS, soil: DIRT, trees: 0.0160 },
  tropicalSeasonal: { surface: GRASS, soil: DIRT, trees: 0.0155 },
  tropicalRainforest: { surface: GRASS, soil: CLAY, trees: 0.0230 },
  tundra: { surface: GRAVEL, soil: GRAVEL, trees: 0.0012 },
  alpine: { surface: GRAVEL, soil: STONE, trees: 0.0018 },
  polar: { surface: SNOW, soil: SNOW, trees: 0 },
};

/** OSM building materials, mapped onto the blocks we have. */
function buildingBlock(b) {
  const kind = b.kind || '';
  if (kind === 'house' || kind === 'shed' || kind === 'barn') return PLANKS;
  if (kind === 'industrial' || kind === 'parking') return CONCRETE;
  const era = b.era;
  if (era && (era.period === 'historic' || era.listed)) return BRICK;
  if (b.levels >= 8) return GLASS;
  return CONCRETE;
}

export class TerrainSampler {
  constructor(world, options = {}) {
    this.world = world;
    this.includeBuildings = options.includeBuildings !== false;
    this.treeDensity = options.treeDensity ?? 1;
    this._buildingCache = new Map();
  }

  /**
   * Ground cover for the biome at a point.
   *
   * The same lookup the walking world uses, so the two agree: walk into a
   * desert in one and the sand starts in the same place in the other. Only the
   * expression differs - polygons take a colour, blocks take a block.
   */
  coverAt(x, z) {
    const biome = this.world.biomeAt(x, z);
    return SURFACE[biome && biome.id] || SURFACE.temperateBroadleaf;
  }

  /**
   * What one column of the world is made of.
   *
   * Slope decides as much as biome does: turf does not cling to a cliff, so
   * anything past about 40 degrees comes out as bare rock, which is what makes
   * a voxel mountain read as a mountain instead of a green staircase.
   */
  column(bx, bz) {
    const world = this.world;
    const x = bx + 0.5, z = bz + 0.5;
    const h = world.terrainAt(x, z);
    if (!isFinite(h)) return { height: -9999, surface: STONE, soil: STONE, soilDepth: 0, waterY: null };

    const dx = world.terrainAt(x + 1, z) - world.terrainAt(x - 1, z);
    const dz = world.terrainAt(x, z + 1) - world.terrainAt(x, z - 1);
    const slope = Math.hypot(dx, dz) / 2;            // metres of rise per metre

    let { surface, soil } = this.coverAt(x, z);
    let soilDepth = 3;
    if (slope > 0.85) { surface = STONE; soil = STONE; soilDepth = 0; }
    else if (slope > 0.55) { surface = GRAVEL; soil = STONE; soilDepth = 1; }

    // Snow line: the same treeline logic the biome classifier uses would be
    // overkill here, and altitude alone reads correctly on a mountain.
    if (surface === GRASS && h > 2600) surface = SNOW;

    const building = this.includeBuildings ? this.buildingAt(bx, bz, x, z) : null;

    let waterY = null;
    if (!building) {
      const w = world.waterAt(x, z);
      if (w && w.depth > 0.2) {
        waterY = w.level;
        // A lake bed is silt, not lawn.
        surface = soil = (w.depth > 3 ? CLAY : GRAVEL);
      }
    }

    return { height: h, surface, soil, soilDepth, waterY, building, slope };
  }

  /**
   * The ore, if any, in a block of stone this far below the surface.
   *
   * Called for every stone block generated, so it has to be cheap: two hashes
   * and no allocation. The vein hash is on the cell and the fill hash on the
   * block, which is what makes a pocket rather than a dusting.
   */
  oreAt(bx, by, bz, depth) {
    for (let i = 0; i < ORES.length; i++) {
      const o = ORES[i];
      if (depth < o.from || depth > o.to) continue;
      const cx = Math.floor(bx / ORE_CELL), cy = Math.floor(by / ORE_CELL), cz = Math.floor(bz / ORE_CELL);
      if (hash3(cx, cy, cz, o.salt) > o.rate) continue;
      if (hash3(bx, by, bz, o.salt + 1) > o.fill) continue;
      return o.id;
    }
    return 0;
  }

  /**
   * The building standing on a column, if any.
   *
   * Footprints are looked up per voxel chunk and cached: testing every
   * building in a 256 m chunk against all 256 columns would be a thousand
   * point-in-polygon tests per column, and the answer only changes when the
   * chunk does.
   */
  buildingAt(bx, bz, x, z) {
    const world = this.world;
    const key = Math.floor(bx / CHUNK) + ',' + Math.floor(bz / CHUNK);
    let list = this._buildingCache.get(key);
    if (list === undefined) {
      list = [];
      const minX = Math.floor(bx / CHUNK) * CHUNK, minZ = Math.floor(bz / CHUNK) * CHUNK;
      const maxX = minX + CHUNK, maxZ = minZ + CHUNK;
      // A voxel chunk is 16 m; a world chunk is 256 m. One world chunk holds
      // the lot, but a footprint can straddle the seam, so check the
      // neighbours too.
      const seen = new Set();
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const wk = Math.floor((minX + dx * CHUNK) / 256) + ',' + Math.floor((minZ + dz * CHUNK) / 256);
          if (seen.has(wk)) continue;
          seen.add(wk);
          const fs = world.chunkFeatures.get(wk);
          if (!fs) continue;
          for (const b of fs.buildings) {
            if (!b.ring || b.ring.length < 3) continue;
            const bb = b.bounds || (b.bounds = bounds(b.ring));
            if (bb.maxX < minX || bb.minX > maxX || bb.maxZ < minZ || bb.minZ > maxZ) continue;
            list.push(b);
          }
        }
      }
      this._buildingCache.set(key, list);
    }
    if (!list.length) return null;

    for (const b of list) {
      if (!pointInRing(b.ring, x, z)) continue;
      if (b.holes && b.holes.some((hole) => pointInRing(hole, x, z))) continue;
      const top = (b.heights && b.heights.top) || 6;
      return { top, block: buildingBlock(b) };
    }
    return null;
  }

  /**
   * Everything that sits on top of the ground: buildings, then trees.
   *
   * Run after the column fill so a trunk can stand on the block it grew from,
   * and allowed to write into a neighbouring chunk - a canopy near a seam
   * reaches across, and the grid holds those blocks until that chunk exists.
   */
  decorate(grid, chunk, originX, originZ) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const bx = originX + lx, bz = originZ + lz;
        // How thickly trees stand is a property of the place, not the session:
        // a chunk that straddles the edge of a wood should thin out across it.
        const density = this.coverAt(bx + 0.5, bz + 0.5).trees * this.treeDensity;
        const col = this.column(bx, bz);
        if (col.height < -9000) continue;
        const groundY = Math.floor(col.height);

        if (col.building) {
          this.raiseBuilding(grid, bx, bz, groundY, col.building);
          continue;
        }
        if (!density || col.waterY !== null) continue;
        if (col.surface !== GRASS && col.surface !== CLAY) continue;
        if (col.slope > 0.5) continue;
        // At most one tree per five-metre cell, standing at a spot jittered
        // inside it. Rolling the dice per column instead lets two trunks land
        // side by side, and a pair of five-metre crowns a metre apart is an
        // indistinguishable green lump rather than two trees.
        const cellX = Math.floor(bx / TREE_CELL), cellZ = Math.floor(bz / TREE_CELL);
        if (hash2(cellX, cellZ, 11) > density * TREE_CELL * TREE_CELL) continue;
        const jx = Math.floor(hash2(cellX, cellZ, 12) * TREE_CELL);
        const jz = Math.floor(hash2(cellX, cellZ, 13) * TREE_CELL);
        if (bx - cellX * TREE_CELL !== jx || bz - cellZ * TREE_CELL !== jz) continue;
        this.growTree(grid, bx, bz, groundY);
      }
    }
  }

  raiseBuilding(grid, bx, bz, groundY, building) {
    const top = Math.round(building.top);
    for (let y = 1; y <= top; y++) grid.place(bx, groundY + y, bz, building.block);
  }

  /**
   * A tree: a trunk with a blob of leaves on it.
   *
   * Deliberately the Minecraft shape rather than the walking world's card
   * foliage - at one-metre resolution there is nothing else a tree can be, and
   * trying for a silhouette at this scale reads as noise.
   */
  growTree(grid, bx, bz, groundY) {
    const r = hash2(bx, bz, 29);
    const height = 4 + Math.floor(hash2(bx, bz, 31) * 4);
    const radius = r > 0.7 ? 3 : 2;

    for (let y = 1; y <= height; y++) grid.place(bx, groundY + y, bz, WOOD);

    const crownY = groundY + height;
    for (let dy = -2; dy <= 2; dy++) {
      // Flatten the top and bottom of the ball so it looks like a canopy
      // rather than a sphere impaled on a stick.
      const rr = radius - Math.abs(dy) * (dy > 0 ? 1 : 0.5);
      if (rr <= 0) continue;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dz * dz > rr * rr + 0.4) continue;
          if (dx === 0 && dz === 0 && dy <= 0) continue;      // keep the trunk
          if (hash2(bx + dx * 7, bz + dz * 13, dy + 40) < 0.12) continue;
          grid.place(bx + dx, crownY + dy, bz + dz, LEAVES);
        }
      }
    }
  }

  /** Footprint lookups are only valid while the world's chunks are. */
  invalidate() { this._buildingCache.clear(); }
}

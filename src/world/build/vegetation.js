// Vegetation.
//
// Where things grow, and how densely, comes from the NASA MODIS NDVI reading
// for the actual coordinates (see geo/nasa.js) multiplied by the land-cover
// class. What grows there comes from the biome, which is itself derived from
// latitude, elevation and that same NDVI. The upshot is that a park in Lagos
// and a park in Oslo are planted differently without anyone hand-authoring
// either, and a drought-stricken summer reads as one.
//
// Trees are crossed alpha cards plus a tapered trunk, drawn with InstancedMesh
// so a forest of ten thousand is a handful of draw calls. Trunks go into the
// collision mesh; canopies do not, because walking through low branches is
// better than being stopped by them.

import * as THREE from 'three';
import { foliageTexture } from '../../gfx/textures.js';
import { makeRng, jitteredScatter, hashString, fbm2 } from '../../core/rng.js';
import { pointInPolygon, bounds, area } from '../geometry.js';
import { clamp, lerp } from '../../core/util.js';

/**
 * Species palettes per biome. `w` is the relative frequency; `shape` picks the
 * canopy construction; `h` is the height range in metres.
 */
export const SPECIES = {
  oak:       { foliage: 'broadleaf', bark: 'rough', shape: 'round',    h: [9, 22],  crown: 0.62, spread: 0.9,  colours: [0x4e6b32, 0x577439, 0x435c2b] },
  maple:     { foliage: 'broadleaf', bark: 'rough', shape: 'round',    h: [8, 18],  crown: 0.6,  spread: 0.8,  colours: [0x54763a, 0x5f7f3f, 0x6b6a2c] },
  birch:     { foliage: 'sparse',    bark: 'birch', shape: 'columnar', h: [10, 20], crown: 0.55, spread: 0.5,  colours: [0x74914a, 0x6a8742, 0x7d9a52] },
  poplar:    { foliage: 'sparse',    bark: 'rough', shape: 'columnar', h: [14, 28], crown: 0.7,  spread: 0.32, colours: [0x5e7a3c, 0x688443] },
  planeTree: { foliage: 'broadleaf', bark: 'rough', shape: 'round',    h: [12, 24], crown: 0.55, spread: 0.85, colours: [0x5a7538, 0x647f41] },
  spruce:    { foliage: 'needle',    bark: 'rough', shape: 'conical',  h: [12, 30], crown: 0.78, spread: 0.42, colours: [0x2f4a2c, 0x35522f, 0x293f26] },
  pine:      { foliage: 'needle',    bark: 'rough', shape: 'umbrella', h: [12, 26], crown: 0.42, spread: 0.62, colours: [0x3a5432, 0x415c37] },
  fir:       { foliage: 'needle',    bark: 'rough', shape: 'conical',  h: [10, 26], crown: 0.8,  spread: 0.38, colours: [0x2b4529, 0x314c2e] },
  cypress:   { foliage: 'needle',    bark: 'rough', shape: 'columnar', h: [8, 18],  crown: 0.85, spread: 0.22, colours: [0x2f4630, 0x364e35] },
  olive:     { foliage: 'sparse',    bark: 'rough', shape: 'round',    h: [4, 9],   crown: 0.6,  spread: 0.95, colours: [0x6d7a52, 0x77835c] },
  palm:      { foliage: 'palm',      bark: 'palm',  shape: 'palm',     h: [7, 20],  crown: 0.22, spread: 0.75, colours: [0x4f7a38, 0x578341] },
  acacia:    { foliage: 'sparse',    bark: 'rough', shape: 'umbrella', h: [6, 14],  crown: 0.3,  spread: 1.25, colours: [0x67783f, 0x718146] },
  kapok:     { foliage: 'broadleaf', bark: 'rough', shape: 'umbrella', h: [25, 45], crown: 0.32, spread: 1.1,  colours: [0x39592b, 0x3f6130] },
  jungle:    { foliage: 'broadleaf', bark: 'rough', shape: 'round',    h: [14, 32], crown: 0.5,  spread: 0.9,  colours: [0x2f5227, 0x365a2c, 0x3d6431] },
  shrub:     { foliage: 'sparse',    bark: 'rough', shape: 'round',    h: [1.1, 2.6], crown: 0.82, spread: 1.0, colours: [0x5c6b3c, 0x667443] },
  dwarfPine: { foliage: 'needle',    bark: 'rough', shape: 'conical',  h: [2, 6],   crown: 0.8,  spread: 0.55, colours: [0x2f4630, 0x384f36] },
  cactus:    { foliage: 'sparse',    bark: 'rough', shape: 'columnar', h: [2, 6],   crown: 0.7,  spread: 0.25, colours: [0x4f6b45, 0x58744d] },
};

const BIOME_SPECIES = {
  tropicalRainforest: [{ id: 'jungle', w: 6 }, { id: 'kapok', w: 2 }, { id: 'palm', w: 2 }],
  tropicalSeasonal:   [{ id: 'jungle', w: 3 }, { id: 'palm', w: 3 }, { id: 'acacia', w: 2 }, { id: 'shrub', w: 2 }],
  savanna:            [{ id: 'acacia', w: 6 }, { id: 'shrub', w: 4 }, { id: 'palm', w: 1 }],
  desert:             [{ id: 'cactus', w: 4 }, { id: 'shrub', w: 5 }, { id: 'palm', w: 1 }],
  mediterranean:      [{ id: 'olive', w: 4 }, { id: 'cypress', w: 3 }, { id: 'pine', w: 3 }, { id: 'shrub', w: 2 }],
  temperateBroadleaf: [{ id: 'oak', w: 5 }, { id: 'maple', w: 3 }, { id: 'birch', w: 2 }, { id: 'planeTree', w: 2 }, { id: 'pine', w: 1 }],
  temperateGrass:     [{ id: 'oak', w: 3 }, { id: 'poplar', w: 2 }, { id: 'shrub', w: 4 }],
  borealConifer:      [{ id: 'spruce', w: 6 }, { id: 'fir', w: 3 }, { id: 'pine', w: 2 }, { id: 'birch', w: 2 }],
  tundra:             [{ id: 'shrub', w: 6 }, { id: 'dwarfPine', w: 2 }],
  alpine:             [{ id: 'dwarfPine', w: 4 }, { id: 'shrub', w: 4 }],
  polar:              [],
};

/** OSM `species`/`genus` values mapped onto our palette. */
const SPECIES_ALIASES = [
  [/quercus|oak|chene|eiche|roble/i, 'oak'],
  [/acer|maple|erable|ahorn/i, 'maple'],
  [/betula|birch|bouleau|birke/i, 'birch'],
  [/populus|poplar|peuplier|pappel|aspen/i, 'poplar'],
  [/platanus|plane|platane/i, 'planeTree'],
  [/picea|spruce|epicea|fichte/i, 'spruce'],
  [/pinus|pine|pin |kiefer/i, 'pine'],
  [/abies|fir|sapin|tanne/i, 'fir'],
  [/cupressus|cypress|cypres|thuja|juniperus/i, 'cypress'],
  [/olea|olive|olivier/i, 'olive'],
  [/palm|phoenix|cocos|washingtonia|arecaceae/i, 'palm'],
  [/acacia|vachellia/i, 'acacia'],
  [/ceiba|kapok/i, 'kapok'],
  [/tilia|lime|linden|fagus|beech|fraxinus|ash|ulmus|elm|aesculus|chestnut|prunus|cherry|salix|willow/i, 'oak'],
];

export function speciesFromTag(value) {
  if (!value) return null;
  for (const [re, id] of SPECIES_ALIASES) if (re.test(value)) return id;
  return null;
}

/** Pick a species for a biome, deterministically per position. */
export function pickSpecies(biomeId, rng) {
  const list = BIOME_SPECIES[biomeId] || BIOME_SPECIES.temperateBroadleaf;
  if (!list.length) return null;
  return rng.weighted(list).id;
}

// --- geometry --------------------------------------------------------------

const geometryCache = new Map();

/**
 * Canopy geometry for a species: crossed alpha cards.
 *
 * Three vertical cards at 60 degrees plus one horizontal reads as a full canopy
 * from any angle a walker will ever see it from, for eight triangles.
 */
function canopyGeometry(shape) {
  const key = `canopy:${shape}`;
  if (geometryCache.has(key)) return geometryCache.get(key);

  const geos = [];
  const cards = shape === 'palm' ? 2 : 3;
  for (let i = 0; i < cards; i++) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.rotateY((i / cards) * Math.PI);
    geos.push(g);
  }
  // A horizontal card fills in the view from above and from a hillside.
  if (shape !== 'columnar') {
    const flat = new THREE.PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    flat.translate(0, shape === 'conical' ? -0.18 : 0, 0);
    geos.push(flat);
  }

  const merged = mergeGeometries(geos);
  geometryCache.set(key, merged);
  return merged;
}

/** Minimal geometry merge; avoids pulling in the full BufferGeometryUtils. */
function mergeGeometries(list) {
  let vertexCount = 0, indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint16Array(indexCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position.array;
    const nrm = g.attributes.normal.array;
    const t = g.attributes.uv.array;
    position.set(p, vo * 3);
    normal.set(nrm, vo * 3);
    uv.set(t, vo * 2);
    const idx = g.index ? g.index.array : null;
    const count = g.attributes.position.count;
    if (idx) {
      for (let i = 0; i < idx.length; i++) index[io++] = idx[i] + vo;
    } else {
      for (let i = 0; i < count; i++) index[io++] = i + vo;
    }
    vo += count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}

function trunkGeometry() {
  if (geometryCache.has('trunk')) return geometryCache.get('trunk');
  // Tapered, open-ended: the top is always hidden inside the canopy.
  const g = new THREE.CylinderGeometry(0.36, 1, 1, 6, 1, true);
  g.translate(0, 0.5, 0);
  geometryCache.set('trunk', g);
  return g;
}

export function disposeVegetationGeometry() {
  for (const g of geometryCache.values()) g.dispose();
  geometryCache.clear();
}

// --- placement -------------------------------------------------------------

/**
 * Collect every tree that belongs in this chunk, from tagged OSM trees, tree
 * rows, and scattered plantings inside vegetated land cover.
 */
export function collectTrees(features, chunk, ctx) {
  const out = [];
  const { minX, minZ, size } = chunk;
  const maxX = minX + size, maxZ = minZ + size;
  const density = ctx.settings.graphics.vegetationDensity;
  if (density <= 0) return out;

  const inChunk = (x, z) => x >= minX && x < maxX && z >= minZ && z < maxZ;

  // 1. Individually mapped trees. These are exact, so they are never skipped.
  for (const t of features.trees) {
    if (!inChunk(t.x, t.z)) continue;
    const rng = makeRng(hashString(`tree${t.id}`));
    let id = speciesFromTag(t.species);
    if (!id && t.leafType === 'needleleaved') id = 'spruce';
    if (!id) id = pickSpecies(ctx.biome.id, rng);
    if (!id) continue;
    const sp = SPECIES[id];
    const height = t.height || (t.circumference ? clamp(t.circumference * 7, 3, 40)
      : rng.range(sp.h[0], sp.h[1]));
    out.push(makeTree(t.x, t.z, id, height, rng, ctx, t.diameter));
  }

  // 2. Tree rows, planted along the way at the tagged spacing.
  for (const row of features.treeRows) {
    const rng = makeRng(hashString(`row${row.id}`));
    let id = speciesFromTag(row.species) || pickSpecies(ctx.biome.id, rng);
    if (!id) continue;
    const spacing = clamp(row.spacing || 8, 3, 30);
    for (let i = 1; i < row.pts.length; i++) {
      const a = row.pts[i - 1], b = row.pts[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(len / spacing));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        if (!inChunk(x, z)) continue;
        const sp = SPECIES[id];
        out.push(makeTree(x, z, id, row.height || rng.range(sp.h[0], sp.h[1]), rng, ctx));
      }
    }
  }

  // 3. Scattered planting inside vegetated polygons, at a density the
  //    satellite actually supports.
  for (const lc of features.landcover) {
    const veg = lc.spec.veg;
    if (veg < 0.05) continue;
    const b = lc.bounds || (lc.bounds = bounds(lc.ring));
    if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;

    const c = ctx.centroidGeo(lc.ring);
    const ndviValue = ctx.ndviAt(c.lat, c.lon);
    // NDVI below about 0.15 is bare ground; above 0.7 is closed canopy.
    const vigour = clamp((ndviValue - 0.12) / 0.55, 0, 1.25);
    const perTree = lerp(26, 6.5, clamp(veg * vigour, 0, 1)) / Math.sqrt(clamp(density, 0.05, 3));
    if (!isFinite(perTree) || perTree > 60) continue;

    const rng = makeRng(hashString(`lc${lc.id}:${chunk.key}`));
    const x0 = Math.max(minX, b.minX), x1 = Math.min(maxX, b.maxX);
    const z0 = Math.max(minZ, b.minZ), z1 = Math.min(maxZ, b.maxZ);
    if (x1 <= x0 || z1 <= z0) continue;

    const pts = jitteredScatter(x0, z0, x1, z1, perTree, rng,
      (x, z) => pointInPolygon(lc.ring, lc.holes, x, z));
    for (const [x, z] of pts) {
      // Thin the edges of a wood so it does not end in a wall of trunks.
      if (rng() > 0.55 + fbm2(x * 0.03, z * 0.03, 2) * 0.45) continue;
      const id = lc.spec.cover === 'orchard' || lc.spec.cover === 'vineyard'
        ? (lc.spec.cover === 'vineyard' ? 'shrub' : 'olive')
        : pickSpecies(ctx.biome.id, rng);
      if (!id) continue;
      const sp = SPECIES[id];
      const scale = lc.spec.cover === 'forest' ? 1 : 0.85;
      out.push(makeTree(x, z, id, rng.range(sp.h[0], sp.h[1]) * scale, rng, ctx));
    }
  }

  return out;
}

function makeTree(x, z, speciesId, height, rng, ctx, crownDiameter) {
  const sp = SPECIES[speciesId];
  const y = ctx.terrainAt(x, z);
  const h = clamp(height, 0.8, 60);
  const spread = crownDiameter ? crownDiameter / 2 : h * sp.spread * 0.34 * rng.range(0.85, 1.18);
  const colour = new THREE.Color(rng.pick(sp.colours));
  // Autumn and drought both pull the green out; do it per tree so a wood
  // turns unevenly, the way a real one does.
  if (ctx.season != null && sp.foliage !== 'needle' && sp.foliage !== 'palm') {
    const autumn = clamp((0.62 - ctx.season) * 1.7, 0, 1) * rng.range(0.5, 1);
    colour.lerp(new THREE.Color(rng.pick([0xb5741f, 0xc4922b, 0x9c4f1e, 0x8a6b22])), autumn * 0.8);
  }
  colour.offsetHSL(rng.range(-0.02, 0.02), rng.range(-0.05, 0.05), rng.range(-0.05, 0.05));
  return {
    x, y, z,
    species: speciesId,
    height: h,
    spread,
    rotation: rng() * Math.PI * 2,
    lean: rng.range(-0.05, 0.05),
    colour,
    trunkRadius: clamp(h * 0.028, 0.05, 1.4),
  };
}

// --- instancing ------------------------------------------------------------

/**
 * Turn a tree list into InstancedMeshes, one pair (trunk + canopy) per species.
 * Trunks are added to the collision mesh; canopies deliberately are not.
 */
export function buildTreeInstances(trees, ctx, group, collide) {
  if (!trees.length) return [];
  const bySpecies = new Map();
  for (const t of trees) {
    let list = bySpecies.get(t.species);
    if (!list) { list = []; bySpecies.set(t.species, list); }
    list.push(t);
  }

  const meshes = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const euler = new THREE.Euler();

  for (const [speciesId, list] of bySpecies) {
    const sp = SPECIES[speciesId];

    // Trunk.
    const trunkMat = ctx.materials.bark(sp.bark);
    const trunk = new THREE.InstancedMesh(trunkGeometry(), trunkMat, list.length);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    trunk.frustumCulled = true;

    // Canopy.
    const canopyMat = ctx.materials.foliage(sp.foliage);
    const canopy = new THREE.InstancedMesh(canopyGeometry(sp.shape), canopyMat, list.length);
    canopy.castShadow = true;
    canopy.receiveShadow = true;

    const trunkColour = new THREE.Color();
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const trunkH = t.height * (1 - sp.crown * 0.55);

      euler.set(t.lean, t.rotation, t.lean * 0.7);
      q.setFromEuler(euler);
      pos.set(t.x, t.y, t.z);
      scl.set(t.trunkRadius * 2, trunkH, t.trunkRadius * 2);
      m.compose(pos, q, scl);
      trunk.setMatrixAt(i, m);
      trunkColour.setHex(sp.bark === 'birch' ? 0xd8d2c4 : 0x6b5744);
      trunk.setColorAt(i, trunkColour);

      const crownH = t.height * sp.crown;
      const crownY = t.y + t.height - crownH * 0.5;
      pos.set(t.x, crownY, t.z);
      euler.set(0, t.rotation, 0);
      q.setFromEuler(euler);
      // Conical species are taller than wide; umbrella species the reverse.
      const wide = sp.shape === 'umbrella' ? 1.35 : sp.shape === 'columnar' ? 0.62 : 1;
      scl.set(t.spread * 2 * wide, crownH * (sp.shape === 'conical' ? 1.15 : 1), t.spread * 2 * wide);
      m.compose(pos, q, scl);
      canopy.setMatrixAt(i, m);
      canopy.setColorAt(i, t.colour);

      if (collide && t.trunkRadius > 0.12) {
        collide.cylinder(t.x, t.y, t.z, t.trunkRadius * 1.15, trunkH, 5);
      }
    }
    trunk.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
    if (trunk.instanceColor) trunk.instanceColor.needsUpdate = true;
    if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    trunk.computeBoundingSphere();
    canopy.computeBoundingSphere();

    group.add(trunk, canopy);
    meshes.push(trunk, canopy);
  }
  return meshes;
}

/**
 * Ground cover that follows the player.
 *
 * Grass only exists within a short radius, so rather than baking it per chunk
 * it lives in one instanced mesh that is re-scattered whenever the player
 * crosses a grid cell. Snapping to a grid is what stops it visibly reshuffling
 * as you walk.
 */
export class GroundCover {
  constructor(ctx, scene) {
    this.ctx = ctx;
    this.scene = scene;
    this.mesh = null;
    this.lastCell = null;
    this.cellSize = 12;
    this.capacity = 0;
  }

  ensure(capacity) {
    if (this.mesh && this.capacity >= capacity) return;
    this.dispose();
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    const crossed = mergeGeometries([geo, (() => {
      const g = new THREE.PlaneGeometry(1, 1);
      g.rotateY(Math.PI / 2);
      g.translate(0, 0.5, 0);
      return g;
    })()]);
    // Point the blade normals at the sky. They come out of the plane geometry
    // horizontal, which is true of the card and false of grass: a vertical
    // surface takes almost nothing from a sun overhead, so a lawn at midday
    // rendered as a field of black tufts. Facing them up is the usual trick -
    // it is what lets a flat card read as a curved blade catching the light.
    const nrm = crossed.getAttribute('normal');
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    nrm.needsUpdate = true;

    this.mesh = new THREE.InstancedMesh(crossed, this.ctx.materials.grass(), capacity);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.capacity = capacity;
    this.scene.add(this.mesh);
  }

  /** Re-scatter around the player if they have moved to a new cell. */
  update(px, pz, isGrassAt) {
    const g = this.ctx.settings.graphics;
    if (!g.grass || g.grassDistance <= 0) {
      if (this.mesh) this.mesh.count = 0;
      return;
    }
    const cx = Math.floor(px / this.cellSize);
    const cz = Math.floor(pz / this.cellSize);
    const key = `${cx},${cz}`;
    if (key === this.lastCell) return;
    this.lastCell = key;

    const radius = g.grassDistance;
    const spacing = lerp(1.4, 0.55, clamp(g.vegetationDensity / 2, 0, 1));
    const estimate = Math.min(24000, Math.ceil((Math.PI * radius * radius) / (spacing * spacing)));
    this.ensure(estimate);
    if (!this.mesh) return;

    const rng = makeRng(hashString(key));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const euler = new THREE.Euler();
    const colour = new THREE.Color();
    let n = 0;

    const originX = Math.floor((px - radius) / spacing) * spacing;
    const originZ = Math.floor((pz - radius) / spacing) * spacing;
    for (let z = originZ; z < pz + radius && n < estimate; z += spacing) {
      for (let x = originX; x < px + radius && n < estimate; x += spacing) {
        const dx = x - px, dz = z - pz;
        const d2 = dx * dx + dz * dz;
        if (d2 > radius * radius) continue;
        // Jitter deterministically from position, not from draw order, so a
        // blade stays put between updates.
        const jx = x + (fbm2(x * 3.1, z * 3.7, 1) * 0.5) * spacing;
        const jz = z + (fbm2(x * 2.3 + 91, z * 2.9 - 41, 1) * 0.5) * spacing;
        const info = isGrassAt(jx, jz);
        if (!info || !info.grass) continue;
        // Thin toward the edge of the radius so it fades rather than ends.
        if (d2 > (radius * 0.7) ** 2 && rng() < (Math.sqrt(d2) / radius - 0.7) * 3) continue;

        const h = 0.22 + rng() * 0.4 * info.lushness;
        pos.set(jx, info.y, jz);
        euler.set(0, rng() * Math.PI, 0);
        q.setFromEuler(euler);
        scl.set(0.3 + rng() * 0.24, h, 0.3 + rng() * 0.24);
        m.compose(pos, q, scl);
        this.mesh.setMatrixAt(n, m);
        // Blades stand up into the light, so they read brighter than the flat
        // ground they grow out of rather than the same shade.
        colour.copy(info.colour).multiplyScalar(1.35)
              .offsetHSL(0, rng() * 0.1 - 0.05, rng() * 0.1 - 0.04);
        this.mesh.setColorAt(n, colour);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh = null;
    this.capacity = 0;
    this.lastCell = null;
  }
}

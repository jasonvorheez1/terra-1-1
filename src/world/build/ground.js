// Terrain, land cover and water.
//
// Terrain is a heightfield sampled from the AWS terrain tiles and then graded
// to the roads crossing it, so streets sit in the landscape instead of slicing
// through it. Fine procedural texture follows the local biome by default;
// aerial imagery can optionally be composited per chunk and draped over it.
//
// Land-cover polygons (parks, forests, sand, car parks) are drawn as separate
// surfaces just above the terrain, ordered by the `z` in their spec so a
// football pitch lands on top of the park it sits in rather than fighting it
// for depth.

import * as THREE from 'three';
import { colourToLinear, shade, ensureClockwise, MeshAccumulator } from './mesh.js';
import { surfaceFamily } from '../../gfx/materials.js';
import { ribbonToRing, bounds, pointInRing } from '../geometry.js';
import { fetchCached, decodeImage } from '../../geo/net.js';
import { lonToTileX, latToTileY, tileXToLon, tileYToLat, zoomForResolution } from '../../geo/projection.js';
import { makeCanvas } from '../../gfx/textures.js';
import { clamp, lerp } from '../../core/util.js';
import { fbm2 } from '../../core/rng.js';
import { featureRng } from '../osm-tags.js';
import { parkingBayLayout } from '../road-layout.js';
import { box } from './props.js';
import { BIOMES } from '../../geo/nasa.js';

const IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

/** Base ground colour for a biome, modulated by how green the satellite says it is. */
export function biomeGroundColour(biome, ndviValue, season) {
  const v = clamp(ndviValue ?? 0.4, 0, 1);
  const palettes = {
    tropicalRainforest: [0x35502a, 0x2c4423],
    tropicalSeasonal:   [0x4e6330, 0x6b7238],
    savanna:            [0x8a7c45, 0x9c8c4e],
    desert:             [0xc4a878, 0xd0b78a],
    mediterranean:      [0x7c7a48, 0x8d854f],
    temperateBroadleaf: [0x4f6b36, 0x5c7840],
    temperateGrass:     [0x76803f, 0x868a4a],
    borealConifer:      [0x3f5433, 0x47603a],
    tundra:             [0x6d6f52, 0x7a7a5c],
    alpine:             [0x8a8676, 0x969183],
    polar:              [0xdfe7ec, 0xe8eef2],
  };
  const pair = palettes[biome.id] || palettes.temperateBroadleaf;
  const base = new THREE.Color(pair[0]).lerp(new THREE.Color(pair[1]), clamp(v * 1.4, 0, 1));
  // Winter drains the colour out of anywhere that has a winter.
  if (season != null && biome.id !== 'tropicalRainforest' && biome.id !== 'desert') {
    const winter = 1 - season;
    base.lerp(new THREE.Color(0x7d7462), winter * 0.45);
  }
  return base.getHex();
}

/**
 * Build the terrain mesh for one chunk.
 *
 * `sampleHeight(x, z)` must already include grading. A one-vertex skirt is
 * added around the edge and dropped, which hides the hairline crack that
 * otherwise shows between chunks built at different times.
 */
export function buildTerrain(chunk, ctx, opts = {}) {
  const { resolution = 33, skirtDepth = 6 } = opts;
  const { minX, minZ, size } = chunk;
  const n = resolution;
  const step = size / (n - 1);

  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const colors = new Float32Array(n * n * 3);
  const heights = new Float32Array(n * n);

  const season = ctx.season;
  let minY = Infinity, maxY = -Infinity;

  // The ground colour used to be computed from scratch at every vertex: an
  // NDVI lookup, a palette blend, four Color allocations and an sRGB
  // conversion, four thousand times a chunk. Almost none of that varies at
  // that scale - NDVI is 250 m data and the chunk is 256 m across, so the
  // question was being asked four thousand times and answered the same way,
  // and the biome and season do not vary within a chunk at all.
  //
  // Take the four corners instead and blend between them, in linear space, so
  // the loop does three lerps and no allocation. This was a third of the whole
  // terrain build.
  const corners = [[minX, minZ], [minX + size, minZ],
                   [minX, minZ + size], [minX + size, minZ + size]];
  const cnr = corners.map(([px, pz]) => {
    const geo = ctx.projection.toGeo(px, pz);
    // Already linear: see the note in colourToLinear.
    return new THREE.Color(biomeGroundColour(ctx.biome, ctx.ndviAt(geo.lat, geo.lon), season));
  });

  // How much is growing, as the satellite measured it, on its own grid.
  //
  // The colour above only needs the corners, but the vegetation weight decides
  // which ground you are standing on, so it is worth a little more shape than a
  // single gradient across the chunk. MODIS is 250 m data and a chunk is 256 m,
  // so VEG_GRID square samples is already finer than the source - past that we
  // would only be interpolating the same pixel more carefully.
  const VEG_GRID = 5;
  const veg = new Float32Array(VEG_GRID * VEG_GRID);
  for (let j = 0; j < VEG_GRID; j++) {
    for (let i = 0; i < VEG_GRID; i++) {
      const px = minX + (size * i) / (VEG_GRID - 1);
      const pz = minZ + (size * j) / (VEG_GRID - 1);
      const geo = ctx.projection.toGeo(px, pz);
      // Bare ground reads near zero and dense canopy near one, but the useful
      // range outdoors sits between; stretch it so the mix uses the whole span
      // rather than hugging one end.
      veg[j * VEG_GRID + i] = clamp((ctx.ndviAt(geo.lat, geo.lon) - 0.12) / 0.46, 0, 1);
    }
  }
  const vegAt = (u, v) => {
    const fx = clamp(u, 0, 1) * (VEG_GRID - 1), fz = clamp(v, 0, 1) * (VEG_GRID - 1);
    const i0 = Math.min(VEG_GRID - 2, Math.floor(fx)), j0 = Math.min(VEG_GRID - 2, Math.floor(fz));
    const tx = fx - i0, tz2 = fz - j0;
    const a = veg[j0 * VEG_GRID + i0], b = veg[j0 * VEG_GRID + i0 + 1];
    const c = veg[(j0 + 1) * VEG_GRID + i0], d = veg[(j0 + 1) * VEG_GRID + i0 + 1];
    return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz2;
  };
  const vegetation = new Float32Array(n * n);

  for (let j = 0; j < n; j++) {
    const tz = j / (n - 1);
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const x = minX + i * step;
      const z = minZ + j * step;
      const y = ctx.terrainAt(x, z);
      heights[idx] = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      uvs[idx * 2] = i / (n - 1);
      uvs[idx * 2 + 1] = 1 - tz;

      const tx = i / (n - 1);
      // A little coherent wander on top of the satellite reading, so the join
      // between bare and living ground is a ragged edge rather than a gradient.
      vegetation[idx] = clamp(vegAt(tx, tz) + fbm2(x * 0.021, z * 0.021, 2) * 0.22, 0, 1);
      // Bilinear across the corner colours, then a little coherent variation
      // so the surface is not one even wash. Multiplying in linear space is a
      // good enough stand-in for the old offsetHSL and costs nothing.
      const k = 1 + fbm2(x * 0.011, z * 0.011, 3) * 0.11;
      const r0 = cnr[0].r + (cnr[1].r - cnr[0].r) * tx, r1 = cnr[2].r + (cnr[3].r - cnr[2].r) * tx;
      const g0 = cnr[0].g + (cnr[1].g - cnr[0].g) * tx, g1 = cnr[2].g + (cnr[3].g - cnr[2].g) * tx;
      const b0 = cnr[0].b + (cnr[1].b - cnr[0].b) * tx, b1 = cnr[2].b + (cnr[3].b - cnr[2].b) * tx;
      colors[idx * 3] = (r0 + (r1 - r0) * tz) * k;
      colors[idx * 3 + 1] = (g0 + (g1 - g0) * tz) * k;
      colors[idx * 3 + 2] = (b0 + (b1 - b0) * tz) * k;
    }
  }

  // Normals from central differences on the height grid: cheaper and smoother
  // than accumulating face normals, and exact for a regular grid.
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const hl = heights[j * n + Math.max(0, i - 1)];
      const hr = heights[j * n + Math.min(n - 1, i + 1)];
      const hd = heights[Math.max(0, j - 1) * n + i];
      const hu = heights[Math.min(n - 1, j + 1) * n + i];
      const sx = (i === 0 || i === n - 1) ? step : step * 2;
      const sz = (j === 0 || j === n - 1) ? step : step * 2;
      const nx = (hl - hr) / sx;
      const nz = (hd - hu) / sz;
      const len = Math.sqrt(nx * nx + 1 + nz * nz);   // hypot is far slower here
      normals[idx * 3] = nx / len;
      normals[idx * 3 + 1] = 1 / len;
      normals[idx * 3 + 2] = nz / len;

      // Little grows on a cliff, whatever the satellite averaged over the
      // quarter kilometre around it. `1 / len` is the cosine of the slope, so
      // this is free here and would cost a second pass anywhere else.
      const flatness = 1 / len;
      if (flatness < 0.94) {
        vegetation[idx] *= clamp((flatness - 0.55) / 0.39, 0, 1);
      }
    }
  }

  const indices = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = j * n + i + 1;
      const c = (j + 1) * n + i, d = (j + 1) * n + i + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Read by the terrain material's shader patch to mix bare ground with
  // living ground; see terrain() in materials.js.
  geometry.setAttribute('aVeg', new THREE.BufferAttribute(vegetation, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  return { geometry, heights, resolution: n, step, minY, maxY };
}

/**
 * Add the terrain surface to the collision mesh.
 *
 * Collision does not need the render grid. A capsule feels the difference
 * between an 8 m and a 4 m heightfield hardly at all, but the triangle count
 * goes up fourfold and every one of them has to go into the chunk's BVH - at
 * the render resolution terrain alone was some sixty per cent of all the
 * collision geometry in the world. `stride` subsamples the heights that were
 * computed anyway, so the saving costs nothing to take.
 */
export function terrainCollision(collide, chunk, terrain, stride = 1) {
  const n = terrain.resolution;
  const s = Math.max(1, Math.min(stride, n - 1));
  const m = Math.floor((n - 1) / s) + 1;         // vertices along the coarse grid
  const step = terrain.step;
  const { minX, minZ } = chunk;
  const base = collide.count;
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const si = Math.min(i * s, n - 1), sj = Math.min(j * s, n - 1);
      collide.vertex(minX + si * step, terrain.heights[sj * n + si], minZ + sj * step);
    }
  }
  for (let j = 0; j < m - 1; j++) {
    for (let i = 0; i < m - 1; i++) {
      const a = base + j * m + i, b = base + j * m + i + 1;
      const c = base + (j + 1) * m + i, d = base + (j + 1) * m + i + 1;
      collide.tri(a, c, b);
      collide.tri(b, c, d);
    }
  }
}

/**
 * Composite aerial imagery covering a chunk into one texture.
 *
 * Esri's World Imagery is served as standard slippy tiles with permissive CORS,
 * so a chunk's worth is a handful of fetches, drawn into a canvas at the exact
 * offset the chunk occupies within them.
 */
export async function fetchChunkImagery(chunk, projection, targetPx = 512) {
  const bbox = projection.localRectToBBox(
    chunk.minX, chunk.minZ, chunk.minX + chunk.size, chunk.minZ + chunk.size);
  const midLat = (bbox.north + bbox.south) / 2;
  const mpp = chunk.size / targetPx;
  const z = clamp(zoomForResolution(midLat, mpp, 10, 19), 10, 19);

  const x0f = lonToTileX(bbox.west, z), x1f = lonToTileX(bbox.east, z);
  const y0f = latToTileY(bbox.north, z), y1f = latToTileY(bbox.south, z);
  const x0 = Math.floor(x0f), x1 = Math.floor(x1f);
  const y0 = Math.floor(y0f), y1 = Math.floor(y1f);
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
  if (cols * rows > 36) return null;                 // guard against a bad bbox

  const TILE = 256;
  const { canvas, ctx } = makeCanvas(cols * TILE, rows * TILE);
  ctx.fillStyle = '#6b6b60';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let loaded = 0;
  await Promise.all(Array.from({ length: cols * rows }, async (_, k) => {
    const tx = x0 + (k % cols), ty = y0 + Math.floor(k / cols);
    try {
      const buf = await fetchCached(`${IMAGERY_URL}/${z}/${ty}/${tx}`, {
        as: 'arrayBuffer',
        maxAgeMs: 1000 * 60 * 60 * 24 * 120,
        retries: 1,
        timeoutMs: 12000,
      });
      const img = await decodeImage(buf, 'image/jpeg');
      ctx.drawImage(img, (tx - x0) * TILE, (ty - y0) * TILE, TILE, TILE);
      if (img.close) img.close();
      loaded++;
    } catch (e) { /* a missing tile just leaves the fallback colour */ }
  }));
  if (!loaded) return null;

  // Crop to exactly the chunk, so UV 0..1 lines up with the mesh.
  const cropX = (x0f - x0) * TILE;
  const cropY = (y0f - y0) * TILE;
  const cropW = (x1f - x0f) * TILE;
  const cropH = (y1f - y0f) * TILE;
  const { canvas: out, ctx: outCtx } = makeCanvas(targetPx, targetPx);
  outCtx.drawImage(canvas, cropX, cropY, Math.max(1, cropW), Math.max(1, cropH), 0, 0, targetPx, targetPx);

  const tex = new THREE.CanvasTexture(out);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Land-cover polygons, drawn just above the terrain and sorted so overlapping
 * covers stack in a sensible order.
 */
export function buildLandcover(list, ctx, multi, collide) {
  const sorted = list.slice().sort((a, b) => (a.spec.z - b.spec.z) || (b.area - a.area));
  for (const lc of sorted) {
    try {
      const spec = lc.spec;
      if (spec.physical === false) continue;                 // zoning, not pavement
      if (spec.cover === 'water') continue;                 // handled separately
      const family = surfaceFamily(spec.surface ? spec.surface.id : 'grass');
      const acc = multi.for(`surface:${family}`, ctx.materials.surface(family));
      let hex = spec.tint;
      // Green cover follows the satellite: a parched park is a parched park.
      if (spec.veg > 0.1) {
        const c = ctx.centroidGeo(lc.ring);
        const v = ctx.ndviAt(c.lat, c.lon);
        const col = new THREE.Color(hex);
        col.lerp(new THREE.Color(0x8b8256), clamp(1 - v * 1.9, 0, 0.7));
        if (ctx.season != null) col.lerp(new THREE.Color(0x7a7360), (1 - ctx.season) * 0.35);
        hex = col.getHex();
      }
      const colour = colourToLinear(hex);
      // Stack by z so a pitch sits on its park rather than z-fighting it.
      const lift = 0.02 + spec.z * 0.012;
      // Green cover gets a slow wander across its own extent. The texture can
      // only repeat, so a big lawn is otherwise one flat green no matter how
      // large, and the tile seam is the only cue that it has any size at all.
      // Traced parks carry plenty of nodes, which is what this has to work
      // with - it varies between the ring's own vertices, not within a triangle.
      const vary = spec.veg > 0.1
        ? (x, z, r, g, b) => {
            const k = 0.86 + fbm2(x * 0.018, z * 0.018, 3) * 0.30;
            return [r * k, g * (k * 0.99 + 0.01), b * (k * 0.94 + 0.03)];
          }
        : null;
      acc.addPolygon(ensureClockwise(lc.ring), lc.holes.map(ensureClockwise), 0, colour, {
        uvScale: 0.16,
        heightFn: (x, z) => ctx.terrainAt(x, z) + lift,
        colourFn: vary,
        // Follow the ground to within 25 cm. Measured over Central Park, that
        // takes the gap between the grass you see and the ground you stand on
        // from 1.34 m to 0.10 m, and the share of it more than a metre out from
        // 48% to none, for 1.7x the land-cover triangles. Tightening to 15 cm
        // costs a third again and buys almost nothing.
        drape: { tolerance: 0.25, minEdge: 3, maxEdge: 64 },
      });
      if (spec.key === 'amenity=parking' && ctx.detail !== 'low') {
        buildParkingMarkings(lc, ctx, multi, lift + 0.018, collide);
      }
    } catch (e) {
      if (ctx.onError) ctx.onError('landcover', lc.source, e);
    }
  }
}

/** Procedural bay separators for mapped and inferred surface car parks. */
export function buildParkingMarkings(lc, ctx, multi, lift = 0.1, collide = null) {
  const bays = parkingBayLayout(lc);
  if (!bays.length) return 0;
  const whole = lc.__parent || lc;
  const acc = multi.for('markings:parking-bays', ctx.materials.markings('lane-solid'));
  const carAcc = multi.for('solid', ctx.materials.solid({ roughness: 0.76 }));
  let count = 0;
  let cars = 0;
  const maxCars = ctx.detail === 'high' ? 42 : 18;
  const propDensity = ctx.settings?.graphics?.propDensity ?? 1;
  const occupancy = clamp(0.22 * propDensity, 0.04, 0.48);

  for (const bay of bays) {
      const { ax, az, bx, bz, ux, uz } = bay;
      const y0 = ctx.terrainAt(ax, az) + lift;
      const y1 = ctx.terrainAt(bx, bz) + lift;
      const hw = 0.055;
      acc.addQuad(
        [ax - ux * hw, y0, az - uz * hw],
        [bx - ux * hw, y1, bz - uz * hw],
        [bx + ux * hw, y1, bz + uz * hw],
        [ax + ux * hw, y0, az + uz * hw],
        [0, 0, 1, 1], [1, 1, 1]);
      count++;

      // A deterministic fraction of bays is occupied. Empty asphalt with
      // perfect paint reads like an abandoned test map; a few simple vehicle
      // silhouettes restore scale and the actual use of the site without
      // pretending to know an exact live car inventory.
      if (cars >= maxCars) continue;
      const rng = featureRng('parked-car', `${whole.id}:${bay.rowIndex}:${bay.bayIndex}`);
      if (rng() >= occupancy) continue;
      // World-local (0, 0) is the arrival point. A synthetic or incompletely
      // mapped car park can legitimately cover it, but spawning a parked car
      // against the player's camera/capsule makes the first frame look huge
      // and can trap movement before the world has even finished streaming.
      // Spawn selection may shift the capsule to nearby clear ground or a
      // pavement, so reserve a wider arrival bubble than the exact origin.
      if (Math.hypot(bay.car.x, bay.car.z) < 22) continue;
      addParkedCar(
        carAcc, collide, ctx,
        bay.car.x, bay.car.z, bay.car.dx, bay.car.dz, rng,
      );
      cars++;
  }
  return count;
}

const CAR_COLOURS = [
  0xe2e1dc, 0xb9bdc0, 0x30343a, 0x666b70, 0x8f2f2b, 0x234b70,
  0x56705a, 0xb9a36a,
];

function addParkedCar(acc, collide, ctx, x, z, dx, dz, rng) {
  const angle = Math.atan2(dz, dx);
  const y = ctx.terrainAt(x, z) + 0.105;
  const length = rng.range(3.8, 4.8);
  const width = rng.range(1.68, 1.92);
  const colour = colourToLinear(rng.pick(CAR_COLOURS));
  const dark = colourToLinear(0x252b31);
  const tyre = colourToLinear(0x17191b);
  box(acc, x, y + 0.28, z, length, 0.48, width, colour, angle);
  box(acc, x - dx * 0.18, y + 0.68, z - dz * 0.18,
      length * 0.48, 0.56, width * 0.82, shade(colour, 1.04), angle);
  // Dark glass band and two understated wheel/tyre axles are enough to stop
  // the silhouette reading as a coloured crate at walking distance.
  box(acc, x - dx * 0.12, y + 0.7, z - dz * 0.12,
      length * 0.34, 0.38, width * 0.86, dark, angle);
  for (const along of [-length * 0.3, length * 0.3]) {
    box(acc, x + dx * along, y + 0.16, z + dz * along,
        0.24, 0.32, width + 0.06, tyre, angle);
  }
  if (collide) collide.rotatedBox(x, y + 0.45, z, length, 0.9, width, angle);
}

/**
 * Water surfaces. The bed is pushed below the surface so shallow edges read as
 * shallow, and the surface itself is not solid - you wade in.
 */
export function buildWater(list, waterways, ctx, group, collide) {
  const material = ctx.materials.water();
  const surfaces = [];
  for (const w of list) {
    try {
      // Water finds its level: the lowest ground it covers. Taking only the
      // edge is not enough once the terrain carries sub-sample relief - the
      // middle of a lake can then sit above its own lowest shore, and the bed
      // surfaces as an island. Sample the inside as well and take the true
      // minimum, so the bed is under the water everywhere.
      let level = Infinity;
      const ring = ensureClockwise(w.ring);
      const stride = Math.max(1, Math.floor(ring.length / 32));
      for (let i = 0; i < ring.length; i += stride) {
        level = Math.min(level, ctx.terrainAt(ring[i][0], ring[i][1]));
      }
      const bb = bounds(ring);
      for (let iy = 1; iy < 6; iy++) {
        for (let ix = 1; ix < 6; ix++) {
          const px = bb.minX + ((bb.maxX - bb.minX) * ix) / 6;
          const pz = bb.minZ + ((bb.maxZ - bb.minZ) * iy) / 6;
          if (!pointInRing(ring, px, pz)) continue;
          level = Math.min(level, ctx.terrainAt(px, pz));
        }
      }
      if (!isFinite(level)) continue;
      surfaces.push({ ring, holes: w.holes.map(ensureClockwise), level: level + 0.08, name: w.name });
    } catch (e) { /* skip a malformed lake */ }
  }

  for (const ww of waterways || []) {
    if (ww.tunnel) continue;
    try {
      const ring = ensureClockwise(ribbonToRing(ww.pts, ww.width));
      let level = Infinity;
      for (const p of ww.pts) level = Math.min(level, ctx.terrainAt(p[0], p[1]));
      if (!isFinite(level)) continue;
      surfaces.push({ ring, holes: [], level: level + 0.06, name: ww.name });
    } catch (e) { /* skip */ }
  }

  if (!surfaces.length) return null;

  const mesh = new MeshAccumulator(true, true);
  const colour = colourToLinear(0xffffff);
  for (const s of surfaces) {
    mesh.addPolygon(s.ring, s.holes, s.level, colour, { uvScale: 0.06 });
  }
  if (mesh.isEmpty) return null;
  const m = new THREE.Mesh(mesh.toGeometry(), material);
  m.receiveShadow = true;
  m.castShadow = false;
  m.matrixAutoUpdate = false;
  m.name = 'water';
  m.userData.waterSurfaces = surfaces;
  group.add(m);
  return m;
}

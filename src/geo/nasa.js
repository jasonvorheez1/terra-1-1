// NASA Earthdata GIBS: satellite-measured vegetation vigour.
//
//   https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{date}/
//          GoogleMapsCompatible_Level9/{z}/{y}/{x}.png
//
// We read MODIS Terra 16-day NDVI and invert the published GIBS colour map back
// into an NDVI value (data/ndvi-lut.js). NDVI drives how densely the world is
// planted, how green the foliage and ground cover read, and which biome the
// procedural species palette comes from, so a walk through Helsinki in February
// and one through the Amazon differ because of measurements, not guesswork.

import { fetchCached, decodeImageData } from './net.js';
import { lonToTileX, latToTileY } from './projection.js';
import { clamp, lerp, DEG } from '../core/util.js';
import { NDVI_LUT } from '../../data/ndvi-lut.js';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const NDVI_LAYER = 'MODIS_Terra_L3_NDVI_16Day';
const NDVI_MATRIX = 'GoogleMapsCompatible_Level9';
const NDVI_MAX_Z = 8;               // Level9 covers zoom levels 0..8
const TILE_PX = 256;

// Coarse RGB-cube index over the LUT so inversion is a small local search.
const LUT_N = NDVI_LUT.length / 4;
const bucketIndex = new Map();
for (let i = 0; i < LUT_N; i++) {
  const r = NDVI_LUT[i * 4], g = NDVI_LUT[i * 4 + 1], b = NDVI_LUT[i * 4 + 2];
  const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
  if (!bucketIndex.has(k)) bucketIndex.set(k, []);
  bucketIndex.get(k).push(i);
}

/** Invert a GIBS NDVI palette colour back to an NDVI value, or null for no-data. */
export function colourToNdvi(r, g, b, a) {
  if (a < 128) return null;                       // transparent: water / cloud / no data
  let best = -1, bestD = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dg = -1; dg <= 1; dg++) {
      for (let db = -1; db <= 1; db++) {
        const rb = (r >> 4) + dr, gb = (g >> 4) + dg, bb = (b >> 4) + db;
        if (rb < 0 || rb > 15 || gb < 0 || gb > 15 || bb < 0 || bb > 15) continue;
        const list = bucketIndex.get((rb << 8) | (gb << 4) | bb);
        if (!list) continue;
        for (let li = 0; li < list.length; li++) {
          const i = list[li];
          const dR = r - NDVI_LUT[i * 4];
          const dG = g - NDVI_LUT[i * 4 + 1];
          const dB = b - NDVI_LUT[i * 4 + 2];
          const d = dR * dR + dG * dG + dB * dB;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
  }
  if (best < 0 || bestD > 3600) return null;      // over ~60 units away: not a palette colour
  return NDVI_LUT[best * 4 + 3];
}

/** Snap a date to the MODIS 16-day compositing grid (periods start on Jan 1). */
export function snapToNdviPeriod(date) {
  const y = date.getUTCFullYear();
  const jan1 = Date.UTC(y, 0, 1);
  const dayOfYear = Math.floor((Date.UTC(y, date.getUTCMonth(), date.getUTCDate()) - jan1) / 86400000);
  const period = Math.floor(dayOfYear / 16) * 16;
  let d = new Date(jan1 + period * 86400000);
  // Composites lag acquisition by a few weeks; step back rather than 404.
  let guard = 0;
  while ((Date.now() - d.getTime()) / 86400000 < 30 && guard++ < 40) {
    d = new Date(d.getTime() - 16 * 86400000);
  }
  return d.toISOString().slice(0, 10);
}

export class VegetationIndexService {
  constructor() {
    this.tiles = new Map();     // "z/x/y/date" -> Float32Array or null
    this.pending = new Map();
    this.enabled = true;
    this.zoom = 8;
    this.date = snapToNdviPeriod(new Date());
    this.defaultNdvi = 0.42;
    this.available = false;     // flips true once a tile decodes successfully
  }

  configure({ enabled = true, date = null, zoom = 8 } = {}) {
    this.enabled = enabled;
    this.zoom = clamp(zoom, 3, NDVI_MAX_Z);
    if (date) this.date = snapToNdviPeriod(date instanceof Date ? date : new Date(date));
  }

  key(z, x, y) { return `${z}/${x}/${y}/${this.date}`; }

  async loadTile(z, x, y) {
    const k = this.key(z, x, y);
    if (this.tiles.has(k)) return this.tiles.get(k);
    if (this.pending.has(k)) return this.pending.get(k);
    const n = Math.pow(2, z);
    if (x < 0 || y < 0 || x >= n || y >= n) return null;

    const p = (async () => {
      try {
        const url = `${GIBS}/${NDVI_LAYER}/default/${this.date}/${NDVI_MATRIX}/${z}/${y}/${x}.png`;
        const buf = await fetchCached(url, {
          as: 'arrayBuffer',
          maxAgeMs: 1000 * 60 * 60 * 24 * 365,
          retries: 1,
          timeoutMs: 15000,
        });
        const img = await decodeImageData(buf, 'image/png');
        const d = img.data;
        const grid = new Float32Array(TILE_PX * TILE_PX);
        const sw = img.width, sh = img.height;
        for (let py = 0; py < TILE_PX; py++) {
          const sy = Math.min(sh - 1, Math.round((py / TILE_PX) * sh));
          for (let px = 0; px < TILE_PX; px++) {
            const sx = Math.min(sw - 1, Math.round((px / TILE_PX) * sw));
            const i = (sy * sw + sx) * 4;
            const v = colourToNdvi(d[i], d[i + 1], d[i + 2], d[i + 3]);
            grid[py * TILE_PX + px] = v === null ? -2 : v;   // -2 marks no-data
          }
        }
        this.tiles.set(k, grid);
        this.available = true;
        if (this.tiles.size > 48) {
          const drop = this.tiles.size - 32;
          let i = 0;
          for (const key of this.tiles.keys()) { if (i++ >= drop) break; this.tiles.delete(key); }
        }
        return grid;
      } catch (e) {
        this.tiles.set(k, null);
        return null;
      } finally { this.pending.delete(k); }
    })();
    this.pending.set(k, p);
    return p;
  }

  /** Load the tiles covering a bbox so `sample` can answer synchronously. */
  async preload(bbox) {
    if (!this.enabled) return;
    const z = this.zoom;
    const x0 = Math.floor(lonToTileX(bbox.west, z)), x1 = Math.floor(lonToTileX(bbox.east, z));
    const y0 = Math.floor(latToTileY(bbox.north, z)), y1 = Math.floor(latToTileY(bbox.south, z));
    const jobs = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) jobs.push(this.loadTile(z, x, y));
    await Promise.all(jobs);
  }

  /**
   * NDVI at a point, roughly [0, 1]. Falls back to `defaultNdvi` where the
   * satellite reported no data (open water, permanent cloud, polar night).
   */
  sample(lat, lon) {
    if (!this.enabled) return this.defaultNdvi;
    const z = this.zoom;
    const fx = lonToTileX(lon, z), fy = latToTileY(lat, z);
    const grid = this.tiles.get(this.key(z, Math.floor(fx), Math.floor(fy)));
    if (!grid) return this.defaultNdvi;
    const px = clamp((fx - Math.floor(fx)) * TILE_PX, 0, TILE_PX - 1.001);
    const py = clamp((fy - Math.floor(fy)) * TILE_PX, 0, TILE_PX - 1.001);
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const x1 = Math.min(x0 + 1, TILE_PX - 1), y1 = Math.min(y0 + 1, TILE_PX - 1);
    const q0 = grid[y0 * TILE_PX + x0], q1 = grid[y0 * TILE_PX + x1];
    const q2 = grid[y1 * TILE_PX + x0], q3 = grid[y1 * TILE_PX + x1];
    const fxr = px - x0, fyr = py - y0;
    const w0 = (1 - fxr) * (1 - fyr), w1 = fxr * (1 - fyr);
    const w2 = (1 - fxr) * fyr, w3 = fxr * fyr;
    // Bilinear over valid samples only, so one no-data pixel cannot drag a coast dark.
    let sum = 0, wsum = 0;
    if (q0 > -1) { sum += q0 * w0; wsum += w0; }
    if (q1 > -1) { sum += q1 * w1; wsum += w1; }
    if (q2 > -1) { sum += q2 * w2; wsum += w2; }
    if (q3 > -1) { sum += q3 * w3; wsum += w3; }
    if (wsum < 0.05) return this.defaultNdvi;
    return sum / wsum;
  }
}

export const ndvi = new VegetationIndexService();

// --- Biome classification --------------------------------------------------
//
// A light Koppen-flavoured classifier: latitude sets the thermal band,
// elevation lifts it toward alpine, and the NASA NDVI reading decides how
// productive the site actually is. Enough to pick believable species palettes
// and ground-cover colours anywhere on Earth.

export const BIOMES = {
  tropicalRainforest: { id: 'tropicalRainforest', label: 'Tropical rainforest' },
  tropicalSeasonal:   { id: 'tropicalSeasonal',   label: 'Tropical seasonal forest' },
  savanna:            { id: 'savanna',            label: 'Savanna' },
  desert:             { id: 'desert',             label: 'Desert' },
  mediterranean:      { id: 'mediterranean',      label: 'Mediterranean' },
  temperateBroadleaf: { id: 'temperateBroadleaf', label: 'Temperate broadleaf forest' },
  temperateGrass:     { id: 'temperateGrass',     label: 'Temperate grassland' },
  borealConifer:      { id: 'borealConifer',      label: 'Boreal conifer forest' },
  tundra:             { id: 'tundra',             label: 'Tundra' },
  alpine:             { id: 'alpine',             label: 'Alpine' },
  polar:              { id: 'polar',              label: 'Polar desert' },
};

/**
 * Altitude of the treeline in metres at a given latitude.
 * A cosine falloff fits the real world far better than a linear one: it gives
 * ~4100 m in the tropics, ~2100 m in the Alps, ~1200 m in southern Norway and
 * ~700 m in Lapland, all within a couple of hundred metres of observed values.
 */
export function treelineAltitude(lat) {
  const c = Math.max(0, Math.cos(clamp(Math.abs(lat), 0, 90) * DEG));
  return clamp(4100 * Math.pow(c, 1.8), 0, 4300);
}

/** Classify a site from latitude, elevation and measured NDVI. */
export function classifyBiome(lat, elevationM, ndviValue) {
  const a = Math.abs(lat);
  const v = ndviValue == null ? 0.4 : ndviValue;
  const treeline = treelineAltitude(lat);
  // Above the treeline is alpine; a further ~1 km up is the nival zone.
  if (elevationM > treeline + 1000) return BIOMES.polar;
  if (elevationM > treeline) return BIOMES.alpine;

  if (a > 66) return v > 0.25 ? BIOMES.tundra : BIOMES.polar;
  if (a > 55) return v > 0.35 ? BIOMES.borealConifer : BIOMES.tundra;
  if (a > 38) {
    if (v < 0.16) return BIOMES.desert;
    if (v < 0.34) return BIOMES.temperateGrass;
    return BIOMES.temperateBroadleaf;
  }
  if (a > 28) {
    if (v < 0.14) return BIOMES.desert;
    if (v < 0.32) return BIOMES.mediterranean;
    return BIOMES.temperateBroadleaf;
  }
  if (a > 15) {
    if (v < 0.15) return BIOMES.desert;
    if (v < 0.40) return BIOMES.savanna;
    return BIOMES.tropicalSeasonal;
  }
  if (v < 0.16) return BIOMES.desert;
  if (v < 0.38) return BIOMES.savanna;
  if (v < 0.62) return BIOMES.tropicalSeasonal;
  return BIOMES.tropicalRainforest;
}

/**
 * Seasonal phase for a date at a latitude: 0 = deep winter, 1 = peak summer.
 * Hemispheres are offset by half a year; the tropics barely swing at all.
 */
export function seasonalPhase(date, lat) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - start) / 86400000;
  const north = 0.5 - 0.5 * Math.cos(((doy - 15) / 365.25) * Math.PI * 2);
  const phase = lat >= 0 ? north : 1 - north;
  const tropicality = clamp((25 - Math.abs(lat)) / 25, 0, 1);
  return lerp(phase, 0.78, tropicality * 0.85);
}

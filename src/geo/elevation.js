// Terrain elevation from the AWS "Terrain Tiles" open dataset (Mapzen terrarium).
//
//   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//
// Terrarium packs metres into RGB:  h = (R * 256 + G + B / 256) - 32768
// Underlying sources are SRTM/NED/etc, so real resolution tops out around 10-30 m;
// we sample bilinearly and add a little coherent noise for sub-tile relief.

import { fetchCached, decodeImageData } from './net.js';
import {
  lonToTileX, latToTileY, tileXToLon, tileYToLat, zoomForResolution, tileRange,
} from './projection.js';
import { fbm2 } from '../core/rng.js';
import { clamp } from '../core/util.js';

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_PX = 256;

/** Decoded terrarium tile: a Float32Array height grid plus its geographic extent. */
class HeightTile {
  constructor(z, x, y, heights) {
    this.z = z; this.x = x; this.y = y;
    this.heights = heights;          // (TILE_PX + 0)^2 samples, row-major
    this.west = tileXToLon(x, z);
    this.east = tileXToLon(x + 1, z);
    this.north = tileYToLat(y, z);
    this.south = tileYToLat(y + 1, z);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
    this.min = mn; this.max = mx;
  }

  /** Bilinear sample from fractional pixel coordinates. */
  sampleFrac(px, py) {
    const h = this.heights;
    const x0 = clamp(Math.floor(px), 0, TILE_PX - 1);
    const y0 = clamp(Math.floor(py), 0, TILE_PX - 1);
    const x1 = Math.min(x0 + 1, TILE_PX - 1);
    const y1 = Math.min(y0 + 1, TILE_PX - 1);
    const fx = clamp(px - x0, 0, 1), fy = clamp(py - y0, 0, 1);
    const h00 = h[y0 * TILE_PX + x0], h10 = h[y0 * TILE_PX + x1];
    const h01 = h[y1 * TILE_PX + x0], h11 = h[y1 * TILE_PX + x1];
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }
}

export class ElevationService {
  constructor() {
    this.tiles = new Map();          // "z/x/y" -> HeightTile
    this.pending = new Map();        // "z/x/y" -> Promise
    this.failed = new Set();
    this.zoom = 13;
    this.microRelief = 1;            // multiplier on the relief scales below
    this.enabled = true;
    this.seaLevelFallback = 0;
  }

  /** Choose a zoom giving roughly `targetMpp` metres per sample at this latitude. */
  configure(lat, { targetMpp = 12, microRelief = 1, enabled = true } = {}) {
    this.zoom = clamp(zoomForResolution(lat, targetMpp, 6, 15), 6, 15);
    this.microRelief = microRelief;
    this.enabled = enabled;
    return this.zoom;
  }

  key(z, x, y) { return `${z}/${x}/${y}`; }

  async loadTile(z, x, y) {
    const k = this.key(z, x, y);
    if (this.tiles.has(k)) return this.tiles.get(k);
    if (this.failed.has(k)) return null;
    if (this.pending.has(k)) return this.pending.get(k);

    const n = Math.pow(2, z);
    if (x < 0 || y < 0 || x >= n || y >= n) return null;

    const p = (async () => {
      try {
        const buf = await fetchCached(`${TERRARIUM_URL}/${z}/${x}/${y}.png`, {
          as: 'arrayBuffer',
          maxAgeMs: 1000 * 60 * 60 * 24 * 180,
          retries: 2,
          timeoutMs: 15000,
        });
        const img = await decodeImageData(buf, 'image/png');
        const d = img.data;
        const heights = new Float32Array(TILE_PX * TILE_PX);
        // Guard against a source tile that is not 256px.
        const sw = img.width, sh = img.height;
        for (let py = 0; py < TILE_PX; py++) {
          const sy = Math.min(sh - 1, Math.round((py / TILE_PX) * sh));
          for (let px = 0; px < TILE_PX; px++) {
            const sx = Math.min(sw - 1, Math.round((px / TILE_PX) * sw));
            const i = (sy * sw + sx) * 4;
            heights[py * TILE_PX + px] = d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768;
          }
        }
        const tile = new HeightTile(z, x, y, heights);
        this.tiles.set(k, tile);
        // Bound memory: terrain tiles are 256 KB each.
        if (this.tiles.size > 160) {
          const drop = this.tiles.size - 120;
          let i = 0;
          for (const key of this.tiles.keys()) { if (i++ >= drop) break; this.tiles.delete(key); }
        }
        return tile;
      } catch (e) {
        this.failed.add(k);
        return null;
      } finally {
        this.pending.delete(k);
      }
    })();
    this.pending.set(k, p);
    return p;
  }

  /** Preload every tile covering a bbox. Resolves once all attempts settle. */
  async preload(bbox, onProgress) {
    if (!this.enabled) return;
    const r = tileRange(bbox, this.zoom);
    const jobs = [];
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) jobs.push([x, y]);
    }
    let done = 0;
    await Promise.all(jobs.map(async ([x, y]) => {
      await this.loadTile(this.zoom, x, y);
      done++;
      if (onProgress) onProgress(done / jobs.length);
    }));
  }

  /**
   * Elevation in metres at a geographic point, synchronous against loaded tiles.
   * Returns `fallback` when the covering tile is not resident yet.
   */
  sample(lat, lon, fallback = null) {
    if (!this.enabled) return this.seaLevelFallback;
    const z = this.zoom;
    const fx = lonToTileX(lon, z), fy = latToTileY(lat, z);
    let tx = Math.floor(fx), ty = Math.floor(fy);
    let tile = this.tiles.get(this.key(z, tx, ty));
    if (!tile) {
      // Fall back to any coarser resident tile so terrain degrades rather than pops.
      for (let dz = 1; dz <= 6 && !tile; dz++) {
        const z2 = z - dz;
        if (z2 < 1) break;
        const x2 = Math.floor(lonToTileX(lon, z2)), y2 = Math.floor(latToTileY(lat, z2));
        tile = this.tiles.get(this.key(z2, x2, y2));
        if (tile) {
          const px = (lonToTileX(lon, z2) - x2) * TILE_PX;
          const py = (latToTileY(lat, z2) - y2) * TILE_PX;
          return tile.sampleFrac(px, py) + this.relief(lat, lon);
        }
      }
      return fallback === null ? this.seaLevelFallback : fallback;
    }
    const px = (fx - tx) * TILE_PX;
    const py = (fy - ty) * TILE_PX;
    return tile.sampleFrac(px, py) + this.relief(lat, lon);
  }

  /**
   * Sub-sample coherent relief, so flat SRTM cells do not read as billiard
   * tables and a hillside is not one smooth ramp.
   *
   * The sources are 10-30 m data. Everything finer than that has already been
   * averaged away before we ever see it, which is why open ground arrives
   * looking pressed flat. This puts some of it back at three scales: broad
   * swells you walk over without quite noticing, the undulation that makes a
   * field read as ground rather than a plane, and roughness you only see
   * underfoot.
   *
   * Indexed in metres rather than degrees. A degree of longitude is a good deal
   * shorter than a degree of latitude away from the equator, so noise taken
   * straight off lat/lon comes out visibly stretched east to west.
   */
  relief(lat, lon) {
    if (this.microRelief <= 0) return 0;
    const mx = lon * 111320 * Math.cos(lat * Math.PI / 180);
    const my = lat * 110570;
    // Every terrain vertex goes through here - four thousand of them per chunk
    // - so the octave count is the budget. Three on the broad scale where the
    // shape actually reads, one each on the two finer ones, where extra
    // octaves would be sub-metre detail nobody sees.
    return (fbm2(mx / 260, my / 260, 3, 2.1, 0.5, 991) * 1.35
          + fbm2(mx / 62, my / 62, 1, 2.0, 0.5, 401) * 0.42
          + fbm2(mx / 16, my / 16, 1, 2.0, 0.5, 77) * 0.13) * this.microRelief;
  }

  /** True once at least one tile covering the point is resident. */
  isLoadedAt(lat, lon) {
    if (!this.enabled) return true;
    const z = this.zoom;
    return this.tiles.has(this.key(z, Math.floor(lonToTileX(lon, z)), Math.floor(latToTileY(lat, z))));
  }

  /** Height range across a bbox, for camera framing and water level guesses. */
  rangeIn(bbox) {
    const r = tileRange(bbox, this.zoom);
    let mn = Infinity, mx = -Infinity, found = false;
    for (let y = r.y0; y <= r.y1; y++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const t = this.tiles.get(this.key(this.zoom, x, y));
        if (!t) continue;
        found = true;
        mn = Math.min(mn, t.min); mx = Math.max(mx, t.max);
      }
    }
    return found ? { min: mn, max: mx } : { min: 0, max: 0 };
  }
}

export const elevation = new ElevationService();

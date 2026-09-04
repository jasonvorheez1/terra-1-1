// Building coverage from Overture Maps.
//
// Live OpenStreetMap remains the primary map. Overture's monthly buildings
// release is used as a gap-filler: its conflated tiles contain OSM, community,
// authoritative and machine-learned roofprints, with OSM explicitly given the
// highest priority. The merge in world/features.js keeps the live OSM geometry
// and only admits footprints which came from another source.
//
// The official PMTiles archive is immutable and addressed with HTTP range
// requests, so a browser can read the handful of z14 tiles around the player
// without downloading the planet-sized archive.

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { fetchCached } from './net.js';
import { tileRange } from './projection.js';

export const OVERTURE_RELEASE = '2026-08-19.0';
export const OVERTURE_BUILDINGS_URL =
  `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${OVERTURE_RELEASE}/buildings.pmtiles`;
export const OVERTURE_BUILDING_ZOOM = 14;

const CACHE_AGE = 1000 * 60 * 60 * 24 * 365;

/** PMTiles byte source backed by the same IndexedDB cache as the other maps. */
class CachedRangeSource {
  constructor(url) { this.url = url; }
  getKey() { return this.url; }

  async getBytes(offset, length, signal = null) {
    const data = await fetchCached(this.url, {
      as: 'arrayBuffer',
      cacheKey: `overture:${OVERTURE_RELEASE}:range:${offset}:${length}`,
      maxAgeMs: CACHE_AGE,
      retries: 2,
      timeoutMs: 30000,
      signal,
      init: { headers: { Range: `bytes=${offset}-${offset + length - 1}` } },
    });
    return { data };
  }
}

/** Tile coordinates intersecting a WGS84 bbox. Exported for deterministic tests. */
export function tilesForBBox(bbox, z = OVERTURE_BUILDING_ZOOM) {
  const r = tileRange(bbox, z);
  const out = [];
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) out.push({ z, x, y });
  }
  return out;
}

function coordinateBounds(ring) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const p of ring) {
    if (p[0] < west) west = p[0];
    if (p[0] > east) east = p[0];
    if (p[1] < south) south = p[1];
    if (p[1] > north) north = p[1];
  }
  return { west, south, east, north };
}

function degreeArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(sum / 2);
}

function intersects(a, b) {
  return a.east >= b.west && a.west <= b.east &&
         a.north >= b.south && a.south <= b.north;
}

function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

/** Decode the building layer of one MVT tile into WGS84 polygon records. */
export function decodeBuildingTile(data, x, y, z) {
  if (!data || !data.byteLength) return [];
  const tile = new VectorTile(new PbfReader(new Uint8Array(data)));
  const layer = tile.layers.building;
  if (!layer) return [];

  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 3) continue;
    const geo = feature.toGeoJSON(x, y, z);
    const props = feature.properties || {};
    const baseId = props.id || `tile-${z}-${x}-${y}-${feature.id ?? i}`;
    const polys = polygonsOf(geo.geometry);
    for (let p = 0; p < polys.length; p++) {
      const coords = polys[p];
      if (!coords || !coords[0] || coords[0].length < 4) continue;
      const outer = coords[0];
      out.push({
        id: polys.length > 1 ? `${baseId}#${p}` : String(baseId),
        gersId: String(baseId),
        outer,
        holes: coords.slice(1),
        properties: props,
        bbox: coordinateBounds(outer),
        sortArea: degreeArea(outer),
      });
    }
  }
  return out;
}

/**
 * Reads and retains decoded Overture tiles. Failed tiles are evicted so a
 * later region can retry; successful tiles are bounded to avoid an endless
 * walking session retaining the entire route in memory.
 */
export class OvertureBuildingsClient {
  constructor({ url = OVERTURE_BUILDINGS_URL, zoom = OVERTURE_BUILDING_ZOOM } = {}) {
    this.url = url;
    this.zoom = zoom;
    this.archive = new PMTiles(new CachedRangeSource(url));
    this.tiles = new Map();
    this.maxTiles = 72;
  }

  tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let pending = this.tiles.get(key);
    if (pending) {
      this.tiles.delete(key);
      this.tiles.set(key, pending); // refresh insertion order for LRU eviction
      return pending;
    }
    pending = this.archive.getZxy(z, x, y)
      .then((result) => decodeBuildingTile(result && result.data, x, y, z))
      .catch((error) => { this.tiles.delete(key); throw error; });
    this.tiles.set(key, pending);
    while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value);
    return pending;
  }

  async fetchBuildings(bbox, { signal = null } = {}) {
    if (signal && signal.aborted) throw new Error('aborted');
    const tiles = tilesForBBox(bbox, this.zoom);
    const settled = await Promise.allSettled(tiles.map((t) => this.tile(t.z, t.x, t.y)));
    if (signal && signal.aborted) throw new Error('aborted');

    const failures = settled.filter((r) => r.status === 'rejected');
    const successes = settled.filter((r) => r.status === 'fulfilled');
    if (!successes.length && failures.length) throw failures[0].reason;

    // Tiles overlap at their buffered edges. The GERS id is stable across the
    // copies; retain the largest copy, which is the unclipped/full footprint.
    const byId = new Map();
    for (const result of successes) {
      for (const rec of result.value) {
        if (!intersects(rec.bbox, bbox)) continue;
        const old = byId.get(rec.id);
        if (!old || rec.sortArea > old.sortArea) byId.set(rec.id, rec);
      }
    }
    return [...byId.values()];
  }
}

export const overtureBuildings = new OvertureBuildingsClient();

// --- transportation --------------------------------------------------------

export const OVERTURE_TRANSPORT_URL =
  `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${OVERTURE_RELEASE}/transportation.pmtiles`;
export const OVERTURE_SEGMENT_ZOOM = 14;

function linesOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/**
 * Decode the segment layer of one MVT tile into WGS84 polyline records.
 *
 * Overture's `class` is OSM's `highway` value by another name - residential,
 * service, footway, secondary, steps all appear verbatim - so a segment can be
 * handed to the existing tag interpreter with a synthesised tag set rather than
 * needing a second road pipeline.
 */
export function decodeSegmentTile(data, x, y, z) {
  if (!data || !data.byteLength) return [];
  const tile = new VectorTile(new PbfReader(new Uint8Array(data)));
  const layer = tile.layers.segment;
  if (!layer) return [];

  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue;                 // LineString only
    const props = feature.properties || {};
    if (props.subtype && props.subtype !== 'road') continue;   // rail and water are drawn elsewhere
    if (!props.class) continue;
    const geo = feature.toGeoJSON(x, y, z);
    const baseId = props.id || `tile-${z}-${x}-${y}-${feature.id ?? i}`;
    const lines = linesOf(geo.geometry);
    for (let p = 0; p < lines.length; p++) {
      const coords = lines[p];
      if (!coords || coords.length < 2) continue;
      out.push({
        id: lines.length > 1 ? `${baseId}#${p}` : String(baseId),
        coords,
        properties: props,
        bbox: coordinateBounds(coords),
      });
    }
  }
  return out;
}

/** Same tile machinery as the buildings client, over the transportation theme. */
export class OvertureSegmentsClient {
  constructor({ url = OVERTURE_TRANSPORT_URL, zoom = OVERTURE_SEGMENT_ZOOM } = {}) {
    this.url = url;
    this.zoom = zoom;
    this.archive = new PMTiles(new CachedRangeSource(url));
    this.tiles = new Map();
    this.maxTiles = 72;
  }

  tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let pending = this.tiles.get(key);
    if (pending) {
      this.tiles.delete(key);
      this.tiles.set(key, pending);
      return pending;
    }
    pending = this.archive.getZxy(z, x, y)
      .then((result) => decodeSegmentTile(result && result.data, x, y, z))
      .catch((error) => { this.tiles.delete(key); throw error; });
    this.tiles.set(key, pending);
    while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value);
    return pending;
  }

  async fetchSegments(bbox, { signal = null } = {}) {
    if (signal && signal.aborted) throw new Error('aborted');
    const tiles = tilesForBBox(bbox, this.zoom);
    const settled = await Promise.allSettled(tiles.map((t) => this.tile(t.z, t.x, t.y)));
    if (signal && signal.aborted) throw new Error('aborted');

    const failures = settled.filter((r) => r.status === 'rejected');
    const successes = settled.filter((r) => r.status === 'fulfilled');
    if (!successes.length && failures.length) throw failures[0].reason;

    // A segment crossing a tile seam appears in both, clipped. Keeping the
    // longest copy per id is the line equivalent of the buildings' largest-area
    // rule, and stops a street being drawn twice with a join in the middle.
    const byId = new Map();
    for (const result of successes) {
      for (const rec of result.value) {
        if (!intersects(rec.bbox, bbox)) continue;
        const old = byId.get(rec.id);
        if (!old || rec.coords.length > old.coords.length) byId.set(rec.id, rec);
      }
    }
    return [...byId.values()];
  }
}

export const overtureSegments = new OvertureSegmentsClient();

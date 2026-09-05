// Global coverage fallbacks from Overture Maps.
//
// Live OpenStreetMap remains the primary map. Overture's monthly buildings,
// transportation and places themes are gap-fillers. The merge in
// world/features.js keeps live OSM geometry/businesses first, then admits real
// footprints, road fallback, and confidence-filtered restaurant points.
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
  constructor(url) {
    this.url = url;
    // The cache key has to name the archive, not just the byte range. With one
    // theme it did not matter; the moment a second was added, transportation
    // asked for bytes 0-16383 and was handed the buildings archive's header out
    // of the cache, so every tile lookup in it came back empty.
    this.theme = (url.match(/\/([^/]+)\.pmtiles$/) || [null, 'overture'])[1];
  }
  getKey() { return this.url; }

  async getBytes(offset, length, signal = null) {
    const data = await fetchCached(this.url, {
      as: 'arrayBuffer',
      cacheKey: `overture:${OVERTURE_RELEASE}:${this.theme}:range:${offset}:${length}`,
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

// --- places ---------------------------------------------------------------

export const OVERTURE_PLACES_URL =
  `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${OVERTURE_RELEASE}/places.pmtiles`;
export const OVERTURE_PLACE_ZOOM = 14;

function jsonProperty(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value) return fallback;
  try { return JSON.parse(value); } catch (e) { return fallback; }
}

function mostlyLatin(value) {
  const text = String(value || '');
  if (!text) return false;
  const letters = text.match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const latin = text.match(/\p{Script=Latin}/gu) || [];
  return latin.length / letters.length >= 0.7;
}

function latinCommonName(names, fallback) {
  const common = names?.common;
  if (common && typeof common === 'object') {
    if (typeof common.en === 'string') return common.en;
    for (const value of Object.values(common)) {
      if (typeof value === 'string' && mostlyLatin(value)) return value;
    }
  }
  return mostlyLatin(fallback) ? fallback : null;
}

/** Map the Overture taxonomy onto the small amenity vocabulary the renderer uses. */
export function overtureRestaurantCategory(properties = {}) {
  const taxonomy = jsonProperty(properties.taxonomy, {}) || {};
  const legacy = jsonProperty(properties.categories, {}) || {};
  const hierarchy = Array.isArray(taxonomy.hierarchy) ? taxonomy.hierarchy : [];
  const values = [properties.basic_category, taxonomy.primary, legacy.primary, ...hierarchy]
    .filter(Boolean).map((v) => String(v).toLowerCase());
  const matches = (pattern) => values.some((v) => pattern.test(v));
  const isRestaurant = hierarchy.includes('restaurant') ||
    matches(/^(?:restaurant|casual_eatery|food_court)$/);
  const foodContext = isRestaurant || hierarchy.includes('food_and_drink') ||
    matches(/^(?:pub|bar|cafe|coffee_shop|tea_house|ice_cream_shop|food_court)$/);
  // Alternates are useful search hints, not permission to recategorise the
  // primary entity. A music venue with alternate=bar and an oxygen bar were
  // otherwise both rendered as restaurants.
  if (!foodContext) return null;

  if (matches(/(?:^|_)(?:pub|gastropub|brewpub)(?:_|$)/)) return 'pub';
  if (matches(/(?:^|_)(?:bar|cocktail_bar|wine_bar)(?:_|$)/)) return 'bar';
  if (matches(/(?:cafe|coffee_shop|tea_house)/)) return 'cafe';
  if (matches(/(?:ice_cream|gelato|frozen_yogurt)/)) return 'ice_cream';
  if (matches(/food_court/)) return 'food_court';
  if (matches(/fast_food/) || (isRestaurant && matches(/(?:burger|hot_dog|sandwich|taco)/))) {
    return 'fast_food';
  }
  return isRestaurant ? 'restaurant' : null;
}

function overtureCuisineHints(properties = {}) {
  const taxonomy = jsonProperty(properties.taxonomy, {}) || {};
  const legacy = jsonProperty(properties.categories, {}) || {};
  const values = [properties.basic_category, taxonomy.primary, ...(taxonomy.hierarchy || []),
    ...(taxonomy.alternates || []), legacy.primary, ...(legacy.alternate || [])]
    .filter(Boolean).join(' ').toLowerCase();
  const rules = [
    ['mexican', /mexican|taco|tex_mex/], ['japanese', /japanese/], ['sushi', /sushi/],
    ['ramen', /ramen/], ['chinese', /chinese/], ['korean', /korean/],
    ['thai', /thai/], ['vietnamese', /vietnamese/], ['indian', /indian/],
    ['italian', /italian/], ['pizza', /pizza/], ['american', /american/],
    ['burger', /burger/], ['diner', /diner|breakfast_and_brunch/],
    ['coffee_shop', /coffee_shop|cafe/], ['barbecue', /barbecue|bbq/],
    ['seafood', /seafood/], ['steak_house', /steak_house|steakhouse/],
  ];
  return rules.filter(([, pattern]) => pattern.test(values)).map(([name]) => name);
}

/** Decode one tile feature's flattened MVT properties into a restaurant record. */
export function overtureRestaurantRecord(properties = {}, coordinates = null) {
  const category = overtureRestaurantCategory(properties);
  if (!category || !Array.isArray(coordinates) || coordinates.length < 2) return null;
  const names = jsonProperty(properties.names, {}) || {};
  const brand = jsonProperty(properties.brand, {}) || {};
  const brandNames = brand.names || {};
  const name = names.primary || properties['@name'] || brandNames.primary || null;
  if (!name) return null;
  // A few provider categories conflate a service named "bar" with a food or
  // drink venue. These phrases describe an activity/wellness service in every
  // region, so excluding them is semantic cleanup rather than a city rule.
  if (/\b(?:oxygen bar|bar crawl)\b/i.test(String(name))) return null;
  const websites = jsonProperty(properties.websites, []) || [];
  const sources = jsonProperty(properties.sources, []) || [];
  const signName = latinCommonName(names, name) ||
    latinCommonName(brandNames, brandNames.primary) || null;
  return {
    id: String(properties.id || ''),
    lon: Number(coordinates[0]),
    lat: Number(coordinates[1]),
    name: String(name),
    signName,
    brand: brandNames.primary || null,
    brandWikidata: brand.wikidata || null,
    category,
    cuisines: overtureCuisineHints(properties),
    website: Array.isArray(websites) ? websites.find((v) => /^https?:\/\//i.test(v)) || null : null,
    confidence: Number(properties.confidence),
    operatingStatus: properties.operating_status || null,
    sources: Array.isArray(sources) ? sources : [],
    properties,
  };
}

/** Decode only restaurant-like points from one Overture places MVT tile. */
export function decodePlaceTile(data, x, y, z) {
  if (!data || !data.byteLength) return [];
  const tile = new VectorTile(new PbfReader(new Uint8Array(data)));
  const layer = tile.layers.place;
  if (!layer) return [];
  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 1) continue;
    const geo = feature.toGeoJSON(x, y, z);
    if (geo.geometry?.type !== 'Point') continue;
    const record = overtureRestaurantRecord(feature.properties || {}, geo.geometry.coordinates);
    if (record) out.push(record);
  }
  return out;
}

export class OverturePlacesClient {
  constructor({ url = OVERTURE_PLACES_URL, zoom = OVERTURE_PLACE_ZOOM } = {}) {
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
      .then((result) => decodePlaceTile(result && result.data, x, y, z))
      .catch((error) => { this.tiles.delete(key); throw error; });
    this.tiles.set(key, pending);
    while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value);
    return pending;
  }

  async fetchPlaces(bbox, { signal = null } = {}) {
    if (signal && signal.aborted) throw new Error('aborted');
    const tiles = tilesForBBox(bbox, this.zoom);
    const settled = await Promise.allSettled(tiles.map((t) => this.tile(t.z, t.x, t.y)));
    if (signal && signal.aborted) throw new Error('aborted');
    const failures = settled.filter((r) => r.status === 'rejected');
    const successes = settled.filter((r) => r.status === 'fulfilled');
    if (!successes.length && failures.length) throw failures[0].reason;

    const byId = new Map();
    for (const result of successes) {
      for (const rec of result.value) {
        if (rec.lon < bbox.west || rec.lon > bbox.east ||
            rec.lat < bbox.south || rec.lat > bbox.north) continue;
        if (!byId.has(rec.id)) byId.set(rec.id, rec);
      }
    }
    return [...byId.values()];
  }
}

export const overturePlaces = new OverturePlacesClient();

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

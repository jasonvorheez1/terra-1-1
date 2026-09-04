// OpenStreetMap data via the Overpass API.
//
// Two things this has to survive, because both happen constantly in practice:
//
//  1. Public Overpass instances go down, rate-limit, or return 504 under load.
//     So we keep a list of mirrors, remember which one last worked, and fail
//     over automatically. A dead endpoint is benched for a few minutes.
//
//  2. Dense cities return a lot of data - a 1.2 km box in Midtown Manhattan is
//     about 4.5 MB. So the region loads in two phases: everything you can walk
//     on and bump into comes first, and the decoration follows once you are
//     already moving. Responses are cached in IndexedDB, so a revisit is free.
//
// Geometry arrives as node ids plus a deduplicated node table (`out body; >;
// out skel qt;`), which is ~17% smaller than inlining coordinates and, more
// usefully, tells us which ways share a node - the basis for working out where
// a bridge ramps back down to the ground.

import { fetchCached } from './net.js';
import { padBBox } from './projection.js';
import { overtureBuildings } from './overture.js';

// Every endpoint in this list must mirror the whole planet. Regional Overpass
// instances return a valid empty response outside their extract, which is
// indistinguishable from genuinely empty countryside once it reaches here.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Increment whenever the request semantics or eligible server coverage
// changes. Version 1 could cache a perfectly successful empty response from
// overpass.osm.ch for two weeks even when the query was for Missouri: that
// server contains Switzerland only, so the response was valid for its database
// but invalid for a world-wide client. A new namespace bypasses those poisoned
// entries without making users clear all of their useful terrain/image cache.
const OVERPASS_CACHE_VERSION = 2;

const BENCH_MS = 4 * 60 * 1000;      // how long a failing mirror sits out
const benched = new Map();           // endpoint -> timestamp it may be retried

/** Structural features: the ground you walk on and the things you collide with. */
function structureQuery(bbox, timeout) {
  const b = `${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)}`;
  return `[out:json][timeout:${timeout}];
(
  way["building"](${b});
  relation["building"]["type"="multipolygon"](${b});
  way["building:part"](${b});
  way["highway"](${b});
  way["railway"](${b});
  way["waterway"](${b});
  way["natural"](${b});
  relation["natural"="water"]["type"="multipolygon"](${b});
  way["landuse"](${b});
  relation["landuse"]["type"="multipolygon"](${b});
  way["leisure"](${b});
  way["aeroway"](${b});
  way["amenity"~"^(parking|school|university|hospital|place_of_worship|marketplace|college|kindergarten|grave_yard)$"](${b});
  way["man_made"~"^(bridge|pier|breakwater|embankment|storage_tank|water_tower|tower|silo|chimney)$"](${b});
  way["barrier"](${b});
);
out body qt;
>;
out skel qt;`;
}

/** Detail features: trees, street furniture, named places. Loaded second. */
function detailQuery(bbox, timeout) {
  const b = `${bbox.south.toFixed(6)},${bbox.west.toFixed(6)},${bbox.north.toFixed(6)},${bbox.east.toFixed(6)}`;
  return `[out:json][timeout:${timeout}];
(
  node["natural"~"^(tree|spring|rock|stone|peak)$"](${b});
  way["natural"="tree_row"](${b});
  node["highway"~"^(street_lamp|traffic_signals|crossing|bus_stop|stop|give_way|elevator|milestone)$"](${b});
  node["barrier"](${b});
  node["entrance"](${b});
  node["amenity"](${b});
  node["shop"](${b});
  node["tourism"](${b});
  node["historic"](${b});
  node["leisure"](${b});
  node["man_made"~"^(flagpole|obelisk|monitoring_station|water_tap|surveillance|street_cabinet|utility_pole)$"](${b});
  node["emergency"="fire_hydrant"](${b});
  node["advertising"](${b});
  node["power"~"^(pole|tower)$"](${b});
);
out body qt;
>;
out skel qt;`;
}

function endpointOrder(preferred) {
  const now = Date.now();
  const live = [];
  const sick = [];
  for (const ep of OVERPASS_ENDPOINTS) {
    const until = benched.get(ep) || 0;
    (until > now ? sick : live).push(ep);
  }
  // Try the one that worked last time first, then the rest, then benched ones.
  const order = live.slice();
  if (preferred) {
    const i = order.indexOf(preferred);
    if (i > 0) { order.splice(i, 1); order.unshift(preferred); }
  }
  return order.concat(sick);
}

export class OverpassClient {
  constructor() {
    this.lastGood = null;
    this.timeoutSec = 30;
  }

  /** POST a query, walking the mirror list until one answers. */
  async run(query, { cacheKey, maxAgeMs = 1000 * 60 * 60 * 24 * 14, signal = null } = {}) {
    const endpoints = endpointOrder(this.lastGood);
    let lastErr = null;

    for (const ep of endpoints) {
      if (signal && signal.aborted) throw new Error('aborted');
      try {
        const json = await fetchCached(ep, {
          as: 'json',
          cacheKey,                       // keyed on the query, not the mirror,
          maxAgeMs,                       // so a failover still hits the cache
          retries: 0,
          // Long enough for a busy mirror to do real work, short enough that a
          // hung one does not hold a region hostage. This used to be the query
          // timeout plus twenty seconds, so five mirrors in turn could block a
          // region for the better part of ten minutes - and every chunk inside
          // it with them.
          timeoutMs: (this.timeoutSec + 8) * 1000,
          signal,
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
          },
        });
        if (!json || !Array.isArray(json.elements)) throw new Error('malformed Overpass response');
        this.lastGood = ep;
        benched.delete(ep);
        return json;
      } catch (e) {
        lastErr = e;
        benched.set(ep, Date.now() + BENCH_MS);
      }
    }
    throw new Error(`every Overpass mirror failed (${lastErr ? lastErr.message : 'unknown'})`);
  }

  fetchStructure(bbox, opts) {
    const q = structureQuery(bbox, this.timeoutSec);
    return this.run(q, { cacheKey: `osm:v${OVERPASS_CACHE_VERSION}:s:${bboxKey(bbox)}`, ...opts });
  }

  fetchDetail(bbox, opts) {
    const q = detailQuery(bbox, this.timeoutSec);
    return this.run(q, { cacheKey: `osm:v${OVERPASS_CACHE_VERSION}:d:${bboxKey(bbox)}`, ...opts });
  }
}

function bboxKey(bbox) {
  return [bbox.south, bbox.west, bbox.north, bbox.east].map((v) => v.toFixed(5)).join(',');
}

export const overpass = new OverpassClient();

// --- parsed model ----------------------------------------------------------

/**
 * A merged view of one or more Overpass responses.
 *
 * `nodes` maps id -> {lat, lon, tags}. `ways` maps id -> {id, tags, refs}.
 * `nodeWayCount` counts how many *rendered* ways touch each node, which is how
 * bridge and tunnel ramps find their portals.
 */
export class OsmData {
  constructor() {
    this.nodes = new Map();
    this.ways = new Map();
    this.relations = new Map();
    this.nodeWayCount = new Map();
    this.bbox = null;
    this.hasDetail = false;
  }

  /** Merge an Overpass JSON response into this model. */
  ingest(json) {
    if (!json || !Array.isArray(json.elements)) return this;
    for (const el of json.elements) {
      if (el.type === 'node') {
        const existing = this.nodes.get(el.id);
        if (existing) {
          // A skeleton node arriving after a tagged one must not erase tags.
          if (el.tags && !existing.tags) existing.tags = el.tags;
          continue;
        }
        this.nodes.set(el.id, { id: el.id, lat: el.lat, lon: el.lon, tags: el.tags || null });
      } else if (el.type === 'way') {
        const existing = this.ways.get(el.id);
        if (existing) {
          if (el.tags && !existing.tags) existing.tags = el.tags;
          if (el.nodes && (!existing.refs || !existing.refs.length)) existing.refs = el.nodes;
          continue;
        }
        this.ways.set(el.id, { id: el.id, tags: el.tags || null, refs: el.nodes || [] });
      } else if (el.type === 'relation') {
        if (this.relations.has(el.id)) continue;
        this.relations.set(el.id, { id: el.id, tags: el.tags || null, members: el.members || [] });
      }
    }
    return this;
  }

  /**
   * Count how many routable ways use each node, and record the lowest and
   * highest `layer` seen there.
   *
   * The layer range is what tells a bridge whether its ends have to come back
   * down: a deck that meets another deck stays up, one that meets the street
   * has to ramp. Without this every flyover ends in a cliff.
   */
  indexJunctions() {
    this.nodeWayCount.clear();
    this.nodeLayerMin = new Map();
    this.nodeLayerMax = new Map();
    for (const way of this.ways.values()) {
      const t = way.tags;
      if (!t) continue;
      if (!t.highway && !t.railway) continue;
      let layer = parseInt(t.layer, 10);
      if (!isFinite(layer)) layer = 0;
      if (layer === 0 && t.tunnel && t.tunnel !== 'no') layer = -1;
      if (layer === 0 && t.bridge && t.bridge !== 'no') layer = 1;
      for (const ref of way.refs) {
        this.nodeWayCount.set(ref, (this.nodeWayCount.get(ref) || 0) + 1);
        const lo = this.nodeLayerMin.get(ref);
        const hi = this.nodeLayerMax.get(ref);
        if (lo === undefined || layer < lo) this.nodeLayerMin.set(ref, layer);
        if (hi === undefined || layer > hi) this.nodeLayerMax.set(ref, layer);
      }
    }
    return this;
  }

  /**
   * Does anything at grade meet this node?
   * A bridge or tunnel end that touches street level has to reach street level.
   */
  touchesGrade(ref) {
    const lo = this.nodeLayerMin ? this.nodeLayerMin.get(ref) : undefined;
    const hi = this.nodeLayerMax ? this.nodeLayerMax.get(ref) : undefined;
    if (lo === undefined) return true;          // unknown: assume it must land
    return lo <= 0 && hi >= 0;
  }

  /** Resolve a way's node refs to `[lat, lon]` pairs, dropping missing nodes. */
  wayCoords(way) {
    const out = [];
    for (const ref of way.refs) {
      const n = this.nodes.get(ref);
      if (n) out.push([n.lat, n.lon]);
    }
    return out;
  }

  /** Is a way closed (first ref equals last)? */
  isClosed(way) {
    return way.refs.length > 3 && way.refs[0] === way.refs[way.refs.length - 1];
  }

  /**
   * Rings for a multipolygon relation, as `{ outer: [[lat,lon]], inner: [] }`
   * fragment lists ready for `assembleRings`.
   */
  relationFragments(rel) {
    const outer = [], inner = [];
    for (const m of rel.members) {
      if (m.type !== 'way') continue;
      const way = this.ways.get(m.ref);
      if (!way || way.refs.length < 2) continue;
      const coords = this.wayCoords(way);
      if (coords.length < 2) continue;
      (m.role === 'inner' ? inner : outer).push(coords);
    }
    return { outer, inner };
  }

  get stats() {
    return {
      nodes: this.nodes.size,
      ways: this.ways.size,
      relations: this.relations.size,
      tagged: [...this.ways.values()].filter((w) => w.tags).length,
    };
  }
}

/**
 * One loaded square of the world.
 *
 * A region covers `sizeM` metres and is fetched with a margin so features that
 * straddle the edge still come back whole. `structure` resolves as soon as the
 * walkable world is in; `detail` resolves later.
 */
export class Region {
  constructor(key, bbox, sizeM) {
    this.key = key;
    this.bbox = bbox;
    this.sizeM = sizeM;
    this.data = new OsmData();
    this.data.bbox = bbox;
    this.overtureBuildings = [];
    this.overtureReady = false;
    this.overtureError = null;
    this.structureReady = false;
    this.detailReady = false;
    this.failed = null;
    this.failedAt = 0;
    this.attempts = 0;
    this.spent = false;                  // failed, and out of retries
    this.abort = new AbortController();
  }

  cancel() { try { this.abort.abort(); } catch (e) { /* already gone */ } }
}

/**
 * Loads and retains the OSM regions around the player.
 *
 * Regions are on a fixed grid so neighbouring loads line up and features are
 * never fetched twice, and each is padded outward so a building on the seam
 * still arrives complete from whichever side asks first.
 */
export class RegionLoader {
  constructor({ sizeM = 1200, marginM = 220, maxRegions = 9, useOvertureBuildings = true } = {}) {
    this.sizeM = sizeM;
    this.marginM = marginM;
    this.maxRegions = maxRegions;
    this.useOvertureBuildings = useOvertureBuildings;
    this.regions = new Map();
    this.onProgress = null;
    // Raised when a region gives up, and again when a retry rescues it, so the
    // UI can say that the ground you are looking at is missing its buildings
    // rather than letting you conclude that Paris is a meadow.
    this.onFailure = null;
    this.retryDelayMs = 20000;
    this.maxAttempts = 4;
  }

  /** How many loaded regions came back empty because every mirror refused. */
  get failedCount() {
    let n = 0;
    for (const r of this.regions.values()) if (r.failed) n++;
    return n;
  }

  /** Grid key for a local-metre position. */
  keyFor(x, z) {
    return `${Math.floor(x / this.sizeM)},${Math.floor(z / this.sizeM)}`;
  }

  /**
   * Ensure the region containing (x, z) is loading or loaded.
   * Returns the Region; await `region.structurePromise` for usable data.
   */
  request(projection, x, z) {
    const gx = Math.floor(x / this.sizeM);
    const gz = Math.floor(z / this.sizeM);
    const key = `${gx},${gz}`;
    const existing = this.regions.get(key);
    // A region that failed is not a region that is empty. Overpass mirrors go
    // down, rate-limit, and time out constantly, and keeping the failure means
    // one transient 504 turns a square kilometre of city into bare terrain for
    // the rest of the session - which looks exactly like an open field, with
    // nothing to say otherwise. So a failed region is allowed to try again,
    // backing off each time, and only stops once it is clearly not coming back.
    if (existing) {
      const spent = existing.attempts >= this.maxAttempts;
      const cooling = Date.now() - existing.failedAt <
                      this.retryDelayMs * existing.attempts;
      if (!existing.failed || spent || cooling) return existing;
      this.regions.delete(key);
    }
    const attempts = existing ? existing.attempts : 0;

    const minX = gx * this.sizeM, minZ = gz * this.sizeM;
    const core = projection.localRectToBBox(minX, minZ, minX + this.sizeM, minZ + this.sizeM);
    const bbox = padBBox(core, this.marginM);
    const region = new Region(key, bbox, this.sizeM);
    region.localBounds = { minX, minZ, maxX: minX + this.sizeM, maxZ: minZ + this.sizeM };
    region.attempts = attempts + 1;
    this.regions.set(key, region);

    region.structurePromise = (async () => {
      // OSM supplies the streets and highest-priority buildings; Overture's
      // official tiles independently fill genuine footprint gaps. Fetch them
      // together so the first frame does not pop thousands of houses in late.
      const osmPending = overpass.fetchStructure(bbox, { signal: region.abort.signal });
      const overturePending = this.useOvertureBuildings
        ? overtureBuildings.fetchBuildings(bbox, { signal: region.abort.signal })
        : Promise.resolve([]);
      const [osmResult, overtureResult] = await Promise.allSettled([osmPending, overturePending]);

      if (osmResult.status === 'fulfilled') {
        region.data.ingest(osmResult.value).indexJunctions();
      } else {
        region.failed = osmResult.reason;
        region.failedAt = Date.now();
        region.spent = region.attempts >= this.maxAttempts;
      }

      if (overtureResult.status === 'fulfilled') {
        region.overtureBuildings = overtureResult.value;
        region.overtureReady = true;
      } else {
        // Coverage enhancement is intentionally non-fatal. Live OSM still
        // renders exactly as before if S3 or a browser range request is down.
        region.overtureError = overtureResult.reason;
        region.overtureReady = true;
      }

      region.structureReady = true;
      if (this.onProgress) this.onProgress(region, region.failed ? 'failed' : 'structure');
      if (region.failed && this.onFailure) {
        this.onFailure(region, region.spent ? 'gave-up' : 'retrying');
      }
      return region;
    })();

    region.detailPromise = (async () => {
      await region.structurePromise;
      if (region.abort.signal.aborted) return region;
      try {
        const json = await overpass.fetchDetail(bbox, { signal: region.abort.signal });
        region.data.ingest(json);
        region.data.hasDetail = true;
        region.detailReady = true;
        if (this.onProgress) this.onProgress(region, 'detail');
      } catch (e) {
        region.detailReady = true;         // trees are optional; the world still works
      }
      return region;
    })();

    this.evict(x, z);
    return region;
  }

  /**
   * Load the region under the player plus the ring around it.
   *
   * Nearest first, and that ordering matters: public Overpass instances are
   * queued one request at a time, so asking for the ring before the centre
   * means waiting through several multi-megabyte downloads for other regions
   * before you can stand anywhere.
   */
  requestAround(projection, x, z, radius = 1, heading = null) {
    const wanted = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const rx = x + dx * this.sizeM, rz = z + dz * this.sizeM;
        const dist = Math.hypot(dx, dz);
        // Bias toward where the player is heading. Walking down a street, the
        // ground ahead is what you are about to need; the region behind you can
        // wait. With one query in flight at a time, this ordering is most of
        // what makes travel feel continuous rather than stop-start.
        let bias = 0;
        if (heading && dist > 0.01) {
          const dot = (dx / dist) * heading.x + (dz / dist) * heading.z;
          bias = -dot * 0.75;
        }
        wanted.push({ rx, rz, d: dist + bias });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    return wanted.map((w) => this.request(projection, w.rx, w.rz));
  }

  /** Drop the regions furthest from the player once we hold too many. */
  evict(x, z) {
    if (this.regions.size <= this.maxRegions) return;
    const scored = [];
    for (const [key, r] of this.regions) {
      const b = r.localBounds;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      scored.push([Math.hypot(cx - x, cz - z), key, r]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    for (let i = 0; i < scored.length && this.regions.size > this.maxRegions; i++) {
      const [, key, r] = scored[i];
      r.cancel();
      this.regions.delete(key);
    }
  }

  /** Every loaded region overlapping a local-metre rect. */
  overlapping(minX, minZ, maxX, maxZ) {
    const out = [];
    for (const r of this.regions.values()) {
      const b = r.localBounds;
      if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
      out.push(r);
    }
    return out;
  }

  clear() {
    for (const r of this.regions.values()) r.cancel();
    this.regions.clear();
  }
}

// The world: streaming, chunk building, and everything that samples the ground.
//
// Data arrives in ~1.2 km OSM regions; geometry is built in 256 m chunks. The
// two are deliberately different sizes: regions are sized to make one Overpass
// request worthwhile, chunks to make culling and streaming smooth.
//
// A chunk is only built once every region overlapping it has answered, and
// building is time-sliced against a frame budget so the world fills in around
// you instead of hitching. Features are assigned to chunks by clipping, so a
// road crossing four chunks is drawn once, not four times.

import * as THREE from 'three';
import { Projection, haversine } from '../geo/projection.js';
import { elevation } from '../geo/elevation.js';
import { ndvi, classifyBiome, seasonalPhase } from '../geo/nasa.js';
import { RegionLoader } from '../geo/overpass.js';
import {
  extractFeatures, mergeOvertureBuildings, mergeOvertureRoads,
  mergeOvertureRestaurantPlaces, assignEntrances, assignRestaurantBusinesses,
  verticalProfile, inferMissingHeights, inferBuildingKinds,
  inferSuburbanHousing, FeatureSet,
} from './features.js';
import { buildGradingField } from './build/grading.js';
import { MultiMesh, clipHalfPlane, colourToLinear } from './build/mesh.js';
import { buildTerrain, terrainCollision, buildLandcover, buildWater, fetchChunkImagery, biomeGroundColour } from './build/ground.js';
import { buildBuildings, reconcileBuildingParts } from './build/buildings.js';
import { buildRoad, buildRail } from './build/roads.js';
import { drivingSideForCountry } from './road-layout.js';
import { resolveRestaurantMedia } from './restaurant-media.js';
import {
  makeRestaurantMediaMesh, disposeRestaurantMedia,
} from './restaurant-media-render.js';
import { buildProps, buildBarriers } from './build/props.js';
import { collectTrees, buildTreeInstances, GroundCover } from './build/vegetation.js';
import { CollisionBuilder, CollisionWorld, SURFACE_IDS } from '../physics/collider.js';
import { bounds, centroid, area, cleanRing, pointInPolygon } from './geometry.js';
import { setFacadeRegion } from './osm-tags.js';
import { clamp, lerp } from '../core/util.js';

export const CHUNK_SIZE = 256;
// Vertices across a 256 m chunk. At 33 the spacing was 8 m, which cannot
// express anything finer than a 16 m wavelength - so real relief arrived
// faceted and the sub-sample detail below was thrown away before it was drawn.
const TERRAIN_RES = { low: 25, medium: 41, high: 65 };

// How far you can be from a chunk before its buildings stop being worth the
// trim. Cornices, balconies and doorways are a few centimetres of relief: past
// a couple of hundred metres they cost triangles and build time and return
// nothing you can see.
const DETAIL_RANK = { low: 0, medium: 1, high: 2 };
const DETAIL_NAME = ['low', 'medium', 'high'];
const DETAIL_BANDS = [340, 850];      // high inside 340 m, medium inside 850 m

// Covers that actually grow blades. `urban` and `bare` carry a little greenery
// in their tint, which is a statement about colour, not about grass.
const GRASSY_COVERS = new Set(['grass', 'scrub', 'forest', 'orchard', 'vineyard', 'wetland']);

/** One built square of world: meshes, a collider, and what it cost. */
class Chunk {
  constructor(cx, cz) {
    this.cx = cx; this.cz = cz;
    this.key = `${cx},${cz}`;
    this.minX = cx * CHUNK_SIZE;
    this.minZ = cz * CHUNK_SIZE;
    this.size = CHUNK_SIZE;
    this.centreX = this.minX + CHUNK_SIZE / 2;
    this.centreZ = this.minZ + CHUNK_SIZE / 2;
    this.group = new THREE.Group();
    this.group.name = `chunk ${this.key}`;
    this.group.matrixAutoUpdate = false;
    this.collider = null;
    this.state = 'pending';       // pending | building | ready | failed
    this.lights = [];
    this.terrain = null;
    this.waterMesh = null;
    this.triangles = 0;
    this.buildMs = 0;
    this.restaurantMediaPending = false;
  }

  dispose(scene, collisionWorld) {
    scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.userData?.ownedRestaurantMedia) {
        disposeRestaurantMedia(o);
        return;
      }
      if (o.geometry) o.geometry.dispose();
      // Materials are shared library instances; never dispose them here.
    });
    this.group.clear();
    collisionWorld.remove(this.key, 'world');
    this.collider = null;
    this.lights.length = 0;
  }
}

export class World {
  constructor(scene, settings, materials) {
    this.scene = scene;
    this.settings = settings;
    this.materials = materials;

    this.projection = new Projection(0, 0);
    this.origin = { lat: 0, lon: 0 };
    this.countryCode = null;
    this.drivingSide = 'right';
    this.regions = new RegionLoader({
      sizeM: settings.data.regionSize,
      marginM: 220,
      useOvertureBuildings: settings.data.useOvertureBuildings,
      useOverturePlaces: settings.data.useOverturePlaces,
    });
    this.collisionWorld = new CollisionWorld();

    this.chunks = new Map();
    this.buildQueue = [];
    this.seenFeatures = new Set();
    this.regionFeatures = new Map();     // region key -> FeatureSet
    this.chunkFeatures = new Map();      // chunk key -> FeatureSet
    this.grading = null;
    this.profiles = new WeakMap();       // road -> vertical profile

    this.biome = classifyBiome(0, 0, 0.4);
    this.season = 0.6;
    this.ready = false;
    this.visible = true;
    this.groundCover = new GroundCover(this.ctx(), scene);

    this.stats = {
      chunks: 0, triangles: 0, collisionTriangles: 0, buildQueue: 0,
      regions: 0, lastBuildMs: 0,
    };
    this.errors = [];
    this.restaurantMediaCredits = new Map();
    this.onStatus = null;
  }

  /** The context object every builder receives. */
  ctx() {
    if (this._ctx) return this._ctx;
    this._ctx = {
      settings: this.settings,
      materials: this.materials,
      projection: this.projection,
      terrainAt: (x, z) => this.terrainAt(x, z),
      rawTerrainAt: (x, z) => this.rawTerrainAt(x, z),
      ndviAt: (lat, lon) => ndvi.sample(lat, lon),
      centroidGeo: (ring) => {
        const c = centroid(ring);
        return this.projection.toGeo(c[0], c[1]);
      },
      get biome() { return this.__world.biome; },
      // Which part of the world we are in, for the facade palettes and the
      // tree species tables. Set once per session from the origin.
      get region() { return this.__world.region; },
      get drivingSide() { return this.__world.drivingSide; },
      get season() { return this.__world.season; },
      // The chunk being built may ask for less than the quality setting allows;
      // see chunkDetailFor.
      get detail() {
        return this.__world.chunkDetail || this.__world.settings.graphics.buildingDetail;
      },
      onError: (kind, id, err) => this.recordError(kind, id, err),
      __world: this,
    };
    return this._ctx;
  }

  recordError(kind, id, err) {
    if (this.errors.length < 40) this.errors.push(`${kind} ${id}: ${err.message}`);
  }

  // --- location ------------------------------------------------------------

  /**
   * Move the world to a new place. Everything already built is thrown away:
   * the local tangent plane is anchored here now.
   */
  async setLocation(lat, lon, { date = new Date(), countryCode = null, onProgress = null } = {}) {
    this.clear();
    this.origin = { lat, lon };
    this.projection.setOrigin(lat, lon);
    // Facade palettes are regional; a session has one location.
    this.region = setFacadeRegion(lat, lon);
    this.setCountryCode(countryCode);
    this.date = date;
    this.ready = false;

    const g = this.settings.graphics;
    const targetMpp = { low: 24, medium: 12, high: 7 }[g.terrainDetail] || 12;
    elevation.configure(lat, { targetMpp, enabled: true });
    ndvi.configure({ enabled: this.settings.world.useNasaVegetation, date });

    if (onProgress) onProgress(0.05, 'Reading terrain');
    // A generous box so the first few hundred metres of walking never stalls.
    const bbox = this.projection.localRectToBBox(-2200, -2200, 2200, 2200);
    await Promise.all([
      elevation.preload(bbox, (p) => onProgress && onProgress(0.05 + p * 0.25, 'Reading terrain')),
      (async () => {
        if (!this.settings.world.useNasaVegetation) return;
        await ndvi.preload(bbox);
        if (onProgress) onProgress(0.35, 'Reading satellite vegetation');
      })(),
    ]);

    const groundElevation = elevation.sample(lat, lon, 0);
    const ndviHere = ndvi.sample(lat, lon);
    this.biome = classifyBiome(lat, groundElevation, ndviHere);
    this.season = seasonalPhase(date, lat);
    this.baseElevation = groundElevation;
    this.ndviHere = ndviHere;

    if (onProgress) onProgress(0.4, 'Downloading streets and building footprints');
    this.regions.sizeM = this.settings.data.regionSize;
    this.regions.useOvertureBuildings = this.settings.data.useOvertureBuildings;
    this.regions.useOverturePlaces = this.settings.data.useOverturePlaces;

    // Ask for the centre region and nothing else. Public Overpass instances
    // serve one query at a time, and a dense city region is several megabytes,
    // so queueing the surrounding ring first would mean waiting through all of
    // it before the ground under your feet exists. The neighbours are fetched
    // in the background once the world is running.
    const centre = this.regions.request(this.projection, 0, 0);
    let waited = 0;
    const tick = setInterval(() => {
      waited += 1;
      if (!onProgress) return;
      // Creep the bar so a slow server still looks like it is doing something,
      // and say so once it has been a while.
      onProgress(0.4 + Math.min(0.2, waited * 0.006),
        waited > 12 ? 'The map server is busy - still waiting, or trying a mirror'
                    : 'Downloading streets and building footprints');
    }, 1000);
    try {
      await centre.structurePromise;
    } finally {
      clearInterval(tick);
    }
    // Overpass failing is not the same as having no map. Overture's tiles are
    // fetched alongside it and settle independently, so if they arrived there
    // is a world to walk in - buildings, and streets from the transportation
    // theme - and the session should start rather than bouncing the player
    // back to the menu because one busy mirror timed out. Only refuse when
    // nothing at all answered.
    const overtureRescued = centre.overtureBuildings.length > 0 ||
                            centre.overtureSegments.length > 0;
    if (centre.failed && !overtureRescued) {
      throw new Error('No map data answered. Both OpenStreetMap and the Overture tiles are unreachable; try again shortly.');
    }
    if (centre.failed) this.osmDegraded = true;
    if (onProgress) onProgress(0.62, 'Building the world');

    this.rebuildGrading();
    this.ready = true;
    return { biome: this.biome, elevation: groundElevation, ndvi: ndviHere };
  }

  /** Update a session's traffic convention before its chunks are generated. */
  setCountryCode(countryCode) {
    this.countryCode = countryCode ? String(countryCode).trim().toUpperCase() : null;
    this.drivingSide = drivingSideForCountry(this.countryCode);
  }

  clear() {
    for (const chunk of this.chunks.values()) chunk.dispose(this.scene, this.collisionWorld);
    this.chunks.clear();
    this.buildQueue.length = 0;
    this.regions.clear();
    this.regionFeatures.clear();
    this.chunkFeatures.clear();
    this.seenFeatures.clear();
    this.collisionWorld.clear();
    this.grading = null;
    this.errors.length = 0;
    this.restaurantMediaCredits.clear();
    this.groundCover.dispose();
  }

  // --- terrain sampling ----------------------------------------------------

  /** Bare elevation, before roads have been graded into it. */
  rawTerrainAt(x, z) {
    const geo = this.projection.toGeo(x, z);
    return elevation.sample(geo.lat, geo.lon, this.baseElevation || 0);
  }

  /** Ground height as built: elevation, graded to the roads crossing it. */
  terrainAt(x, z) {
    const raw = this.rawTerrainAt(x, z);
    if (!this.grading) return raw;
    return this.grading.sample(x, z, raw);
  }

  /** Rebuild the grading field from every road currently loaded. */
  rebuildGrading() {
    const roads = [];
    const rails = [];
    for (const region of this.regions.regions.values()) {
      const fs = this.featuresFor(region);
      if (!fs) continue;
      roads.push(...fs.roads);
      rails.push(...fs.rails);
    }
    // Profiles are computed against raw terrain: grading must not feed back
    // into the thing that produced it.
    const rawAt = (x, z) => this.rawTerrainAt(x, z);
    this.grading = buildGradingField(roads, rails, (way) => {
      let p = this.profiles.get(way);
      if (!p) {
        p = verticalProfile(way.pts, rawAt, way.spec, way.endsAtGrade || [true, true]);
        this.profiles.set(way, p);
      }
      return p;
    });
  }

  profileFor(way) {
    let p = this.profiles.get(way);
    if (!p) {
      p = verticalProfile(way.pts, (x, z) => this.rawTerrainAt(x, z), way.spec,
                          way.endsAtGrade || [true, true]);
      this.profiles.set(way, p);
    }
    return p;
  }

  // --- feature indexing ----------------------------------------------------

  /** Extract a region's features once, then reuse. */
  featuresFor(region) {
    if (!region.structureReady) return null;
    let fs = this.regionFeatures.get(region.key);
    // A retry replaces the Region object but keeps its grid key, so the cache
    // has to be keyed on the attempt too - otherwise the empty feature set from
    // the failed try would be served forever and the retry would buy nothing.
    if (fs && fs.__attempt !== region.attempts) {
      this.regionFeatures.delete(region.key);
      fs = null;
    }
    if (fs) {
      // A region's detail pass arrives later; fold it in when it does.
      if (region.detailReady && !fs.__detail) {
        const extra = extractFeatures(region.data, this.projection, { seen: this.seenFeatures });
        mergeFeatures(fs, extra);
        assignEntrances(fs);
        assignRestaurantBusinesses(fs);
        fs.__detail = true;
        this.indexFeatures(extra);
      }
      return fs;
    }
    fs = extractFeatures(region.data, this.projection, { seen: this.seenFeatures });
    fs.__overture = mergeOvertureBuildings(
      fs,
      region.overtureBuildings,
      this.projection,
      { seen: this.seenFeatures },
    );
    fs.__overturePlaces = mergeOvertureRestaurantPlaces(
      fs,
      region.overturePlaces,
      this.projection,
      { seen: this.seenFeatures },
    );
    // Streets from Overture only where Overpass gave us none. With both in
    // hand OSM is the better map and the two cannot be deduped reliably, so
    // this is a fallback rather than a supplement - see mergeOvertureRoads.
    if (region.failed && !fs.roads.length) {
      fs.__overtureRoads = mergeOvertureRoads(
        fs, region.overtureSegments, this.projection, { seen: this.seenFeatures });
    }
    reconcileBuildingParts(fs);
    // Only after both real footprint sources have been exhausted do mapped-but
    // unbuilt residential zones receive clearly marked synthetic houses.
    if (this.settings.world.inferHousing) inferSuburbanHousing(fs);
    // What a building is comes first: a footprint recognised as a house gets
    // the house class, and so is no longer a gap for the height pass to fill.
    inferBuildingKinds(fs);
    // Untagged buildings take their storey count from their neighbours before
    // anything is built from those heights.
    inferMissingHeights(fs);
    assignEntrances(fs);
    assignRestaurantBusinesses(fs);
    fs.__detail = region.detailReady;
    fs.__attempt = region.attempts;
    this.regionFeatures.set(region.key, fs);
    this.indexFeatures(fs);
    return fs;
  }

  /**
   * Assign features to the chunks they occupy.
   *
   * Linear features are clipped at chunk boundaries and area features are
   * clipped to the chunk rect, so nothing is drawn twice and nothing vanishes
   * because the chunk holding its centroid unloaded while you stood on it.
   */
  indexFeatures(fs) {
    const chunkOf = (x, z) => `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    const get = (key) => {
      let c = this.chunkFeatures.get(key);
      if (!c) { c = new FeatureSet(); this.chunkFeatures.set(key, c); }
      return c;
    };

    // Buildings are small; put each in the chunk holding its centroid so a
    // building is never split down the middle.
    for (const b of fs.buildings) get(chunkOf(b.centroid[0], b.centroid[1])).buildings.push(b);
    for (const b of fs.buildingParts) {
      const c = b.centroid || centroid(b.ring);
      get(chunkOf(c[0], c[1])).buildingParts.push(b);
    }
    for (const t of fs.trees) get(chunkOf(t.x, t.z)).trees.push(t);
    for (const p of fs.props) get(chunkOf(p.x, p.z)).props.push(p);
    for (const p of fs.pois) get(chunkOf(p.x, p.z)).pois.push(p);

    for (const r of fs.roads) this.indexLinear(r, r.pts, get, 'roads');
    for (const r of fs.rails) this.indexLinear(r, r.pts, get, 'rails');
    for (const b of fs.barriers) this.indexLinear(b, b.pts, get, 'barriers');
    for (const w of fs.waterways) this.indexLinear(w, w.pts, get, 'waterways');
    for (const t of fs.treeRows) this.indexLinear(t, t.pts, get, 'treeRows');

    for (const lc of fs.landcover) this.indexArea(lc, get, 'landcover');
    for (const w of fs.waterAreas) this.indexArea(w, get, 'waterAreas');
  }

  /** Split a polyline at chunk boundaries and file each piece. */
  indexLinear(feature, pts, get, listName) {
    const pieces = new Map();
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const key = `${Math.floor(mx / CHUNK_SIZE)},${Math.floor(mz / CHUNK_SIZE)}`;
      let run = pieces.get(key);
      if (!run) { run = []; pieces.set(key, run); }
      // Keep runs contiguous: extend the last one when it ends where we start.
      const last = run[run.length - 1];
      if (last && last[last.length - 1] === a) last.push(b);
      else run.push([a, b]);
    }
    for (const [key, runs] of pieces) {
      for (const run of runs) {
        if (run.length < 2) continue;
        const clone = Object.create(Object.getPrototypeOf(feature));
        Object.assign(clone, feature);
        clone.pts = run;
        clone.__parent = feature;
        if (feature.junctionPatches) {
          const [chunkX, chunkZ] = key.split(',').map(Number);
          clone.junctionPatches = feature.junctionPatches.filter((patch) =>
            Math.floor(patch.x / CHUNK_SIZE) === chunkX &&
            Math.floor(patch.z / CHUNK_SIZE) === chunkZ);
        }
        get(key)[listName].push(clone);
      }
    }
  }

  /** Clip an area feature to each chunk rect it touches. */
  indexArea(feature, get, listName) {
    const b = feature.bounds || (feature.bounds = bounds(feature.ring));
    const c0x = Math.floor(b.minX / CHUNK_SIZE), c1x = Math.floor(b.maxX / CHUNK_SIZE);
    const c0z = Math.floor(b.minZ / CHUNK_SIZE), c1z = Math.floor(b.maxZ / CHUNK_SIZE);
    const cells = (c1x - c0x + 1) * (c1z - c0z + 1);

    // A feature inside one chunk needs no clipping at all.
    if (cells <= 1) {
      get(`${c0x},${c0z}`)[listName].push(feature);
      return;
    }
    // Something enormous (a whole national park) would cost more to clip into
    // every cell than it is worth; file it by centroid and let culling handle it.
    if (cells > 400) {
      const c = centroid(feature.ring);
      get(`${Math.floor(c[0] / CHUNK_SIZE)},${Math.floor(c[1] / CHUNK_SIZE)}`)[listName].push(feature);
      return;
    }

    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const x0 = cx * CHUNK_SIZE - 0.5, x1 = (cx + 1) * CHUNK_SIZE + 0.5;
        const z0 = cz * CHUNK_SIZE - 0.5, z1 = (cz + 1) * CHUNK_SIZE + 0.5;
        const ring = clipRect(feature.ring, x0, z0, x1, z1);
        if (ring.length < 3) continue;
        const holes = [];
        for (const h of feature.holes || []) {
          const hc = clipRect(h, x0, z0, x1, z1);
          if (hc.length >= 3) holes.push(hc);
        }
        const clone = Object.create(Object.getPrototypeOf(feature));
        Object.assign(clone, feature);
        clone.ring = ring;
        clone.holes = holes;
        clone.bounds = bounds(ring);
        clone.area = area(ring);
        clone.__parent = feature;
        get(`${cx},${cz}`)[listName].push(clone);
      }
    }
  }

  // --- streaming -----------------------------------------------------------

  /**
   * Called every frame. Requests data, queues chunk builds, evicts what is
   * behind you, and spends a fixed slice of the frame actually building.
   */
  update(px, pz, dt, budgetMs = 6, heading = null) {
    if (!this.ready) return;
    this.lastViewer = { x: px, z: pz };

    this.regions.requestAround(this.projection, px, pz,
                               this.settings.data.prefetchRadius, heading);

    const radius = this.settings.graphics.renderDistance;
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);
    const r = Math.ceil(radius / CHUNK_SIZE);

    // Queue anything missing, nearest first.
    const wanted = new Set();
    const candidates = [];
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const kx = cx + dx, kz = cz + dz;
        const ccx = kx * CHUNK_SIZE + CHUNK_SIZE / 2;
        const ccz = kz * CHUNK_SIZE + CHUNK_SIZE / 2;
        const dist = Math.hypot(ccx - px, ccz - pz);
        if (dist > radius + CHUNK_SIZE) continue;
        const key = `${kx},${kz}`;
        wanted.add(key);
        if (this.chunks.has(key)) continue;
        // Same idea as the region ordering: a chunk you are walking toward is
        // worth more than one the same distance behind you.
        let priority = dist;
        if (heading && dist > 1) {
          priority -= ((ccx - px) / dist * heading.x + (ccz - pz) / dist * heading.z)
                      * CHUNK_SIZE * 1.5;
        }
        candidates.push({ kx, kz, key, dist, priority });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    const queued = new Set(this.buildQueue.map((q) => q.key));
    for (const c of candidates) {
      if (queued.has(c.key)) continue;
      this.buildQueue.push(c);
      queued.add(c.key);
    }
    // Re-prioritise the whole queue against where the player is now, so a
    // change of direction takes effect immediately rather than after the old
    // ordering has drained.
    for (const q of this.buildQueue) {
      const ccx = q.kx * CHUNK_SIZE + CHUNK_SIZE / 2;
      const ccz = q.kz * CHUNK_SIZE + CHUNK_SIZE / 2;
      const d = Math.hypot(ccx - px, ccz - pz);
      q.priority = d - (heading && d > 1
        ? ((ccx - px) / d * heading.x + (ccz - pz) / d * heading.z) * CHUNK_SIZE * 1.5
        : 0);
    }
    this.buildQueue.sort((a, b) => a.priority - b.priority);

    // Evict what has fallen outside the radius, with hysteresis so a chunk on
    // the boundary does not thrash in and out as you pace back and forth.
    for (const [key, chunk] of this.chunks) {
      const dist = Math.hypot(chunk.centreX - px, chunk.centreZ - pz);
      if (dist > radius + CHUNK_SIZE * 2.5) {
        chunk.dispose(this.scene, this.collisionWorld);
        this.chunks.delete(key);
      }
    }

    // Rebuild chunks that were built before all their data had arrived. Only
    // once every region they were waiting on has landed, so a chunk is rebuilt
    // at most once no matter how many neighbours it straddles.
    for (const [key, chunk] of this.chunks) {
      if (!chunk.awaiting || chunk.awaiting.size === 0) continue;
      let allHere = true;
      for (const rk of chunk.awaiting) {
        const region = this.regions.regions.get(rk);
        if (!region) continue;                 // evicted; nothing more is coming
        if (!region.structureReady) { allHere = false; break; }
        // A region that failed is marked ready so the world is not held up by
        // it, but its chunk was built from terrain alone. Keep asking until it
        // either answers or runs out of retries, otherwise a single timeout
        // leaves a square kilometre of city looking like open grass.
        if (region.failed && !region.spent) {
          this.regions.request(this.projection, chunk.centreX, chunk.centreZ);
          allHere = false;
          break;
        }
      }
      if (!allHere) continue;
      chunk.dispose(this.scene, this.collisionWorld);
      this.chunks.delete(key);
      this.buildQueue.unshift({ kx: chunk.cx, kz: chunk.cz, key, dist: 0 });
      break;                                   // at most one rebuild per frame
    }

    // Walk toward a chunk that was built coarse and it earns its detail back.
    // Only ever upgrades: letting it downgrade as well would rebuild the same
    // chunk twice every time you paced across a band boundary. One per frame,
    // nearest first, so approaching a city does not rebuild half of it at once.
    let upgrade = null, upgradeDist = Infinity;
    for (const [key, chunk] of this.chunks) {
      if (chunk.awaiting && chunk.awaiting.size) continue;   // still waiting on data
      // Compare the band, not the capped detail: with buildings set to low the
      // capped value never moves, but the terrain resolution still should.
      if (this.detailBandFor(chunk.centreX, chunk.centreZ) <= (chunk.band ?? 2)) continue;
      const d = Math.hypot(chunk.centreX - px, chunk.centreZ - pz);
      if (d < upgradeDist) { upgradeDist = d; upgrade = key; }
    }
    if (upgrade) {
      const chunk = this.chunks.get(upgrade);
      chunk.dispose(this.scene, this.collisionWorld);
      this.chunks.delete(upgrade);
      this.buildQueue.unshift({ kx: chunk.cx, kz: chunk.cz, key: upgrade, dist: 0 });
    }

    // Build within the frame budget.
    //
    // A chunk whose region has not arrived is set aside rather than put back
    // at the head of the queue: the queue is sorted by distance, so blocking
    // on the nearest unbuildable chunk would stall every buildable one behind
    // it, and the world would stop filling in entirely until one slow Overpass
    // query returned.
    const deadline = performance.now() + budgetMs;
    let built = 0;
    let attempts = 0;
    const deferred = [];
    // How many builds the budget can actually afford, from what they have been
    // costing. A flat cap of three was three chunks' worth of work in one frame
    // whatever the budget said - and since the deadline was only consulted
    // after the first build, a frame could spend sixty milliseconds building
    // and still call it a six millisecond budget. One build is always allowed,
    // or the world would never fill in on a slow machine.
    const avg = this.stats.avgBuildMs || 8;
    const maxBuilds = Math.max(1, Math.min(3, Math.floor(budgetMs / avg)));
    while (this.buildQueue.length && attempts < 64) {
      if (built > 0 && performance.now() >= deadline) break;
      if (built >= maxBuilds) break;
      const job = this.buildQueue.shift();
      attempts++;
      if (this.chunks.has(job.key)) continue;
      const chunk = this.buildChunk(job.kx, job.kz);
      if (chunk === null) { deferred.push(job); continue; }
      built++;
    }
    if (deferred.length) this.buildQueue.push(...deferred);

    this.stats.chunks = this.chunks.size;
    this.stats.buildQueue = this.buildQueue.length;
    this.stats.regions = this.regions.regions.size;
    this.stats.collisionTriangles = this.collisionWorld.triangleCount;

    // Ground cover follows the player rather than living in chunks.
    this.groundCover.ctx = this.ctx();
    this.groundCover.update(px, pz, (x, z) => this.groundCoverAt(x, z));
  }

  /** Does grass grow here, and what does it look like? */
  groundCoverAt(x, z) {
    const chunk = this.chunks.get(`${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`);
    if (!chunk || chunk.state !== 'ready') return null;
    const fs = this.chunkFeatures.get(chunk.key);
    if (!fs) return null;
    // Whatever is on top decides, not whatever is greenest. Filtering to
    // vegetated covers first meant a paved square could never veto the polygon
    // underneath it - and `landuse=residential` carries veg 0.14, just over the
    // old threshold, so grass was growing across every residential district in
    // the world, Marienplatz included, paving and all.
    let best = null;
    for (const lc of fs.landcover) {
      const b = lc.bounds;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (!pointInPolygon(lc.ring, lc.holes, x, z)) continue;
      if (!best || lc.spec.z > best.spec.z) best = lc;
    }
    if (!best || !GRASSY_COVERS.has(best.spec.cover)) return null;
    const geo = this.projection.toGeo(x, z);
    const v = ndvi.sample(geo.lat, geo.lon);
    const lushness = clamp(v * 1.6, 0.2, 1.4) * clamp(best.spec.veg * 2, 0.3, 1.5);
    const colour = new THREE.Color(biomeGroundColour(this.biome, v, this.season));
    return { grass: true, y: this.terrainAt(x, z) + 0.01, lushness, colour };
  }

  /**
   * Build one chunk. Always produces ground; whatever OSM data has not arrived
   * is noted on `chunk.awaiting` and folded in by the straggler rebuild.
   */
  /** Which distance band a chunk falls in: 2 near, 1 middle, 0 far. */
  detailBandFor(centreX, centreZ) {
    const p = this.lastViewer;
    if (!p) return 2;
    const d = Math.hypot(centreX - p.x, centreZ - p.z);
    return d < DETAIL_BANDS[0] ? 2 : d < DETAIL_BANDS[1] ? 1 : 0;
  }

  /** The building detail a chunk deserves, never above the quality setting. */
  chunkDetailFor(centreX, centreZ) {
    const cap = DETAIL_RANK[this.settings.graphics.buildingDetail] ?? 2;
    return DETAIL_NAME[Math.min(cap, this.detailBandFor(centreX, centreZ))];
  }

  buildChunk(cx, cz) {
    const chunk = new Chunk(cx, cz);
    chunk.band = this.detailBandFor(chunk.centreX, chunk.centreZ);
    chunk.detail = this.chunkDetailFor(chunk.centreX, chunk.centreZ);
    this.chunkDetail = chunk.detail;

    // A chunk overlaps up to four regions once its margin is taken into
    // account, and regions arrive one at a time because public Overpass
    // instances serve one query at a time. Waiting for all of them would mean
    // a minute of empty world in a dense city, so we build with whatever has
    // arrived and rebuild the chunk when the stragglers land.
    const pad = 60;
    const overlapping = this.regions.overlapping(
      chunk.minX - pad, chunk.minZ - pad, chunk.minX + chunk.size + pad, chunk.minZ + chunk.size + pad);
    // The region the chunk sits in.
    const primary = overlapping.find((r) => {
      const b = r.localBounds;
      return chunk.centreX >= b.minX && chunk.centreX < b.maxX &&
             chunk.centreZ >= b.minZ && chunk.centreZ < b.maxZ;
    });

    chunk.awaiting = new Set();
    // Terrain does not need OSM. It used to: a chunk whose region had not
    // arrived refused to build at all, and refusing to build does not mean
    // "not finished loading", it means there is nothing there - no ground, no
    // collision, a hole you walk into and fall through. And the wait is not
    // short. A hung Overpass mirror is abandoned only after its timeout, and
    // with five mirrors tried in turn a single region can block for minutes,
    // which is long enough to walk to the edge of the world and off it.
    //
    // So build from the elevation tiles, which are already resident, and note
    // what is missing. The straggler pass rebuilds the chunk when the data
    // lands, and until then you are standing on real ground watching a city
    // arrive rather than falling into a void.
    if (!primary || !primary.structureReady) {
      this.regions.request(this.projection, chunk.centreX, chunk.centreZ);
      chunk.awaiting.add(this.regions.keyFor(chunk.centreX, chunk.centreZ));
    }
    for (const region of overlapping) {
      if (!region.structureReady) { chunk.awaiting.add(region.key); continue; }
      const osmMissing = region.failed && !region.spent;
      // A failed Overpass query does not mean an empty region. Overture is
      // fetched alongside it and settles independently, so when the OSM half
      // times out the footprints are usually already in hand - and refusing to
      // look at them left a district of houses unbuilt because a mirror was
      // busy. Build with whatever arrived.
      const haveOverture = region.overtureReady && region.overtureBuildings.length > 0;
      if (!osmMissing || haveOverture) this.featuresFor(region);
      // Still waiting on OSM either way: the streets, the land cover and the
      // tag detail only come from there, so the chunk is rebuilt when it lands.
      if (osmMissing) chunk.awaiting.add(region.key);
    }

    const t0 = performance.now();
    const ctx = this.ctx();
    const fs = this.chunkFeatures.get(chunk.key) || new FeatureSet();
    const multi = new MultiMesh();
    const collide = new CollisionBuilder();

    // Terrain first: everything else asks it for heights.
    ctx.aerial = {
      enabled: this.settings.graphics.groundStyle === 'aerial',
      minX: chunk.minX, minZ: chunk.minZ, size: chunk.size,
    };
    // Terrain follows the same bands. A chunk a kilometre away does not need a
    // four-metre heightfield, and its vertex loop is the single most expensive
    // thing in a build - so at 25 across instead of 65 it costs a seventh of
    // the samples. The edge skirt hides the seam against a finer neighbour.
    const tcap = DETAIL_RANK[this.settings.graphics.terrainDetail] ?? 1;
    const res = TERRAIN_RES[DETAIL_NAME[Math.min(tcap, chunk.band ?? 2)]] || 33;
    chunk.terrain = buildTerrain(chunk, ctx, { resolution: res });
    const terrainMesh = new THREE.Mesh(
      chunk.terrain.geometry,
      this.materials.terrain(null, this.biome && this.biome.id),
    );
    terrainMesh.receiveShadow = true;
    terrainMesh.castShadow = false;
    terrainMesh.matrixAutoUpdate = false;
    terrainMesh.name = 'terrain';
    chunk.group.add(terrainMesh);
    collide.surface(SURFACE_IDS.dirt);
    // Collide at the full render resolution on the chunks you can actually
    // stand on. Subsampling the heightfield puts a straight chord under every
    // crest the eye can see, so the ground you are standing on sits below the
    // ground you are looking at and you sink into it - worst on roads, because
    // a graded road has no surface collider of its own and the graded terrain
    // *is* the road. Further out nobody is standing on it, so it can halve.
    terrainCollision(collide, chunk, chunk.terrain, (chunk.band ?? 2) >= 2 ? 1 : 2);

    // Surfaces.
    collide.surface(SURFACE_IDS.grass);
    buildLandcover(fs.landcover, ctx, multi, collide);

    collide.surface(SURFACE_IDS.concrete);
    for (const road of fs.roads) {
      const prof = this.profileFor(road.__parent || road);
      const sub = road.__parent ? sliceProfile(road, road.__parent, prof) : prof;
      try { buildRoad(road, sub, ctx, multi, collide); }
      catch (e) { this.recordError('road', road.source, e); }
    }
    for (const rail of fs.rails) {
      const prof = this.profileFor(rail.__parent || rail);
      const sub = rail.__parent ? sliceProfile(rail, rail.__parent, prof) : prof;
      try { buildRail(rail, sub, ctx, multi, collide); }
      catch (e) { this.recordError('rail', rail.source, e); }
    }

    // Buildings.
    collide.surface(SURFACE_IDS.concrete);
    const buildingList = fs.buildings.concat(fs.buildingParts);
    ctx.restaurantMediaTargets = [];
    buildBuildings(buildingList, ctx, multi, { detail: ctx.detail, collide });
    const restaurantMediaTargets = ctx.restaurantMediaTargets;
    ctx.restaurantMediaTargets = null;
    for (const b of buildingList) {
      if (b.hasParts) continue;
      const g = lowestGround(b.ring, ctx.terrainAt);
      b.groundY = g;
      // Buildings are solid from the street. Going inside is a cell transition
      // at the door, not a hole in the wall, so there is nothing to leave open.
      collide.loop(b.ring, g - 0.5, g + b.heights.top);
      // A roof you can end up standing on needs a surface.
      collide.polygon(b.ring, b.holes, g + b.heights.wallTop);
      for (const hole of b.holes) collide.loop(hole, g - 0.5, g + b.heights.top);
    }

    buildBarriers(fs.barriers, ctx, multi, collide);
    chunk.lights = buildProps(fs.props, ctx, multi, collide);

    // Vegetation.
    const trees = collectTrees(fs, chunk, ctx);
    buildTreeInstances(trees, ctx, chunk.group, collide);

    // Water is transparent and goes in its own mesh so it sorts correctly.
    chunk.waterMesh = buildWater(fs.waterAreas, fs.waterways, ctx, chunk.group, collide);

    for (const mesh of multi.build()) chunk.group.add(mesh);
    chunk.triangles = multi.triangleCount;

    chunk.collider = collide.build(`collide ${chunk.key}`);
    if (chunk.collider) this.collisionWorld.set(chunk.key, chunk.collider, 'world');

    chunk.state = 'ready';
    chunk.group.visible = this.visible !== false;
    chunk.buildMs = performance.now() - t0;
    this.stats.lastBuildMs = chunk.buildMs;
    // Rolling average, so the build budget can size itself to what chunks are
    // actually costing on this machine rather than to a guess.
    this.stats.avgBuildMs = this.stats.avgBuildMs
      ? this.stats.avgBuildMs * 0.8 + chunk.buildMs * 0.2
      : chunk.buildMs;
    this.scene.add(chunk.group);
    chunk.group.updateMatrixWorld(true);
    this.chunks.set(chunk.key, chunk);
    this.chunkDetail = null;              // back to the quality setting

    if (restaurantMediaTargets.length) {
      this.decorateRestaurantMedia(chunk, restaurantMediaTargets);
    }

    // Satellite drape arrives asynchronously and swaps in when it lands.
    if (this.settings.graphics.groundStyle === 'aerial') this.drapeImagery(chunk);

    return chunk;
  }

  /** Add optional Commons/Wikidata restaurant media after core geometry lands. */
  async decorateRestaurantMedia(chunk, targets) {
    if (!chunk || chunk.restaurantMediaPending) return;
    chunk.restaurantMediaPending = true;
    const unique = [];
    const seen = new Set();
    for (const target of targets) {
      const r = target.restaurant;
      const key = `${r.id || ''}|${r.name || ''}|${r.wikidata || ''}|${r.image || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(target);
      if (unique.length >= 6) break; // protect dense food courts from request storms
    }

    await Promise.allSettled(unique.map(async (target) => {
      const media = await resolveRestaurantMedia(target.restaurant);
      const current = this.chunks.get(chunk.key);
      if (!media) return;
      if (current !== chunk || chunk.state !== 'ready') {
        if (media.image && typeof media.image.close === 'function') media.image.close();
        return;
      }
      const mesh = makeRestaurantMediaMesh(media, target);
      if (!mesh) {
        if (media.image && typeof media.image.close === 'function') media.image.close();
        return;
      }
      chunk.group.add(mesh);
      mesh.updateMatrixWorld(true);
      this.restaurantMediaCredits.set(media.sourceUrl, {
        restaurant: target.restaurant.name || target.restaurant.brand || 'Restaurant',
        title: media.title,
        artist: media.attribution || media.artist,
        licence: media.licence,
        licenceUrl: media.licenceUrl,
        sourceUrl: media.sourceUrl,
      });
    }));
    if (this.chunks.get(chunk.key) === chunk) chunk.restaurantMediaPending = false;
  }

  async drapeImagery(chunk) {
    try {
      const tex = await fetchChunkImagery(chunk, this.projection, 512);
      if (!tex || !this.chunks.has(chunk.key)) { if (tex) tex.dispose(); return; }
      const mesh = chunk.group.getObjectByName('terrain');
      if (!mesh) { tex.dispose(); return; }
      mesh.material = this.materials.terrain(tex);
      // Fade the vertex tint back so the photograph dominates but still picks
      // up the biome colour where imagery is poor.
      const colours = mesh.geometry.getAttribute('color');
      if (colours) {
        for (let i = 0; i < colours.count; i++) {
          colours.setXYZ(i,
            lerp(colours.getX(i), 0.85, 0.75),
            lerp(colours.getY(i), 0.85, 0.75),
            lerp(colours.getZ(i), 0.85, 0.75));
        }
        colours.needsUpdate = true;
      }
      // Flat roofs were built with UVs in this chunk's frame, so the same
      // photograph drops straight onto them, aligned to the buildings.
      const roofs = chunk.group.getObjectByName('roof:aerial');
      if (roofs) {
        const previous = roofs.material;
        roofs.material = this.materials.aerialRoof(tex);
        if (previous && previous !== this.materials.roof('flat')) previous.dispose();
      }
      chunk.imageryTexture = tex;
    } catch (e) { /* imagery is a bonus, never a blocker */ }
  }

  /**
   * A sensible place to start: on a footway or a quiet street near the
   * requested point, rather than in the middle of whichever building happens
   * to sit on the coordinates. Returns `{x, z}` in local metres.
   *
   * This is the first of the ranked list; prefer `spawnCandidates` when the
   * world is built and you can check a spot against real geometry.
   */
  findSpawnPoint(x = 0, z = 0, maxDist = 160) {
    return this.spawnCandidates(x, z, maxDist)[0] || { x, z };
  }

  /**
   * Places to start, best first.
   *
   * A road is the good answer - you want to begin on a pavement looking down a
   * street. But plenty of points have no road within reach, and the fallback
   * used to be the coordinates as given, which is precisely the case where
   * those coordinates are the middle of a building: search a landmark by name
   * and Nominatim hands back a point inside it. So there is a real fallback
   * now, and callers get a list rather than one guess, because whether a spot
   * is genuinely clear cannot be settled until the chunks around it exist.
   */
  spawnCandidates(x = 0, z = 0, maxDist = 160) {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const candidates = [];
    const buildings = [];

    // Every building that could contain a spawn point, gathered once from the
    // regions rather than from the chunk index. Chunks hold a building under
    // the chunk containing its *centroid*, which quietly misses the block-sized
    // ones whose middle is three chunks away but whose footprint covers exactly
    // where we are about to stand - and those are the buildings you most want
    // not to wake up inside.
    const reach = maxDist + 60;
    for (const fs of this.regionFeatures.values()) {
      for (const b of fs.buildings) {
        const bb = b.bounds;
        if (bb.maxX < x - reach || bb.minX > x + reach ||
            bb.maxZ < z - reach || bb.minZ > z + reach) continue;
        buildings.push(b);
      }
    }

    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const fs = this.chunkFeatures.get(`${cx + dx},${cz + dz}`);
        if (!fs) continue;
        for (const road of fs.roads) {
          const spec = road.spec;
          if (spec.tunnel || spec.bridge || spec.steps) continue;
          // Somewhere you would actually stand: pavements and quiet streets
          // first, dual carriageways last.
          const preference = spec.kind === 'foot' ? 0
            : spec.kind === 'plaza' ? 2
            : spec.kind === 'cycle' ? 12
            : spec.kind === 'street' ? 18
            : spec.kind === 'service' ? 26
            : spec.kind === 'track' ? 34
            : 90;
          for (let i = 0; i < road.pts.length; i++) {
            const p = road.pts[i];
            const d = Math.hypot(p[0] - x, p[1] - z);
            if (d > maxDist) continue;
            // Direction along the way, for stepping onto the pavement.
            const q = road.pts[i + 1] || road.pts[i - 1] || p;
            candidates.push({ x: p[0], z: p[1], dx: q[0] - p[0], dz: q[1] - p[1],
                              width: spec.width, kind: spec.kind, score: d + preference });
          }
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);

    const insideAnyBuilding = (px, pz) => {
      for (const b of buildings) {
        const bb = b.bounds;
        if (px < bb.minX || px > bb.maxX || pz < bb.minZ || pz > bb.maxZ) continue;
        if (pointInPolygon(b.ring, b.holes, px, pz)) return true;
      }
      return false;
    };

    // How far the nearest footprint is, so a spot in the open beats one in a
    // gap between two walls that the capsule cannot actually fit through.
    const clearance = (px, pz, cap = 6) => {
      let best = cap;
      for (const b of buildings) {
        const bb = b.bounds;
        if (px < bb.minX - cap || px > bb.maxX + cap ||
            pz < bb.minZ - cap || pz > bb.maxZ + cap) continue;
        const ring = b.ring;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const ax = ring[j][0], az = ring[j][1];
          const ex = ring[i][0] - ax, ez = ring[i][1] - az;
          const len2 = ex * ex + ez * ez || 1;
          const t = clamp(((px - ax) * ex + (pz - az) * ez) / len2, 0, 1);
          const d = Math.hypot(px - (ax + ex * t), pz - (az + ez * t));
          if (d < best) best = d;
        }
      }
      return best;
    };

    const out = [];
    // Step to either side of the carriageway. Checking against the footprints
    // matters: offsetting blindly lands you inside the building on whichever
    // side it happens to be, and starting a walking simulator embedded in a
    // wall is a poor opening.
    for (const c of candidates.slice(0, 240)) {
      const len = Math.hypot(c.dx, c.dz) || 1;
      const nx = c.dz / len, nz = -c.dx / len;
      const offsets = c.kind === 'foot' || c.kind === 'plaza'
        ? [0, 1.2, -1.2]
        : [c.width / 2 + 1.1, -(c.width / 2 + 1.1), 0];
      for (const o of offsets) {
        const px = c.x + nx * o, pz = c.z + nz * o;
        if (insideAnyBuilding(px, pz)) continue;
        if (clearance(px, pz) < 0.9) continue;   // a slot too narrow to stand in
        out.push({ x: px, z: pz });
        break;                                   // one spot per road point
      }
      if (out.length >= 24) break;
    }

    // No road answered - either there are none nearby or every one of them is
    // hemmed in. Sweep outward for open ground instead of handing back the
    // requested point, which is the one place we already know may be a
    // building: searching for a landmark by name gives a coordinate inside it.
    if (!out.length) {
      for (let r = 6; r <= maxDist && out.length < 8; r += 6) {
        const steps = Math.max(8, Math.round((2 * Math.PI * r) / 6));
        for (let i = 0; i < steps && out.length < 8; i++) {
          const a = (i / steps) * Math.PI * 2;
          const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
          if (insideAnyBuilding(px, pz)) continue;
          if (clearance(px, pz) < 1.4) continue;
          out.push({ x: px, z: pz });
        }
      }
    }

    // Still nothing: the road centreline beats the raw coordinate, and the raw
    // coordinate is the last resort rather than the first answer.
    if (!out.length && candidates.length) out.push({ x: candidates[0].x, z: candidates[0].z });
    if (!out.length) out.push({ x, z });
    return out;
  }

  /** Nearest named road to a point, for the HUD. */
  nearestRoadName(x, z, maxDist = 30) {
    let best = null, bestD = maxDist * maxDist;
    const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    for (const dz of [-1, 0, 1]) {
      for (const dx of [-1, 0, 1]) {
        const fs = this.chunkFeatures.get(
          `${Math.floor(x / CHUNK_SIZE) + dx},${Math.floor(z / CHUNK_SIZE) + dz}`);
        if (!fs) continue;
        for (const r of fs.roads) {
          if (!r.name) continue;
          for (const p of r.pts) {
            const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
            if (d < bestD) { bestD = d; best = r.name; }
          }
        }
      }
    }
    return best;
  }

  /** Buildings whose door is within `radius` of a point. */
  nearbyDoors(x, z, radius = 3.2) {
    const out = [];
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const fs = this.chunkFeatures.get(`${cx + dx},${cz + dz}`);
        if (!fs) continue;
        for (const b of fs.buildings) {
          if (!b.door) continue;
          const d = Math.hypot(b.door.x - x, b.door.z - z);
          if (d <= radius) out.push({ building: b, distance: d });
        }
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** Named POIs near a point, for the HUD and the journal. */
  nearbyPois(x, z, radius = 30) {
    const out = [];
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const fs = this.chunkFeatures.get(`${cx + dx},${cz + dz}`);
        if (!fs) continue;
        for (const p of fs.pois) {
          const d = Math.hypot(p.x - x, p.z - z);
          if (d <= radius) out.push({ ...p, distance: d });
        }
        for (const b of fs.buildings) {
          if (!b.name) continue;
          const d = Math.hypot(b.centroid[0] - x, b.centroid[1] - z);
          if (d <= radius) out.push({ name: b.name, x: b.centroid[0], z: b.centroid[1], distance: d, category: b.kind });
        }
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
  }

  /** Am I standing in water, and how deep? */
  waterAt(x, z) {
    const chunk = this.chunks.get(`${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`);
    if (!chunk || !chunk.waterMesh) return null;
    for (const s of chunk.waterMesh.userData.waterSurfaces) {
      if (pointInPolygon(s.ring, s.holes, x, z)) {
        const bed = this.terrainAt(x, z);
        return { level: s.level, depth: Math.max(0, s.level - bed), name: s.name };
      }
    }
    return null;
  }

  /**
   * Show or hide everything outdoors.
   *
   * Used by the interior cells: while you are inside a building the entire
   * outdoor world stops being drawn, which is most of the point of loading
   * interiors as cells rather than keeping them all resident.
   */
  setVisible(visible) {
    this.visible = visible;
    for (const chunk of this.chunks.values()) chunk.group.visible = visible;
    if (this.groundCover.mesh) this.groundCover.mesh.visible = visible;
  }

  /** Total geometry currently resident, for the debug overlay. */
  refreshStats() {
    let tris = 0;
    for (const c of this.chunks.values()) tris += c.triangles;
    this.stats.triangles = tris;
    return this.stats;
  }
}

// --- helpers ---------------------------------------------------------------

/** Lowest terrain sample around a ring. */
function lowestGround(ring, terrainAt) {
  let min = Infinity;
  const step = Math.max(1, Math.floor(ring.length / 16));
  for (let i = 0; i < ring.length; i += step) {
    min = Math.min(min, terrainAt(ring[i][0], ring[i][1]));
  }
  return isFinite(min) ? min : 0;
}

/** Clip a ring to an axis-aligned rectangle. */
function clipRect(ring, x0, z0, x1, z1) {
  let r = clipHalfPlane(ring, -1, 0, -x0);
  if (r.length < 3) return r;
  r = clipHalfPlane(r, 1, 0, x1);
  if (r.length < 3) return r;
  r = clipHalfPlane(r, 0, -1, -z0);
  if (r.length < 3) return r;
  return clipHalfPlane(r, 0, 1, z1);
}

/**
 * Take the slice of a parent way's vertical profile that corresponds to a
 * chunk-clipped piece of it, so a bridge split across chunks still lines up.
 */
function sliceProfile(piece, parent, parentProfile) {
  const n = piece.pts.length;
  const heights = new Float64Array(n);
  const ground = new Float64Array(n);
  const shape = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Match by identity first - the clipper reuses point objects - then by
    // nearest position for any interpolated endpoint.
    let idx = parent.pts.indexOf(piece.pts[i]);
    if (idx < 0) {
      let bestD = Infinity;
      for (let j = 0; j < parent.pts.length; j++) {
        const d = (parent.pts[j][0] - piece.pts[i][0]) ** 2 + (parent.pts[j][1] - piece.pts[i][1]) ** 2;
        if (d < bestD) { bestD = d; idx = j; }
      }
    }
    heights[i] = parentProfile.heights[idx];
    ground[i] = parentProfile.ground[idx];
    shape[i] = parentProfile.shape ? parentProfile.shape[idx] : 1;
  }
  return {
    heights, ground, shape,
    kind: parentProfile.kind,
    clearance: parentProfile.clearance,
    offset: parentProfile.offset,
  };
}

/** Fold a second extraction pass into an existing feature set. */
function mergeFeatures(target, extra) {
  for (const key of Object.keys(target)) {
    if (Array.isArray(target[key]) && Array.isArray(extra[key])) {
      target[key].push(...extra[key]);
    }
  }
}

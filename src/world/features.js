// Turning OSM elements into typed, metric, ready-to-build features.
//
// This is the seam between "what the mappers wrote" and "what the geometry
// builders need". Everything here works in local metres and carries a resolved
// spec from osm-tags.js, so the mesh builders never have to look at a raw tag.
//
// The interesting work is vertical. OSM's `layer` is an ordering hint, not an
// elevation, so tunnels and bridges need real profiles inventing for them, and
// the honest way to do that turns out to depend on the terrain:
//
//   * A road tunnel through a hill is not "the road, six metres down". The road
//     runs roughly level between its two portals and the *ground* climbs over
//     it. Interpolating portal to portal reproduces that exactly: you enter the
//     hillside at grade and come out the far side at grade.
//
//   * An urban underpass has no hill to go under, so the same interpolation
//     leaves it flat at street level. When we detect that there is not enough
//     ground above the line, we dig a smooth dip instead.
//
//   * Bridges are the same problem mirrored: over a valley the portal-to-portal
//     line is already high, and over a flat junction it needs a hump.

import {
  roadSpec, railSpec, barrierSpec, landcoverSpec, buildingHeights, facadeSpec,
  isWater, waterwayWidth, layerOffset, featureRng, parseLength, parseCount,
  isTruthy, lookupSurface, parseColour, describesItself, buildingEra,
  BUILDING_CLASSES,
} from './osm-tags.js';
import {
  area, centroid, cleanRing, simplify, assembleRings, classifyRings, bounds,
  polygonArea, polylineLength, resample, orientedBounds, pointInRing,
  pointInPolygon,
} from './geometry.js';
import { clamp, lerp, smoothstep } from '../core/util.js';

/** Minimum ground clearance over a tunnel, and under a bridge deck, in metres. */
const TUNNEL_CLEARANCE = 5.0;
const BRIDGE_CLEARANCE = 5.2;
const FOOT_TUNNEL_CLEARANCE = 3.4;
const FOOT_BRIDGE_CLEARANCE = 3.6;

/**
 * Vertical profile for a layered way.
 *
 * `pts` are local metres and `terrainAt(x, z)` samples ground height.
 * `endsAtGrade` is `[startMeetsStreetLevel, endMeetsStreetLevel]`, taken from
 * the junction index: a deck that meets another deck stays up, one that meets
 * the street has to ramp down or it ends in a cliff.
 *
 * The shape is a ramp, a plateau, and a ramp - not a bell. That distinction
 * matters: a bell only reaches full clearance at one point, so a bell-shaped
 * flyover still clips the road it is meant to cross everywhere except dead
 * centre. The plateau is sized so the *minimum* clearance along it is the one
 * we asked for.
 *
 * Returns heights, the sampled ground, and a `kind` the mesh builder uses to
 * decide whether to draw portals, a tube, or piers.
 */
export function verticalProfile(pts, terrainAt, spec, endsAtGrade = [true, true]) {
  const n = pts.length;
  const heights = new Float64Array(n);
  const groundAt = new Float64Array(n);
  for (let i = 0; i < n; i++) groundAt[i] = terrainAt(pts[i][0], pts[i][1]);

  const isTunnel = !!spec.tunnel;
  const isBridge = !!spec.bridge;
  if (!isTunnel && !isBridge) {
    const off = layerOffset(spec);
    for (let i = 0; i < n; i++) heights[i] = groundAt[i] + off;
    return { heights, ground: groundAt, kind: off === 0 ? 'grade' : 'layered', clearance: 0, offset: off };
  }
  if (spec.tunnel === 'building_passage') {
    for (let i = 0; i < n; i++) heights[i] = groundAt[i];
    return { heights, ground: groundAt, kind: 'passage', clearance: 0, offset: 0 };
  }

  // Arc length along the way.
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    s[i] = s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const total = s[n - 1] || 1;

  // Baseline: straight from one end to the other. On its own this is already
  // the right answer for a tunnel bored through a hill or a bridge over a
  // gorge - the ground rises over it, or falls away beneath it, for free.
  const baseline = new Float64Array(n);
  const h0 = groundAt[0], h1 = groundAt[n - 1];
  for (let i = 0; i < n; i++) baseline[i] = lerp(h0, h1, s[i] / total);

  const foot = spec.kind === 'foot' || spec.kind === 'cycle' || spec.kind === 'steps';
  const want = isTunnel
    ? (foot ? FOOT_TUNNEL_CLEARANCE : TUNNEL_CLEARANCE)
    : (foot ? FOOT_BRIDGE_CLEARANCE : BRIDGE_CLEARANCE);
  const extraLayers = Math.max(0, Math.abs(spec.layer) - 1) * 4.5;

  // Ramp length: enough to stay walkable (10% grade), but never more than a
  // third of the way, so a short bridge still gets a flat middle.
  const nominal = want + extraLayers;
  const rampLen = Math.min(total * 0.34, Math.max(8, nominal / 0.1));
  const rampStart = endsAtGrade[0] ? rampLen : 0;
  const rampEnd = endsAtGrade[1] ? rampLen : 0;

  const shape = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dStart = s[i];
    const dEnd = total - s[i];
    let f = 1;
    if (rampStart > 0) f = Math.min(f, dStart / rampStart);
    if (rampEnd > 0) f = Math.min(f, dEnd / rampEnd);
    shape[i] = smoothstep(clamp(f, 0, 1));
  }

  // Is the structure already enclosed by the landscape? Look at the best point
  // in the middle, not the worst: a bored tunnel has nearly no cover at its
  // portals by definition, and demanding cover there would turn every hillside
  // tunnel into a trench. What makes it a tunnel is that the ground closes over
  // it *somewhere*.
  let bestMiddle = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = s[i] / total;
    if (t < 0.2 || t > 0.8) continue;
    const gap = isTunnel ? groundAt[i] - baseline[i] : baseline[i] - groundAt[i];
    if (gap > bestMiddle) bestMiddle = gap;
  }
  if (!isFinite(bestMiddle)) {
    const mid = Math.floor(n / 2);
    bestMiddle = isTunnel ? groundAt[mid] - baseline[mid] : baseline[mid] - groundAt[mid];
  }

  let need = 0;
  if (bestMiddle < want) {
    // Nothing to hide under (or fly over). Size the offset so the *tightest*
    // point of the plateau gets the clearance, not merely the midpoint - a
    // mid-peaked curve leaves a flyover clipping the road it crosses at every
    // other point along the span.
    //
    // Dividing by `shape` matters: the plateau is only flat to within a
    // rounding tolerance, and sizing the lift as if shape were exactly 1 while
    // applying 0.999 leaves the deck a few centimetres short of clearing.
    let bestShape = 0, fallback = 0;
    for (let i = 0; i < n; i++) {
      const d = isTunnel
        ? (baseline[i] - (groundAt[i] - want))          // how far down we must go
        : ((groundAt[i] + want) - baseline[i]);         // how far up
      if (shape[i] >= 0.999) {
        const scaled = d / shape[i];
        if (scaled > need) need = scaled;
      } else if (shape[i] > bestShape) {
        // Very short way: the ramps meet and there is no true plateau.
        bestShape = shape[i];
        fallback = d / Math.max(0.2, shape[i]);
      }
    }
    if (need === 0 && bestShape > 0) need = fallback;
  }
  // Stacked layers go further out still, on top of whatever clearance needs.
  const offset = Math.max(0, need) + extraLayers;

  let kind;
  if (need <= 1e-9) kind = isTunnel ? 'bored' : 'span';
  else kind = isTunnel ? 'cut' : 'flyover';

  const sign = isTunnel ? -1 : 1;
  for (let i = 0; i < n; i++) heights[i] = baseline[i] + sign * offset * shape[i];

  // Then enforce the constraint pointwise.
  //
  // Deciding "is this already buried?" from the *deepest* cover along the way
  // is right for a short bore through a single hill, and badly wrong for a
  // Metro line 700 points long: it passes under one rise, is declared bored,
  // and then surfaces in the middle of the road every time the ground drops
  // away. A tunnel has to be under the ground *everywhere*, not somewhere, and
  // a bridge deck over it everywhere.
  //
  // Scaling the requirement by `shape` is what keeps portals working: at the
  // ends of a bored tunnel the shape falls to zero, the constraint relaxes with
  // it, and the roadway is allowed to meet daylight exactly where it should.
  for (let i = 0; i < n; i++) {
    const margin = want * shape[i];
    if (isTunnel) heights[i] = Math.min(heights[i], groundAt[i] - margin);
    else heights[i] = Math.max(heights[i], groundAt[i] + margin);
  }

  return { heights, ground: groundAt, baseline, shape, kind, clearance: want, offset };
}

/** Discrete step heights for a `highway=steps` way. */
export function stepProfile(pts, heights, spec) {
  const len = polylineLength(pts);
  const rise = heights[heights.length - 1] - heights[0];
  let count = spec.stepCount;
  if (!count || count < 2) count = Math.max(2, Math.round(Math.abs(rise) / 0.17));
  count = clamp(Math.round(count), 2, 400);
  const treadDepth = len / count;
  return { count, rise: rise / count, treadDepth, totalRise: rise, length: len };
}

// --- extraction ------------------------------------------------------------

/**
 * A bundle of typed features in local metres, ready for the mesh builders.
 * `seen` lets a second region skip anything an earlier one already produced.
 */
export class FeatureSet {
  constructor() {
    this.buildings = [];
    this.buildingParts = [];
    this.roads = [];
    this.rails = [];
    this.waterAreas = [];
    this.waterways = [];
    this.landcover = [];
    this.barriers = [];
    this.trees = [];
    this.treeRows = [];
    this.props = [];
    this.pois = [];
    this.entrances = [];
  }

  get count() {
    return this.buildings.length + this.roads.length + this.rails.length +
           this.waterAreas.length + this.landcover.length + this.barriers.length +
           this.trees.length + this.props.length;
  }
}

/** Convert a way's lat/lon coords to local metres. */
function toLocal(projection, coords) {
  const out = new Array(coords.length);
  for (let i = 0; i < coords.length; i++) {
    out[i] = [projection.toLocalX(coords[i][1]), projection.toLocalZ(coords[i][0])];
  }
  return out;
}

/**
 * Extract every renderable feature from an OSM model.
 *
 * `opts.seen` is a Set of `type:id` keys already produced by another region;
 * anything in it is skipped, which is what stops the overlap margin between
 * regions from drawing every seam building twice.
 */
export function extractFeatures(osm, projection, opts = {}) {
  const {
    seen = new Set(),
    simplifyTolerance = 0.35,
    minBuildingArea = 6,
    maxRoadSegment = 9,
  } = opts;
  const fs = new FeatureSet();

  const markSeen = (key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  // --- areas from relations (multipolygons) --------------------------------
  for (const rel of osm.relations.values()) {
    if (!rel.tags) continue;
    const key = `r:${rel.id}`;
    if (!markSeen(key)) continue;
    const frags = osm.relationFragments(rel);
    if (!frags.outer.length) continue;
    const outerRings = assembleRings(frags.outer.map((c) => toLocal(projection, c)));
    const innerRings = assembleRings(frags.inner.map((c) => toLocal(projection, c)));
    const polys = classifyRings(outerRings.concat(innerRings), outerRings, innerRings);
    // A multipolygon can legitimately yield several shells (a lake with an
    // island in it, an estate in two blocks), so each needs its own identity
    // or downstream de-duplication throws all but one away.
    polys.forEach((poly, i) => {
      const src = polys.length > 1 ? `relation/${rel.id}#${i}` : `relation/${rel.id}`;
      addArea(fs, rel.tags, poly.outer, poly.holes, src, rel.id, simplifyTolerance, minBuildingArea);
    });
  }

  // --- ways ----------------------------------------------------------------
  for (const way of osm.ways.values()) {
    const tags = way.tags;
    if (!tags) continue;
    const key = `w:${way.id}`;
    if (!markSeen(key)) continue;

    const coords = osm.wayCoords(way);
    if (coords.length < 2) continue;
    const pts = toLocal(projection, coords);
    const closed = osm.isClosed(way) || (pts.length > 3 &&
      Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.2);

    if (tags.highway) {
      const spec = roadSpec(tags);
      if (spec.area && closed) {
        // A pedestrian square mapped as an area, not a line.
        const ring = cleanRing(pts);
        if (ring.length >= 3 && area(ring) > 2) {
          fs.landcover.push({
            id: way.id, source: `way/${way.id}`, ring, holes: [],
            spec: { tint: spec.surface.tint, veg: 0.02, z: 5, cover: 'paved', surface: spec.surface, key: `highway=${tags.highway}` },
            name: tags.name || null, area: area(ring),
          });
        }
        continue;
      }
      const line = simplify(pts, simplifyTolerance * 0.6, false);
      if (polylineLength(line) < 0.7) continue;
      fs.roads.push({
        id: way.id,
        source: `way/${way.id}`,
        pts: resample(line, maxRoadSegment),
        rawPts: line,
        spec,
        tags,
        closed,
        startRef: way.refs[0],
        endRef: way.refs[way.refs.length - 1],
        startJunction: (osm.nodeWayCount.get(way.refs[0]) || 0) > 1,
        endJunction: (osm.nodeWayCount.get(way.refs[way.refs.length - 1]) || 0) > 1,
        endsAtGrade: [
          osm.touchesGrade(way.refs[0]),
          osm.touchesGrade(way.refs[way.refs.length - 1]),
        ],
        name: spec.name,
      });
      continue;
    }

    if (tags.railway) {
      const spec = railSpec(tags);
      if (!spec) continue;
      const line = simplify(pts, simplifyTolerance * 0.6, false);
      if (polylineLength(line) < 2) continue;
      fs.rails.push({
        id: way.id, source: `way/${way.id}`,
        pts: resample(line, maxRoadSegment), spec, tags,
        startJunction: (osm.nodeWayCount.get(way.refs[0]) || 0) > 1,
        endJunction: (osm.nodeWayCount.get(way.refs[way.refs.length - 1]) || 0) > 1,
        endsAtGrade: [
          osm.touchesGrade(way.refs[0]),
          osm.touchesGrade(way.refs[way.refs.length - 1]),
        ],
        name: spec.name,
      });
      continue;
    }

    if (tags.waterway && !closed) {
      const kindsWithWidth = ['river', 'stream', 'canal', 'ditch', 'drain'];
      if (kindsWithWidth.includes(tags.waterway)) {
        const line = simplify(pts, simplifyTolerance, false);
        if (polylineLength(line) < 3) continue;
        fs.waterways.push({
          id: way.id, source: `way/${way.id}`,
          pts: resample(line, 12),
          width: waterwayWidth(tags),
          tunnel: !!tags.tunnel && tags.tunnel !== 'no',
          name: tags.name || null,
          tags,
        });
      }
      continue;
    }

    if (tags.natural === 'tree_row') {
      const line = simplify(pts, 0.5, false);
      if (line.length >= 2) {
        fs.treeRows.push({
          id: way.id, pts: line,
          spacing: parseLength(tags['spacing']) || 8,
          species: tags['species'] || tags['genus'] || null,
          leafType: tags['leaf_type'] || null,
          height: parseLength(tags['height']),
        });
      }
      continue;
    }

    if (tags.barrier && !closed) {
      const spec = barrierSpec(tags);
      if (!spec) continue;
      const line = simplify(pts, simplifyTolerance * 0.5, false);
      if (polylineLength(line) < 0.6) continue;
      fs.barriers.push({ id: way.id, source: `way/${way.id}`, pts: line, spec, tags });
      continue;
    }

    if (closed) {
      const ring = cleanRing(pts);
      if (ring.length < 3) continue;
      addArea(fs, tags, ring, [], `way/${way.id}`, way.id, simplifyTolerance, minBuildingArea);
      // A closed barrier is both an area and a fence around it.
      if (tags.barrier) {
        const spec = barrierSpec(tags);
        if (spec) fs.barriers.push({ id: way.id, source: `way/${way.id}`, pts: ring.concat([ring[0]]), spec, tags });
      }
    }
  }

  // --- nodes ---------------------------------------------------------------
  for (const node of osm.nodes.values()) {
    const tags = node.tags;
    if (!tags) continue;
    const key = `n:${node.id}`;
    if (!markSeen(key)) continue;
    const x = projection.toLocalX(node.lon);
    const z = projection.toLocalZ(node.lat);

    if (tags.natural === 'tree') {
      fs.trees.push({
        id: node.id, x, z,
        height: parseLength(tags['height']),
        circumference: parseLength(tags['circumference']),
        diameter: parseLength(tags['diameter_crown']),
        species: tags['species'] || tags['genus'] || null,
        leafType: tags['leaf_type'] || null,
        leafCycle: tags['leaf_cycle'] || null,
        denotation: tags['denotation'] || null,
      });
      continue;
    }

    if (tags.entrance) {
      fs.entrances.push({ id: node.id, x, z, kind: tags.entrance, tags });
      continue;
    }

    // Street furniture, signage, hydrants - anything that becomes a prop.
    const propKind = classifyProp(tags);
    if (propKind) {
      fs.props.push({ id: node.id, x, z, kind: propKind, tags, name: tags.name || null });
    }

    if (tags.name && (tags.amenity || tags.shop || tags.tourism || tags.historic || tags.leisure)) {
      fs.pois.push({
        id: node.id, x, z, name: tags.name,
        category: tags.amenity || tags.shop || tags.tourism || tags.historic || tags.leisure,
        tags,
      });
    }
  }

  return fs;
}

/** Route a closed ring to the right feature list based on its tags. */
function addArea(fs, tags, ring, holes, source, id, tol, minBuildingArea) {
  const cleaned = cleanRing(ring);
  if (cleaned.length < 3) return;
  const a = area(cleaned);
  if (a < 0.5) return;

  if (tags.building || tags['building:part']) {
    if (a < minBuildingArea) return;
    const simplified = simplify(cleaned, Math.min(tol, 0.25), true);
    const ringOut = simplified.length >= 3 ? simplified : cleaned;
    const rng = featureRng('b', id);
    const heights = buildingHeights(tags, a, rng);
    const facade = facadeSpec(tags, heights.cls, rng);
    const rec = {
      id, source, ring: ringOut, holes: holes.map((h) => cleanRing(h)).filter((h) => h.length >= 3),
      area: a, tags, heights, facade,
      name: tags.name || null,
      centroid: centroid(ringOut),
      bounds: bounds(ringOut),
      isPart: !!tags['building:part'] && !tags.building,
      levels: heights.levels,
      kind: heights.cls.kind,
      era: buildingEra(tags),
    };
    if (rec.isPart) fs.buildingParts.push(rec);
    else fs.buildings.push(rec);
    return;
  }

  if (isWater(tags)) {
    const simplified = simplify(cleaned, tol, true);
    fs.waterAreas.push({
      id, source, ring: simplified.length >= 3 ? simplified : cleaned,
      holes: holes.map((h) => simplify(cleanRing(h), tol, true)).filter((h) => h.length >= 3),
      area: a, tags, name: tags.name || null,
      salt: tags.salt === 'yes' || tags.natural === 'bay' || tags.natural === 'strait',
    });
    return;
  }

  const cover = landcoverSpec(tags);
  if (cover) {
    const simplified = simplify(cleaned, tol, true);
    fs.landcover.push({
      id, source, ring: simplified.length >= 3 ? simplified : cleaned,
      holes: holes.map((h) => simplify(cleanRing(h), tol, true)).filter((h) => h.length >= 3),
      area: a, spec: cover, tags, name: tags.name || null,
    });
  }
}

// --- Overture building merge ----------------------------------------------

function parsedOvertureSources(properties) {
  const value = properties && properties.sources;
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) { return []; }
}

function osmSourceKeys(properties) {
  const out = [];
  for (const source of parsedOvertureSources(properties)) {
    if (source.provider !== 'osm' && source.dataset !== 'OpenStreetMap') continue;
    const match = String(source.record_id || '').match(/^([wr])(\d+)(?:@|$)/);
    if (!match) continue;
    out.push(`${match[1] === 'w' ? 'way' : 'relation'}/${match[2]}`);
  }
  return out;
}

function overtureTags(properties) {
  const p = properties || {};
  const tags = { building: 'yes' };
  const cls = [p.class, p.subtype].find((v) => v && BUILDING_CLASSES[v]);
  if (cls) tags.building = cls;

  const copy = (key, value) => {
    if (value !== undefined && value !== null && value !== '') tags[key] = value;
  };
  copy('name', p['@name']);
  copy('height', p.height);
  copy('building:levels', p.num_floors);
  copy('min_height', p.min_height);
  copy('building:min_level', p.min_floor);
  copy('building:colour', p.facade_color);
  copy('building:material', p.facade_material);
  copy('roof:colour', p.roof_color);
  copy('roof:material', p.roof_material);
  copy('roof:shape', p.roof_shape);
  copy('roof:direction', p.roof_direction);
  copy('roof:orientation', p.roof_orientation);
  copy('roof:height', p.roof_height);
  return tags;
}

/** GeoJSON uses [longitude, latitude], unlike Overpass' [latitude, longitude]. */
function overtureToLocal(projection, coords) {
  const out = new Array(coords.length);
  for (let i = 0; i < coords.length; i++) {
    out[i] = [projection.toLocalX(coords[i][0]), projection.toLocalZ(coords[i][1])];
  }
  return out;
}

function overtureRecordToBuilding(record, projection, minBuildingArea, tol) {
  const p = record.properties || {};
  if (p.is_underground === true || p.is_underground === 'true') return null;
  const cleaned = cleanRing(overtureToLocal(projection, record.outer || []));
  if (cleaned.length < 3) return null;
  const rawHoles = (record.holes || []).map((h) => cleanRing(overtureToLocal(projection, h)))
    .filter((h) => h.length >= 3);
  const a = polygonArea(cleaned, rawHoles);
  if (a < minBuildingArea) return null;

  const simple = simplify(cleaned, Math.min(tol, 0.2), true);
  const ring = simple.length >= 3 ? simple : cleaned;
  const holes = rawHoles.map((h) => {
    const s = simplify(h, Math.min(tol, 0.2), true);
    return s.length >= 3 ? s : h;
  });
  const tags = overtureTags(p);
  const id = record.id;
  const rng = featureRng('overture', id);
  const heights = buildingHeights(tags, a, rng);
  return {
    id,
    source: `overture/${id}`,
    ring,
    holes,
    area: a,
    tags,
    heights,
    facade: facadeSpec(tags, heights.cls, rng),
    name: tags.name || null,
    centroid: centroid(ring),
    bounds: bounds(ring),
    isPart: false,
    levels: heights.levels,
    kind: heights.cls.kind,
    era: buildingEra(tags),
    overture: true,
    overtureId: record.gersId || id,
    geometrySource: p['@geometry_source'] || null,
  };
}

function boundsOverlap(a, b) {
  return a.maxX >= b.minX && a.minX <= b.maxX &&
         a.maxZ >= b.minZ && a.minZ <= b.maxZ;
}

/**
 * Approximate polygon intersection-over-union with a regular sample grid.
 * It is only used after bounding-box and spatial-grid rejection, so the cost
 * is paid for the handful of footprints that could genuinely be duplicates.
 */
export function approximateBuildingIoU(a, b, samples = 12) {
  if (!boundsOverlap(a.bounds, b.bounds)) return 0;
  const minX = Math.min(a.bounds.minX, b.bounds.minX);
  const minZ = Math.min(a.bounds.minZ, b.bounds.minZ);
  const maxX = Math.max(a.bounds.maxX, b.bounds.maxX);
  const maxZ = Math.max(a.bounds.maxZ, b.bounds.maxZ);
  const dx = (maxX - minX) / samples;
  const dz = (maxZ - minZ) / samples;
  if (dx <= 0 || dz <= 0) return 0;

  let intersection = 0, union = 0;
  for (let iz = 0; iz < samples; iz++) {
    const z = minZ + (iz + 0.5) * dz;
    for (let ix = 0; ix < samples; ix++) {
      const x = minX + (ix + 0.5) * dx;
      const inA = pointInPolygon(a.ring, a.holes, x, z);
      const inB = pointInPolygon(b.ring, b.holes, x, z);
      if (inA || inB) union++;
      if (inA && inB) intersection++;
    }
  }
  return union ? intersection / union : 0;
}

function enrichOsmBuilding(building, record) {
  const incoming = overtureTags(record.properties);
  const tags = { ...(building.tags || {}) };
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    const replaceGenericClass = key === 'building' && tags[key] === 'yes' && value !== 'yes';
    if ((tags[key] === undefined || tags[key] === null || tags[key] === '' || replaceGenericClass) &&
        value !== undefined && value !== null && value !== '') {
      tags[key] = value;
      changed = true;
    }
  }
  if (!changed) return false;

  const rng = featureRng('b', building.id);
  const heights = buildingHeights(tags, building.area, rng);
  building.tags = tags;
  building.heights = heights;
  building.facade = facadeSpec(tags, heights.cls, rng);
  building.name = tags.name || building.name || null;
  building.levels = heights.levels;
  building.kind = heights.cls.kind;
  building.era = buildingEra(tags);
  building.overtureEnriched = true;
  building.overtureId = record.gersId || record.id;
  return true;
}

/**
 * Merge decoded Overture footprint records into an extracted OSM FeatureSet.
 *
 * Precedence is deliberately strict:
 *   1. a live OSM way/relation is kept and may receive missing attributes;
 *   2. Overture features whose chosen geometry source is OSM are not copied;
 *   3. non-OSM footprints matching a newly-added live OSM shape are dropped;
 *   4. only the remaining real footprints fill gaps in OSM coverage.
 */
/**
 * Add streets from Overture's transportation theme.
 *
 * Used only where the Overpass half of a region failed. Roads are not deduped
 * against OSM the way buildings are - buildings carry a GERS id that names the
 * OSM feature they came from, and a street has no equally exact handle - so
 * running both sources at once risks drawing every road twice, slightly
 * offset. Restricting this to regions with no OSM at all sidesteps that
 * entirely and is what the fallback is for: not a better map, a map at all.
 *
 * Overture's `class` is OSM's `highway` value by another name, so each segment
 * is given a synthesised tag set and passed through the same roadSpec every
 * OSM way goes through. Everything downstream - widths, kerbs, markings,
 * grading, the spawn search - then works unchanged.
 */
export function mergeOvertureRoads(fs, records, projection, opts = {}) {
  const { seen = new Set(), maxRoadSegment = 14, simplifyTolerance = 0.25 } = opts;
  let added = 0;
  if (!records || !records.length) return added;

  for (const record of records) {
    const source = `overture-seg/${record.id}`;
    if (seen.has(source)) continue;

    const props = record.properties || {};
    const tags = { highway: props.class };
    // `names` arrives as a JSON object on the tile; the primary is the one a
    // street sign would carry.
    const names = typeof props.names === 'string' ? safeJson(props.names) : props.names;
    if (names && names.primary) tags.name = names.primary;
    else if (props['@name']) tags.name = props['@name'];
    if (typeof props.road_surface === 'string' && !props.road_surface.startsWith('[')) {
      tags.surface = props.road_surface;
    }

    const spec = roadSpec(tags);
    if (!spec.cls) continue;

    const pts = [];
    for (const c of record.coords) {
      pts.push([projection.toLocalX(c[1]), projection.toLocalZ(c[0])]);
    }
    const line = simplify(pts, simplifyTolerance * 0.6, false);
    if (line.length < 2 || polylineLength(line) < 0.7) continue;

    seen.add(source);
    fs.roads.push({
      id: record.id,
      source,
      pts: resample(line, maxRoadSegment),
      rawPts: line,
      spec,
      tags,
      closed: false,
      // No connector graph is read, so every end is treated as meeting the
      // street. That is the safe assumption: it ramps a bridge down rather
      // than leaving it ending in mid-air.
      startRef: null,
      endRef: null,
      startJunction: false,
      endJunction: false,
      endsAtGrade: [true, true],
      overture: true,
    });
    added++;
  }
  return added;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

export function mergeOvertureBuildings(fs, records, projection, opts = {}) {
  const { seen = new Set(), minBuildingArea = 6, simplifyTolerance = 0.25 } = opts;
  const stats = { added: 0, enriched: 0, duplicates: 0, osmGeometry: 0, invalid: 0 };
  if (!records || !records.length) return stats;

  const osmBySource = new Map();
  for (const b of fs.buildings) {
    if (!b.source || b.overture) continue;
    osmBySource.set(b.source, b);
    osmBySource.set(b.source.split('#')[0], b);
  }

  // Attribute enrichment is exact: use the OSM record id carried in the
  // Overture source list, never geometry proximity.
  const matchedRecords = new Set();
  for (const record of records) {
    for (const key of osmSourceKeys(record.properties)) {
      const building = osmBySource.get(key);
      if (!building) continue;
      if (enrichOsmBuilding(building, record)) stats.enriched++;
      matchedRecords.add(record.id);
      break;
    }
  }

  // Spatial index of live OSM footprints for the small window where OSM was
  // edited after this monthly Overture release and source ids cannot yet match.
  const CELL = 80;
  const grid = new Map();
  for (const b of fs.buildings) {
    if (b.overture) continue;
    const x0 = Math.floor(b.bounds.minX / CELL), x1 = Math.floor(b.bounds.maxX / CELL);
    const z0 = Math.floor(b.bounds.minZ / CELL), z1 = Math.floor(b.bounds.maxZ / CELL);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${x},${z}`;
        let list = grid.get(key);
        if (!list) { list = []; grid.set(key, list); }
        list.push(b);
      }
    }
  }

  for (const record of records) {
    const source = `overture/${record.id}`;
    if (seen.has(source)) continue;
    seen.add(source);

    const geomSource = String(record.properties && record.properties['@geometry_source'] || '');
    if (matchedRecords.has(record.id) || geomSource.toLowerCase() === 'openstreetmap') {
      stats.osmGeometry++;
      continue;
    }

    const candidate = overtureRecordToBuilding(record, projection, minBuildingArea, simplifyTolerance);
    if (!candidate) { stats.invalid++; continue; }

    const possible = new Set();
    const x0 = Math.floor(candidate.bounds.minX / CELL), x1 = Math.floor(candidate.bounds.maxX / CELL);
    const z0 = Math.floor(candidate.bounds.minZ / CELL), z1 = Math.floor(candidate.bounds.maxZ / CELL);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const list = grid.get(`${x},${z}`);
        if (list) for (const b of list) possible.add(b);
      }
    }
    let duplicate = false;
    for (const b of possible) {
      if (!boundsOverlap(candidate.bounds, b.bounds)) continue;
      if (approximateBuildingIoU(candidate, b) > 0.48) { duplicate = true; break; }
    }
    if (duplicate) { stats.duplicates++; continue; }

    fs.buildings.push(candidate);
    stats.added++;
  }
  return stats;
}

/** Which prop model (if any) a tagged node should become. */
function classifyProp(tags) {
  if (tags.highway === 'street_lamp') return 'streetlamp';
  if (tags.highway === 'traffic_signals') return 'traffic_signal';
  if (tags.highway === 'bus_stop' || tags.public_transport === 'platform') return 'bus_stop';
  if (tags.highway === 'crossing') return null;
  if (tags.amenity === 'bench') return 'bench';
  if (tags.amenity === 'waste_basket') return 'bin';
  if (tags.amenity === 'drinking_water' || tags.amenity === 'water_point') return 'fountain_small';
  if (tags.amenity === 'fountain') return 'fountain';
  if (tags.amenity === 'bicycle_parking') return 'bike_rack';
  if (tags.amenity === 'post_box') return 'postbox';
  if (tags.amenity === 'telephone') return 'phonebox';
  if (tags.amenity === 'shelter') return 'shelter';
  if (tags.amenity === 'clock') return 'clock';
  if (tags.emergency === 'fire_hydrant') return 'hydrant';
  if (tags.barrier === 'bollard') return 'bollard';
  if (tags.barrier === 'gate' || tags.barrier === 'lift_gate') return 'gate';
  if (tags.barrier === 'block') return 'block';
  if (tags.man_made === 'flagpole') return 'flagpole';
  if (tags.man_made === 'utility_pole' || tags.power === 'pole') return 'utility_pole';
  if (tags.power === 'tower') return 'pylon';
  if (tags.man_made === 'surveillance') return 'camera';
  if (tags.man_made === 'street_cabinet') return 'cabinet';
  if (tags.advertising === 'billboard') return 'billboard';
  if (tags.advertising) return 'ad_column';
  if (tags.natural === 'rock' || tags.natural === 'stone') return 'boulder';
  if (tags.tourism === 'information') return 'info_board';
  if (tags.historic === 'memorial' || tags.historic === 'monument') return 'monument';
  return null;
}

// --- height inference ------------------------------------------------------

/**
 * Give untagged buildings the height of their neighbours.
 *
 * Roughly a third of buildings in a well-mapped city carry no height or storey
 * count at all. Falling back to the `building=*` class default puts a six-metre
 * box in the middle of a Haussmann terrace, because `building=yes` defaults to
 * two storeys everywhere on Earth — and being wrong by four storeys in the
 * middle of a street is far more visible than being wrong about a whole
 * district would be.
 *
 * Buildings are overwhelmingly like their neighbours, so the median storey
 * count of the tagged buildings nearby is a much better estimate than any
 * global default. Where there are no tagged neighbours - open countryside, a
 * thinly mapped area - the class default stands.
 */
/**
 * Guess what an untyped building is.
 *
 * `building=yes` says that something is there and nothing else, and across
 * most of suburban America - where the footprints came in as bulk imports -
 * that is nearly every building on the map. Grandview, Missouri is 767 of 809.
 * Rendered literally they come out as identical grey boxes with flat roofs,
 * which is both wrong and the reason a town made of houses does not look like
 * one.
 *
 * A footprint and the street it stands on are enough to recognise the commonest
 * case. Detached housing runs about 45-400 m² and sits on a residential or
 * service road; anything bigger, or on a main road, is left as it was. The
 * guess is recorded on the record rather than written back into the tags,
 * because the tags are what OSM said and this is not.
 */
export function inferBuildingKinds(fs, opts = {}) {
  const { minArea = 45, maxArea = 400, maxRoadDistance = 80 } = opts;
  if (!fs.buildings.length || !fs.roads.length) return 0;

  // Points of the kinds of road houses stand on, on a coarse grid so this
  // stays linear - a region holds thousands of buildings and as many ways.
  const CELL = maxRoadDistance;
  const grid = new Map();
  for (const r of fs.roads) {
    const k = r.spec.kind;
    if (k !== 'street' && k !== 'service' && k !== 'track') continue;
    if (r.spec.tunnel) continue;
    for (const p of r.rawPts || r.pts) {
      const key = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
      let list = grid.get(key);
      if (!list) { list = []; grid.set(key, list); }
      list.push(p);
    }
  }
  if (!grid.size) return 0;

  const maxD2 = maxRoadDistance * maxRoadDistance;
  let changed = 0;
  for (const b of fs.buildings) {
    if (b.kind !== 'generic' || b.isPart) continue;
    const t = b.tags || {};
    // Anything that states a height, or names itself in any way, is not a guess
    // we are entitled to make.
    if (t.height || t['building:height'] || t['building:levels'] || t.levels) continue;
    if (describesItself(t)) continue;
    if (b.area < minArea || b.area > maxArea) continue;

    const cx = Math.floor(b.centroid[0] / CELL), cz = Math.floor(b.centroid[1] / CELL);
    let near = false;
    for (let dz = -1; dz <= 1 && !near; dz++) {
      for (let dx = -1; dx <= 1 && !near; dx++) {
        const list = grid.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (const p of list) {
          const ddx = p[0] - b.centroid[0], ddz = p[1] - b.centroid[1];
          if (ddx * ddx + ddz * ddz <= maxD2) { near = true; break; }
        }
      }
    }
    if (!near) continue;

    // Rebuild the derived description as if it had been tagged a house: the
    // class carries the storey count, the floor height and the pitched roof,
    // and the facade palette follows from it.
    const rng = featureRng('b', b.id);
    const asHouse = { ...t, building: 'house' };
    b.heights = buildingHeights(asHouse, b.area, rng);
    b.facade = facadeSpec(asHouse, b.heights.cls, rng);
    b.levels = b.heights.levels;
    b.kind = b.heights.cls.kind;
    b.kindInferred = 'house';
    changed++;
  }
  return changed;
}

/**
 * Lay out houses where a suburb is mapped but not built.
 *
 * Measured against OpenStreetMap: a square kilometre of central Munich holds
 * 1,185 buildings and one of Grandview, Missouri holds 23. The streets are
 * there, the residential land use is there, the houses were never traced -
 * North American footprints came from bulk imports that were applied region by
 * region and never finished. Rendering that literally gives you a street grid
 * across an empty field, which is honest and useless.
 *
 * So where a residential polygon contains streets and almost no buildings, the
 * houses are laid out along the frontages: plots at a typical lot width, set
 * back from the kerb, squared to the street, both sides. This is invented and
 * says so - every record is marked `synthetic` - and it never runs where the
 * mapping is already good, because the test for "unbuilt" is measured per
 * polygon rather than assumed.
 *
 * Deterministic from the road id and the step index, so the same houses appear
 * every time and neighbouring regions cannot disagree about them.
 */
export function inferSuburbanHousing(fs, opts = {}) {
  const {
    lotWidth = 21, setback = 9, houseWidth = 12.5, houseDepth = 10.5,
    maxExistingPerKm2 = 45, minPolygonArea = 12000, clearance = 13,
  } = opts;
  if (!fs.roads.length) return 0;

  // Residential land that is essentially unbuilt. Anything better mapped than
  // this is left exactly as the mappers left it.
  // Region-level land cover carries no bounds - only the clipped chunk copies
  // do - so each zone gets its own, once.
  const zones = [];
  for (const lc of fs.landcover) {
    if (lc.spec.cover !== 'urban') continue;
    if ((lc.tags && lc.tags.landuse) !== 'residential') continue;
    if (lc.area < minPolygonArea) continue;
    const bb = lc.bounds || bounds(lc.ring);
    let inside = 0;
    for (const b of fs.buildings) {
      const c = b.centroid;
      if (c[0] < bb.minX || c[0] > bb.maxX || c[1] < bb.minZ || c[1] > bb.maxZ) continue;
      if (pointInRing(lc.ring, c[0], c[1])) inside++;
    }
    if (inside / (lc.area / 1e6) > maxExistingPerKm2) continue;
    zones.push({ ring: lc.ring, bb });
  }
  if (!zones.length) return 0;

  // Everything already standing, on a grid, so the frontage walk can check
  // against it cheaply and never build on top of a real footprint.
  const CELL = 40;
  const taken = new Map();
  const mark = (x, z) => {
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let l = taken.get(k);
    if (!l) { l = []; taken.set(k, l); }
    l.push([x, z]);
  };
  const clashes = (x, z, r) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const l = taken.get(`${cx + dx},${cz + dz}`);
        if (!l) continue;
        for (const p of l) {
          if ((p[0] - x) ** 2 + (p[1] - z) ** 2 < r * r) return true;
        }
      }
    }
    return false;
  };
  for (const b of fs.buildings) mark(b.centroid[0], b.centroid[1]);

  // Carriageways, on the same grid. Setting back from the street being walked
  // is not enough on its own: at a corner, or wherever two streets run close,
  // the plot lands in the *other* one. Sampled at 6 m, which is finer than any
  // road is wide.
  const tarmac = new Map();
  for (const r of fs.roads) {
    if (r.spec.tunnel) continue;
    const half = r.spec.width / 2;
    const pts = r.rawPts || r.pts;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], az = pts[i - 1][1];
      const ex = pts[i][0] - ax, ez = pts[i][1] - az;
      const len = Math.hypot(ex, ez);
      const steps = Math.max(1, Math.ceil(len / 6));
      for (let s = 0; s <= steps; s++) {
        const x = ax + (ex * s) / steps, z = az + (ez * s) / steps;
        const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
        let l = tarmac.get(k);
        if (!l) { l = []; tarmac.set(k, l); }
        l.push([x, z, half]);
      }
    }
  }
  const onRoad = (x, z, margin) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const l = tarmac.get(`${cx + dx},${cz + dz}`);
        if (!l) continue;
        for (const p of l) {
          const need = p[2] + margin;
          if ((p[0] - x) ** 2 + (p[1] - z) ** 2 < need * need) return true;
        }
      }
    }
    return false;
  };

  const inAZone = (x, z) => {
    for (const zone of zones) {
      const bb = zone.bb;
      if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
      if (pointInRing(zone.ring, x, z)) return zone;
    }
    return null;
  };

  let made = 0;
  for (const road of fs.roads) {
    const spec = road.spec;
    if (spec.tunnel || spec.bridge || spec.area) continue;
    if (spec.kind !== 'street' && spec.kind !== 'service') continue;
    if (spec.highway === 'driveway') continue;
    const pts = road.rawPts || road.pts;
    if (!pts || pts.length < 2) continue;

    // Walk the centreline at lot-width intervals.
    const offset = spec.width / 2 + setback + houseDepth / 2;
    let carry = 0;
    let step = 0;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], az = pts[i - 1][1];
      const ex = pts[i][0] - ax, ez = pts[i][1] - az;
      const len = Math.hypot(ex, ez);
      if (len < 1e-3) continue;
      const dx = ex / len, dz = ez / len;
      const nx = -dz, nz = dx;
      const angle = Math.atan2(dz, dx);

      for (let d = lotWidth - carry; d < len; d += lotWidth, step++) {
        const px = ax + dx * d, pz = az + dz * d;
        for (const side of [-1, 1]) {
          const cx = px + nx * side * offset, cz = pz + nz * side * offset;
          if (!inAZone(cx, cz)) continue;
          if (clashes(cx, cz, clearance)) continue;
          if (onRoad(cx, cz, houseDepth * 0.55)) continue;

          // Jitter the plot a little so the street is not a barracks.
          const rng = featureRng('sub', `${road.id}:${step}:${side}`);
          const jw = houseWidth * rng.range(0.86, 1.14);
          const jd = houseDepth * rng.range(0.86, 1.14);
          const ja = angle + rng.range(-0.04, 0.04);
          const back = rng.range(-1.6, 1.6);
          const ox = cx + nx * side * back, oz = cz + nz * side * back;

          const ca = Math.cos(ja), sa = Math.sin(ja);
          const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [
            ox + (u * jw / 2) * ca - (v * jd / 2) * sa,
            oz + (u * jw / 2) * sa + (v * jd / 2) * ca,
          ]);

          const tags = { building: 'house' };
          const heights = buildingHeights(tags, jw * jd, rng);
          fs.buildings.push({
            id: `syn/${road.id}/${step}/${side}`,
            source: `synthetic/${road.id}/${step}/${side}`,
            ring, holes: [], area: jw * jd, tags, heights,
            facade: facadeSpec(tags, heights.cls, rng),
            name: null,
            centroid: [ox, oz],
            bounds: bounds(ring),
            isPart: false,
            levels: heights.levels,
            kind: heights.cls.kind,
            era: buildingEra(tags),
            synthetic: true,
          });
          mark(ox, oz);
          made++;
        }
      }
      carry = (carry + len) % lotWidth;
    }
  }
  return made;
}

export function inferMissingHeights(fs, opts = {}) {
  const { radius = 90, minSamples = 3, maxSamples = 12 } = opts;
  const known = [];
  const unknown = [];

  for (const b of fs.buildings) {
    const t = b.tags || {};
    const explicit = t.height || t['building:height'] || t['building:levels'] || t.levels;
    // A building that names its type is not missing a height - its class
    // supplies one, and that is a better answer than the median of whatever
    // happens to stand nearby. Only `building=yes` is genuinely silent.
    if (explicit) known.push(b);
    else if (describesItself(t)) known.push(b);
    // A building we have already guessed at is neither a fact to copy from nor
    // a gap to fill: leave it with the house height its class gave it.
    else if (b.kindInferred) continue;
    else unknown.push(b);
  }
  if (!known.length || !unknown.length) return 0;

  // A coarse grid so this stays linear rather than quadratic; a dense city
  // block can hold thousands of buildings.
  const CELL = radius;
  const grid = new Map();
  for (const b of known) {
    const key = `${Math.floor(b.centroid[0] / CELL)},${Math.floor(b.centroid[1] / CELL)}`;
    let list = grid.get(key);
    if (!list) { list = []; grid.set(key, list); }
    list.push(b);
  }

  let changed = 0;
  const r2 = radius * radius;
  for (const b of unknown) {
    const cx = Math.floor(b.centroid[0] / CELL), cz = Math.floor(b.centroid[1] / CELL);
    const samples = [];
    for (let dz = -1; dz <= 1 && samples.length < maxSamples * 4; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = grid.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (const n of list) {
          const d2 = (n.centroid[0] - b.centroid[0]) ** 2 + (n.centroid[1] - b.centroid[1]) ** 2;
          if (d2 <= r2) samples.push({ d2, levels: n.heights.levels, floorH: n.heights.floorH });
        }
      }
    }
    if (samples.length < minSamples) continue;

    samples.sort((p, q) => p.d2 - q.d2);
    const near = samples.slice(0, maxSamples);
    near.sort((p, q) => p.levels - q.levels);
    const levels = near[near.length >> 1].levels;
    const floorH = near[near.length >> 1].floorH;
    if (!levels || levels < 1) continue;

    // Rewrite the vertical description, keeping the roof the class asked for.
    const h = b.heights;
    const roofHeight = h.roofHeight;
    h.levels = levels;
    h.floorH = floorH;
    h.top = clamp(levels * floorH + roofHeight, 1.8, 830);
    h.roofHeight = Math.min(roofHeight, Math.max(0, h.top - 1.5));
    h.wallTop = h.top - h.roofHeight;
    h.inferred = true;
    b.levels = levels;
    changed++;
  }
  return changed;
}

// --- entrances -------------------------------------------------------------

/**
 * Attach entrance points to buildings so the interior generator knows where
 * the door is, and the player knows where to stand to open it.
 *
 * Buildings with no tagged entrance get one placed on the facade edge closest
 * to the nearest road, which is where a front door usually is.
 */
export function assignEntrances(fs, opts = {}) {
  const { maxRoadDistance = 45 } = opts;

  // Index tagged entrance nodes onto the building whose ring they sit on.
  for (const e of fs.entrances) {
    let best = null, bestD = Infinity;
    for (const b of fs.buildings) {
      const bb = b.bounds;
      if (e.x < bb.minX - 2 || e.x > bb.maxX + 2 || e.z < bb.minZ - 2 || e.z > bb.maxZ + 2) continue;
      const d = Math.hypot(e.x - b.centroid[0], e.z - b.centroid[1]);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best) {
      if (!best.doors) best.doors = [];
      // `main` beats `yes` beats `service` when the generator picks a front door.
      const rank = e.kind === 'main' ? 0 : e.kind === 'yes' ? 1 : 2;
      // A tagged entrance gives us a position but no facing. Snap it to the
      // wall it belongs to so the interior and the prompt agree on which way
      // the door opens.
      const snapped = snapToRing(best.ring, e.x, e.z, best.centroid);
      best.doors.push({
        x: snapped ? snapped.x : e.x,
        z: snapped ? snapped.z : e.z,
        nx: snapped ? snapped.nx : 0,
        nz: snapped ? snapped.nz : 1,
        edge: snapped ? snapped.edge : null,
        edgeLength: snapped ? snapped.edgeLength : 2,
        rank, tagged: true, kind: e.kind,
      });
    }
  }

  // Everything else gets a door facing the nearest road.
  for (const b of fs.buildings) {
    if (b.doors && b.doors.length) {
      b.doors.sort((p, q) => p.rank - q.rank);
      b.door = b.doors[0];
      continue;
    }
    const target = nearestRoadPoint(fs.roads, b.centroid[0], b.centroid[1], maxRoadDistance);
    const aim = target || [b.centroid[0], b.centroid[1] + 1000];
    const door = doorOnRing(b.ring, b.centroid, aim);
    if (door) {
      b.door = { ...door, rank: 3, tagged: false, kind: 'generated' };
      b.doors = [b.door];
    }
  }
  return fs;
}

/**
 * Snap a loose point onto the nearest edge of a ring, returning the contact
 * point and that wall's outward normal.
 */
export function snapToRing(ring, x, z, centre) {
  let best = null, bestD = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], az = ring[j][1];
    const bx = ring[i][0], bz = ring[i][1];
    const ex = bx - ax, ez = bz - az;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-6) continue;
    let t = ((x - ax) * ex + (z - az) * ez) / len2;
    t = clamp(t, 0, 1);
    const px = ax + ex * t, pz = az + ez * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bestD) {
      const len = Math.sqrt(len2);
      let nx = ez / len, nz = -ex / len;
      if (centre && nx * (px - centre[0]) + nz * (pz - centre[1]) < 0) { nx = -nx; nz = -nz; }
      bestD = d;
      best = { x: px, z: pz, nx, nz, edge: [ax, az, bx, bz], edgeLength: len };
    }
  }
  return best;
}

/** Closest point on any road centreline within `maxD` metres. */
function nearestRoadPoint(roads, x, z, maxD) {
  let best = null, bestD = maxD * maxD;
  for (const r of roads) {
    if (r.spec.tunnel) continue;
    for (const p of r.rawPts || r.pts) {
      const dx = p[0] - x, dz = p[1] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best;
}

/**
 * Pick a point on a building's outline to put the front door.
 * Chooses the ring edge most directly facing `aim`, and places the door at the
 * middle of that edge with the outward normal recorded for the interior.
 */
export function doorOnRing(ring, centre, aim) {
  const dirX = aim[0] - centre[0], dirZ = aim[1] - centre[1];
  const dl = Math.hypot(dirX, dirZ) || 1;
  const ux = dirX / dl, uz = dirZ / dl;

  let best = null, bestScore = -Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0], az = ring[j][1];
    const bx = ring[i][0], bz = ring[i][1];
    const ex = bx - ax, ez = bz - az;
    const len = Math.hypot(ex, ez);
    if (len < 1.2) continue;                  // too short to hold a door
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    // Outward normal for a clockwise-from-above ring.
    let nx = ez / len, nz = -ex / len;
    // Make sure it points away from the centre.
    if (nx * (mx - centre[0]) + nz * (mz - centre[1]) < 0) { nx = -nx; nz = -nz; }
    const facing = nx * ux + nz * uz;
    const score = facing * 2 + Math.min(len, 8) * 0.12;
    if (score > bestScore) {
      bestScore = score;
      best = { x: mx, z: mz, nx, nz, edge: [ax, az, bx, bz], edgeLength: len };
    }
  }
  return best;
}

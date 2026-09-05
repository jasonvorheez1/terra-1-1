// Building geometry.
//
// Walls are extruded from the OSM footprint and split into a ground-floor band
// and an upper band, because the ground storey of a real building never looks
// like the ones above it - shopfronts and doors down here, windows up there.
// UVs are driven by real metres, so a window is a window whether the building
// is four metres wide or four hundred.
//
// Roofs implement the Simple 3D Buildings shapes. The two general tricks that
// make arbitrary footprints work:
//
//   * Hips, mansards and pyramids come from insetting the footprint ring and
//     lifting the inset copy. That degrades gracefully: a long narrow building
//     insets to a line, which is exactly the ridge it should have.
//   * Gables come from clipping the footprint against the ridge line and
//     sloping each half. Clipping rather than assuming a rectangle is what
//     lets an L-shaped house get a sensible roof.

import {
  colourToLinear, shade, clipHalfPlane, ensureClockwise,
} from './mesh.js';
import {
  facadeStyleFor, groundStyleFor, roofPatternFor,
  FACADE_U_PER_METRE, FACADE_V_PER_METRE,
} from '../../gfx/materials.js';
import {
  insetRing, orientedBounds, centroid, area, bounds, perimeter, pointInRing,
} from '../geometry.js';
import { clamp, lerp, DEG } from '../../core/util.js';
import { featureRng } from '../osm-tags.js';
import { addArchitecture, addDoorway, addRestaurantStorefronts } from './architecture.js';
import { box } from './props.js';

const GROUND_BAND = 4.2;          // metres of ground-floor treatment
const PARAPET_HEIGHT = 0.75;

/**
 * Ground height for a footprint.
 *
 * The highest sample is where the building is bedded - a floor sits at the top
 * of its grade, not under it - and the lowest is how far the plinth has to
 * reach to close the gap on the downhill side.
 */
function footprintGround(ring, terrainAt) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  const step = Math.max(1, Math.floor(ring.length / 24));
  for (let i = 0; i < ring.length; i += step) {
    const h = terrainAt(ring[i][0], ring[i][1]);
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h; n++;
  }
  if (!isFinite(min)) return { min: 0, max: 0, avg: 0 };
  return { min, max, avg: sum / n };
}

/**
 * Mark buildings that are described in more detail by `building:part`
 * polygons. Where parts exist the Simple 3D Buildings scheme says they
 * supersede the outline, so drawing both would double up every wall.
 */
export function reconcileBuildingParts(features) {
  if (!features.buildingParts.length) return;
  for (const b of features.buildings) { b.hasParts = false; b.lowestPart = Infinity; }
  for (const part of features.buildingParts) {
    const c = part.centroid || centroid(part.ring);
    part.centroid = c;
    for (const b of features.buildings) {
      const bb = b.bounds;
      if (c[0] < bb.minX || c[0] > bb.maxX || c[1] < bb.minZ || c[1] > bb.maxZ) continue;
      if (pointInRing(b.ring, c[0], c[1])) {
        b.hasParts = true;
        part.parent = b;
        b.lowestPart = Math.min(b.lowestPart, part.heights.base);
        break;
      }
    }
  }

  // A part set only supersedes the outline if it actually stands in for it.
  // Mappers routinely add a part for an upper element alone - a tower, a raised
  // roof, a lantern - and leave the body of the building to the outline. Taking
  // the spec literally there deletes the building and leaves its top floating:
  // way/27909460 in Munich is an 883 m² outline nineteen metres tall whose only
  // part *starts* at nineteen metres, and it was drawn as a slab in the sky.
  // If nothing reaches the ground, the outline is still the building.
  for (const b of features.buildings) {
    if (b.hasParts && b.lowestPart > 1.5) b.hasParts = false;
  }
}

/**
 * Build every wall and roof for a list of buildings into `multi`.
 * `ctx` carries terrain sampling, the material library and settings.
 */
export function buildBuildings(list, ctx, multi, opts = {}) {
  const { detail = 'high', maxParts = Infinity, collide = null } = opts;
  let built = 0;

  for (const b of list) {
    if (b.hasParts) {
      // Superseded by its building:part set, so the outline draws no walls -
      // but the entrance is tagged on the outline, not on the parts, and the
      // parts never carry one. Skipping the whole feature is why most large
      // buildings had no way in at all: in a city centre the big blocks are
      // exactly the ones mapped in parts.
      if (detail !== 'low') addPartedEntrance(b, ctx, multi, collide);
      continue;
    }
    if (built >= maxParts) break;
    try {
      buildOne(b, ctx, multi, detail, collide);
      built++;
    } catch (e) {
      // One malformed footprint must never take the chunk down with it.
      if (ctx.onError) ctx.onError('building', b.source, e);
    }
  }
  return built;
}

/**
 * The entrance for a building whose walls come from its `building:part` set.
 *
 * Only the door: the parts supply everything else. It is placed on the same
 * ground the parts are bedded into, so it meets the wall rather than floating
 * in front of it.
 */
function addPartedEntrance(b, ctx, multi, collide) {
  if (!b.door) return;
  try {
    const g = footprintGround(ensureClockwise(b.ring), ctx.terrainAt);
    // Same bedding rule as buildOne, or the door sits at a different height
    // from the parts it belongs to.
    const baseY = g.max + b.heights.base - (b.heights.base > 0 ? 0 : 0.05);
    const acc = multi.for('solid', ctx.materials.solid({ roughness: 0.85 }));
    addDoorway(b.door, acc, collide, baseY, colourToLinear(b.facade.colour), b,
               featureRng('arch', b.id));
    if (b.restaurant) {
      addRestaurantStorefronts(b, b.door, ctx, multi, acc, baseY,
                               featureRng('restaurant-arch', b.id));
    }
  } catch (e) {
    if (ctx.onError) ctx.onError('entrance', b.source, e);
  }
}

/**
 * Columns holding a canopy up, in place of walls.
 *
 * Spaced around the perimeter rather than dropped at every traced node: a
 * hand-drawn forecourt can carry forty nodes down one straight edge, and a
 * column on each would be a fence. Corners always get one, because a canopy
 * with nothing under its corners reads as floating however many posts are
 * strung along the middle.
 */
function addCanopyColumns(ring, acc, baseY, topY, colour, collide, spacing = 9) {
  const height = topY - baseY;
  if (height < 0.4) return;
  const r = clamp(height * 0.045, 0.11, 0.3);
  const tone = shade(colour, 0.86);
  const n = ring.length;
  let carry = 0;

  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ex = c[0] - a[0], ez = c[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 1e-3) continue;

    // The corner post, then evenly along the edge to the next corner.
    post(a[0], a[1]);
    for (let d = spacing - carry; d < len - 0.5; d += spacing) {
      post(a[0] + (ex * d) / len, a[1] + (ez * d) / len);
    }
    carry = (carry + len) % spacing;
  }

  function post(x, z) {
    box(acc, x, baseY + height / 2, z, r * 2, height, r * 2, tone);
    if (collide) collide.box(x, baseY + height / 2, z, r * 2.2, height, r * 2.2);
  }
}

/**
 * A foundation band under the walls, from the floor down past the lowest
 * ground the footprint touches.
 *
 * Drawn as one skirt rather than following the terrain per-vertex: the point
 * is to close the gap under a level building on sloping ground, and a straight
 * band buried at its bottom edge does that while staying two triangles an edge.
 */
function addPlinth(ring, acc, topY, bottomY, colour, collide) {
  const n = ring.length;
  const dark = shade(colour, 0.88);
  for (let i = 0; i < n; i++) {
    // Walls run anticlockwise so their faces point outdoors; match that here.
    const a = ring[(i + 1) % n], c = ring[i];
    acc.addQuad([a[0], bottomY, a[1]], [c[0], bottomY, c[1]],
                [c[0], topY, c[1]], [a[0], topY, a[1]],
                [0, 0, 1, Math.max(0.2, (topY - bottomY) * 0.35)], dark);
  }
  // Solid too, or you can walk in under the floor where the ground has fallen
  // away. `wall` wants a per-point height offset; the plinth is level, so zero.
  if (collide) {
    const closed = ring.concat([ring[0]]);
    collide.wall(closed, new Float32Array(closed.length), bottomY, topY - bottomY);
  }
}

function buildOne(b, ctx, multi, detail, collide) {
  const ring = ensureClockwise(b.ring);
  const holes = (b.holes || []).map(ensureClockwise);
  const g = footprintGround(ring, ctx.terrainAt);
  const h = b.heights;

  // Bed the building at the *highest* ground under its footprint, not the
  // lowest.
  //
  // Sinking it to the lowest corner guarantees no gap opens downhill, which is
  // why it was done, but it buries the building by the full fall across the
  // plot: measured over Grandview, 97 of 142 houses had more than a metre of
  // earth up their walls and the worst had 3.6 m against a 3.3 m wall - the
  // whole storey underground. A real building does not have soil pressing on
  // its ground floor. It sits level at the top of the grade and shows a
  // foundation on the downhill side, which is what addPlinth draws.
  const ref = g.max;
  const baseY = ref + h.base - (h.base > 0 ? 0 : 0.05);
  const wallTopY = ref + h.wallTop;
  const topY = ref + h.top;
  // How far the ground falls away beneath the floor, for the foundation.
  const plinthDrop = baseY - (g.min - 0.35);
  const wallHeight = wallTopY - baseY;
  if (wallHeight <= 0.05) return;

  const colour = colourToLinear(b.facade.colour);
  const rng = featureRng('bg', b.id);

  const style = facadeStyleFor(b);
  const groundStyle = groundStyleFor(b);
  const hasGroundBand = detail !== 'low' && wallHeight > GROUND_BAND * 1.35 && style !== 'none';
  const bandY = hasGroundBand ? baseY + GROUND_BAND : baseY;

  const upperAcc = multi.for(`facade:${style}`, ctx.materials.facade('upper', style));
  const groundAcc = hasGroundBand
    ? multi.for(`ground:${groundStyle}`, ctx.materials.facade('ground', groundStyle))
    : null;

  // --- walls ---------------------------------------------------------------
  // `building=roof` is a roof and nothing else - a porte-cochere, a filling
  // station, a bandstand, a platform canopy - so it gets columns instead of a
  // shell. Walling them in turns a thing you shelter under into a sealed slab
  // you cannot enter or see past, and the Strip is built out of them: 118 in
  // this square kilometre of Las Vegas, the largest 8,100 m² at three metres
  // tall, which walled in is a low windowless warehouse over the forecourt.
  // The foundation. Now that the floor sits at the top of the grade, the
  // ground falls away from it downhill, and something has to close that gap or
  // you can see under the building. A plinth is what a real house does about
  // exactly this problem, so it is drawn as one: a plain band a shade darker
  // than the wall, following the ground down to below the lowest corner.
  if (plinthDrop > 0.12 && b.kind !== 'canopy') {
    addPlinth(ring, multi.for('solid', ctx.materials.solid({ roughness: 0.9 })),
              baseY, g.min - 0.35, shade(colour, 0.72), collide);
  }

  if (b.kind === 'canopy') {
    addCanopyColumns(ring, multi.for('solid', ctx.materials.solid({ roughness: 0.85 })),
                     baseY, wallTopY, colour, collide);
  } else {
    // A clockwise footprint is the convention for horizontal surfaces, but a
    // vertical quad following that ring faces into the building. Walk the shell
    // the other way so its geometric normals and front faces point outdoors.
    addWallLoop(ring.slice().reverse(), upperAcc, groundAcc, baseY, bandY, wallTopY, colour);
    for (const hole of holes) {
      // The building occupies the outside of a courtyard ring, so its clockwise
      // winding already points the wall into the open courtyard.
      addWallLoop(hole, upperAcc, groundAcc, baseY, bandY, wallTopY, colour);
    }
  }

  // --- roof ----------------------------------------------------------------
  const pattern = roofPatternFor(b);
  const roofColour = colourToLinear(
    h.roof.colour ?? (h.roof.material ? h.roof.material.tint : defaultRoofColour(b, rng)));

  // A flat roof photographed from directly overhead is exactly what satellite
  // imagery is, so where the chunk has imagery coming, use the real thing
  // instead of a generated one. Pitched roofs keep their tiles: an orthophoto
  // stretched down a slope would not read correctly.
  const flat = h.roof.shape === 'flat' || h.roofHeight <= 0.05;
  const aerial = flat && ctx.aerial && ctx.aerial.enabled
    ? { ...ctx.aerial, tint: [0.92, 0.92, 0.92] } : null;
  const roofAcc = aerial
    ? multi.for('roof:aerial', ctx.materials.roof('flat'))
    : multi.for(`roof:${pattern}`, ctx.materials.roof(pattern));

  buildRoof(b, ring, holes, wallTopY, topY, roofAcc, upperAcc, roofColour, colour, detail, rng, aerial);

  // --- what makes it a school rather than a box ----------------------------
  const solidAcc = multi.for('solid', ctx.materials.solid({ roughness: 0.85 }));
  addArchitecture(b, ring, ctx, solidAcc, collide,
                  { baseY, wallTopY, topY, colour }, featureRng('arch', b.id), multi);
}

function defaultRoofColour(b, rng) {
  const kind = b.kind;
  if (kind === 'house') return rng.pick([0x8a4a35, 0x9c5a3f, 0x6f4a3a, 0x5a5f63, 0x77462f]);
  if (kind === 'industrial' || kind === 'barn') return rng.pick([0x8d9296, 0x77797a, 0x9aa0a4]);
  if (kind === 'worship') return rng.pick([0x5d6266, 0x7a5343, 0x4f6b5e]);
  return rng.pick([0x6e7176, 0x7b7e82, 0x63666a, 0x85888c]);
}

/**
 * Extrude one closed ring into walls.
 *
 * `u` accumulates real metres around the perimeter so window bays stay the
 * same physical size no matter how long the wall is, and stay continuous
 * around corners.
 */
function addWallLoop(ring, upperAcc, groundAcc, baseY, bandY, topY, colour) {
  const n = ring.length;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const c = ring[(i + 1) % n];
    const dx = c[0] - a[0], dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const u0 = u * FACADE_U_PER_METRE;
    const u1 = (u + len) * FACADE_U_PER_METRE;
    u += len;

    // Slightly vary tone per wall so a box does not read as flat-shaded.
    // Walls facing different ways catching light differently is most of what
    // sells a building as solid.
    const facing = Math.abs(dx) / (len || 1);
    const tone = shade(colour, 0.94 + facing * 0.1);

    if (groundAcc && bandY > baseY) {
      groundAcc.addQuad(
        [a[0], baseY, a[1]], [c[0], baseY, c[1]],
        [c[0], bandY, c[1]], [a[0], bandY, a[1]],
        [u0, 0, u1, 1], tone);
    }
    const upperBase = groundAcc ? bandY : baseY;
    if (topY > upperBase) {
      // v runs from 0 at the bottom of the band to one repeat per storey at
      // the top. addQuad gives uv[1] to the bottom edge and uv[3] to the top,
      // so passing them the other way round hangs every window upside down.
      const vTop = (topY - upperBase) * FACADE_V_PER_METRE;
      upperAcc.addQuad(
        [a[0], upperBase, a[1]], [c[0], upperBase, c[1]],
        [c[0], topY, c[1]], [a[0], topY, a[1]],
        [u0, 0, u1, vTop], tone);
    }
  }
}

// --- roofs -----------------------------------------------------------------

function buildRoof(b, ring, holes, wallTopY, topY, acc, wallAcc, roofColour, wallColour, detail, rng, aerial) {
  const spec = b.heights.roof;
  const rise = topY - wallTopY;
  const shape = detail === 'low' ? 'flat' : spec.shape;

  if (shape === 'none') return;

  if (shape === 'flat' || rise <= 0.05) {
    if (aerial) {
      // Map the roof into the chunk's aerial photograph. V runs opposite to
      // world Z, matching how the terrain drape is oriented.
      acc.addPolygon(ring, holes, wallTopY, aerial.tint, {
        uvScale: 1 / aerial.size,
        uvScaleV: -1 / aerial.size,
        uvOrigin: [aerial.minX, aerial.minZ + aerial.size],
      });
    } else {
      acc.addPolygon(ring, holes, wallTopY, roofColour, { uvScale: 0.22 });
    }
    // A parapet reads as a real roof edge and stops the silhouette looking
    // like a cut-off box, which is most of why flat roofs look wrong.
    if (detail === 'high' && b.levels >= 2 && b.kind !== 'canopy') {
      addParapet(ring, wallAcc, acc, wallTopY, PARAPET_HEIGHT, wallColour, roofColour);
    }
    return;
  }

  switch (shape) {
    case 'gabled':
    case 'half-hipped':
    // A saltbox is an asymmetric gable and a quadruple one a cross gable. Both
    // are approximated by a plain gable, which loses the asymmetry but keeps
    // the ridge - and a ridge is what these were missing, having previously
    // fallen through to the flat default.
    case 'saltbox':
    case 'double_saltbox':
    case 'quadruple_saltbox':
      buildGabled(ring, holes, wallTopY, rise, acc, wallAcc, roofColour, wallColour, spec, shape === 'half-hipped');
      break;
    case 'hipped':
      buildHipped(ring, wallTopY, rise, acc, roofColour, 0.5);
      break;
    case 'pyramidal':
      buildPyramidal(ring, wallTopY, rise, acc, roofColour);
      break;
    case 'skillion':
      buildSkillion(ring, wallTopY, rise, acc, wallAcc, roofColour, wallColour, spec);
      break;
    case 'mansard':
      buildMansard(ring, wallTopY, rise, acc, roofColour);
      break;
    case 'gambrel':
      buildGabled(ring, holes, wallTopY, rise, acc, wallAcc, roofColour, wallColour, spec, false, true);
      break;
    case 'dome':
    case 'onion':
      buildDome(ring, wallTopY, rise, acc, roofColour, shape === 'onion');
      break;
    case 'round':
      buildRound(ring, wallTopY, rise, acc, roofColour, spec);
      break;
    case 'sawtooth':
      buildSawtooth(ring, wallTopY, rise, acc, roofColour, spec);
      break;
    default:
      acc.addPolygon(ring, holes, wallTopY, roofColour, { uvScale: 0.22 });
  }
}

/** Low wall around a flat roof. */
function addParapet(ring, wallAcc, roofAcc, y, height, wallColour, capColour) {
  const inner = insetRing(ring, 0.3);
  const tone = shade(wallColour, 0.9);
  const n = ring.length;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (len < 0.05) continue;
    const u0 = u * FACADE_U_PER_METRE, u1 = (u + len) * FACADE_U_PER_METRE;
    u += len;
    wallAcc.addQuad(
      [c[0], y, c[1]], [a[0], y, a[1]],
      [a[0], y + height, a[1]], [c[0], y + height, c[1]],
      [u0, 0, u1, 0.02], tone);
  }
  // Cap the top of the parapet so it is not a zero-thickness sheet.
  if (inner) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const ai = inner[Math.floor((i * inner.length) / ring.length) % inner.length];
      const ci = inner[Math.floor(((i + 1) * inner.length) / ring.length) % inner.length];
      roofAcc.addQuad(
        [c[0], y + height, c[1]], [a[0], y + height, a[1]],
        [ai[0], y + height, ai[1]], [ci[0], y + height, ci[1]],
        [0, 0, 0.3, 0.3], capColour);
    }
  }
}

/**
 * Gabled roof: clip the footprint either side of the ridge and slope each half
 * up to it. `gambrel` breaks each slope into two pitches.
 */
function buildGabled(ring, holes, wallTopY, rise, acc, wallAcc, roofColour, wallColour, spec, halfHipped, gambrel) {
  const ob = orientedBounds(ring);
  // The ridge runs along the building's long axis unless tagged otherwise.
  let ridgeAngle = ob.width >= ob.depth ? ob.angle : ob.angle + Math.PI / 2;
  if (spec.orientation === 'across') ridgeAngle += Math.PI / 2;
  if (spec.direction != null) ridgeAngle = (90 - spec.direction) * DEG;

  // Unit vector along the ridge, and the perpendicular we measure span on.
  const rx = Math.cos(ridgeAngle), rz = Math.sin(ridgeAngle);
  const px = -rz, pz = rx;
  const cx = ob.cx, cz = ob.cz;
  const d0 = px * cx + pz * cz;

  let halfSpan = 0;
  for (const p of ring) halfSpan = Math.max(halfSpan, Math.abs(px * p[0] + pz * p[1] - d0));
  if (halfSpan < 0.4) {
    acc.addPolygon(ring, holes, wallTopY, roofColour, { uvScale: 0.22 });
    return;
  }

  const heightAt = (x, z) => {
    const d = Math.abs(px * x + pz * z - d0) / halfSpan;
    if (gambrel) {
      // Two pitches: steep at the eaves, shallow at the ridge.
      const t = 1 - d;
      return wallTopY + rise * (t < 0.5 ? t * 1.5 : 0.75 + (t - 0.5) * 0.5);
    }
    return wallTopY + rise * (1 - d);
  };

  for (const sign of [1, -1]) {
    const half = clipHalfPlane(ring, px * sign, pz * sign, d0 * sign);
    if (half.length < 3) continue;
    acc.addPolygon(ensureClockwise(half), null, wallTopY, roofColour, {
      uvScale: 0.3, heightFn: heightAt,
      normalFn: (x, z) => {
        const across = px * x + pz * z - d0;
        const s = Math.sign(across) || 1;
        const t = 1 - Math.min(1, Math.abs(across) / halfSpan);
        // A gambrel has a steep lower pitch and a shallow upper pitch; using
        // one averaged normal made both planes look bent even though their
        // vertices were in the right places.
        const pitch = gambrel ? (t < 0.5 ? 1.5 : 0.5) : 1;
        const slope = (rise * pitch) / halfSpan;
        const l = Math.hypot(slope, 1);
        return [(px * s * slope) / l, 1 / l, (pz * s * slope) / l];
      },
    });
  }

  // Gable ends: the triangle of wall between the eaves and the ridge.
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ha = heightAt(a[0], a[1]), hc = heightAt(c[0], c[1]);
    if (ha - wallTopY < 0.02 && hc - wallTopY < 0.02) continue;
    // Only walls that actually rise toward the ridge need filling in.
    const tone = shade(wallColour, 0.96);
    wallAcc.addQuad(
      [c[0], wallTopY, c[1]], [a[0], wallTopY, a[1]],
      [a[0], ha, a[1]], [c[0], hc, c[1]],
      [0, 0, 0.3, (Math.max(ha, hc) - wallTopY) * FACADE_V_PER_METRE], tone);
  }
}

/**
 * Hipped roof: inset the ring and lift the copy. `ratio` is how far in the
 * ridge sits as a fraction of the shortest half-span.
 */
function buildHipped(ring, wallTopY, rise, acc, roofColour, ratio) {
  const ob = orientedBounds(ring);
  const inset = Math.min(ob.width, ob.depth) * 0.5 * clamp(ratio, 0.1, 0.95);
  const top = insetRing(ring, inset);
  const topY = wallTopY + rise;

  if (!top || top.length < 3) { buildPyramidal(ring, wallTopY, rise, acc, roofColour); return; }

  // Skirt between eaves and ridge. Walk both rings proportionally so the
  // quads stay well formed even when the inset dropped vertices.
  const n = ring.length, m = top.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ai = top[Math.floor((i * m) / n) % m];
    const ci = top[Math.floor(((i + 1) * m) / n) % m];
    acc.addQuad(
      [c[0], wallTopY, c[1]], [a[0], wallTopY, a[1]],
      [ai[0], topY, ai[1]], [ci[0], topY, ci[1]],
      [0, 0.4, 0.4, 0], shade(roofColour, 1.02));
  }
  acc.addPolygon(ensureClockwise(top), null, topY, roofColour, { uvScale: 0.3 });
}

function buildPyramidal(ring, wallTopY, rise, acc, roofColour) {
  const c = centroid(ring);
  const apexY = wallTopY + rise;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ax = a[0], az = a[1], bx = b[0], bz = b[1];
    // Face normal from the triangle itself.
    const ux = bx - ax, uy = 0, uz = bz - az;
    const vx = c[0] - ax, vy = apexY - wallTopY, vz = c[1] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    // The clockwise footprint order makes (edge x apex) point down. Negate it
    // and reverse the triangle so stored and geometric normals both face out.
    nx = -nx / l; ny = -ny / l; nz = -nz / l;
    const [r, g, bl] = roofColour;
    const i0 = acc.vertex(ax, wallTopY, az, nx, ny, nz, 0, 0, r, g, bl);
    const i1 = acc.vertex(bx, wallTopY, bz, nx, ny, nz, 0.5, 0, r, g, bl);
    const i2 = acc.vertex(c[0], apexY, c[1], nx, ny, nz, 0.25, 0.6, r, g, bl);
    acc.tri(i1, i0, i2);
  }
}

/** Mansard: a steep lower pitch, then a shallow one, then a small flat top. */
function buildMansard(ring, wallTopY, rise, acc, roofColour) {
  const ob = orientedBounds(ring);
  const shortHalf = Math.min(ob.width, ob.depth) * 0.5;
  const first = insetRing(ring, Math.min(shortHalf * 0.4, rise * 0.9));
  if (!first) { buildHipped(ring, wallTopY, rise, acc, roofColour, 0.5); return; }
  const midY = wallTopY + rise * 0.72;
  skirt(ring, first, wallTopY, midY, acc, shade(roofColour, 1.04));
  const second = insetRing(first, Math.min(shortHalf * 0.35, rise * 1.2));
  if (second) {
    skirt(first, second, midY, wallTopY + rise, acc, roofColour);
    acc.addPolygon(ensureClockwise(second), null, wallTopY + rise, roofColour, { uvScale: 0.3 });
  } else {
    acc.addPolygon(ensureClockwise(first), null, midY, roofColour, { uvScale: 0.3 });
  }
}

function skirt(outer, inner, y0, y1, acc, colour) {
  const n = outer.length, m = inner.length;
  for (let i = 0; i < n; i++) {
    const a = outer[i], c = outer[(i + 1) % n];
    const ai = inner[Math.floor((i * m) / n) % m];
    const ci = inner[Math.floor(((i + 1) * m) / n) % m];
    acc.addQuad(
      [c[0], y0, c[1]], [a[0], y0, a[1]],
      [ai[0], y1, ai[1]], [ci[0], y1, ci[1]],
      [0, 0.4, 0.4, 0], colour);
  }
}

/** Single-pitch roof, sloping up toward one side. */
function buildSkillion(ring, wallTopY, rise, acc, wallAcc, roofColour, wallColour, spec) {
  const ob = orientedBounds(ring);
  let dirAngle = ob.width >= ob.depth ? ob.angle + Math.PI / 2 : ob.angle;
  if (spec.direction != null) dirAngle = (90 - spec.direction) * DEG;
  const dx = Math.cos(dirAngle), dz = Math.sin(dirAngle);

  let lo = Infinity, hi = -Infinity;
  for (const p of ring) {
    const d = dx * p[0] + dz * p[1];
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  const span = Math.max(0.01, hi - lo);
  const heightAt = (x, z) => wallTopY + rise * ((dx * x + dz * z - lo) / span);

  const slope = rise / span;
  const l = Math.hypot(slope, 1);
  acc.addPolygon(ring, null, wallTopY, roofColour, {
    uvScale: 0.3, heightFn: heightAt,
    normalFn: () => [(-dx * slope) / l, 1 / l, (-dz * slope) / l],
  });

  // Fill the triangle of wall the slope leaves behind.
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ha = heightAt(a[0], a[1]), hc = heightAt(c[0], c[1]);
    if (ha - wallTopY < 0.02 && hc - wallTopY < 0.02) continue;
    wallAcc.addQuad(
      [c[0], wallTopY, c[1]], [a[0], wallTopY, a[1]],
      [a[0], ha, a[1]], [c[0], hc, c[1]],
      [0, 0, 0.3, (Math.max(ha, hc) - wallTopY) * FACADE_V_PER_METRE],
      shade(wallColour, 0.96));
  }
}

/** Dome or onion, built as stacked inset rings. */
function buildDome(ring, wallTopY, rise, acc, roofColour, onion) {
  const steps = 7;
  let prev = ring;
  let prevY = wallTopY;
  const ob = orientedBounds(ring);
  const maxInset = Math.min(ob.width, ob.depth) * 0.5;

  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    // A circular profile for a dome; onions bulge before they taper.
    const profile = onion
      ? Math.sin(t * Math.PI * 0.72) * 1.12
      : Math.sin(t * Math.PI * 0.5);
    const insetAmount = maxInset * (onion ? Math.max(0, t * 1.15 - 0.12) : 1 - Math.cos(t * Math.PI * 0.5));
    const y = wallTopY + rise * profile;
    const next = s === steps ? null : insetRing(ring, insetAmount);
    if (!next || next.length < 3) {
      // Cap with a cone to the centre once the rings collapse.
      const c = centroid(prev);
      const apexY = wallTopY + rise;
      for (let i = 0; i < prev.length; i++) {
        const a = prev[i], b = prev[(i + 1) % prev.length];
        const ux = b[0] - a[0], uz = b[1] - a[1];
        const vx = c[0] - a[0], vy = apexY - prevY, vz = c[1] - a[1];
        let nx = uz * vy, ny = ux * vz - uz * vx, nz = -ux * vy;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const [r, g, bl] = roofColour;
        const i0 = acc.vertex(a[0], prevY, a[1], nx, ny, nz, 0, 0, r, g, bl);
        const i1 = acc.vertex(b[0], prevY, b[1], nx, ny, nz, 0.4, 0, r, g, bl);
        const i2 = acc.vertex(c[0], apexY, c[1], nx, ny, nz, 0.2, 0.5, r, g, bl);
        acc.tri(i1, i0, i2);
      }
      break;
    }
    skirt(prev, next, prevY, y, acc, shade(roofColour, 1 + (1 - t) * 0.06));
    prev = next; prevY = y;
  }
}

/** Barrel vault along the long axis - warehouses, station trainsheds. */
function buildRound(ring, wallTopY, rise, acc, roofColour, spec) {
  const ob = orientedBounds(ring);
  let axis = ob.width >= ob.depth ? ob.angle : ob.angle + Math.PI / 2;
  if (spec.direction != null) axis = (90 - spec.direction) * DEG;
  const px = -Math.sin(axis), pz = Math.cos(axis);
  const d0 = px * ob.cx + pz * ob.cz;
  let halfSpan = 0;
  for (const p of ring) halfSpan = Math.max(halfSpan, Math.abs(px * p[0] + pz * p[1] - d0));
  if (halfSpan < 0.3) { acc.addPolygon(ring, null, wallTopY, roofColour, { uvScale: 0.3 }); return; }

  const heightAt = (x, z) => {
    const d = clamp((px * x + pz * z - d0) / halfSpan, -1, 1);
    return wallTopY + rise * Math.sqrt(Math.max(0, 1 - d * d));
  };
  // Slice across the vault so the curve is actually round, not faceted once.
  const slices = 10;
  for (let s = 0; s < slices; s++) {
    const a0 = d0 - halfSpan + (2 * halfSpan * s) / slices;
    const a1 = d0 - halfSpan + (2 * halfSpan * (s + 1)) / slices;
    let band = clipHalfPlane(ring, px, pz, a1);
    band = clipHalfPlane(band, -px, -pz, -a0);
    if (band.length < 3) continue;
    acc.addPolygon(ensureClockwise(band), null, wallTopY, roofColour, {
      uvScale: 0.3, heightFn: heightAt,
      normalFn: (x, z) => {
        const d = clamp((px * x + pz * z - d0) / halfSpan, -1, 1);
        const ny = Math.sqrt(Math.max(0.01, 1 - d * d));
        const l = Math.hypot(d, ny) || 1;
        return [(px * d) / l, ny / l, (pz * d) / l];
      },
    });
  }
}

/** Sawtooth: repeated north-light slopes, classic for factories. */
function buildSawtooth(ring, wallTopY, rise, acc, roofColour, spec) {
  const ob = orientedBounds(ring);
  const axis = ob.width >= ob.depth ? ob.angle : ob.angle + Math.PI / 2;
  const px = -Math.sin(axis), pz = Math.cos(axis);
  const d0 = px * ob.cx + pz * ob.cz;
  const span = ob.width >= ob.depth ? ob.depth : ob.width;
  const teeth = clamp(Math.round(span / 9), 1, 12);
  const toothWidth = span / teeth;

  for (let t = 0; t < teeth; t++) {
    const a0 = d0 - span / 2 + toothWidth * t;
    const a1 = a0 + toothWidth;
    let band = clipHalfPlane(ring, px, pz, a1);
    band = clipHalfPlane(band, -px, -pz, -a0);
    if (band.length < 3) continue;
    const heightAt = (x, z) => {
      const d = (px * x + pz * z - a0) / toothWidth;
      return wallTopY + rise * clamp(d, 0, 1);
    };
    acc.addPolygon(ensureClockwise(band), null, wallTopY, roofColour, {
      uvScale: 0.3, heightFn: heightAt,
      normalFn: () => {
        const slope = rise / toothWidth;
        const l = Math.hypot(slope, 1);
        return [(-px * slope) / l, 1 / l, (-pz * slope) / l];
      },
    });
    // The vertical glazed face of each tooth.
    const faceRing = clipHalfPlane(band, px, pz, a1 - 0.01);
    if (faceRing.length >= 2) {
      for (let i = 0; i < faceRing.length; i++) {
        const p = faceRing[i], q = faceRing[(i + 1) % faceRing.length];
        const dp = px * p[0] + pz * p[1] - a1;
        const dq = px * q[0] + pz * q[1] - a1;
        if (Math.abs(dp) > 0.2 || Math.abs(dq) > 0.2) continue;
        acc.addQuad(
          [p[0], wallTopY, p[1]], [q[0], wallTopY, q[1]],
          [q[0], wallTopY + rise, q[1]], [p[0], wallTopY + rise, p[1]],
          [0, 0.3, 0.3, 0], shade(roofColour, 0.8));
      }
    }
  }
}

// Roads, footways, steps, bridges, tunnels and railways.
//
// Every linear way becomes a ribbon of quads that follows its vertical profile
// (see features.verticalProfile). On top of that:
//
//   * At-grade streets get raised kerbs and pavements, which are collidable, so
//     stepping up onto a pavement is a real step you feel.
//   * Bridges get a deck box, parapets and piers spaced along the span.
//   * Tunnels get a lining - walls and a soffit - wherever the roadway is
//     genuinely enclosed, with an open cutting on the approach. The portal is
//     simply where those two meet.
//   * Steps get individual treads and risers rather than a ramp, so the
//     character controller climbs them one at a time.

import { colourToLinear, shade } from './mesh.js';
import { surfaceFamily } from '../../gfx/materials.js';
import { ribbon, polylineNormals, polylineLength, resample } from '../geometry.js';
import { stepProfile } from '../features.js';
import { clamp, lerp } from '../../core/util.js';
import { featureRng } from '../osm-tags.js';
import {
  junctionSetback, trimPolylineProfile, splitPolylineProfileAtJunctions,
  roadMarkingLayout, shouldBuildSidewalk,
} from '../road-layout.js';

const KERB_HEIGHT = 0.14;
const SIDEWALK_WIDTH = 2.2;
const ROAD_LIFT = 0.035;          // sit just proud of the terrain
const MARKING_LIFT = 0.012;
const TUNNEL_HEIGHT = 5.6;
const FOOT_TUNNEL_HEIGHT = 3.2;
const PARAPET_HEIGHT = 1.05;
const DECK_THICKNESS = 0.85;

/**
 * Build the carriageway, and everything that hangs off it, for one way.
 * `collide` collects geometry the physics pass should treat as solid.
 */
export function buildRoad(road, prof, ctx, multi, collide) {
  const spec = road.spec;
  const pts = road.pts;
  if (pts.length < 2 || !prof) return;

  if (spec.steps) { buildSteps(road, prof, ctx, multi, collide); return; }

  const family = surfaceFamily(spec.surface.id);
  const acc = multi.for(`surface:${family}`, ctx.materials.surface(family));
  // OSM ways of the same surface should belong to the same material, but they
  // should not all have exactly the same age. Use the road name when possible
  // so separate way sections of one street keep a consistent shade.
  const surfaceRng = featureRng('road-surface', road.name || road.source || road.id);
  const variation = family === 'asphalt' ? 0.88 + surfaceRng() * 0.18
                                         : 0.94 + surfaceRng() * 0.12;
  const colour = shade(colourToLinear(spec.surface.tint), variation);

  // A separately-mapped pavement sits on a kerb, like the ones generated
  // alongside a carriageway. Without this, a city that maps its pavements
  // properly renders them as paint on the road.
  const raised = spec.pavement && prof.kind === 'grade' ? KERB_HEIGHT : 0;
  const lift = (prof.kind === 'grade' ? ROAD_LIFT : 0) + raised;
  const edges = ribbon(pts, spec.width);
  const heights = prof.heights;

  // --- carriageway ---------------------------------------------------------
  let along = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const y0 = heights[i] + lift, y1 = heights[i + 1] + lift;
    const v0 = along * 0.25, v1 = (along + segLen) * 0.25;
    along += segLen;
    acc.addQuad(
      [edges.left[i][0], y0, edges.left[i][1]],
      [edges.right[i][0], y0, edges.right[i][1]],
      [edges.right[i + 1][0], y1, edges.right[i + 1][1]],
      [edges.left[i + 1][0], y1, edges.left[i + 1][1]],
      [0, v0, spec.width * 0.25, v1], colour);
  }

  if (prof.kind === 'grade' && road.junctionPatches && road.junctionPatches.length) {
    buildJunctionPatches(road, prof, acc, colour, lift);
  }

  // Every carriageway is solid, not just the elevated ones. An at-grade road
  // used to rely on the terrain underneath it for collision, which is only the
  // same surface where the two agree - and they routinely do not. A road is
  // graded to a driveable gradient while the ground it crosses is not, so on
  // any slope, embankment or dip the ribbon you can see sits centimetres to
  // metres away from the terrain you actually stand on, and you walk sunk into
  // the road or hovering over it. Collide with the ribbon itself and the
  // surface you see is the surface you are on.
  addRibbonCollision(collide, edges, heights, lift);

  // --- lane markings -------------------------------------------------------
  if (ctx.detail !== 'low') {
    if (spec.markings && spec.width >= 5) buildLaneMarkings(road, prof, ctx, multi, lift);
    if (spec.crossingMarked) buildCrossingMarkings(road, prof, ctx, multi, lift);
  }

  // --- pavements and kerbs -------------------------------------------------
  if (shouldBuildSidewalk(spec, ctx.region) && prof.kind === 'grade' && ctx.detail !== 'low') {
    buildSidewalks(road, prof, ctx, multi, collide);
  }
  if (raised) addKerbEdges(edges, heights, lift, acc, collide, shade(colour, 0.84));

  // --- structures ----------------------------------------------------------
  if (prof.kind === 'span' || prof.kind === 'flyover') {
    buildBridge(road, prof, ctx, multi, collide, edges);
  } else if (prof.kind === 'cut' || prof.kind === 'bored') {
    buildTunnelLining(road, prof, ctx, multi, collide, edges);
  }
}

/** Fill the angular wedges between incident road ribbons at a shared node. */
function buildJunctionPatches(road, prof, acc, colour, lift) {
  for (const patch of road.junctionPatches) {
    let best = null;
    let bestD2 = Infinity;
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1], b = road.pts[i];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const ll = dx * dx + dz * dz;
      const t = ll > 0 ? clamp(((patch.x - a[0]) * dx + (patch.z - a[1]) * dz) / ll, 0, 1) : 0;
      const x = a[0] + dx * t, z = a[1] + dz * t;
      const d2 = (patch.x - x) ** 2 + (patch.z - z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = { i, t }; }
    }
    if (!best || bestD2 > 1) continue;
    const y = lerp(prof.heights[best.i - 1], prof.heights[best.i], best.t) + lift + 0.001;
    const ring = [];
    const sides = patch.radius > 8 ? 18 : 14;
    for (let i = 0; i < sides; i++) {
      const angle = -(i / sides) * Math.PI * 2;
      ring.push([
        patch.x + Math.cos(angle) * patch.radius,
        patch.z + Math.sin(angle) * patch.radius,
      ]);
    }
    acc.addPolygon(ring, [], y, shade(colour, 0.99), { uvScale: 0.25 });
  }
}

/** Runs with a deliberate gap around each junction node. */
function detailRuns(road, prof, purpose) {
  const setback = junctionSetback(road.spec, purpose);
  if (road.junctionPoints && road.junctionPoints.length) {
    return splitPolylineProfileAtJunctions(
      road.pts, prof.heights, road.junctionPoints, setback);
  }
  const start = road.startJunction ? setback : 0;
  const end = road.endJunction ? setback : 0;
  const run = trimPolylineProfile(road.pts, prof.heights, start, end);
  return run.pts.length >= 2 ? [run] : [];
}

/** Offset a line without losing the miter correction at bends. */
function offsetPolyline(pts, offset) {
  if (Math.abs(offset) < 1e-6) return pts;
  const normals = polylineNormals(pts);
  return pts.map((p, i) => [
    p[0] + normals[i][0] * normals[i][2] * offset,
    p[1] + normals[i][1] * normals[i][2] * offset,
  ]);
}

/** Individual lane dividers, rather than one stretched centre-line texture. */
function buildLaneMarkings(road, prof, ctx, multi, lift) {
  const layout = roadMarkingLayout(road.spec, ctx.region, ctx.drivingSide);
  if (!layout.length) return;
  const runs = detailRuns(road, prof, 'marking');
  for (const line of layout) {
    const key = `markings:${line.kind}:${line.colour.toString(16)}`;
    const mAcc = multi.for(key, ctx.materials.markings(line.kind, line.colour));
    for (const run of runs) {
      const centre = offsetPolyline(run.pts, line.offset);
      const edge = ribbon(centre, line.width);
      let along = 0;
      for (let i = 0; i < centre.length - 1; i++) {
        const segLen = Math.hypot(
          centre[i + 1][0] - centre[i][0], centre[i + 1][1] - centre[i][1]);
        const y0 = run.heights[i] + lift + MARKING_LIFT;
        const y1 = run.heights[i + 1] + lift + MARKING_LIFT;
        const v0 = along / 8, v1 = (along + segLen) / 8;
        along += segLen;
        mAcc.addQuad(
          [edge.left[i][0], y0, edge.left[i][1]],
          [edge.right[i][0], y0, edge.right[i][1]],
          [edge.right[i + 1][0], y1, edge.right[i + 1][1]],
          [edge.left[i + 1][0], y1, edge.left[i + 1][1]],
          [0, v0, 1, v1], [1, 1, 1]);
      }
    }
  }
}

/** Zebra paint for a separately-mapped crossing way. */
function buildCrossingMarkings(road, prof, ctx, multi, lift) {
  const mAcc = multi.for('markings:crossing', ctx.materials.markings('crossing'));
  const edge = ribbon(road.pts, road.spec.width * 0.92);
  let along = 0;
  for (let i = 0; i < road.pts.length - 1; i++) {
    const segLen = Math.hypot(
      road.pts[i + 1][0] - road.pts[i][0], road.pts[i + 1][1] - road.pts[i][1]);
    const y0 = prof.heights[i] + lift + MARKING_LIFT + 0.003;
    const y1 = prof.heights[i + 1] + lift + MARKING_LIFT + 0.003;
    const v0 = along * 0.12, v1 = (along + segLen) * 0.12;
    along += segLen;
    mAcc.addQuad(
      [edge.left[i][0], y0, edge.left[i][1]],
      [edge.right[i][0], y0, edge.right[i][1]],
      [edge.right[i + 1][0], y1, edge.right[i + 1][1]],
      [edge.left[i + 1][0], y1, edge.left[i + 1][1]],
      [0, v0, 1, v1], [1, 1, 1]);
  }
}

/**
 * The vertical kerb face down both sides of a separately-mapped pavement,
 * and the collision that makes it a step you feel rather than a stripe.
 */
function addKerbEdges(edges, heights, lift, acc, collide, colour) {
  for (const side of ['left', 'right']) {
    const e = edges[side];
    for (let i = 0; i < e.length - 1; i++) {
      const top0 = heights[i] + lift, top1 = heights[i + 1] + lift;
      const bot0 = heights[i] + ROAD_LIFT, bot1 = heights[i + 1] + ROAD_LIFT;
      if (side === 'left') {
        acc.addQuad([e[i][0], bot0, e[i][1]], [e[i + 1][0], bot1, e[i + 1][1]],
                    [e[i + 1][0], top1, e[i + 1][1]], [e[i][0], top0, e[i][1]],
                    [0, 0, 1, 0.06], colour);
      } else {
        acc.addQuad([e[i + 1][0], bot1, e[i + 1][1]], [e[i][0], bot0, e[i][1]],
                    [e[i][0], top0, e[i][1]], [e[i + 1][0], top1, e[i + 1][1]],
                    [0, 0, 1, 0.06], colour);
      }
    }
    const base = [];
    for (let i = 0; i < heights.length; i++) base.push([e[i][0], e[i][1]]);
    collide.wall(base, heights, ROAD_LIFT, lift - ROAD_LIFT + 0.02);
  }
  // The pavement top is walkable, so it has to be solid.
  const left = [], right = [];
  for (let i = 0; i < heights.length; i++) {
    left.push([edges.left[i][0], heights[i] + lift, edges.left[i][1]]);
    right.push([edges.right[i][0], heights[i] + lift, edges.right[i][1]]);
  }
  collide.strip(left, right);
}

/** Raised pavements either side, with a kerb face you actually step up. */
function buildSidewalks(road, prof, ctx, multi, collide) {
  const spec = road.spec;
  const acc = multi.for('surface:concrete', ctx.materials.surface('concrete'));
  const colour = colourToLinear(0xa8a49c);
  const kerbColour = shade(colour, 0.86);

  for (const run of detailRuns(road, prof, 'sidewalk')) {
    const pts = run.pts;
    const heights = run.heights;
    const inner = ribbon(pts, spec.width);
    const outer = ribbon(pts, spec.width + SIDEWALK_WIDTH * 2);

    const sides = [];
    if (spec.sidewalkLeft !== false) sides.push('left');
    if (spec.sidewalkRight !== false) sides.push('right');
    for (const side of sides) {
      const a = inner[side], b = outer[side];
      let along = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        const roadY0 = heights[i] + ROAD_LIFT, roadY1 = heights[i + 1] + ROAD_LIFT;
        const topY0 = roadY0 + KERB_HEIGHT, topY1 = roadY1 + KERB_HEIGHT;
        const v0 = along * 0.3, v1 = (along + segLen) * 0.3;
        along += segLen;

        // Kerb face.
        acc.addQuad(
          [a[i][0], roadY0, a[i][1]], [a[i + 1][0], roadY1, a[i + 1][1]],
          [a[i + 1][0], topY1, a[i + 1][1]], [a[i][0], topY0, a[i][1]],
          [0, 0, 0.06, v1 - v0], kerbColour);
        // Pavement surface.
        acc.addQuad(
          [a[i][0], topY0, a[i][1]], [b[i][0], topY0, b[i][1]],
          [b[i + 1][0], topY1, b[i + 1][1]], [a[i + 1][0], topY1, a[i + 1][1]],
          [0, v0, SIDEWALK_WIDTH * 0.3, v1], colour);
      }
      // The kerb is a real 14 cm step, so it goes in the collision mesh.
      const seg = [];
      for (let i = 0; i < pts.length; i++) seg.push([a[i][0], heights[i] + ROAD_LIFT + KERB_HEIGHT, a[i][1]]);
      const segOuter = [];
      for (let i = 0; i < pts.length; i++) segOuter.push([b[i][0], heights[i] + ROAD_LIFT + KERB_HEIGHT, b[i][1]]);
      collide.strip(seg, segOuter);
      collide.wall(a, heights, ROAD_LIFT, KERB_HEIGHT);
    }
  }
}

/** Deck box, parapets and piers. */
function buildBridge(road, prof, ctx, multi, collide, edges) {
  const spec = road.spec;
  const pts = road.pts;
  const heights = prof.heights;
  const acc = multi.for('surface:concrete', ctx.materials.surface('concrete'));
  const deckColour = colourToLinear(0x8b8880);
  const rail = colourToLinear(spec.kind === 'foot' ? 0x6e7378 : 0x9aa0a4);

  // Underside and fascia, so the bridge is a solid object from below.
  for (let i = 0; i < pts.length - 1; i++) {
    const y0 = heights[i], y1 = heights[i + 1];
    const b0 = y0 - DECK_THICKNESS, b1 = y1 - DECK_THICKNESS;
    acc.addQuad(
      [edges.left[i + 1][0], b1, edges.left[i + 1][1]],
      [edges.right[i + 1][0], b1, edges.right[i + 1][1]],
      [edges.right[i][0], b0, edges.right[i][1]],
      [edges.left[i][0], b0, edges.left[i][1]],
      [0, 0, 1, 1], shade(deckColour, 0.72));
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
      const e = edges[side];
      acc.addQuad(
        [e[i][0], b0, e[i][1]], [e[i + 1][0], b1, e[i + 1][1]],
        [e[i + 1][0], y1, e[i + 1][1]], [e[i][0], y0, e[i][1]],
        [0, 0, 1, 0.2], sign > 0 ? deckColour : shade(deckColour, 0.94));
    }
  }

  // Parapets. Solid, because walking off a bridge should not be possible.
  const parapetOuter = ribbon(pts, spec.width + 0.36);
  for (const side of ['left', 'right']) {
    const a = edges[side], b = parapetOuter[side];
    for (let i = 0; i < pts.length - 1; i++) {
      const y0 = heights[i], y1 = heights[i + 1];
      const t0 = y0 + PARAPET_HEIGHT, t1 = y1 + PARAPET_HEIGHT;
      acc.addQuad([a[i][0], y0, a[i][1]], [a[i + 1][0], y1, a[i + 1][1]],
                  [a[i + 1][0], t1, a[i + 1][1]], [a[i][0], t0, a[i][1]], [0, 0, 1, 0.3], rail);
      acc.addQuad([b[i + 1][0], y1, b[i + 1][1]], [b[i][0], y0, b[i][1]],
                  [b[i][0], t0, b[i][1]], [b[i + 1][0], t1, b[i + 1][1]], [0, 0, 1, 0.3], rail);
      acc.addQuad([a[i][0], t0, a[i][1]], [b[i][0], t0, b[i][1]],
                  [b[i + 1][0], t1, b[i + 1][1]], [a[i + 1][0], t1, a[i + 1][1]], [0, 0, 0.3, 0.3], shade(rail, 1.1));
    }
    collide.wall(a, heights, 0, PARAPET_HEIGHT);
  }

  // Piers wherever the deck stands clear of the ground.
  if (ctx.detail !== 'low') {
    let sinceLast = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      sinceLast += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const clearance = heights[i] - prof.ground[i] - DECK_THICKNESS;
      if (sinceLast < 24 || clearance < 1.6) continue;
      sinceLast = 0;
      addPier(acc, pts[i][0], pts[i][1], prof.ground[i], heights[i] - DECK_THICKNESS,
              Math.min(2.2, spec.width * 0.28), deckColour, collide);
    }
  }
}

function addPier(acc, x, z, baseY, topY, radius, colour, collide) {
  const sides = 8;
  const c = shade(colour, 0.88);
  for (let s = 0; s < sides; s++) {
    const a0 = (s / sides) * Math.PI * 2;
    const a1 = ((s + 1) / sides) * Math.PI * 2;
    const x0 = x + Math.cos(a0) * radius, z0 = z + Math.sin(a0) * radius;
    const x1 = x + Math.cos(a1) * radius, z1 = z + Math.sin(a1) * radius;
    acc.addQuad([x0, baseY - 1, z0], [x1, baseY - 1, z1], [x1, topY, z1], [x0, topY, z0],
                [0, 0, 0.3, (topY - baseY) * 0.15], c);
  }
  if (collide) collide.box(x, (baseY + topY) / 2, z, radius * 1.6, topY - baseY, radius * 1.6);
}

/**
 * Tunnel lining.
 *
 * Only the genuinely enclosed part gets a soffit: the approach is an open
 * cutting (the ground there having been graded down to the roadway), so walls
 * run the whole length but the roof starts where the cover does. That boundary
 * is the portal, and it lands wherever the terrain actually closes over.
 */
function buildTunnelLining(road, prof, ctx, multi, collide, edges) {
  const spec = road.spec;
  const pts = road.pts;
  const heights = prof.heights;
  const foot = spec.kind === 'foot' || spec.kind === 'cycle';
  const height = foot ? FOOT_TUNNEL_HEIGHT : TUNNEL_HEIGHT;
  const acc = multi.for('surface:concrete', ctx.materials.surface('concrete'));
  const wallColour = colourToLinear(0x8e8b84);
  const roofColour = shade(wallColour, 0.62);

  const outer = ribbon(pts, spec.width + 0.7);
  const covered = [];
  for (let i = 0; i < pts.length; i++) {
    covered.push(prof.ground[i] - heights[i] > height - 0.4);
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const y0 = heights[i], y1 = heights[i + 1];
    const t0 = y0 + height, t1 = y1 + height;

    for (const [side, dir] of [['left', 1], ['right', -1]]) {
      const a = edges[side], b = outer[side];
      // Inner face of the lining.
      if (dir > 0) {
        acc.addQuad([a[i + 1][0], y1, a[i + 1][1]], [a[i][0], y0, a[i][1]],
                    [a[i][0], t0, a[i][1]], [a[i + 1][0], t1, a[i + 1][1]],
                    [0, 0, 1, height * 0.2], wallColour);
      } else {
        acc.addQuad([a[i][0], y0, a[i][1]], [a[i + 1][0], y1, a[i + 1][1]],
                    [a[i + 1][0], t1, a[i + 1][1]], [a[i][0], t0, a[i][1]],
                    [0, 0, 1, height * 0.2], wallColour);
      }
      // Outer face, seen from the cutting.
      acc.addQuad([b[i][0], y0 - 1, b[i][1]], [b[i + 1][0], y1 - 1, b[i + 1][1]],
                  [b[i + 1][0], t1, b[i + 1][1]], [b[i][0], t0, b[i][1]],
                  [0, 0, 1, height * 0.2], shade(wallColour, 0.92));
    }

    // Soffit, only where there is cover overhead.
    if (covered[i] && covered[i + 1]) {
      acc.addQuad(
        [edges.left[i][0], t0, edges.left[i][1]],
        [edges.left[i + 1][0], t1, edges.left[i + 1][1]],
        [edges.right[i + 1][0], t1, edges.right[i + 1][1]],
        [edges.right[i][0], t0, edges.right[i][1]],
        [0, 0, 1, 1], roofColour);
    } else if (covered[i] !== covered[i + 1]) {
      // The portal itself: a headwall across the mouth.
      const j = covered[i] ? i : i + 1;
      const y = heights[j] + height;
      acc.addQuad(
        [edges.left[j][0], y, edges.left[j][1]],
        [edges.right[j][0], y, edges.right[j][1]],
        [edges.right[j][0], y + 1.2, edges.right[j][1]],
        [edges.left[j][0], y + 1.2, edges.left[j][1]],
        [0, 0, 1, 0.3], shade(wallColour, 0.8));
    }
  }

  // Walls and soffit are solid; the roadway inside is walkable.
  collide.wall(edges.left, heights, 0, height);
  collide.wall(edges.right, heights, 0, height);
  addRibbonCollision(collide, edges, heights, 0);
  const ceilHeights = heights.map((h) => h + height);
  addRibbonCollision(collide, edges, ceilHeights, 0);
}

/** Discrete treads and risers for `highway=steps`. */
function buildSteps(road, prof, ctx, multi, collide) {
  const pts = resample(road.pts, 1.2);
  const heights = [];
  // Re-sample the profile onto the denser point list.
  const srcLen = polylineLength(road.pts);
  let acc2 = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc2 += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const t = srcLen > 0 ? acc2 / srcLen : 0;
    const f = t * (prof.heights.length - 1);
    const i0 = clamp(Math.floor(f), 0, prof.heights.length - 1);
    const i1 = Math.min(i0 + 1, prof.heights.length - 1);
    heights.push(lerp(prof.heights[i0], prof.heights[i1], f - i0));
  }

  const p = stepProfile(pts, heights, road.spec);
  const acc = multi.for('surface:concrete', ctx.materials.surface('concrete'));
  const colour = colourToLinear(0x9d9a92);
  const width = Math.max(1.2, road.spec.width);
  const edges = ribbon(pts, width);
  const total = polylineLength(pts);

  // Walk the flight, emitting a tread and a riser per step.
  let dist = 0;
  let stepIndex = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    const tMid = total > 0 ? (dist + segLen / 2) / total : 0;
    dist += segLen;
    const targetStep = Math.floor(tMid * p.count);
    const y = heights[0] + p.rise * targetStep;
    const yNext = heights[0] + p.rise * (targetStep + 1);

    // Tread.
    acc.addQuad(
      [edges.left[i][0], y, edges.left[i][1]],
      [edges.right[i][0], y, edges.right[i][1]],
      [edges.right[i + 1][0], y, edges.right[i + 1][1]],
      [edges.left[i + 1][0], y, edges.left[i + 1][1]],
      [0, 0, width * 0.3, segLen * 0.3], colour);
    // Riser, where the step changes.
    if (targetStep !== stepIndex) {
      stepIndex = targetStep;
      const lo = Math.min(y, y - p.rise), hi = Math.max(y, y - p.rise);
      acc.addQuad(
        [edges.left[i][0], lo, edges.left[i][1]],
        [edges.right[i][0], lo, edges.right[i][1]],
        [edges.right[i][0], hi, edges.right[i][1]],
        [edges.left[i][0], hi, edges.left[i][1]],
        [0, 0, width * 0.3, 0.06], shade(colour, 0.86));
    }
    collide.quad(
      [edges.left[i][0], y, edges.left[i][1]],
      [edges.right[i][0], y, edges.right[i][1]],
      [edges.right[i + 1][0], y, edges.right[i + 1][1]],
      [edges.left[i + 1][0], y, edges.left[i + 1][1]]);
    if (targetStep !== stepIndex - 1) {
      collide.quad(
        [edges.left[i][0], y - Math.abs(p.rise), edges.left[i][1]],
        [edges.right[i][0], y - Math.abs(p.rise), edges.right[i][1]],
        [edges.right[i][0], y, edges.right[i][1]],
        [edges.left[i][0], y, edges.left[i][1]]);
    }
  }
}

/** Railway: ballast shoulder, sleepers and rails. */
export function buildRail(rail, prof, ctx, multi, collide) {
  const spec = rail.spec;
  const pts = rail.pts;
  const heights = prof.heights;
  if (pts.length < 2) return;

  const ballastAcc = multi.for('surface:gravel', ctx.materials.surface('gravel'));
  const ballastColour = colourToLinear(0x8a8378);
  const railColour = colourToLinear(0x6b6259);

  const bed = ribbon(pts, spec.width + 1.4);
  const bedLift = spec.cls.ballast > 0 ? 0.28 : 0.02;
  for (let i = 0; i < pts.length - 1; i++) {
    const y0 = heights[i] + bedLift, y1 = heights[i + 1] + bedLift;
    ballastAcc.addQuad(
      [bed.left[i][0], y0, bed.left[i][1]], [bed.right[i][0], y0, bed.right[i][1]],
      [bed.right[i + 1][0], y1, bed.right[i + 1][1]], [bed.left[i + 1][0], y1, bed.left[i + 1][1]],
      [0, i * 0.4, 1.6, (i + 1) * 0.4], ballastColour);
  }

  if (ctx.detail === 'low') return;

  // Two rails per track, as thin raised strips.
  const solidAcc = multi.for('solid', ctx.materials.solid({ roughness: 0.4, metalness: 0.7 }));
  for (let t = 0; t < spec.tracks; t++) {
    const centreOffset = (t - (spec.tracks - 1) / 2) * spec.cls.width;
    for (const gauge of [-0.7175, 0.7175]) {
      const line = ribbon(pts, 0.14);
      for (let i = 0; i < pts.length - 1; i++) {
        const y0 = heights[i] + bedLift + 0.16, y1 = heights[i + 1] + bedLift + 0.16;
        const off = centreOffset + gauge;
        const nx = line.left[i][0] - pts[i][0], nz = line.left[i][1] - pts[i][1];
        const nl = Math.hypot(nx, nz) || 1;
        const ox = (nx / nl) * off, oz = (nz / nl) * off;
        const nx2 = line.left[i + 1][0] - pts[i + 1][0], nz2 = line.left[i + 1][1] - pts[i + 1][1];
        const nl2 = Math.hypot(nx2, nz2) || 1;
        const ox2 = (nx2 / nl2) * off, oz2 = (nz2 / nl2) * off;
        solidAcc.addQuad(
          [line.left[i][0] + ox, y0, line.left[i][1] + oz],
          [line.right[i][0] + ox, y0, line.right[i][1] + oz],
          [line.right[i + 1][0] + ox2, y1, line.right[i + 1][1] + oz2],
          [line.left[i + 1][0] + ox2, y1, line.left[i + 1][1] + oz2],
          [0, 0, 1, 1], railColour);
      }
    }
  }

  if (prof.kind === 'span' || prof.kind === 'flyover') {
    addRibbonCollision(collide, bed, heights.map((h) => h + bedLift), 0);
  }
}

/** Add a ribbon's surface to the collision mesh. */
function addRibbonCollision(collide, edges, heights, lift) {
  const left = [], right = [];
  for (let i = 0; i < heights.length; i++) {
    left.push([edges.left[i][0], heights[i] + lift, edges.left[i][1]]);
    right.push([edges.right[i][0], heights[i] + lift, edges.right[i][1]]);
  }
  collide.strip(left, right);
}

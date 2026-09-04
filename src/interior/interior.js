// Turning a floor plan into geometry you can walk around.
//
// Interiors are discrete cells, in the manner of Fallout or Morrowind: you
// press a key at a door and load into one, and while you are inside the entire
// outdoor world is hidden and its collision layer switched off. Only one
// interior exists at a time.
//
// That is a deliberate performance decision. A city block holds dozens of
// enterable buildings; generating and retaining every interior costs geometry,
// draw calls and BVH memory for rooms nobody is standing in. Loading one on
// demand means the interior can afford to be far more detailed than an
// always-resident one could, and the frame cost of being indoors is roughly
// the cost of one building rather than of the whole street.
//
// Because the outside is unloaded, the cell has to enclose itself: it builds
// its own outer envelope with glazed windows, and its own front door back out.

import * as THREE from 'three';
import {
  generateInterior, WALL_THICKNESS, DOOR_WIDTH, DOOR_HEIGHT, ROOM_LABELS,
} from './floorplan.js';
import { MultiMesh, colourToLinear, shade } from '../world/build/mesh.js';
import { box, cylinder } from '../world/build/props.js';
import { CollisionBuilder, SURFACE_IDS } from '../physics/collider.js';
import { makeRng, hashString } from '../core/rng.js';
import { clamp, lerp } from '../core/util.js';

const STAIR_RISE = 0.175;
const STAIR_TREAD = 0.27;

/** Palette per room type: floor, wall, and what the room is for. */
const ROOM_STYLE = {
  hall:       { floor: 0x6b5a45, wall: 0xd8d2c6, surface: 'wood' },
  landing:    { floor: 0x6b5a45, wall: 0xd8d2c6, surface: 'wood' },
  corridor:   { floor: 0x8a857c, wall: 0xd4cfc6, surface: 'tile' },
  living:     { floor: 0x7a6448, wall: 0xdcd6c8, surface: 'wood' },
  dining:     { floor: 0x7a6448, wall: 0xd9d2c2, surface: 'wood' },
  kitchen:    { floor: 0xb0aca4, wall: 0xe2e0da, surface: 'tile' },
  kitchenette:{ floor: 0xb0aca4, wall: 0xe2e0da, surface: 'tile' },
  bedroom:    { floor: 0x6f5c46, wall: 0xd6cfc0, surface: 'carpet' },
  bathroom:   { floor: 0xc2c6c8, wall: 0xdfe4e6, surface: 'tile' },
  wc:         { floor: 0xc2c6c8, wall: 0xdfe4e6, surface: 'tile' },
  study:      { floor: 0x6f5c46, wall: 0xd4cec2, surface: 'carpet' },
  office:     { floor: 0x8f8b84, wall: 0xdedbd4, surface: 'carpet' },
  meeting:    { floor: 0x8f8b84, wall: 0xdcd9d2, surface: 'carpet' },
  lobby:      { floor: 0x9a958c, wall: 0xdedad2, surface: 'tile' },
  reception:  { floor: 0x9a958c, wall: 0xdedad2, surface: 'tile' },
  flat:       { floor: 0x7a6448, wall: 0xdcd6c8, surface: 'wood' },
  hotelroom:  { floor: 0x6f5c46, wall: 0xd8cfbe, surface: 'carpet' },
  shopfloor:  { floor: 0xa8a49c, wall: 0xe0ddd6, surface: 'tile' },
  checkout:   { floor: 0xa8a49c, wall: 0xe0ddd6, surface: 'tile' },
  storeroom:  { floor: 0x7c7870, wall: 0xc8c4bc, surface: 'concrete' },
  store:      { floor: 0x7c7870, wall: 0xc8c4bc, surface: 'concrete' },
  staff:      { floor: 0x8a857c, wall: 0xd6d2ca, surface: 'carpet' },
  classroom:  { floor: 0x8f8a80, wall: 0xdcd8ce, surface: 'wood' },
  ward:       { floor: 0xb4b8ba, wall: 0xe0e4e6, surface: 'tile' },
  nave:       { floor: 0x9a9184, wall: 0xd2ccbe, surface: 'stone' },
  vestry:     { floor: 0x7a6448, wall: 0xd0cabc, surface: 'wood' },
  workshop:   { floor: 0x6e6a64, wall: 0xb8b4ac, surface: 'concrete' },
  barnfloor:  { floor: 0x6b5c46, wall: 0x8a7a62, surface: 'dirt' },
  parkdeck:   { floor: 0x6a6660, wall: 0x9c9890, surface: 'concrete' },
  concourse:  { floor: 0x9a958c, wall: 0xdad6ce, surface: 'tile' },
  bar:        { floor: 0x5f4c38, wall: 0xc8b8a0, surface: 'wood' },
  stairwell:  { floor: 0x8a857c, wall: 0xd0ccc4, surface: 'concrete' },
  room:       { floor: 0x8a857c, wall: 0xd8d4cc, surface: 'wood' },
};

const styleFor = (type) => ROOM_STYLE[type] || ROOM_STYLE.room;

/**
 * Build the geometry for a whole building interior.
 * Returns a group, a collider and the plan (for labels and spawn points).
 */
export function buildInterior(building, ctx) {
  const plan = generateInterior(building, { detail: ctx.settings.world.interiorDetail });
  if (!plan.viable) return null;

  const rng = makeRng(hashString(`furnish/${building.source || building.id}`));
  const frame = plan.frame;
  const groundY = ctx.groundYFor(building);

  const multi = new MultiMesh();
  const collide = new CollisionBuilder();
  const group = new THREE.Group();
  group.name = `interior ${building.source}`;
  group.matrixAutoUpdate = false;

  const lights = [];
  const labels = [];

  // World position of a point in the building's own frame.
  const w = (u, v) => frame.toWorld(u, v);

  for (const floor of plan.floors) {
    const baseY = groundY + floor.baseY;
    const ceilY = groundY + floor.ceilingY;
    const detail = ctx.settings.world.interiorDetail;

    // The outer envelope, with windows. The exterior of the building is not
    // loaded while you are in here, so this is what stops the cell being open
    // to the void, and the windows are what stop it feeling like a bunker.
    buildEnvelope(plan, floor, baseY, ceilY, multi, collide, ctx, w);

    // A floor plate across the whole footprint, under the room slabs. Rooms
    // that were clipped away at the footprint edge leave gaps otherwise, and
    // falling through the floor of a building is a poor experience.
    collide.surface(SURFACE_IDS.concrete);
    collide.polygon(plan.localRing.map((p) => w(p[0], p[1])), null, baseY - 0.06);

    for (const room of floor.rooms) {
      const style = styleFor(room.type);
      buildRoomShell(room, floor, plan, baseY, ceilY, style, multi, collide, ctx, w);

      // One ceiling light per room, plus a record for the renderer to place a
      // real point light in the few nearest rooms.
      const c = w(room.cu, room.cv);
      lights.push({
        x: c[0], y: ceilY - 0.12, z: c[1],
        colour: room.type === 'shopfloor' || room.type === 'office' ? 0xf2f4ff : 0xffe2b4,
        // Physical units: a point light with decay 2 delivers
        // intensity / (4*pi*d^2), so a room fitting needs a couple of
        // hundred candela to read as lit, not single digits.
        intensity: room.area > 60 ? 170 : 52,
        range: Math.max(6, Math.sqrt(room.area) * 2.4),
        level: floor.level,
      });
      if (detail !== 'low') {
        const lampAcc = multi.for('emissive-int', ctx.materials.emissive(0xfff0d8));
        box(lampAcc, c[0], ceilY - 0.06, c[1], 0.36, 0.06, 0.36, [1, 1, 1], frame.angle);
      }

      labels.push({
        x: c[0], y: baseY + 1.6, z: c[1],
        text: ROOM_LABELS[room.type] || 'Room',
        level: floor.level,
      });

      if (detail !== 'low') {
        furnishRoom(room, floor, plan, baseY, ceilY, multi, collide, ctx, rng, w);
      }
    }

    // Stairs up to the next floor.
    if (floor.stairRoom && floor.level < plan.floors.length - 1) {
      buildStairs(floor.stairRoom, baseY, groundY + plan.floors[floor.level + 1].baseY,
                  plan, multi, collide, ctx, w);
    }
  }

  // The way back out: a door leaf in the envelope at the entrance, and the two
  // positions the transition teleports between.
  const exit = buildExitDoor(plan, groundY, multi, collide, ctx, w, building);

  for (const mesh of multi.build({ castShadow: true, receiveShadow: true })) group.add(mesh);

  const collider = collide.build(`interior ${building.source}`);

  // Where you arrive when you step through the front door.
  const spawn = interiorSpawn(plan, groundY, w);

  return {
    group, collider, plan, lights, labels, spawn, exit, groundY,
    building,
    triangles: multi.triangleCount,
    floorCount: plan.floors.length,
  };
}

/**
 * The outer wall of the cell for one storey, following the real footprint.
 *
 * Built in three horizontal bands so windows can be punched out of the middle
 * one: solid below the sill, solid above the head, and pierced between. Glass
 * goes in the openings, which is what lets daylight and the sky in.
 */
function buildEnvelope(plan, floor, baseY, ceilY, multi, collide, ctx, w) {
  const acc = multi.for('int-wall', ctx.materials.solid({ roughness: 0.94 }));
  const glassAcc = multi.for('int-glass', ctx.materials.glass());
  const colour = colourToLinear(0xcfc9bd);
  const ring = plan.localRing;
  const n = ring.length;

  const sill = baseY + 0.95;
  const head = Math.min(baseY + 2.35, ceilY - 0.25);
  const isGround = floor.level === 0;

  collide.surface(SURFACE_IDS.concrete);

  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const du = b[0] - a[0], dv = b[1] - a[1];
    const len = Math.hypot(du, dv);
    if (len < 0.25) continue;

    // Openings along this edge, as [from, to] distances from `a`.
    const openings = [];
    // On the ground floor, the front door replaces a window.
    let doorSpan = null;
    if (isGround) {
      const t = ((plan.entrance.u - a[0]) * du + (plan.entrance.v - a[1]) * dv) / (len * len);
      if (t > 0.02 && t < 0.98) {
        const px = a[0] + du * t, pv = a[1] + dv * t;
        if (Math.hypot(px - plan.entrance.u, pv - plan.entrance.v) < 0.8) {
          const c = t * len;
          doorSpan = [Math.max(0.1, c - 0.6), Math.min(len - 0.1, c + 0.6)];
        }
      }
    }

    const spacing = 3.4;
    const count = Math.max(0, Math.floor(len / spacing));
    for (let k = 0; k < count; k++) {
      const centre = (len * (k + 0.5)) / count;
      const from = centre - 0.7, to = centre + 0.7;
      if (from < 0.35 || to > len - 0.35) continue;
      if (doorSpan && to > doorSpan[0] - 0.3 && from < doorSpan[1] + 0.3) continue;
      openings.push([from, to]);
    }

    const at = (d) => w(a[0] + (du / len) * d, a[1] + (dv / len) * d);
    const wall = (d0, d1, y0, y1, tint) => {
      if (d1 - d0 < 0.02 || y1 - y0 < 0.02) return;
      const p0 = at(d0), p1 = at(d1);
      // Two faces: the cell can be viewed from either side of a re-entrant
      // corner, and a one-sided envelope shows a hole from the wrong angle.
      acc.addQuad([p0[0], y0, p0[1]], [p1[0], y0, p1[1]],
                  [p1[0], y1, p1[1]], [p0[0], y1, p0[1]],
                  [0, 0, (d1 - d0) * 0.4, (y1 - y0) * 0.4], tint);
      acc.addQuad([p1[0], y0, p1[1]], [p0[0], y0, p0[1]],
                  [p0[0], y1, p0[1]], [p1[0], y1, p1[1]],
                  [0, 0, (d1 - d0) * 0.4, (y1 - y0) * 0.4], shade(tint, 0.9));
      collide.quad([p0[0], y0, p0[1]], [p1[0], y0, p1[1]],
                   [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]);
    };

    // Band below the sill, and above the head, run the full length except
    // where the front door cuts through both.
    const solidBands = [[baseY, sill], [head, ceilY]];
    for (const [y0, y1] of solidBands) {
      if (doorSpan && y0 < baseY + DOOR_HEIGHT) {
        wall(0, doorSpan[0], y0, y1, colour);
        wall(doorSpan[1], len, y0, y1, colour);
        if (y1 > baseY + DOOR_HEIGHT) {
          wall(doorSpan[0], doorSpan[1], baseY + DOOR_HEIGHT, y1, colour);
        }
      } else {
        wall(0, len, y0, y1, colour);
      }
    }

    // The pierced band: piers between the windows, glass in the gaps.
    let cursor = 0;
    const spans = openings.slice();
    if (doorSpan) spans.push(doorSpan);
    spans.sort((p, q) => p[0] - q[0]);
    for (const [o0, o1] of spans) {
      if (o0 > cursor) wall(cursor, o0, sill, head, colour);
      const isDoor = doorSpan && o0 === doorSpan[0];
      if (!isDoor) {
        const p0 = at(o0), p1 = at(o1);
        glassAcc.addQuad([p0[0], sill, p0[1]], [p1[0], sill, p1[1]],
                         [p1[0], head, p1[1]], [p0[0], head, p0[1]],
                         [0, 0, 1, 1], [1, 1, 1]);
      }
      cursor = Math.max(cursor, o1);
    }
    if (cursor < len) wall(cursor, len, sill, head, colour);
  }
}

/**
 * A door leaf at the entrance, plus the pair of positions the cell transition
 * moves the player between.
 */
function buildExitDoor(plan, groundY, multi, collide, ctx, w, building) {
  const acc = multi.for('int-prop', ctx.materials.solid({ roughness: 0.8, side: 2 }));
  const e = plan.entrance;
  const inside = w(e.u, e.v);

  // The entrance normal points out of the building, in frame-local terms.
  const nl = Math.hypot(e.nu, e.nv) || 1;
  const nu = e.nu / nl, nv = e.nv / nl;
  const leafCentre = w(e.u + nu * 0.06, e.v + nv * 0.06);
  const angle = plan.frame.angle + Math.atan2(nv, nu);

  // A door you can see, set into the opening the envelope left for it.
  box(acc, leafCentre[0], groundY + DOOR_HEIGHT / 2, leafCentre[1],
      DOOR_WIDTH + 0.06, DOOR_HEIGHT, 0.07, colourToLinear(0x5c452f), angle);
  box(acc, leafCentre[0], groundY + 1.0, leafCentre[1],
      0.05, 0.05, 0.16, colourToLinear(0xc9b27a), angle);

  // Standing spot inside, and where you come out. The outside point comes from
  // the OSM door position pushed clear of the wall, so leaving puts you on the
  // pavement rather than back inside the building you just left.
  const stepIn = w(e.u - nu * 1.15, e.v - nv * 1.15);
  const door = building.door;
  const outside = door
    ? { x: door.x + door.nx * 1.35, z: door.z + door.nz * 1.35 }
    : { x: inside[0] + (inside[0] - stepIn[0]) * 2, z: inside[1] + (inside[1] - stepIn[1]) * 2 };

  return {
    doorway: { x: inside[0], y: groundY, z: inside[1] },
    standInside: { x: stepIn[0], y: groundY + 0.05, z: stepIn[1] },
    outside,
  };
}

/** A point just inside the front door, on the ground floor. */
function interiorSpawn(plan, groundY, w) {
  const ground = plan.floors[0];
  const room = ground.entranceRoom || ground.rooms[0];
  if (!room) return null;
  // Step in from the door toward the middle of the room it opens into.
  const u = lerp(plan.entrance.u, room.cu, 0.55);
  const v = lerp(plan.entrance.v, room.cv, 0.55);
  const p = w(clamp(u, room.u0 + 0.6, room.u1 - 0.6), clamp(v, room.v0 + 0.6, room.v1 - 0.6));
  return { x: p[0], y: groundY + 0.05, z: p[1] };
}

/**
 * Floor slab, ceiling and the four walls of a room, with openings cut where
 * doors are. Walls are built as spans either side of each opening plus a
 * lintel over it, which is why doorways are real holes you walk through
 * rather than decals on a solid wall.
 */
function buildRoomShell(room, floor, plan, baseY, ceilY, style, multi, collide, ctx, w) {
  const floorAcc = multi.for('int-floor', ctx.materials.solid({ roughness: 0.88, side: 2 }));
  const wallAcc = multi.for(`int-wall`, ctx.materials.solid({ roughness: 0.94 }));
  const floorColour = colourToLinear(style.floor);
  const wallColour = colourToLinear(style.wall);

  // Floor slab.
  const c00 = w(room.u0, room.v0), c10 = w(room.u1, room.v0);
  const c11 = w(room.u1, room.v1), c01 = w(room.u0, room.v1);
  floorAcc.addQuad(
    [c00[0], baseY, c00[1]], [c10[0], baseY, c10[1]],
    [c11[0], baseY, c11[1]], [c01[0], baseY, c01[1]],
    [0, 0, room.width * 0.35, room.depth * 0.35], floorColour);
  collide.surface(SURFACE_IDS[style.surface] ?? SURFACE_IDS.concrete);
  collide.quad(
    [c00[0], baseY, c00[1]], [c10[0], baseY, c10[1]],
    [c11[0], baseY, c11[1]], [c01[0], baseY, c01[1]]);

  // Ceiling, except over a stairwell, which has to be open to the floor above.
  if (room.type !== 'stairwell' || floor.level === plan.floors.length - 1) {
    floorAcc.addQuad(
      [c01[0], ceilY, c01[1]], [c11[0], ceilY, c11[1]],
      [c10[0], ceilY, c10[1]], [c00[0], ceilY, c00[1]],
      [0, 0, room.width * 0.35, room.depth * 0.35], shade(wallColour, 1.06));
    collide.quad(
      [c01[0], ceilY, c01[1]], [c11[0], ceilY, c11[1]],
      [c10[0], ceilY, c10[1]], [c00[0], ceilY, c00[1]]);
  }

  // Each of the four walls, minus any doorways on it.
  const walls = [
    { axis: 'u', at: room.v0, lo: room.u0, hi: room.u1, inward: 1 },
    { axis: 'u', at: room.v1, lo: room.u0, hi: room.u1, inward: -1 },
    { axis: 'v', at: room.u0, lo: room.v0, hi: room.v1, inward: 1 },
    { axis: 'v', at: room.u1, lo: room.v0, hi: room.v1, inward: -1 },
  ];

  // Walls that lie on the edge of the envelope are the building's outside
  // wall, and the envelope has already built those - with windows in them.
  // Drawing both puts two coplanar surfaces in the same place, which z-fights
  // and boards up every window.
  const env = plan.envelope;
  const onEnvelope = (wall) => (wall.axis === 'u'
    ? Math.abs(wall.at - env.v0) < 0.06 || Math.abs(wall.at - env.v1) < 0.06
    : Math.abs(wall.at - env.u0) < 0.06 || Math.abs(wall.at - env.u1) < 0.06);

  collide.surface(SURFACE_IDS.concrete);
  for (const wall of walls) {
    if (onEnvelope(wall)) continue;
    const openings = floor.doors
      .filter((d) => (d.a === room.index || d.b === room.index) &&
                     d.axis === wall.axis && Math.abs(d.at - wall.at) < 0.03)
      .map((d) => [d.centre - d.width / 2, d.centre + d.width / 2])
      .sort((a, b) => a[0] - b[0]);

    // The entrance itself is an opening in the exterior wall.
    if (floor.level === 0 && room === floor.entranceRoom) {
      const e = plan.entrance;
      const onThisWall = wall.axis === 'u'
        ? Math.abs(e.v - wall.at) < 1.2 && e.u > wall.lo - 0.5 && e.u < wall.hi + 0.5
        : Math.abs(e.u - wall.at) < 1.2 && e.v > wall.lo - 0.5 && e.v < wall.hi + 0.5;
      if (onThisWall) {
        const pos = clamp(wall.axis === 'u' ? e.u : e.v, wall.lo + DOOR_WIDTH, wall.hi - DOOR_WIDTH);
        openings.push([pos - DOOR_WIDTH / 2, pos + DOOR_WIDTH / 2]);
        openings.sort((a, b) => a[0] - b[0]);
      }
    }

    let cursor = wall.lo;
    for (const [o0, o1] of openings) {
      const a = clamp(o0, wall.lo, wall.hi);
      const b = clamp(o1, wall.lo, wall.hi);
      if (a > cursor) addWallSpan(wall, cursor, a, baseY, ceilY, wallAcc, collide, wallColour, w);
      // Lintel over the opening.
      const top = Math.min(baseY + DOOR_HEIGHT, ceilY);
      if (top < ceilY) addWallSpan(wall, a, b, top, ceilY, wallAcc, collide, wallColour, w);
      cursor = Math.max(cursor, b);
    }
    if (cursor < wall.hi) addWallSpan(wall, cursor, wall.hi, baseY, ceilY, wallAcc, collide, wallColour, w);
  }
}

/** One rectangular piece of wall, from `from` to `to` along its axis. */
function addWallSpan(wall, from, to, y0, y1, acc, collide, colour, w) {
  if (to - from < 0.02 || y1 - y0 < 0.02) return;
  const p0 = wall.axis === 'u' ? w(from, wall.at) : w(wall.at, from);
  const p1 = wall.axis === 'u' ? w(to, wall.at) : w(wall.at, to);
  // Two faces so the wall reads from both rooms; it is drawn front-side only.
  acc.addQuad(
    [p0[0], y0, p0[1]], [p1[0], y0, p1[1]],
    [p1[0], y1, p1[1]], [p0[0], y1, p0[1]],
    [0, 0, (to - from) * 0.4, (y1 - y0) * 0.4], colour);
  acc.addQuad(
    [p1[0], y0, p1[1]], [p0[0], y0, p0[1]],
    [p0[0], y1, p0[1]], [p1[0], y1, p1[1]],
    [0, 0, (to - from) * 0.4, (y1 - y0) * 0.4], shade(colour, 0.94));
  collide.quad(
    [p0[0], y0, p0[1]], [p1[0], y0, p1[1]],
    [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]);
}

/** A straight flight of stairs filling the stairwell. */
function buildStairs(room, baseY, topY, plan, multi, collide, ctx, w) {
  const rise = topY - baseY;
  if (rise <= 0.1) return;
  const acc = multi.for('int-floor', ctx.materials.solid({ roughness: 0.88, side: 2 }));
  const colour = colourToLinear(0x8d887e);

  const steps = Math.max(3, Math.round(rise / STAIR_RISE));
  const stepRise = rise / steps;
  // Run the flight along the room's longer side.
  const alongU = room.width >= room.depth;
  const runLength = (alongU ? room.width : room.depth) - 0.2;
  const stepRun = runLength / steps;
  const halfWidth = ((alongU ? room.depth : room.width) - 0.3) / 2;

  collide.surface(SURFACE_IDS.concrete);
  for (let i = 0; i < steps; i++) {
    const t0 = (alongU ? room.u0 : room.v0) + 0.1 + i * stepRun;
    const t1 = t0 + stepRun;
    const y = baseY + (i + 1) * stepRise;
    const cross = alongU ? room.cv : room.cu;

    // Keep the corner order consistent between the two orientations, or the
    // tread winds the other way round and the whole flight shades black.
    const a = alongU ? w(t0, cross - halfWidth) : w(cross + halfWidth, t0);
    const b = alongU ? w(t1, cross - halfWidth) : w(cross + halfWidth, t1);
    const c = alongU ? w(t1, cross + halfWidth) : w(cross - halfWidth, t1);
    const d = alongU ? w(t0, cross + halfWidth) : w(cross - halfWidth, t0);

    // Tread.
    acc.addQuad([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [d[0], y, d[1]],
                [0, 0, 0.4, 0.4], colour);
    collide.quad([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], [d[0], y, d[1]]);
    // Riser.
    acc.addQuad([a[0], y - stepRise, a[1]], [d[0], y - stepRise, d[1]],
                [d[0], y, d[1]], [a[0], y, a[1]], [0, 0, 0.4, 0.1], shade(colour, 0.88));
    collide.quad([a[0], y - stepRise, a[1]], [d[0], y - stepRise, d[1]],
                 [d[0], y, d[1]], [a[0], y, a[1]]);
  }
}

// --- furniture -------------------------------------------------------------

/**
 * Populate a room with a few pieces appropriate to what it is for.
 *
 * Deliberately restrained: enough to tell a bedroom from a kitchen at a
 * glance, placed against walls and away from doorways, without trying to be an
 * interior design tool.
 */
function furnishRoom(room, floor, plan, baseY, ceilY, multi, collide, ctx, rng, w) {
  const acc = multi.for('int-prop', ctx.materials.solid({ roughness: 0.8, side: 2 }));
  const ang = plan.frame.angle;
  const put = (u, v, width, height, depth, colour, solid = true) => {
    // Keep furniture inside the room and clear of the walls.
    if (u - width / 2 < room.u0 + 0.1 || u + width / 2 > room.u1 - 0.1) return;
    if (v - depth / 2 < room.v0 + 0.1 || v + depth / 2 > room.v1 - 0.1) return;
    const p = w(u, v);
    box(acc, p[0], baseY + height / 2, p[1], width, height, depth, colourToLinear(colour), ang);
    if (solid && height > 0.25) {
      collide.rotatedBox(p[0], baseY + height / 2, p[1], width, height, depth, ang);
    }
  };

  const cu = room.cu, cv = room.cv;
  const wall = 0.35;    // how far from a wall things sit

  switch (room.type) {
    case 'living': {
      put(cu, room.v0 + wall + 0.4, Math.min(2.1, room.width * 0.6), 0.72, 0.85, 0x6a5f52);
      put(cu, cv, Math.min(1.1, room.width * 0.35), 0.42, 0.6, 0x7a6448);
      put(cu, room.v1 - wall - 0.15, Math.min(1.4, room.width * 0.45), 0.62, 0.3, 0x3a3d40);
      break;
    }
    case 'dining': {
      put(cu, cv, Math.min(1.9, room.width * 0.55), 0.76, Math.min(1.0, room.depth * 0.4), 0x7a5b3c);
      for (const [du, dv] of [[-1.1, 0], [1.1, 0], [0, -0.8], [0, 0.8]]) {
        put(cu + du, cv + dv, 0.44, 0.92, 0.44, 0x6b5a45);
      }
      break;
    }
    case 'kitchen': case 'kitchenette': {
      // Counter run along the longest wall.
      const alongU = room.width >= room.depth;
      const len = (alongU ? room.width : room.depth) - 0.6;
      if (alongU) {
        put(cu, room.v0 + 0.32, len, 0.92, 0.62, 0xb8b2a6);
        put(cu, room.v0 + 0.28, len * 0.5, 0.7, 0.34, 0xcac4b8, false);
      } else {
        put(room.u0 + 0.32, cv, 0.62, 0.92, len, 0xb8b2a6);
      }
      put(room.u1 - 0.45, room.v1 - 0.45, 0.66, 1.75, 0.66, 0xc8ccd0);
      break;
    }
    case 'flat': {
      // A whole dwelling in one room: bed at one end, living at the other,
      // and a counter along a wall. Apartment blocks are mostly made of these,
      // so leaving them empty leaves most of a building empty.
      const bedW = Math.min(1.4, room.width * 0.42);
      put(room.u0 + bedW / 2 + 0.5, room.v0 + 1.15, bedW, 0.5, 1.95, 0x8a7a68);
      put(cu + room.width * 0.18, cv + room.depth * 0.2, Math.min(1.8, room.width * 0.45), 0.7, 0.8, 0x6a5f52);
      put(cu + room.width * 0.18, cv - room.depth * 0.05, Math.min(0.9, room.width * 0.28), 0.42, 0.55, 0x7a6448);
      put(room.u1 - 0.4, room.v1 - 1.0, 0.6, 0.9, Math.min(1.8, room.depth * 0.4), 0xb8b2a6);
      put(room.u1 - 0.45, room.v0 + 0.5, 0.6, 1.75, 0.6, 0xc8ccd0);
      break;
    }
    case 'hall': case 'landing': {
      put(cu, room.v0 + 0.3, Math.min(1.1, room.width * 0.5), 0.78, 0.35, 0x6f5c46);
      put(room.u1 - 0.35, cv, 0.35, 1.75, 0.35, 0x5f5348);
      break;
    }
    case 'bedroom': case 'hotelroom': {
      const bedW = Math.min(1.5, room.width * 0.5);
      put(cu, room.v0 + 1.15, bedW, 0.52, 2.0, 0x8a7a68);
      put(cu, room.v0 + 0.28, bedW * 0.9, 0.72, 0.16, 0xd8d2c4, false);
      put(room.u1 - 0.4, room.v0 + 0.5, 0.42, 0.55, 0.42, 0x6f5c46);
      if (room.area > 12) put(room.u0 + 0.35, cv + 0.8, 0.6, 1.9, 1.1, 0x6b5a45);
      break;
    }
    case 'bathroom': case 'wc': {
      put(room.u0 + 0.35, room.v0 + 0.4, 0.42, 0.78, 0.62, 0xeceff0);
      if (room.area > 5) put(room.u1 - 0.45, cv, 0.75, 0.56, Math.min(1.7, room.depth * 0.6), 0xeceff0);
      put(room.u0 + 0.35, room.v1 - 0.4, 0.55, 0.86, 0.42, 0xe4e8ea);
      break;
    }
    case 'office': case 'study': {
      const desks = clamp(Math.floor(room.area / 7), 1, 8);
      for (let i = 0; i < desks; i++) {
        const u = lerp(room.u0 + 1, room.u1 - 1, desks === 1 ? 0.5 : i / (desks - 1));
        put(u, cv, 1.35, 0.74, 0.7, 0x8a7a62);
        put(u, cv + 0.62, 0.48, 0.95, 0.48, 0x3f4347);
        put(u, cv - 0.12, 0.5, 0.34, 0.06, 0x24282c, false);
      }
      break;
    }
    case 'meeting': {
      put(cu, cv, Math.min(2.8, room.width * 0.6), 0.74, Math.min(1.3, room.depth * 0.5), 0x6f5c46);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        put(cu + Math.cos(a) * 1.7, cv + Math.sin(a) * 1.1, 0.46, 0.9, 0.46, 0x40444a);
      }
      break;
    }
    case 'classroom': {
      const rows = clamp(Math.floor(room.depth / 1.6), 1, 5);
      const cols = clamp(Math.floor(room.width / 1.5), 1, 6);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const u = lerp(room.u0 + 1, room.u1 - 1, cols === 1 ? 0.5 : c / (cols - 1));
          const v = lerp(room.v0 + 1.4, room.v1 - 0.8, rows === 1 ? 0.5 : r / (rows - 1));
          put(u, v, 1.1, 0.72, 0.5, 0x9c8a6c);
        }
      }
      put(cu, room.v0 + 0.2, Math.min(3, room.width * 0.7), 1.2, 0.08, 0x2f4438, false);
      break;
    }
    case 'shopfloor': {
      const aisles = clamp(Math.floor(room.width / 3.2), 1, 8);
      for (let i = 0; i < aisles; i++) {
        const u = lerp(room.u0 + 1.4, room.u1 - 1.4, aisles === 1 ? 0.5 : i / (aisles - 1));
        put(u, cv, 0.9, 1.85, Math.min(room.depth - 2.2, 7), 0xa8a49a);
      }
      break;
    }
    case 'checkout': {
      const n = clamp(Math.floor(room.width / 2.2), 1, 5);
      for (let i = 0; i < n; i++) {
        const u = lerp(room.u0 + 1, room.u1 - 1, n === 1 ? 0.5 : i / (n - 1));
        put(u, cv, 1.5, 0.95, 0.7, 0x8f9498);
      }
      break;
    }
    case 'storeroom': case 'store': {
      const racks = clamp(Math.floor(room.width / 1.8), 1, 6);
      for (let i = 0; i < racks; i++) {
        const u = lerp(room.u0 + 0.8, room.u1 - 0.8, racks === 1 ? 0.5 : i / (racks - 1));
        put(u, cv, 0.7, 2.1, Math.min(room.depth - 1.2, 4), 0x8a8378);
      }
      break;
    }
    case 'lobby': case 'reception': {
      put(cu, room.v0 + 0.9, Math.min(2.4, room.width * 0.5), 1.1, 0.7, 0x6f5c46);
      put(room.u0 + 1.0, room.v1 - 1.0, 1.8, 0.6, 0.8, 0x55585c);
      break;
    }
    case 'bar': {
      put(cu, room.v0 + 0.8, Math.min(4, room.width * 0.7), 1.1, 0.6, 0x5f4c38);
      for (let i = 0; i < 4; i++) put(cu - 1.5 + i, room.v0 + 1.6, 0.36, 0.75, 0.36, 0x3f3a34);
      break;
    }
    case 'ward': {
      const beds = clamp(Math.floor(room.width / 2.4), 1, 6);
      for (let i = 0; i < beds; i++) {
        const u = lerp(room.u0 + 1.2, room.u1 - 1.2, beds === 1 ? 0.5 : i / (beds - 1));
        put(u, room.v0 + 1.2, 1.0, 0.6, 2.0, 0xdfe4e6);
      }
      break;
    }
    case 'nave': {
      const rows = clamp(Math.floor(room.depth / 1.1), 2, 24);
      for (let r = 0; r < rows; r++) {
        const v = lerp(room.v0 + 2, room.v1 - 2, r / (rows - 1));
        put(cu - room.width * 0.18, v, room.width * 0.28, 0.85, 0.42, 0x6b5334);
        put(cu + room.width * 0.18, v, room.width * 0.28, 0.85, 0.42, 0x6b5334);
      }
      break;
    }
    case 'workshop': case 'barnfloor': {
      const n = clamp(Math.floor(room.area / 40), 1, 8);
      for (let i = 0; i < n; i++) {
        put(rng.range(room.u0 + 1.5, room.u1 - 1.5), rng.range(room.v0 + 1.5, room.v1 - 1.5),
            rng.range(1, 2.4), rng.range(0.8, 1.6), rng.range(0.8, 1.6), 0x7a746a);
      }
      break;
    }
    case 'staff': {
      put(cu, cv, 1.4, 0.74, 0.8, 0x7a6448);
      put(room.u0 + 0.5, room.v1 - 0.5, 0.6, 1.7, 0.6, 0xc8ccd0);
      break;
    }
    default:
      break;
  }
}

// --- streaming -------------------------------------------------------------

/**
 * Keeps interiors generated for the buildings you are closest to.
 *
 * Generating on approach rather than on a keypress means walking through a
 * doorway is continuous: there is nothing to trigger and nothing to wait for.
 */
export class InteriorManager {
  constructor(scene, world, ctx) {
    this.scene = scene;
    this.world = world;
    this.ctx = ctx;
    this.current = null;           // the one loaded cell, or null when outdoors
    this.failed = new Set();       // buildings that could not produce a plan
    this.stats = { active: 0, triangles: 0, lastBuildMs: 0 };
  }

  get isInside() { return this.current !== null; }

  /**
   * Load a building's interior and take over the world.
   *
   * Returns the position to put the player, or null if the building has no
   * viable interior (too small, or generation failed).
   */
  enter(building) {
    if (this.current) this.leave();
    const key = building.source;
    if (this.failed.has(key)) return null;

    const t0 = performance.now();
    let interior;
    try {
      interior = buildInterior(building, this.ctx);
    } catch (e) {
      this.failed.add(key);
      this.world.recordError('interior', key, e);
      return null;
    }
    if (!interior) { this.failed.add(key); return null; }

    this.scene.add(interior.group);
    interior.group.updateMatrixWorld(true);
    if (interior.collider) {
      this.world.collisionWorld.set(`int:${key}`, interior.collider, 'interior');
    }
    // Everything outdoors stops being drawn and stops being collided against.
    this.world.setVisible(false);
    this.world.collisionWorld.useLayer('interior');

    this.current = interior;
    this.stats.active = 1;
    this.stats.triangles = interior.triangles;
    this.stats.lastBuildMs = performance.now() - t0;
    return interior.spawn;
  }

  /**
   * Unload the cell and hand back the position to step out to.
   * The caller still has to drop the player onto the ground there.
   */
  leave() {
    const interior = this.current;
    if (!interior) return null;
    const out = interior.exit ? interior.exit.outside : null;

    this.scene.remove(interior.group);
    interior.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.world.collisionWorld.clear('interior');
    this.world.collisionWorld.useLayer('world');
    this.world.setVisible(true);

    this.current = null;
    this.stats.active = 0;
    this.stats.triangles = 0;
    return out;
  }

  /** Which room am I standing in, if any? */
  roomAt(x, y, z) {
    const interior = this.current;
    if (!interior) return null;
    const [u, v] = interior.plan.frame.toLocal(x, z);
    const groundY = interior.groundY;
    for (const floor of interior.plan.floors) {
      const base = groundY + floor.baseY;
      if (y < base - 0.6 || y > base + interior.plan.ceiling + 0.4) continue;
      for (const room of floor.rooms) {
        if (u >= room.u0 && u <= room.u1 && v >= room.v0 && v <= room.v1) {
          return { interior, room, floor, label: ROOM_LABELS[room.type] || 'Room' };
        }
      }
    }
    return null;
  }

  /** How far is the player from the way out? */
  distanceToExit(x, y, z) {
    if (!this.current || !this.current.exit) return Infinity;
    const d = this.current.exit.doorway;
    // Only the ground floor counts: the door is not on the third storey.
    if (Math.abs(y - d.y) > 2.2) return Infinity;
    return Math.hypot(d.x - x, d.z - z);
  }

  clear() {
    this.leave();
    this.failed.clear();
  }

  /** Ceiling lights near the player, for the renderer to instantiate. */
  nearbyLights(px, py, pz, radius = 16, max = 8) {
    if (!this.current) return [];
    const out = [];
    for (const l of this.current.lights) {
      const d = Math.hypot(l.x - px, l.z - pz, (l.y - py) * 0.5);
      if (d < radius) out.push({ ...l, distance: d });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, max);
  }
}

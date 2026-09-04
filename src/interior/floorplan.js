// Procedural floor plans.
//
// OSM knows a building's outline, its height and roughly what it is for. It
// does not know where the kitchen is. So interiors are invented - but invented
// deterministically, seeded from the building's OSM id, so the same building
// always has the same layout. Walk out and back in and nothing has moved.
//
// The method:
//
//   1. Work in the building's own oriented bounding box, not in world axes, so
//      a terrace on a diagonal street still gets rooms square to its walls.
//   2. Reserve a circulation corridor first for anything that needs one (a
//      block of flats, an office floor, a school), because corridors are what
//      make a plan legible and pure BSP never produces them.
//   3. Recursively split what is left, stopping when a room is small enough for
//      its purpose.
//   4. Drop leaves that fall outside the real footprint, which is what gives an
//      L-shaped building an L-shaped plan.
//   5. Connect everything: build the adjacency graph, spanning-tree it from the
//      front door so every room is reachable, then add a few extra doors so it
//      is not a pure tree.
//
// Everything here is plain geometry with no rendering dependency, so it can be
// tested headlessly - and it is, in tests/interior.test.mjs.

import { makeRng, hashString } from '../core/rng.js';
import { orientedBounds, pointInPolygon, insetRing, area, centroid } from '../world/geometry.js';
import { clamp } from '../core/util.js';

export const WALL_THICKNESS = 0.14;
export const EXTERIOR_THICKNESS = 0.32;
export const DOOR_WIDTH = 0.92;
export const DOOR_HEIGHT = 2.05;
export const MIN_ROOM = 2.1;          // no dimension smaller than this
export const CORRIDOR_WIDTH = 1.6;

/**
 * What each kind of building is made of.
 *
 * `target` is the area a room of that type wants; `corridor` says the floor
 * needs circulation; `unitised` means the floor divides into repeated dwellings
 * or offices off that corridor rather than one continuous plan.
 */
export const PROGRAMS = {
  house: {
    target: 15, corridor: false, unitised: false, ceiling: 2.5,
    ground: [['hall', 1], ['living', 2.4], ['kitchen', 1.5], ['dining', 1.2], ['wc', 0.5], ['study', 0.8]],
    upper: [['landing', 0.8], ['bedroom', 3], ['bathroom', 1], ['study', 0.7]],
  },
  apartments: {
    target: 17, corridor: true, unitised: true, ceiling: 2.55,
    ground: [['lobby', 1.4], ['flat', 4], ['store', 0.5]],
    upper: [['flat', 6]],
  },
  hotel: {
    target: 19, corridor: true, unitised: true, ceiling: 2.7,
    ground: [['lobby', 3], ['bar', 1.4], ['office', 0.6], ['wc', 0.6]],
    upper: [['hotelroom', 8]],
  },
  office: {
    target: 26, corridor: true, unitised: false, ceiling: 2.9,
    ground: [['lobby', 2], ['reception', 1], ['office', 3], ['meeting', 1], ['wc', 0.7]],
    upper: [['office', 5], ['meeting', 1.4], ['kitchenette', 0.7], ['wc', 0.6]],
  },
  retail: {
    target: 155, corridor: false, unitised: false, ceiling: 3.4,
    ground: [['shopfloor', 5], ['checkout', 0.7], ['storeroom', 1], ['staff', 0.5]],
    upper: [['storeroom', 2], ['office', 1.4], ['staff', 0.8]],
  },
  school: {
    target: 48, corridor: true, unitised: false, ceiling: 3.1,
    ground: [['hall', 1.4], ['classroom', 4], ['office', 0.8], ['wc', 0.7]],
    upper: [['classroom', 6], ['office', 0.7], ['wc', 0.6]],
  },
  hospital: {
    target: 30, corridor: true, unitised: false, ceiling: 2.9,
    ground: [['lobby', 1.6], ['ward', 3], ['office', 1.2], ['wc', 0.8]],
    upper: [['ward', 5], ['office', 1], ['wc', 0.7]],
  },
  civic: {
    target: 34, corridor: true, unitised: false, ceiling: 3.4,
    ground: [['lobby', 2.2], ['hall', 2], ['office', 2], ['wc', 0.7]],
    upper: [['office', 4], ['meeting', 1.4], ['wc', 0.6]],
  },
  worship: {
    target: 400, corridor: false, unitised: false, ceiling: 8,
    ground: [['nave', 8], ['vestry', 0.6]],
    upper: [['nave', 1]],
  },
  industrial: {
    target: 260, corridor: false, unitised: false, ceiling: 6.5,
    ground: [['workshop', 6], ['store', 1.4], ['office', 0.7]],
    upper: [['store', 2], ['office', 1]],
  },
  barn: {
    target: 180, corridor: false, unitised: false, ceiling: 5.5,
    ground: [['barnfloor', 6], ['store', 1]],
    upper: [['store', 2]],
  },
  shed: {
    target: 14, corridor: false, unitised: false, ceiling: 2.3,
    ground: [['store', 3]],
    upper: [['store', 1]],
  },
  parking: {
    target: 400, corridor: false, unitised: false, ceiling: 2.5,
    ground: [['parkdeck', 6]],
    upper: [['parkdeck', 6]],
  },
  station: {
    target: 200, corridor: false, unitised: false, ceiling: 7,
    ground: [['concourse', 6], ['office', 0.7], ['wc', 0.6]],
    upper: [['office', 2]],
  },
  stadium: {
    target: 400, corridor: false, unitised: false, ceiling: 9,
    ground: [['concourse', 6]],
    upper: [['concourse', 2]],
  },
  generic: {
    target: 24, corridor: false, unitised: false, ceiling: 2.7,
    ground: [['hall', 1], ['room', 4], ['wc', 0.5]],
    upper: [['room', 5], ['wc', 0.5]],
  },
};

export const ROOM_LABELS = {
  hall: 'Hallway', landing: 'Landing', living: 'Living room', kitchen: 'Kitchen',
  dining: 'Dining room', bedroom: 'Bedroom', bathroom: 'Bathroom', wc: 'Toilet',
  study: 'Study', lobby: 'Lobby', flat: 'Apartment', hotelroom: 'Guest room',
  office: 'Office', meeting: 'Meeting room', kitchenette: 'Kitchenette',
  reception: 'Reception', shopfloor: 'Shop floor', checkout: 'Checkout',
  storeroom: 'Stockroom', staff: 'Staff room', store: 'Store', classroom: 'Classroom',
  ward: 'Ward', nave: 'Nave', vestry: 'Vestry', workshop: 'Workshop',
  barnfloor: 'Barn', parkdeck: 'Parking deck', concourse: 'Concourse',
  bar: 'Bar', room: 'Room', corridor: 'Corridor', stairwell: 'Stairwell',
};

/** A room is an axis-aligned rectangle in the building's own frame. */
class Room {
  constructor(u0, v0, u1, v1, type) {
    this.u0 = u0; this.v0 = v0; this.u1 = u1; this.v1 = v1;
    this.type = type || 'room';
    this.doors = [];
    this.index = -1;
  }
  get width() { return this.u1 - this.u0; }
  get depth() { return this.v1 - this.v0; }
  get area() { return this.width * this.depth; }
  get cu() { return (this.u0 + this.u1) / 2; }
  get cv() { return (this.v0 + this.v1) / 2; }
  get label() { return ROOM_LABELS[this.type] || 'Room'; }
}

/** Transform between world metres and the building's own frame. */
export class BuildingFrame {
  constructor(obb) {
    this.cx = obb.cx; this.cz = obb.cz;
    this.ux = obb.axisX[0]; this.uz = obb.axisX[1];
    this.vx = obb.axisZ[0]; this.vz = obb.axisZ[1];
    this.width = obb.width; this.depth = obb.depth;
    this.angle = obb.angle;
  }
  toLocal(x, z) {
    const dx = x - this.cx, dz = z - this.cz;
    return [dx * this.ux + dz * this.uz, dx * this.vx + dz * this.vz];
  }
  toWorld(u, v) {
    return [
      this.cx + u * this.ux + v * this.vx,
      this.cz + u * this.uz + v * this.vz,
    ];
  }
}

/**
 * Generate the complete interior for a building.
 * Returns floors, each with rooms, doors, walls and the stair shaft.
 */
export function generateInterior(building, opts = {}) {
  const {
    maxFloors = 8,
    detail = 'high',
  } = opts;

  const rng = makeRng(hashString(`interior/${building.source || building.id}`));
  const program = PROGRAMS[building.kind] || PROGRAMS.generic;

  const obb = orientedBounds(building.ring);
  const frame = new BuildingFrame(obb);

  // The usable envelope: the footprint pulled in by the thickness of the
  // external wall, expressed in the building's own frame.
  const inner = insetRing(building.ring, EXTERIOR_THICKNESS) || building.ring;
  const localRing = inner.map(([x, z]) => frame.toLocal(x, z));
  const localHoles = (building.holes || []).map((h) => h.map(([x, z]) => frame.toLocal(x, z)));

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [u, v] of localRing) {
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const envelope = { u0: minU, v0: minV, u1: maxU, v1: maxV };
  const usableArea = area(localRing);

  // Anything this small is a cupboard, not a building you can walk into.
  if (usableArea < 6 || (maxU - minU) < 2.2 || (maxV - minV) < 2.2) {
    return { viable: false, reason: 'too small to enter' };
  }

  const floorHeight = clamp(building.heights.floorH, 2.3, 12);
  const ceiling = Math.min(program.ceiling, floorHeight - 0.28);
  const floorCount = clamp(Math.min(building.levels, maxFloors), 1, maxFloors);

  // Where the front door is, in the building's frame.
  const door = building.door;
  const doorLocal = door ? frame.toLocal(door.x, door.z) : [0, minV];
  const doorNormal = door ? [
    door.nx * frame.ux + door.nz * frame.uz,
    door.nx * frame.vx + door.nz * frame.vz,
  ] : [0, -1];

  // One subdivision, shared by every floor.
  //
  // Real buildings are like this - the structure does not move between
  // storeys - and it also solves two problems for free: the stair shaft is in
  // the same place all the way up without any special handling, and the shaft
  // is an ordinary room in the layout rather than a hole punched through it,
  // so it can never overlap or orphan its neighbours.
  const skeleton = subdivideBuilding(envelope, localRing, localHoles, program, rng);
  if (!skeleton.rooms.length) return { viable: false, reason: 'no room fits inside' };

  // The room you step into should be a hall or a shop floor, not a stair
  // shaft, so the stairs are placed anywhere but there.
  const entranceRoom = nearestRoom(skeleton.rooms, doorLocal[0], doorLocal[1]);
  const entranceIndex = entranceRoom ? entranceRoom.index : -1;
  const stairIndex = floorCount > 1
    ? chooseStairwell(skeleton.rooms, doorLocal, rng, entranceIndex) : -1;
  const stairs = stairIndex >= 0 ? { ...skeleton.rooms[stairIndex] } : null;

  const floors = [];
  for (let level = 0; level < floorCount; level++) {
    const isGround = level === 0;
    const plan = planFloor({
      skeleton, stairIndex, program,
      mix: isGround ? program.ground : program.upper,
      rng: makeRng(hashString(`floor/${building.source || building.id}/${level}`)),
      level, isGround, doorLocal,
    });
    plan.level = level;
    plan.baseY = level * floorHeight;
    plan.ceilingY = plan.baseY + ceiling;
    floors.push(plan);
  }

  return {
    viable: true,
    frame,
    floors,
    floorCount,
    floorHeight,
    ceiling,
    stairs,
    localRing,
    localHoles,
    envelope,
    program,
    entrance: { u: doorLocal[0], v: doorLocal[1], nu: doorNormal[0], nv: doorNormal[1] },
    building,
    name: building.name,
    kind: building.kind,
  };
}

/**
 * Pick which room becomes the stairwell: small enough not to waste a good
 * room, near the entrance so you find the stairs where you expect them.
 */
function chooseStairwell(rooms, doorLocal, rng, avoidIndex = -1) {
  let best = -1, bestScore = Infinity;
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    if (i === avoidIndex) continue;
    if (r.type === 'corridor') continue;
    if (r.width < 2.0 || r.depth < 2.0) continue;
    const dist = Math.hypot(r.cu - doorLocal[0], r.cv - doorLocal[1]);
    // Prefer a modest room a short way in from the front door.
    const sizePenalty = Math.abs(r.area - 9) * 0.35;
    const score = dist * 0.8 + sizePenalty + rng() * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  }
  // A one-room floor has nowhere else to put them; better a stairwell in the
  // entrance room than a building whose upper storeys cannot be reached.
  if (best < 0 && avoidIndex >= 0) return chooseStairwell(rooms, doorLocal, rng, -1);
  return best;
}

/** How much of a rectangle lies inside the footprint, sampled on a grid. */
function rectCoverage(rect, ring, holes, samples = 5) {
  let inside = 0, total = 0;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const u = rect.u0 + ((i + 0.5) / samples) * (rect.u1 - rect.u0);
      const v = rect.v0 + ((j + 0.5) / samples) * (rect.v1 - rect.v0);
      total++;
      if (pointInPolygon(ring, holes, u, v)) inside++;
    }
  }
  return total ? inside / total : 0;
}

/**
 * Divide the envelope into rooms once, for the whole building.
 * Returns the room rectangles and which of them are corridors.
 */
function subdivideBuilding(envelope, localRing, localHoles, program, rng) {
  const corridors = [];

  // Reserve circulation first, where the building needs it. Pure BSP never
  // produces a corridor, and a block of flats without one is just a warren.
  let regions = [{ ...envelope }];
  const spanU = envelope.u1 - envelope.u0;
  const spanV = envelope.v1 - envelope.v0;
  if (program.corridor && Math.min(spanU, spanV) > CORRIDOR_WIDTH + MIN_ROOM * 2) {
    const alongU = spanU >= spanV;
    const mid = alongU ? (envelope.v0 + envelope.v1) / 2 : (envelope.u0 + envelope.u1) / 2;
    const half = CORRIDOR_WIDTH / 2;
    if (alongU) {
      corridors.push({ u0: envelope.u0, v0: mid - half, u1: envelope.u1, v1: mid + half });
      regions = [
        { u0: envelope.u0, v0: envelope.v0, u1: envelope.u1, v1: mid - half },
        { u0: envelope.u0, v0: mid + half, u1: envelope.u1, v1: envelope.v1 },
      ];
    } else {
      corridors.push({ u0: mid - half, v0: envelope.v0, u1: mid + half, v1: envelope.v1 });
      regions = [
        { u0: envelope.u0, v0: envelope.v0, u1: mid - half, v1: envelope.v1 },
        { u0: mid + half, v0: envelope.v0, u1: envelope.u1, v1: envelope.v1 },
      ];
    }
  }

  const leaves = [];
  for (const region of regions) {
    if (region.u1 - region.u0 < MIN_ROOM || region.v1 - region.v0 < MIN_ROOM) continue;
    subdivide(region, program.target, rng, leaves, 0);
  }

  const rooms = [];
  // Corridors first, so they take low indices and read as the spine.
  for (const c of corridors) {
    if (rectCoverage(c, localRing, localHoles) < 0.4) continue;
    rooms.push(new Room(c.u0, c.v0, c.u1, c.v1, 'corridor'));
  }
  // Then the rooms that genuinely sit inside the footprint. Dropping the rest
  // is what gives an L-shaped building an L-shaped plan.
  for (const leaf of leaves) {
    if (rectCoverage(leaf, localRing, localHoles) < 0.55) continue;
    const room = new Room(leaf.u0, leaf.v0, leaf.u1, leaf.v1);
    if (room.width < MIN_ROOM * 0.8 || room.depth < MIN_ROOM * 0.8) continue;
    rooms.push(room);
  }
  rooms.forEach((r, i) => { r.index = i; });
  return { rooms, corridorCount: corridors.length };
}

/** Lay out one storey over the shared skeleton. */
function planFloor({ skeleton, stairIndex, program, mix, rng, level, isGround, doorLocal }) {
  // Copy the shared rectangles; only the types and doors differ per floor.
  const rooms = skeleton.rooms.map((r) => {
    const copy = new Room(r.u0, r.v0, r.u1, r.v1, r.type);
    copy.index = r.index;
    return copy;
  });

  const stairRoom = stairIndex >= 0 ? rooms[stairIndex] : null;
  if (stairRoom) stairRoom.type = 'stairwell';

  // Assign types to everything that is not already spoken for.
  const assignable = rooms.filter((r) => r.type !== 'corridor' && r.type !== 'stairwell');
  assignTypes(assignable, mix, rng);

  let doors = connectRooms(rooms, doorLocal, isGround, rng);

  // Drop anything the connector could not reach, and reindex.
  if (rooms.some((r) => r.orphaned)) {
    const remap = new Map();
    const kept = [];
    for (const r of rooms) {
      if (r.orphaned) continue;
      remap.set(r.index, kept.length);
      r.index = kept.length;
      kept.push(r);
    }
    doors = doors
      .filter((d) => remap.has(d.a) && remap.has(d.b))
      .map((d) => ({ ...d, a: remap.get(d.a), b: remap.get(d.b) }));
    rooms.length = 0;
    rooms.push(...kept);
  }

  return {
    rooms,
    doors,
    stairRoom: stairRoom && !stairRoom.orphaned ? stairRoom : null,
    corridorCount: skeleton.corridorCount,
    entranceRoom: isGround ? nearestRoom(rooms, doorLocal[0], doorLocal[1]) : null,
  };
}

/** Recursive binary split, always across the longer side. */
function subdivide(rect, target, rng, out, depth) {
  const w = rect.u1 - rect.u0, d = rect.v1 - rect.v0;
  const a = w * d;
  if (depth > 7 || a <= target * rng.range(1.0, 1.9) || (w < MIN_ROOM * 2 && d < MIN_ROOM * 2)) {
    out.push(rect);
    return;
  }
  const splitU = w >= d;
  const span = splitU ? w : d;
  if (span < MIN_ROOM * 2) { out.push(rect); return; }
  // Split near the middle but not exactly, so rooms are not all identical.
  const t = rng.range(0.38, 0.62);
  const cut = (splitU ? rect.u0 : rect.v0) + span * t;
  const lo = splitU
    ? { u0: rect.u0, v0: rect.v0, u1: cut, v1: rect.v1 }
    : { u0: rect.u0, v0: rect.v0, u1: rect.u1, v1: cut };
  const hi = splitU
    ? { u0: cut, v0: rect.v0, u1: rect.u1, v1: rect.v1 }
    : { u0: rect.u0, v0: cut, u1: rect.u1, v1: rect.v1 };
  subdivide(lo, target, rng, out, depth + 1);
  subdivide(hi, target, rng, out, depth + 1);
}

function rectsOverlap(a, b, margin = 0) {
  return !(a.u1 <= b.u0 + margin || a.u0 >= b.u1 - margin ||
           a.v1 <= b.v0 + margin || a.v0 >= b.v1 - margin);
}

/** Hand out room types, largest rooms getting the types that want space. */
function assignTypes(rooms, mix, rng) {
  if (!rooms.length) return;
  const sorted = rooms.slice().sort((a, b) => b.area - a.area);
  // Expand the weighted mix into a queue proportional to the room count.
  const queue = [];
  const totalWeight = mix.reduce((s, [, w]) => s + w, 0);
  for (const [type, weight] of mix) {
    const n = Math.max(1, Math.round((weight / totalWeight) * sorted.length));
    for (let i = 0; i < n; i++) queue.push(type);
  }
  // Types that want to be large go first, so they land on the big rooms.
  const wantsSpace = { living: 5, shopfloor: 9, nave: 9, workshop: 9, concourse: 9,
                       barnfloor: 8, parkdeck: 8, hall: 6, lobby: 6, classroom: 6,
                       ward: 5, meeting: 4, office: 3, flat: 4, hotelroom: 3,
                       bedroom: 3, dining: 3, kitchen: 2, staff: 2, store: 1.5,
                       storeroom: 2, study: 2, bathroom: 1, kitchenette: 1,
                       reception: 3, checkout: 2, bar: 4, vestry: 1, wc: 0.5, room: 2 };
  queue.sort((a, b) => (wantsSpace[b] || 2) - (wantsSpace[a] || 2));

  for (let i = 0; i < sorted.length; i++) {
    sorted[i].type = queue[Math.min(i, queue.length - 1)] || 'room';
  }
  // A tiny room should never be the living room.
  for (const r of sorted) {
    if (r.area < 4.5 && !['wc', 'bathroom', 'store', 'kitchenette', 'stairwell'].includes(r.type)) {
      r.type = rng.pick(['wc', 'store', 'kitchenette']);
    }
  }
}

function nearestRoom(rooms, u, v) {
  let best = null, bestD = Infinity;
  for (const r of rooms) {
    const du = clamp(u, r.u0, r.u1) - u;
    const dv = clamp(v, r.v0, r.v1) - v;
    const d = du * du + dv * dv;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/**
 * Put doors between rooms so the whole floor is reachable.
 *
 * A spanning tree from the entrance guarantees reachability; a few extra edges
 * afterwards stop the plan feeling like a maze with exactly one route.
 */
function connectRooms(rooms, doorLocal, isGround, rng) {
  const doors = [];
  const n = rooms.length;
  if (n === 0) return doors;

  // Every pair of rooms that share enough wall for a door.
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const shared = sharedWall(rooms[i], rooms[j]);
      if (shared) edges.push({ i, j, shared, cost: rng() });
    }
  }

  // Prefer opening onto a corridor: real buildings do.
  for (const e of edges) {
    if (rooms[e.i].type === 'corridor' || rooms[e.j].type === 'corridor') e.cost -= 2;
    if (rooms[e.i].type === 'stairwell' || rooms[e.j].type === 'stairwell') e.cost -= 0.6;
  }
  edges.sort((a, b) => a.cost - b.cost);

  // Kruskal, giving a minimum spanning forest over the adjacency graph.
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent[ra] = rb; return true; };

  const used = new Set();
  for (const e of edges) {
    if (union(e.i, e.j)) {
      doors.push(makeDoor(e, rooms));
      used.add(`${e.i}:${e.j}`);
    }
  }
  // Repair pass. A room whose only shared walls are shorter than a door still
  // has to be reachable - a sealed room is worse than a narrow door. Relax the
  // requirement for anything still cut off, and if even that fails, punch
  // through to the nearest room outright.
  const components = () => {
    const seen = new Map();
    for (let i = 0; i < n; i++) seen.set(find(i), (seen.get(find(i)) || []).concat(i));
    return [...seen.values()];
  };
  let groups = components();
  if (groups.length > 1) {
    const relaxed = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (find(i) === find(j)) continue;
        const shared = sharedWall(rooms[i], rooms[j], 0.05, 0.62);
        if (shared) relaxed.push({ i, j, shared, cost: -(shared.hi - shared.lo) });
      }
    }
    relaxed.sort((a, b) => a.cost - b.cost);
    for (const e of relaxed) {
      if (union(e.i, e.j)) { doors.push(makeDoor(e, rooms)); used.add(`${e.i}:${e.j}`); }
    }
    groups = components();
  }
  if (groups.length > 1) {
    // Still stranded: drop the orphans rather than ship an unreachable room.
    const main = groups.reduce((a, b) => (a.length >= b.length ? a : b));
    const keep = new Set(main);
    const orphans = [];
    for (let i = 0; i < n; i++) if (!keep.has(i)) orphans.push(i);
    if (orphans.length && orphans.length < n) {
      for (const i of orphans) rooms[i].orphaned = true;
    }
  }

  // A handful of extra doors for loops, so the plan is not a pure tree.
  const extra = Math.floor(edges.length * 0.16);
  for (let k = 0, added = 0; k < edges.length && added < extra; k++) {
    const e = edges[k];
    if (used.has(`${e.i}:${e.j}`)) continue;
    if (rooms[e.i].orphaned || rooms[e.j].orphaned) continue;
    if (rng() < 0.4) { doors.push(makeDoor(e, rooms)); used.add(`${e.i}:${e.j}`); added++; }
  }

  return doors;
}

function makeDoor(edge, rooms) {
  const s = edge.shared;
  const mid = (s.lo + s.hi) / 2;
  const door = {
    a: edge.i, b: edge.j,
    axis: s.axis,                        // 'u' means the wall runs along u
    at: s.at,                            // position on the perpendicular axis
    centre: mid,
    width: Math.min(DOOR_WIDTH, s.hi - s.lo - 0.2),
    open: rooms[edge.i].type === 'corridor' || rooms[edge.j].type === 'corridor'
          ? Math.random() < 0.35 : false,
  };
  return door;
}

/**
 * Where two rectangles share a wall, if they do.
 * Returns the axis the wall runs along, its position, and the overlap range.
 */
export function sharedWall(a, b, tolerance = 0.02, minOverlap = DOOR_WIDTH + 0.25) {
  // Vertical wall: a's right edge against b's left edge, or vice versa.
  for (const [p, q] of [[a, b], [b, a]]) {
    if (Math.abs(p.u1 - q.u0) < tolerance) {
      const lo = Math.max(p.v0, q.v0), hi = Math.min(p.v1, q.v1);
      if (hi - lo >= minOverlap) return { axis: 'v', at: p.u1, lo, hi };
    }
    if (Math.abs(p.v1 - q.v0) < tolerance) {
      const lo = Math.max(p.u0, q.u0), hi = Math.min(p.u1, q.u1);
      if (hi - lo >= minOverlap) return { axis: 'u', at: p.v1, lo, hi };
    }
  }
  return null;
}

/**
 * Check a floor is fully connected from its entrance.
 * Used by the tests, and by the generator as a sanity check before building.
 */
export function reachableRooms(floor) {
  const { rooms, doors } = floor;
  if (!rooms.length) return new Set();
  const adjacency = new Map();
  for (let i = 0; i < rooms.length; i++) adjacency.set(i, []);
  for (const d of doors) {
    adjacency.get(d.a).push(d.b);
    adjacency.get(d.b).push(d.a);
  }
  const start = floor.entranceRoom ? floor.entranceRoom.index
    : (floor.stairRoom ? floor.stairRoom.index : 0);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of adjacency.get(cur) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

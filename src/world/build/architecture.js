// Architectural detail by building type.
//
// An extruded footprint with a window texture on it reads as "a building", but
// not as a *school*, or a *church*, or a *corner shop*. OSM tells us what each
// building is for, and the things that actually distinguish those types at a
// glance are mostly small and additive: a chimney, a projecting cornice, an
// entrance canopy, a shop awning and fascia sign, balconies, rooftop plant, a
// spire, a roller shutter.
//
// So this pass takes the finished shell and bolts on whatever its `kind` calls
// for. Everything goes into the shared vertex-coloured material, so a street of
// detailed buildings still merges into the same handful of draw calls as a
// street of plain boxes.

import { colourToLinear, shade } from './mesh.js';
import { box, cylinder } from './props.js';
import { insetRing, offsetRing, orientedBounds, centroid, perimeter, simplify } from '../geometry.js';
import { clamp, lerp } from '../../core/util.js';

/**
 * Add the detail appropriate to a building's type.
 *
 * `acc` is the shared solid accumulator, `collide` the chunk's collision
 * builder. Only things a person could stand on or walk into are collided;
 * a cornice 12 metres up is decoration.
 */
export function addArchitecture(b, ring, ctx, acc, collide, geom, rng) {
  const { baseY, wallTopY, topY, colour } = geom;
  const kind = b.kind;
  const levels = b.levels;
  const flatRoof = b.heights.roof.shape === 'flat';
  const detail = ctx.detail;
  if (detail === 'low') return;

  const ob = orientedBounds(ring);
  const footprint = b.area;
  const door = b.door;
  // Nothing protected grows air handling units. `heritage` marks 364 of the
  // 3,750 buildings in central Munich, and every one of them is a building that
  // would never be permitted rooftop plant.
  const listed = !!(b.era && (b.era.listed || b.era.period === 'historic'));

  // Detail is emitted per ring edge, and a hand-traced OSM footprint can carry
  // forty of them for a plain rectangle. Running the trim along a simplified
  // outline keeps a cornice to a dozen quads instead of a hundred and twenty,
  // which matters when the street has four thousand buildings on it.
  const trim = simplify(ring, 0.7, true);
  const outline = trim.length >= 3 ? trim : ring;

  // The door itself, before any of the trim that shelters it. Every building a
  // person could walk into gets one: the entrance is the single most legible
  // thing on a facade, and the one the interact prompt points at, so a blank
  // wall where the prompt says "enter" reads as broken more than any missing
  // cornice ever could. Warehouses are the exception - their door is the roller
  // shutter, which addRollerDoor draws instead.
  if (door && kind !== 'industrial' && kind !== 'barn' &&
      kind !== 'parking' && kind !== 'canopy') {
    addDoorway(door, acc, collide, baseY, colour, b, rng);
  }

  switch (kind) {
    case 'house':
      addEaves(outline, acc, wallTopY, 0.32, colour);
      if (rng() < 0.85) addChimney(outline, ob, acc, topY, colour, rng);
      if (door && footprint > 40) addPorch(door, acc, collide, baseY, colour, rng, 1.1);
      break;

    case 'apartments':
      addCornice(outline, acc, wallTopY, colour);
      if (levels >= 4 && detail === 'high') addBalconies(outline, acc, collide, baseY, b, rng);
      if (levels <= 6 && flatRoof && rng() < 0.5) addChimney(outline, ob, acc, topY, colour, rng);
      if (door) addPorch(door, acc, collide, baseY, colour, rng, 0.9);
      break;

    case 'retail':
      // The three things that make a shop read as a shop from across a street.
      addFascia(outline, acc, baseY, colour, b);
      addAwning(outline, acc, baseY, rng);
      if (flatRoof) addParapetPlant(outline, acc, wallTopY, rng, 0.4);
      break;

    case 'office':
      addCornice(outline, acc, wallTopY, colour);
      if (flatRoof && !listed) addRoofPlant(outline, acc, collide, wallTopY, rng, levels);
      if (door) addCanopy(door, acc, collide, baseY, colour, 2.4, 1.6);
      break;

    case 'school':
      // Long, low, flat-roofed, with a covered entrance and roof plant.
      addCornice(outline, acc, wallTopY, colour);
      if (door) addCanopy(door, acc, collide, baseY, colour, 3.2, 2.0);
      if (flatRoof && !listed) addRoofPlant(outline, acc, collide, wallTopY, rng, levels);
      break;

    case 'hospital':
      addCornice(outline, acc, wallTopY, colour);
      if (door) addCanopy(door, acc, collide, baseY, colour, 4.5, 3.0);
      if (flatRoof && !listed) addRoofPlant(outline, acc, collide, wallTopY, rng, levels);
      break;

    case 'hotel':
      addCornice(outline, acc, wallTopY, colour);
      if (door) addCanopy(door, acc, collide, baseY, colour, 3.6, 2.4);
      if (levels >= 4 && detail === 'high') addBalconies(outline, acc, collide, baseY, b, rng);
      break;

    case 'civic':
      addCornice(outline, acc, wallTopY, colour);
      // A portico is what says "public building" more than anything else.
      if (door && footprint > 260) addPortico(door, acc, collide, baseY, wallTopY, colour);
      else if (door) addCanopy(door, acc, collide, baseY, colour, 3.0, 1.8);
      break;

    case 'worship':
      addSpire(outline, ob, acc, wallTopY, topY, b, rng);
      break;

    case 'industrial':
    case 'barn': {
      // A warehouse's door is the shutter. People still need a way in beside
      // it, though, and that personnel door is what makes the scale of the
      // shutter read - without it a roller door is just a grey rectangle.
      const shutter = door ? addRollerDoor(door, acc, baseY, colour) : 0;
      if (door && door.edgeLength > shutter + 2.4) {
        const off = shutter / 2 + 0.75;
        addDoorway({ ...door, x: door.x + -door.nz * off, z: door.z + door.nx * off,
                     edgeLength: 1.6 },
                   acc, collide, baseY, colour, { ...b, kind: 'shed' }, rng);
      }
      addEaves(outline, acc, wallTopY, 0.4, colour);
      break;
    }

    case 'station':
      if (door) addCanopy(door, acc, collide, baseY, colour, 6.0, 3.5);
      addCornice(outline, acc, wallTopY, colour);
      break;

    case 'castle':
      addCrenellation(outline, acc, wallTopY, colour);
      break;

    case 'tower':
      addCornice(outline, acc, wallTopY, colour);
      break;

    default:
      // `generic` is by far the most numerous kind in any city; give it eaves
      // only where they will actually be seen.
      if (levels >= 3 && footprint > 60) addEaves(outline, acc, wallTopY, 0.22, colour);
      break;
  }
}

// --- shared pieces ---------------------------------------------------------

/** A projecting band around the top of the wall. */
function addEaves(ring, acc, y, overhang, colour) {
  const outer = offsetRing(ring, overhang);
  if (!outer) return;
  const tone = shade(colour, 0.82);
  const n = ring.length, m = outer.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ao = outer[Math.floor((i * m) / n) % m];
    const co = outer[Math.floor(((i + 1) * m) / n) % m];
    // Underside and fascia only. The top surface is never visible from the
    // street and doubles the cost of the commonest piece of detail there is.
    acc.addQuad([ao[0], y, ao[1]], [co[0], y, co[1]], [c[0], y, c[1]], [a[0], y, a[1]],
                [0, 0, 0.4, 0.2], shade(tone, 0.7));
    acc.addQuad([co[0], y, co[1]], [ao[0], y, ao[1]],
                [ao[0], y + 0.18, ao[1]], [co[0], y + 0.18, co[1]],
                [0, 0, 0.4, 0.08], tone);
  }
}

/** A heavier moulded cornice, for anything with pretensions. */
function addCornice(ring, acc, y, colour) {
  addEaves(ring, acc, y, 0.42, colour);
}

/** Battlements. */
function addCrenellation(ring, acc, y, colour) {
  const tone = shade(colour, 1.04);
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const count = Math.max(1, Math.floor(len / 2.2));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.25) / count;
      const x = a[0] + (c[0] - a[0]) * t, z = a[1] + (c[1] - a[1]) * t;
      box(acc, x, y + 0.6, z, 1.0, 1.2, 0.7, tone,
          Math.atan2(c[1] - a[1], c[0] - a[0]));
    }
  }
}

/** A brick stack on the roof. Houses without one look wrong. */
function addChimney(ring, ob, acc, topY, colour, rng) {
  const c = centroid(ring);
  // Offset from centre toward one end, which is where they usually sit.
  const t = rng.range(0.18, 0.42) * (rng.bool() ? 1 : -1);
  const x = c[0] + ob.axisX[0] * ob.width * t;
  const z = c[1] + ob.axisX[1] * ob.width * t;
  const h = rng.range(1.0, 1.9);
  const brick = colourToLinear(rng.pick([0x8a5a44, 0x9c6a4e, 0x7a5240, 0xa8a49c]));
  cylinder(acc, x, topY - 0.4, z, 0.45, 0.42, h, brick, 4);
  box(acc, x, topY - 0.4 + h + 0.06, z, 1.05, 0.12, 1.05, shade(brick, 1.15), ob.angle);
}

/** Flat-roof plant: lift housings, tanks, air handling. */
function addRoofPlant(ring, acc, collide, y, rng, levels) {
  const inner = insetRing(ring, 2.4);
  if (!inner || inner.length < 3) return;
  const c = centroid(inner);
  const grey = colourToLinear(0x9a9690);
  const count = clamp(Math.floor(levels / 2), 1, 4);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 1.5;
    const r = rng.range(0, 4);
    const x = c[0] + Math.cos(a) * r, z = c[1] + Math.sin(a) * r;
    const w = rng.range(1.6, 3.4), h = rng.range(1.0, 2.4), d = rng.range(1.4, 2.8);
    box(acc, x, y + h / 2, z, w, h, d, shade(grey, rng.range(0.9, 1.1)), rng() * Math.PI);
    if (collide) collide.box(x, y + h / 2, z, w, h, d);
  }
}

/** Low clutter behind a parapet: aerials, vents. */
function addParapetPlant(ring, acc, y, rng, density) {
  const inner = insetRing(ring, 1.6);
  if (!inner) return;
  const c = centroid(inner);
  const n = Math.max(1, Math.round(density * 3));
  for (let i = 0; i < n; i++) {
    cylinder(acc, c[0] + rng.range(-3, 3), y, c[1] + rng.range(-3, 3),
             0.14, 0.1, rng.range(0.6, 1.4), colourToLinear(0x8b8f92), 5);
  }
}

/**
 * What kind of door this building wants.
 *
 * The numbers are the ones that make a door read at a glance from across a
 * street: how wide, how tall, how many leaves, and how much of it is glass. A
 * house has one solid painted leaf under two metres; a hospital has a pair of
 * two-and-a-half metre glass ones. Getting those two apart matters more than
 * any amount of detail on either.
 */
function doorSpecFor(b, rng) {
  const wide = { leaves: 2, glaze: 0.74, width: 2.1, height: 2.5 };
  switch (b.kind) {
    case 'house':
      return { leaves: 1, glaze: 0.0, width: 1.0, height: 2.05, fanlight: true,
               tone: rng.pick([0x44688a, 0x7d5540, 0x466b52, 0x8e4447, 0x51555a]) };
    case 'apartments':
      return { leaves: 2, glaze: 0.55, width: 1.65, height: 2.35, fanlight: true,
               tone: rng.pick([0x3f5665, 0x5c4c3e, 0x4b4e52]) };
    case 'retail':
      return { leaves: 2, glaze: 0.86, width: 1.9, height: 2.45, tone: 0x6f757a };
    case 'office':
    case 'hotel':
      return { ...wide, width: 2.2, height: 2.6, tone: 0x666c72 };
    case 'hospital':
    case 'station':
      return { ...wide, width: 2.6, height: 2.6, tone: 0x686f74 };
    case 'school':
      return { leaves: 2, glaze: 0.6, width: 1.9, height: 2.35, tone: 0x4a6d8f };
    case 'civic':
      return { leaves: 2, glaze: 0.35, width: 2.2, height: 3.0, tone: 0x6a543c };
    case 'worship':
      // Tall, solid, timber, with a fanlight standing in for a tympanum.
      return { leaves: 2, glaze: 0.0, width: 1.9, height: 3.2, fanlight: true,
               tone: 0x6d5033 };
    case 'castle':
    case 'tower':
      return { leaves: 2, glaze: 0.0, width: 1.6, height: 2.6, tone: 0x5c4633 };
    case 'shed':
      return { leaves: 1, glaze: 0.0, width: 0.95, height: 2.0, tone: 0x8a8e88 };
    default:
      return { leaves: 1, glaze: 0.4, width: 1.1, height: 2.2, tone: 0x5e6469 };
  }
}

/**
 * A real door at the real entrance.
 *
 * The facade is a single band of quads, so there is no opening to cut without
 * re-triangulating every wall in the city. Instead the whole assembly is hung
 * on the front: an architrave standing 11 cm proud, leaves that stand only 6 cm
 * proud, and a near-black reveal behind them. The leaves therefore sit five
 * centimetres *behind* the frame face, which is what the eye reads as a
 * recessed opening - and it costs a dozen boxes rather than a rebuild of the
 * wall.
 */
export function addDoorway(door, acc, collide, baseY, colour, b, rng) {
  const spec = doorSpecFor(b, rng);
  const nx = door.nx, nz = door.nz;
  const ax = -nz, az = nx;                    // unit vector along the wall
  const a = Math.atan2(nz, nx);

  // `width` is the whole opening, not the width of one leaf: a pair of doors
  // is two narrow leaves in a 2 m hole, not two 2 m leaves in a 4 m one.
  // Never let it exceed the wall carrying it either - a garden shed traced as a
  // two-metre triangle should not get a two-metre door.
  const room = door.edgeLength ? door.edgeLength - 0.4 : 4;
  const w = Math.min(spec.width, Math.max(0.85, room));
  const h = Math.min(spec.height, Math.max(1.9, (b.levels ? b.levels : 1) * 3.0 - 0.6));

  // `box()` runs its `w` argument along the angle it is given and `d` across
  // it. For anything hung on a wall that is the opposite of how you think about
  // it, so this wrapper takes (width across the wall, depth out of it) and puts
  // them in the slots box() actually wants. `t` slides along the wall, and the
  // piece is placed so its back face is on the wall plane.
  const piece = (t, y, along, height, depth, tone) =>
    box(acc, door.x + nx * depth * 0.5 + ax * t, y,
        door.z + nz * depth * 0.5 + az * t,
        depth, height, along, tone, a);

  // An entrance is nearly always in its own shadow - under a canopy, in a
  // recess, on the dark side of the street - so tones picked to look right in
  // isolation all collapse to the same black once they are in place. These are
  // deliberately lighter than the real thing so the door still reads as a door
  // and not as a hole punched in the wall.
  const frame = shade(colour, 1.18);
  const leafTone = colourToLinear(spec.tone);
  const reveal = colourToLinear(0x23272b);
  const glass = colourToLinear(0x7d94a4);

  const JAMB = 0.15, FRAME_OUT = 0.11, LEAF_OUT = 0.06;

  // The dark opening. Drawn first and shallowest, so everything else covers it.
  piece(0, baseY + h / 2, w, h, 0.02, reveal);

  // Architrave: two jambs and a head across them.
  piece(-(w / 2 + JAMB / 2), baseY + h / 2, JAMB, h, FRAME_OUT, frame);
  piece(+(w / 2 + JAMB / 2), baseY + h / 2, JAMB, h, FRAME_OUT, frame);
  piece(0, baseY + h + JAMB / 2, w + JAMB * 2, JAMB, FRAME_OUT + 0.02, frame);

  // Leaves, with a hairline between a pair so they read as two.
  const n = spec.leaves;
  const bay = w / n;
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) * bay;
    const lw = bay - 0.035;
    piece(t, baseY + h / 2 - 0.02, lw, h - 0.04, LEAF_OUT, leafTone);

    // Glazing, as one pane filling the top of the leaf. A shopfront door is
    // almost all glass; a front door has none at all.
    if (spec.glaze > 0.02) {
      const gh = (h - 0.5) * spec.glaze;
      piece(t, baseY + h - 0.28 - gh / 2, lw - 0.16, gh, LEAF_OUT + 0.012, glass);
    }

    // Handle on the meeting stile - the inner edge of a pair, the far edge of
    // a single leaf.
    const side = n === 2 ? (i === 0 ? 1 : -1) : -1;
    const hx = t + side * (lw / 2 - 0.09);
    piece(hx, baseY + 1.04, 0.045, spec.glaze > 0.5 ? 0.62 : 0.16, LEAF_OUT + 0.045,
          colourToLinear(0xb8bcc0));
  }

  // A fanlight over the head, where the storey height allows one.
  if (spec.fanlight) {
    piece(0, baseY + h + JAMB + 0.24, w * 0.86, 0.42, 0.03, glass);
  }

  // The step you actually walk onto. This is the only part worth colliding:
  // everything else is within a hand's width of a wall that already collides.
  const stepD = 0.42, stepH = 0.14;
  piece(0, baseY + stepH / 2, w + 0.34, stepH, stepD, shade(colour, 0.82));
  if (collide) {
    collide.rotatedBox(door.x + nx * stepD * 0.5, baseY + stepH / 2, door.z + nz * stepD * 0.5,
                       stepD, stepH, w + 0.34, a);
  }
}

/** A small pitched hood over a front door. */
function addPorch(door, acc, collide, baseY, colour, rng, depth) {
  const a = Math.atan2(door.nz, door.nx);
  const w = 1.7;
  const y = baseY + 2.3;
  const tone = shade(colour, 0.88);
  const cx = door.x + door.nx * depth * 0.5;
  const cz = door.z + door.nz * depth * 0.5;
  // Depth runs along the angle, width across it - see the note in addDoorway.
  box(acc, cx, y, cz, depth, 0.16, w, tone, a);
  // Two slender posts at the outer corners.
  for (const s of [-1, 1]) {
    const px = cx + (-door.nz) * s * (w / 2 - 0.12) + door.nx * (depth / 2 - 0.1);
    const pz = cz + (door.nx) * s * (w / 2 - 0.12) + door.nz * (depth / 2 - 0.1);
    cylinder(acc, px, baseY, pz, 0.07, 0.07, 2.3, shade(tone, 1.1), 5);
    if (collide) collide.cylinder(px, baseY, pz, 0.09, 2.3, 4);
  }
}

/** A larger flat canopy, the institutional version of a porch. */
function addCanopy(door, acc, collide, baseY, colour, width, depth) {
  const a = Math.atan2(door.nz, door.nx);
  const y = baseY + 3.1;
  const cx = door.x + door.nx * depth * 0.5;
  const cz = door.z + door.nz * depth * 0.5;
  const tone = shade(colour, 0.8);
  box(acc, cx, y, cz, depth, 0.22, width, tone, a);
  for (const s of [-1, 1]) {
    const px = cx + (-door.nz) * s * (width / 2 - 0.25) + door.nx * (depth / 2 - 0.2);
    const pz = cz + (door.nx) * s * (width / 2 - 0.25) + door.nz * (depth / 2 - 0.2);
    cylinder(acc, px, baseY, pz, 0.09, 0.09, 3.1, shade(tone, 1.15), 6);
    if (collide) collide.cylinder(px, baseY, pz, 0.11, 3.1, 4);
  }
}

/** Columns across the entrance: the civic gesture. */
function addPortico(door, acc, collide, baseY, wallTopY, colour) {
  const height = Math.min(wallTopY - baseY - 0.5, 7.5);
  if (height < 3) return;
  const a = Math.atan2(door.nz, door.nx);
  const depth = 2.6, width = 7.0;
  const cx = door.x + door.nx * depth * 0.5;
  const cz = door.z + door.nz * depth * 0.5;
  const stone = shade(colour, 1.08);

  for (let i = 0; i < 4; i++) {
    const t = (i / 3 - 0.5) * (width - 0.9);
    const px = cx + (-door.nz) * t + door.nx * (depth / 2 - 0.4);
    const pz = cz + (door.nx) * t + door.nz * (depth / 2 - 0.4);
    cylinder(acc, px, baseY, pz, 0.42, 0.36, height, stone, 10);
    if (collide) collide.cylinder(px, baseY, pz, 0.44, height, 6);
  }
  // Entablature and a shallow pediment above it.
  box(acc, cx, baseY + height + 0.45, cz, depth, 0.9, width, stone, a);
  box(acc, cx, baseY + height + 1.35, cz, depth * 0.8, 0.9, width * 0.82, shade(stone, 1.05), a);
}

/** Shop fascia: the signboard band above the window. */
function addFascia(ring, acc, baseY, colour, b) {
  const y = baseY + 4.0;
  const tone = colourToLinear(0x2f3338);
  const n = ring.length;
  const outer = offsetRing(ring, 0.12);
  if (!outer) return;
  const m = outer.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 2) continue;
    const ao = outer[Math.floor((i * m) / n) % m];
    const co = outer[Math.floor(((i + 1) * m) / n) % m];
    acc.addQuad([co[0], y - 0.55, co[1]], [ao[0], y - 0.55, ao[1]],
                [ao[0], y, ao[1]], [co[0], y, co[1]],
                [0, 0, 1, 0.2], tone);
  }
}

/** A projecting awning over the shopfront. */
function addAwning(ring, acc, baseY, rng) {
  const stripe = colourToLinear(rng.pick([0x8f3b34, 0x2f5a44, 0x37507a, 0x7a5f2c]));
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ex = c[0] - a[0], ez = c[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 3.5) continue;
    if (rng() < 0.4) continue;
    // Outward normal for a clockwise-from-above ring.
    const nx = ez / len, nz = -ex / len;
    const segments = Math.min(3, Math.floor(len / 3.5));
    for (let k = 0; k < segments; k++) {
      const t = (k + 0.5) / segments;
      const mx = a[0] + ex * t, mz = a[1] + ez * t;
      const w = Math.min(3.0, len / segments - 0.4);
      const angle = Math.atan2(ez, ex);
      box(acc, mx + nx * 0.7, baseY + 3.05, mz + nz * 0.7, w, 0.1, 1.4, stripe, angle);
      box(acc, mx + nx * 1.35, baseY + 2.78, mz + nz * 1.35, w, 0.42, 0.06, shade(stripe, 0.9), angle);
    }
  }
}

/** Balconies on the upper floors. */
function addBalconies(ring, acc, collide, baseY, b, rng) {
  const floorH = b.heights.floorH;
  const rail = colourToLinear(0x55585c);
  const slab = colourToLinear(0xb0aca4);
  const n = ring.length;
  const topFloor = Math.min(b.levels, 8);
  // A balcony is two boxes. Left uncapped, balconies alone cost more than
  // every other piece of detail in the city put together, so each building
  // gets a small allowance and spends it on its longest frontages.
  let budget = 8;

  for (let i = 0; i < n && budget > 0; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ex = c[0] - a[0], ez = c[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 6) continue;
    const nx = ez / len, nz = -ex / len;
    const angle = Math.atan2(ez, ex);
    const perFloor = Math.min(2, Math.floor(len / 6));
    if (perFloor < 1) continue;

    for (let f = 1; f < topFloor && budget > 0; f++) {
      if (rng() < 0.45) continue;              // not every floor, not every bay
      const y = baseY + f * floorH + 0.1;
      for (let k = 0; k < perFloor && budget > 0; k++) {
        const t = (k + 0.5) / perFloor;
        const mx = a[0] + ex * t, mz = a[1] + ez * t;
        const w = Math.min(2.6, len / perFloor - 1.0);
        if (w < 1.2) continue;
        box(acc, mx + nx * 0.55, y, mz + nz * 0.55, w, 0.14, 1.1, slab, angle);
        box(acc, mx + nx * 1.05, y + 0.5, mz + nz * 1.05, w, 0.9, 0.06, rail, angle);
        budget--;
        if (collide) {
          collide.rotatedBox(mx + nx * 0.55, y, mz + nz * 0.55, w, 0.16, 1.1, angle);
        }
      }
    }
  }
}

/** A tower and spire on a church. */
function addSpire(ring, ob, acc, wallTopY, topY, b, rng) {
  const c = centroid(ring);
  // Put the tower at one end of the long axis, which is where they go.
  const t = 0.34 * (rng.bool() ? 1 : -1);
  const x = c[0] + ob.axisX[0] * ob.width * t;
  const z = c[1] + ob.axisX[1] * ob.width * t;
  const side = clamp(Math.min(ob.width, ob.depth) * 0.34, 2.2, 6.5);
  const towerTop = wallTopY + clamp(b.heights.top * 0.55, 4, 22);
  const stone = colourToLinear(0xb8b0a0);

  box(acc, x, (wallTopY + towerTop) / 2 - 2, z, side, towerTop - wallTopY + 4, side, stone, ob.angle);
  // Belfry openings, as a darker recessed band.
  box(acc, x, towerTop - 1.6, z, side * 1.02, 1.6, side * 1.02, shade(stone, 0.55), ob.angle);
  // Cornice, then the spire itself.
  box(acc, x, towerTop + 0.2, z, side * 1.18, 0.4, side * 1.18, shade(stone, 1.1), ob.angle);

  // What goes on top depends on whose building it is. `religion` is tagged on
  // most places of worship and was not being read, so every mosque and
  // synagogue in the world was getting a church steeple.
  const religion = (b.tags && b.tags.religion || '').toLowerCase();
  const slate = colourToLinear(rng.pick([0x4a5057, 0x5c5348, 0x3f4a52]));

  if (religion === 'muslim') {
    // A shallow dome over the hall, and the tower carried up as a minaret with
    // a balcony and a small cap rather than cut off at a belfry.
    dome(acc, c[0], wallTopY, c[1], Math.min(ob.width, ob.depth) * 0.42,
         Math.min(ob.width, ob.depth) * 0.3, colourToLinear(0xbfc4c0));
    const shaft = side * 0.42;
    cylinder(acc, x, towerTop + 0.4, z, shaft, shaft * 0.88, side * 2.2, shade(stone, 1.04), 10);
    cylinder(acc, x, towerTop + 0.4 + side * 1.5, z, shaft * 1.35, shaft * 1.35, 0.35,
             shade(stone, 0.8), 10);
    dome(acc, x, towerTop + 0.4 + side * 2.2, z, shaft * 1.05, shaft * 1.5,
         colourToLinear(0x9fa79f));
    return;
  }
  if (religion === 'jewish' || religion === 'buddhist' ||
      religion === 'hindu' || religion === 'sikh') {
    dome(acc, c[0], wallTopY, c[1], Math.min(ob.width, ob.depth) * 0.44,
         Math.min(ob.width, ob.depth) * 0.34, colourToLinear(0xa9ada6));
    return;
  }

  const spireH = side * rng.range(1.5, 2.4);
  cylinder(acc, x, towerTop + 0.4, z, side * 0.62, 0.02, spireH, slate, 4);
  cylinder(acc, x, towerTop + 0.4 + spireH, z, 0.06, 0.06, 0.9, colourToLinear(0xc9a227), 4);
}

/** A hemispherical cap, as stacked rings. Used for domes and minaret caps. */
function dome(acc, x, baseY, z, radius, height, colour, rings = 5, sides = 12) {
  let rPrev = radius, yPrev = baseY;
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    const r = radius * Math.cos(t * Math.PI / 2);
    const y = baseY + height * Math.sin(t * Math.PI / 2);
    cylinder(acc, x, yPrev, z, rPrev, r, y - yPrev, shade(colour, 0.9 + t * 0.2), sides, false);
    rPrev = r; yPrev = y;
  }
}

/** A roller shutter, for a warehouse or a barn. Returns the width it used. */
function addRollerDoor(door, acc, baseY, colour) {
  const a = Math.atan2(door.nz, door.nx);
  const w = Math.min(4.2, Math.max(2.6, door.edgeLength ? door.edgeLength * 0.5 : 3.2));
  const h = 4.0;
  box(acc, door.x + door.nx * 0.08, baseY + h / 2, door.z + door.nz * 0.08,
      0.16, h, w, colourToLinear(0x8e9296), a);
  box(acc, door.x + door.nx * 0.12, baseY + h + 0.2, door.z + door.nz * 0.12,
      0.3, 0.4, w + 0.4, colourToLinear(0x6f7377), a);
  return w;
}

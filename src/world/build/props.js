// Street furniture and barriers.
//
// Small objects, but they carry a lot of the weight in making a street feel
// like a street: lamp posts that actually light up at dusk, benches you can sit
// beside, bollards you have to walk around, walls and hedges you cannot walk
// through. All of it built from primitives into the shared vertex-coloured
// material, so a whole chunk's worth is one draw call.

import * as THREE from 'three';
import { colourToLinear, shade } from './mesh.js';
import { makeRng, hashString } from '../../core/rng.js';
import { clamp } from '../../core/util.js';
import { ribbon, polylineLength } from '../geometry.js';

// --- primitives ------------------------------------------------------------

/** Axis-aligned box into an accumulator. */
export function box(acc, cx, cy, cz, w, h, d, colour, angle = 0) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const hw = w / 2, hd = d / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  const p = (sx, sz) => [cx + sx * hw * c - sz * hd * s, 0, cz + sx * hw * s + sz * hd * c];
  const a = p(-1, -1), b = p(1, -1), e = p(1, 1), f = p(-1, 1);
  const at = (q, y) => [q[0], y, q[2]];
  // The corners are named clockwise from above. Reverse each face so its
  // geometric winding and its stored normal point out of the solid.
  acc.addQuad(at(f, y1), at(e, y1), at(b, y1), at(a, y1), [0, 0, 1, 1], colour);
  acc.addQuad(at(a, y0), at(b, y0), at(e, y0), at(f, y0), [0, 0, 1, 1], shade(colour, 0.6));
  acc.addQuad(at(a, y1), at(b, y1), at(b, y0), at(a, y0), [0, 0, 1, 1], shade(colour, 0.92));
  acc.addQuad(at(e, y1), at(f, y1), at(f, y0), at(e, y0), [0, 0, 1, 1], shade(colour, 0.88));
  acc.addQuad(at(f, y1), at(a, y1), at(a, y0), at(f, y0), [0, 0, 1, 1], shade(colour, 0.96));
  acc.addQuad(at(b, y1), at(e, y1), at(e, y0), at(b, y0), [0, 0, 1, 1], shade(colour, 0.84));
}

/** Vertical cylinder or cone. */
export function cylinder(acc, cx, cy, cz, rBottom, rTop, height, colour, sides = 8, cap = true) {
  const y0 = cy, y1 = cy + height;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
    const shadeK = 0.82 + 0.22 * (0.5 + 0.5 * Math.cos(a0));
    acc.addQuad(
      [cx + Math.cos(a0) * rTop, y1, cz + Math.sin(a0) * rTop],
      [cx + Math.cos(a1) * rTop, y1, cz + Math.sin(a1) * rTop],
      [cx + Math.cos(a1) * rBottom, y0, cz + Math.sin(a1) * rBottom],
      [cx + Math.cos(a0) * rBottom, y0, cz + Math.sin(a0) * rBottom],
      [0, 0, 1, height * 0.3], shade(colour, shadeK));
  }
  if (cap && rTop > 0.01) {
    const [r, g, b] = colour;
    const centre = acc.vertex(cx, y1, cz, 0, 1, 0, 0.5, 0.5, r, g, b);
    const first = acc.count;
    for (let i = 0; i <= sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      acc.vertex(cx + Math.cos(a) * rTop, y1, cz + Math.sin(a) * rTop, 0, 1, 0,
                 0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5, r, g, b);
    }
    for (let i = 0; i < sides; i++) acc.tri(centre, first + i + 1, first + i);
  }
}

// --- props -----------------------------------------------------------------

const PROP_BUILDERS = {
  streetlamp(acc, lampAcc, x, y, z, rng, ctx) {
    const h = rng.range(4.2, 6.4);
    const pole = colourToLinear(0x4a4d50);
    cylinder(acc, x, y, z, 0.11, 0.07, h, pole, 6);
    // Arm reaching over the carriageway, then the lantern.
    const a = rng() * Math.PI * 2;
    const reach = rng.range(0.7, 1.5);
    const hx = x + Math.cos(a) * reach, hz = z + Math.sin(a) * reach;
    box(acc, (x + hx) / 2, y + h, (z + hz) / 2, reach, 0.09, 0.09, pole, a);
    box(lampAcc, hx, y + h - 0.14, hz, 0.42, 0.16, 0.24, [1, 1, 1], a);
    return { light: { x: hx, y: y + h - 0.2, z: hz, colour: 0xffd9a0, intensity: 420, range: 22 } };
  },
  bench(acc, lampAcc, x, y, z, rng) {
    const wood = colourToLinear(rng.pick([0x7a5638, 0x8a6642, 0x5f4a34]));
    const metal = colourToLinear(0x44474a);
    const a = rng() * Math.PI * 2;
    box(acc, x, y + 0.44, z, 1.8, 0.07, 0.5, wood, a);
    box(acc, x - Math.sin(a) * 0.24, y + 0.72, z + Math.cos(a) * 0.24, 1.8, 0.42, 0.06, wood, a);
    for (const s of [-0.7, 0.7]) {
      box(acc, x + Math.cos(a) * s, y + 0.22, z + Math.sin(a) * s, 0.08, 0.44, 0.48, metal, a);
    }
    return { collide: { w: 1.9, h: 0.9, d: 0.6, angle: a } };
  },
  bin(acc, lampAcc, x, y, z, rng) {
    const c = colourToLinear(rng.pick([0x3d4144, 0x2f5540, 0x4a4238]));
    cylinder(acc, x, y, z, 0.24, 0.27, 0.92, c, 8);
    return { collide: { w: 0.55, h: 0.95, d: 0.55, angle: 0 } };
  },
  bollard(acc, lampAcc, x, y, z, rng) {
    const c = colourToLinear(0x35383b);
    cylinder(acc, x, y, z, 0.08, 0.08, 0.88, c, 6);
    cylinder(acc, x, y + 0.88, z, 0.09, 0.05, 0.06, c, 6);
    return { collide: { w: 0.2, h: 0.95, d: 0.2, angle: 0 } };
  },
  block(acc, lampAcc, x, y, z, rng) {
    const c = colourToLinear(0x8d8a84);
    box(acc, x, y + 0.32, z, 0.7, 0.65, 0.7, c, rng() * Math.PI);
    return { collide: { w: 0.75, h: 0.7, d: 0.75, angle: 0 } };
  },
  traffic_signal(acc, lampAcc, x, y, z, rng) {
    const pole = colourToLinear(0x3a3d40);
    cylinder(acc, x, y, z, 0.09, 0.08, 3.5, pole, 6);
    box(acc, x, y + 3.1, z, 0.26, 0.78, 0.22, colourToLinear(0x222528), rng() * Math.PI * 2);
    box(lampAcc, x, y + 3.36, z, 0.16, 0.16, 0.02, [1, 0.2, 0.1]);
    return { collide: { w: 0.22, h: 3.5, d: 0.22, angle: 0 } };
  },
  bus_stop(acc, lampAcc, x, y, z, rng) {
    const pole = colourToLinear(0x50545a);
    cylinder(acc, x, y, z, 0.06, 0.06, 2.6, pole, 6);
    box(acc, x, y + 2.5, z, 0.5, 0.36, 0.05, colourToLinear(0xd8d3c4), rng() * Math.PI);
    return { collide: { w: 0.18, h: 2.6, d: 0.18, angle: 0 } };
  },
  shelter(acc, lampAcc, x, y, z, rng) {
    const frame = colourToLinear(0x565b60);
    const a = rng() * Math.PI * 2;
    for (const [sx, sz] of [[-1.6, -0.7], [1.6, -0.7], [-1.6, 0.7], [1.6, 0.7]]) {
      const px = x + sx * Math.cos(a) - sz * Math.sin(a);
      const pz = z + sx * Math.sin(a) + sz * Math.cos(a);
      cylinder(acc, px, y, pz, 0.06, 0.06, 2.4, frame, 4);
    }
    box(acc, x, y + 2.5, z, 3.6, 0.1, 1.8, frame, a);
    return { collide: { w: 3.6, h: 2.6, d: 1.8, angle: a, hollow: true } };
  },
  hydrant(acc, lampAcc, x, y, z, rng) {
    const c = colourToLinear(rng.pick([0xb03028, 0xc4b02c, 0xb8b4ae]));
    cylinder(acc, x, y, z, 0.13, 0.11, 0.62, c, 6);
    cylinder(acc, x, y + 0.62, z, 0.09, 0.06, 0.14, c, 6);
    return { collide: { w: 0.3, h: 0.8, d: 0.3, angle: 0 } };
  },
  postbox(acc, lampAcc, x, y, z, rng) {
    const c = colourToLinear(rng.pick([0xa8302a, 0xc4901f, 0x2a4fa0, 0x1f6f3a]));
    cylinder(acc, x, y, z, 0.29, 0.29, 1.15, c, 10);
    cylinder(acc, x, y + 1.15, z, 0.3, 0.16, 0.2, c, 10);
    return { collide: { w: 0.62, h: 1.35, d: 0.62, angle: 0 } };
  },
  phonebox(acc, lampAcc, x, y, z, rng) {
    const c = colourToLinear(0x9c2a24);
    box(acc, x, y + 1.2, z, 0.95, 2.4, 0.95, c, rng() * Math.PI);
    return { collide: { w: 1, h: 2.4, d: 1, angle: 0 } };
  },
  flagpole(acc, lampAcc, x, y, z, rng) {
    cylinder(acc, x, y, z, 0.08, 0.04, rng.range(6, 12), colourToLinear(0xd8d5cf), 6);
    return { collide: { w: 0.2, h: 6, d: 0.2, angle: 0 } };
  },
  utility_pole(acc, lampAcc, x, y, z, rng) {
    const h = rng.range(7, 11);
    cylinder(acc, x, y, z, 0.17, 0.12, h, colourToLinear(0x6a5842), 6);
    box(acc, x, y + h - 0.5, z, 1.8, 0.11, 0.11, colourToLinear(0x5f5040), rng() * Math.PI);
    return { collide: { w: 0.36, h, d: 0.36, angle: 0 } };
  },
  pylon(acc, lampAcc, x, y, z, rng) {
    const h = rng.range(24, 45);
    const c = colourToLinear(0x8b9096);
    for (const [sx, sz] of [[-1.8, -1.8], [1.8, -1.8], [-1.8, 1.8], [1.8, 1.8]]) {
      cylinder(acc, x + sx, y, z + sz, 0.16, 0.05, h, c, 4);
    }
    for (const t of [0.55, 0.78, 0.95]) {
      box(acc, x, y + h * t, z, 8.5, 0.16, 0.16, c);
    }
    return { collide: { w: 4.2, h, d: 4.2, angle: 0, hollow: true } };
  },
  billboard(acc, lampAcc, x, y, z, rng) {
    const a = rng() * Math.PI * 2;
    cylinder(acc, x, y, z, 0.14, 0.14, 3.2, colourToLinear(0x55585c), 6);
    box(acc, x, y + 4.2, z, 5.4, 2.4, 0.2, colourToLinear(0xdad6cc), a);
    return { collide: { w: 0.3, h: 3.2, d: 0.3, angle: 0 } };
  },
  ad_column(acc, lampAcc, x, y, z, rng) {
    cylinder(acc, x, y, z, 0.62, 0.62, 2.8, colourToLinear(0x3e4245), 12);
    cylinder(acc, x, y + 2.8, z, 0.7, 0.2, 0.5, colourToLinear(0x33373a), 12);
    return { collide: { w: 1.3, h: 3, d: 1.3, angle: 0 } };
  },
  fountain(acc, lampAcc, x, y, z, rng) {
    const stone = colourToLinear(0xb0aaa0);
    cylinder(acc, x, y, z, 2.2, 2.2, 0.55, stone, 14);
    cylinder(acc, x, y + 0.55, z, 0.35, 0.22, 1.4, stone, 8);
    return { collide: { w: 4.4, h: 0.6, d: 4.4, angle: 0 } };
  },
  fountain_small(acc, lampAcc, x, y, z, rng) {
    cylinder(acc, x, y, z, 0.18, 0.15, 1.0, colourToLinear(0x6f7478), 8);
    return { collide: { w: 0.4, h: 1, d: 0.4, angle: 0 } };
  },
  bike_rack(acc, lampAcc, x, y, z, rng) {
    const c = colourToLinear(0x7d8287);
    const a = rng() * Math.PI * 2;
    for (let i = -2; i <= 2; i++) {
      const px = x + Math.cos(a) * i * 0.6, pz = z + Math.sin(a) * i * 0.6;
      box(acc, px, y + 0.35, pz, 0.05, 0.7, 0.05, c, a);
    }
    box(acc, x, y + 0.7, z, 3.0, 0.05, 0.05, c, a);
    return { collide: { w: 3.0, h: 0.75, d: 0.3, angle: a } };
  },
  boulder(acc, lampAcc, x, y, z, rng) {
    const r = rng.range(0.4, 1.4);
    cylinder(acc, x, y, z, r, r * 0.55, r * 1.1, colourToLinear(0x8b867d), 6);
    return { collide: { w: r * 2, h: r * 1.1, d: r * 2, angle: 0 } };
  },
  monument(acc, lampAcc, x, y, z, rng) {
    const stone = colourToLinear(0xa8a298);
    box(acc, x, y + 0.35, z, 2.2, 0.7, 2.2, stone);
    box(acc, x, y + 2.2, z, 0.9, 3.0, 0.9, shade(stone, 1.05), rng() * 0.4);
    return { collide: { w: 2.3, h: 3.8, d: 2.3, angle: 0 } };
  },
  info_board(acc, lampAcc, x, y, z, rng) {
    const a = rng() * Math.PI * 2;
    box(acc, x, y + 0.9, z, 0.9, 0.7, 0.06, colourToLinear(0xd6d1c4), a);
    for (const s of [-0.35, 0.35]) {
      box(acc, x + Math.cos(a) * s, y + 0.55, z + Math.sin(a) * s, 0.06, 1.1, 0.06, colourToLinear(0x5d5a54), a);
    }
    return { collide: { w: 0.95, h: 1.3, d: 0.2, angle: a } };
  },
  camera(acc, lampAcc, x, y, z, rng) {
    cylinder(acc, x, y, z, 0.06, 0.06, 3.0, colourToLinear(0x60656a), 6);
    box(acc, x, y + 3.0, z, 0.3, 0.12, 0.12, colourToLinear(0x2e3134), rng() * Math.PI * 2);
    return { collide: { w: 0.16, h: 3, d: 0.16, angle: 0 } };
  },
  cabinet(acc, lampAcc, x, y, z, rng) {
    box(acc, x, y + 0.65, z, 0.8, 1.3, 0.42, colourToLinear(0x8b8f8a), rng() * Math.PI);
    return { collide: { w: 0.85, h: 1.3, d: 0.5, angle: 0 } };
  },
  gate(acc, lampAcc, x, y, z, rng) {
    const a = rng() * Math.PI * 2;
    for (const s of [-1.5, 1.5]) {
      cylinder(acc, x + Math.cos(a) * s, y, z + Math.sin(a) * s, 0.09, 0.09, 1.9, colourToLinear(0x55504a), 6);
    }
    return { collide: null };
  },
  clock(acc, lampAcc, x, y, z, rng) {
    cylinder(acc, x, y, z, 0.1, 0.08, 3.4, colourToLinear(0x3f4347), 8);
    cylinder(acc, x, y + 3.4, z, 0.42, 0.42, 0.16, colourToLinear(0xe4e0d4), 12);
    return { collide: { w: 0.22, h: 3.5, d: 0.22, angle: 0 } };
  },
};

/**
 * Build every prop in a chunk. Returns the point lights that should exist at
 * night, for the renderer to prioritise by distance.
 */
export function buildProps(props, ctx, multi, collide) {
  const density = ctx.settings.graphics.propDensity;
  if (density <= 0) return [];
  const acc = multi.for('solid', ctx.materials.solid({ roughness: 0.8 }));
  const lampAcc = multi.for('emissive', ctx.materials.emissive(0xffe0b0));
  const lights = [];

  for (const p of props) {
    const builder = PROP_BUILDERS[p.kind];
    if (!builder) continue;
    const rng = makeRng(hashString(`prop${p.id}`));
    // Thin out decorative props at low density, but never the ones that
    // matter for navigation.
    const essential = p.kind === 'streetlamp' || p.kind === 'traffic_signal' || p.kind === 'bollard';
    if (!essential && density < 1 && rng() > density) continue;

    try {
      const y = ctx.terrainAt(p.x, p.z);
      const res = builder(acc, lampAcc, p.x, y, p.z, rng, ctx) || {};
      if (res.collide) {
        const c = res.collide;
        if (c.hollow) {
          // A shelter or pylon: legs are solid, the space between is not.
        } else {
          collide.rotatedBox(p.x, y + c.h / 2, p.z, c.w, c.h, c.d, c.angle || 0);
        }
      }
      if (res.light) lights.push(res.light);
    } catch (e) {
      if (ctx.onError) ctx.onError('prop', p.kind, e);
    }
  }
  return lights;
}

// --- barriers --------------------------------------------------------------

/** Walls, fences and hedges: visible, and genuinely in the way. */
export function buildBarriers(barriers, ctx, multi, collide) {
  const acc = multi.for('solid', ctx.materials.solid({ roughness: 0.9 }));

  for (const b of barriers) {
    try {
      const spec = b.spec;
      const pts = b.pts;
      if (pts.length < 2) continue;
      const colour = colourToLinear(spec.tint);
      const heights = pts.map((p) => ctx.terrainAt(p[0], p[1]));
      const half = Math.max(0.03, spec.thickness / 2);
      const edges = ribbon(pts, spec.thickness);

      if (spec.kind === 'fence' || spec.kind === 'rail') {
        // Posts and rails, rather than a solid sheet.
        const rail = shade(colour, 1.05);
        for (let i = 0; i < pts.length - 1; i++) {
          const y0 = heights[i], y1 = heights[i + 1];
          for (const frac of spec.kind === 'rail' ? [0.75] : [0.35, 0.75, 0.98]) {
            acc.addQuad(
              [edges.left[i][0], y0 + spec.height * frac - 0.04, edges.left[i][1]],
              [edges.left[i + 1][0], y1 + spec.height * frac - 0.04, edges.left[i + 1][1]],
              [edges.right[i + 1][0], y1 + spec.height * frac + 0.04, edges.right[i + 1][1]],
              [edges.right[i][0], y0 + spec.height * frac + 0.04, edges.right[i][1]],
              [0, 0, 1, 0.05], rail);
          }
        }
        let dist = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
          dist += segLen;
          if (dist < 2.4) continue;
          dist = 0;
          box(acc, pts[i][0], heights[i] + spec.height / 2, pts[i][1],
              0.09, spec.height, 0.09, shade(colour, 0.85));
        }
      } else {
        // A solid run: two faces and a capping.
        for (let i = 0; i < pts.length - 1; i++) {
          const y0 = heights[i], y1 = heights[i + 1];
          const t0 = y0 + spec.height, t1 = y1 + spec.height;
          acc.addQuad(
            [edges.left[i][0], y0, edges.left[i][1]], [edges.left[i + 1][0], y1, edges.left[i + 1][1]],
            [edges.left[i + 1][0], t1, edges.left[i + 1][1]], [edges.left[i][0], t0, edges.left[i][1]],
            [0, 0, 1, spec.height * 0.3], colour);
          acc.addQuad(
            [edges.right[i + 1][0], y1, edges.right[i + 1][1]], [edges.right[i][0], y0, edges.right[i][1]],
            [edges.right[i][0], t0, edges.right[i][1]], [edges.right[i + 1][0], t1, edges.right[i + 1][1]],
            [0, 0, 1, spec.height * 0.3], shade(colour, 0.9));
          acc.addQuad(
            [edges.left[i][0], t0, edges.left[i][1]], [edges.right[i][0], t0, edges.right[i][1]],
            [edges.right[i + 1][0], t1, edges.right[i + 1][1]], [edges.left[i + 1][0], t1, edges.left[i + 1][1]],
            [0, 0, 0.3, 0.3], shade(colour, 1.12));
        }
      }

      // Everything except a knee-high kerb blocks the player.
      if (spec.height > 0.3) {
        collide.wall(pts, heights, 0, spec.height);
      }
    } catch (e) {
      if (ctx.onError) ctx.onError('barrier', b.source, e);
    }
  }
}

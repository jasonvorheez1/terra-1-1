// Terrain grading.
//
// Raw SRTM elevation and hand-drawn OSM road centrelines disagree constantly:
// a street traversing a hillside cuts into the slope on one side and floats
// over it on the other, because the elevation data has no idea the street is
// there. Real roads are graded into the landscape, so we do the same - pull the
// ground toward the road surface inside the carriageway, and blend back out
// over a short verge.
//
// The same machinery gives tunnels their portals. A tunnel approach is graded
// down to follow the roadway, which opens a cutting; once the roadway is deeper
// than the tunnel is tall, grading stops and the ground closes over the top.
// The mouth of the tunnel is simply where those two regimes meet, which means
// portals land in the right place without anyone having to author them.

import { clamp, smoothstep } from '../../core/util.js';
import { closestPointOnSegment } from '../geometry.js';

const CELL = 24;                  // spatial index cell size in metres

export const GRADE_ROAD = 0;      // conform ground to the carriageway
export const GRADE_CUT = 1;       // tunnel approach: cut down, then stop
export const GRADE_FILL = 2;      // bridge approach: build an embankment

/**
 * A spatial index of road corridors that can answer "what should the ground be
 * here?" fast enough to call once per terrain vertex.
 */
export class GradingField {
  constructor() {
    this.cells = new Map();
    this.segments = [];
    this.enabled = true;
  }

  key(cx, cz) { return `${cx},${cz}`; }

  /**
   * Register one corridor segment.
   * `halfWidth` is where full grading applies; `falloff` how far the blend
   * back to natural ground extends beyond that.
   */
  addSegment(x0, z0, y0, x1, z1, y1, halfWidth, falloff, mode = GRADE_ROAD, depth = 0) {
    const seg = { x0, z0, y0, x1, z1, y1, halfWidth, falloff, mode, depth };
    const idx = this.segments.length;
    this.segments.push(seg);

    const reach = halfWidth + falloff;
    const minX = Math.min(x0, x1) - reach, maxX = Math.max(x0, x1) + reach;
    const minZ = Math.min(z0, z1) - reach, maxZ = Math.max(z0, z1) + reach;
    const c0x = Math.floor(minX / CELL), c1x = Math.floor(maxX / CELL);
    const c0z = Math.floor(minZ / CELL), c1z = Math.floor(maxZ / CELL);
    // A pathologically long segment would carpet the index; roads are
    // resampled before they get here, so this is a guard, not a normal path.
    if ((c1x - c0x + 1) * (c1z - c0z + 1) > 4096) return;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const k = this.key(cx, cz);
        let list = this.cells.get(k);
        if (!list) { list = []; this.cells.set(k, list); }
        list.push(idx);
      }
    }
  }

  /** Add every segment of a polyline with a per-vertex height. */
  addPolyline(pts, heights, halfWidth, falloff, mode = GRADE_ROAD, depth = 0) {
    for (let i = 1; i < pts.length; i++) {
      this.addSegment(
        pts[i - 1][0], pts[i - 1][1], heights[i - 1],
        pts[i][0], pts[i][1], heights[i],
        halfWidth, falloff, mode, depth);
    }
  }

  /**
   * Ground height at a point, given the natural elevation there.
   *
   * Where corridors overlap - junctions, a slip road beside a motorway - the
   * strongest influence wins rather than the average, so a junction stays flat
   * instead of developing a dimple in the middle.
   */
  sample(x, z, raw) {
    if (!this.enabled || this.segments.length === 0) return raw;
    const list = this.cells.get(this.key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list || !list.length) return raw;

    let bestWeight = 0, bestTarget = raw;
    for (let i = 0; i < list.length; i++) {
      const s = this.segments[list[i]];
      const c = closestPointOnSegment(s.x0, s.z0, s.x1, s.z1, x, z);
      // Reject on squared distance. Every terrain vertex in the world comes
      // through this loop against every road segment near it, and most of those
      // segments are out of reach - so the square root belongs after the test,
      // not before it.
      const ddx = c[0] - x, ddz = c[1] - z;
      const d2 = ddx * ddx + ddz * ddz;
      const reach = s.halfWidth + s.falloff;
      if (d2 >= reach * reach) continue;
      const dist = Math.sqrt(d2);

      const roadY = s.y0 + (s.y1 - s.y0) * c[2];
      let target = roadY;

      if (s.mode === GRADE_CUT) {
        // Only cut while the roadway is shallower than the tunnel is tall.
        // Past that the ground closes over and we have a tunnel, not a trench.
        const depthHere = raw - roadY;
        if (depthHere > s.depth) continue;
        // Ease the last metre so the portal is a lintel, not a step.
        const fade = smoothstep(1 - (depthHere - (s.depth - 1.5)) / 1.5);
        target = roadY + (raw - roadY) * (1 - fade);
      } else if (s.mode === GRADE_FILL) {
        // Embankments only build up, never dig.
        if (roadY < raw) continue;
        if (roadY - raw > s.depth) continue;
      }

      // Full strength inside the carriageway, easing out across the verge.
      const w = dist <= s.halfWidth ? 1 : smoothstep(1 - (dist - s.halfWidth) / s.falloff);
      if (w > bestWeight) { bestWeight = w; bestTarget = target; }
      if (bestWeight >= 0.999) break;
    }
    if (bestWeight <= 0) return raw;
    return raw + (bestTarget - raw) * bestWeight;
  }

  get size() { return this.segments.length; }

  clear() { this.cells.clear(); this.segments.length = 0; }
}

/**
 * Build the grading field for a set of roads.
 *
 * `profileFor(road)` returns the vertical profile computed against *raw*
 * terrain - grading must not feed back into the profiles that produced it, or
 * roads would chase their own tails down a hillside.
 */
export function buildGradingField(roads, rails, profileFor, opts = {}) {
  const field = new GradingField();
  const { verge = 5.5, tunnelHeight = 5.6 } = opts;

  for (const road of roads) {
    const spec = road.spec;
    if (spec.area) continue;
    const prof = profileFor(road);
    if (!prof) continue;
    const half = spec.width / 2 + (spec.sidewalk ? 2.4 : 0.4);

    if (prof.kind === 'grade') {
      field.addPolyline(road.pts, prof.heights, half, verge, GRADE_ROAD);
    } else if (prof.kind === 'cut' || prof.kind === 'bored') {
      field.addPolyline(road.pts, prof.heights, half + 0.8, 3.5, GRADE_CUT, tunnelHeight);
    } else if (prof.kind === 'flyover' || prof.kind === 'span') {
      // Only the shallow ends of a bridge get an embankment; the span itself
      // stands on piers and the ground under it is left alone.
      field.addPolyline(road.pts, prof.heights, half, verge, GRADE_FILL, 2.2);
    } else if (prof.kind === 'passage') {
      field.addPolyline(road.pts, prof.heights, half, verge, GRADE_ROAD);
    }
  }

  for (const rail of rails || []) {
    const prof = profileFor(rail);
    if (!prof) continue;
    const half = rail.spec.width / 2 + 1.6;
    if (prof.kind === 'grade') field.addPolyline(rail.pts, prof.heights, half, 6, GRADE_ROAD);
    else if (prof.kind === 'cut' || prof.kind === 'bored') {
      field.addPolyline(rail.pts, prof.heights, half, 3.5, GRADE_CUT, 6.4);
    }
  }

  return field;
}

// Pure road-layout helpers. Kept free of Three.js and DOM imports so the
// decisions which affect junction geometry can be tested directly in Node.

import { clamp } from '../core/util.js';
import { orientedBounds, pointInPolygon } from './geometry.js';

const NORTH_AMERICAN_MARKINGS = new Set(['northAmerica', 'southwest']);

// ISO 3166-1 alpha-2 codes for countries and territories where traffic keeps
// left. Search and reverse-geocoding already return these codes, so road
// geometry can follow the local rule without recognising city names or baking
// test locations into the renderer.
const LEFT_DRIVING_COUNTRIES = new Set([
  'AG', 'AI', 'AU', 'BB', 'BD', 'BM', 'BN', 'BS', 'BT', 'BW', 'CC', 'CK',
  'CX', 'CY', 'DM', 'FJ', 'FK', 'GB', 'GD', 'GG', 'GS', 'GY', 'HK', 'ID',
  'IE', 'IM', 'IN', 'IO', 'JE', 'JM', 'JP', 'KE', 'KI', 'KN', 'KY', 'LC',
  'LK', 'LS', 'MO', 'MS', 'MT', 'MU', 'MV', 'MW', 'MY', 'MZ', 'NA', 'NF',
  'NP', 'NR', 'NU', 'NZ', 'PG', 'PK', 'PN', 'SB', 'SC', 'SG', 'SH', 'SR',
  'SZ', 'TC', 'TH', 'TL', 'TK', 'TO', 'TT', 'TV', 'TZ', 'UG', 'VC', 'VG',
  'VI', 'WS', 'ZA', 'ZM', 'ZW',
]);

/** Driving side from an ISO country code; right is the safe global default. */
export function drivingSideForCountry(countryCode) {
  return LEFT_DRIVING_COUNTRIES.has(String(countryCode || '').trim().toUpperCase())
    ? 'left' : 'right';
}

/** How far paint or a raised pavement should stop short of a junction centre. */
export function junctionSetback(spec, purpose = 'marking') {
  const halfRoad = Math.max(0.4, Number(spec && spec.width || 0) / 2);
  return purpose === 'sidewalk' ? halfRoad + 1.15 : halfRoad + 0.55;
}

/**
 * Conservative regional fallback for roads whose sidewalk is not mapped.
 * North-American residential streets often genuinely have none; main roads
 * retain the class fallback, and any explicit OSM side always wins.
 */
export function shouldBuildSidewalk(spec, region = 'default') {
  if (!spec || !spec.sidewalk) return false;
  if (spec.sidewalkTagged) return true;
  if ((region === 'northAmerica' || region === 'southwest') &&
      (spec.highway === 'residential' || spec.highway === 'unclassified')) return false;
  return true;
}

/**
 * Trim metric distance from either end of a polyline while interpolating its
 * per-point heights. A sub-metre remainder is not useful render geometry.
 */
export function trimPolylineProfile(pts, heights, startTrim = 0, endTrim = 0) {
  if (!pts || pts.length < 2 || !heights || heights.length !== pts.length) {
    return { pts: [], heights: [] };
  }
  const distance = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    distance[i] = distance[i - 1] + Math.hypot(
      pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const total = distance[distance.length - 1];
  const from = clamp(Number(startTrim) || 0, 0, total);
  const to = clamp(total - (Number(endTrim) || 0), 0, total);
  if (to - from < 0.5) return { pts: [], heights: [] };

  const sample = (at) => {
    if (at <= 0) return { point: [pts[0][0], pts[0][1]], height: heights[0], index: 0 };
    if (at >= total) {
      const last = pts.length - 1;
      return { point: [pts[last][0], pts[last][1]], height: heights[last], index: last };
    }
    let i = 1;
    while (i < distance.length && distance[i] < at) i++;
    const span = distance[i] - distance[i - 1] || 1;
    const t = (at - distance[i - 1]) / span;
    return {
      point: [
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ],
      height: heights[i - 1] + (heights[i] - heights[i - 1]) * t,
      index: i,
    };
  };

  const first = sample(from);
  const last = sample(to);
  const outPts = [first.point];
  const outHeights = [first.height];
  for (let i = Math.max(1, first.index); i < pts.length - 1; i++) {
    if (distance[i] <= from + 1e-6 || distance[i] >= to - 1e-6) continue;
    outPts.push([pts[i][0], pts[i][1]]);
    outHeights.push(heights[i]);
  }
  outPts.push(last.point);
  outHeights.push(last.height);
  return { pts: outPts, heights: outHeights };
}

/**
 * Break a way into renderable runs with a gap around every OSM junction node.
 * OSM ways commonly continue through several crossings, so endpoint flags
 * alone are not enough to stop kerbs and paint from bisecting intersections.
 */
export function splitPolylineProfileAtJunctions(pts, heights, junctionPoints, setback) {
  if (!junctionPoints || !junctionPoints.length || setback <= 0) {
    return [{ pts: pts.map((p) => [p[0], p[1]]), heights: Array.from(heights) }];
  }
  if (!pts || pts.length < 2 || heights.length !== pts.length) return [];

  const distance = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    distance[i] = distance[i - 1] + Math.hypot(
      pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  const total = distance[distance.length - 1];
  const intervals = [];
  for (const point of junctionPoints) {
    let nearest = null;
    let bestD2 = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0], az = pts[i - 1][1];
      const dx = pts[i][0] - ax, dz = pts[i][1] - az;
      const ll = dx * dx + dz * dz;
      const t = ll > 0 ? clamp(((point[0] - ax) * dx + (point[1] - az) * dz) / ll, 0, 1) : 0;
      const x = ax + dx * t, z = az + dz * t;
      const d2 = (point[0] - x) ** 2 + (point[1] - z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        nearest = distance[i - 1] + Math.sqrt(ll) * t;
      }
    }
    // Simplification may move a mapped junction a few centimetres off the
    // final line. A full metre is generous enough for that, but too small to
    // mistake a nearby parallel service road for the same junction.
    if (nearest == null || bestD2 > (setback + 1) ** 2) continue;
    intervals.push([
      Math.max(0, nearest - setback),
      Math.min(total, nearest + setback),
    ]);
  }
  if (!intervals.length) {
    return [{ pts: pts.map((p) => [p[0], p[1]]), heights: Array.from(heights) }];
  }

  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], interval[1]);
    else merged.push(interval.slice());
  }

  const runs = [];
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from - cursor >= 0.5) {
      const run = trimPolylineProfile(pts, heights, cursor, total - from);
      if (run.pts.length >= 2) runs.push(run);
    }
    cursor = Math.max(cursor, to);
  }
  if (total - cursor >= 0.5) {
    const run = trimPolylineProfile(pts, heights, cursor, 0);
    if (run.pts.length >= 2) runs.push(run);
  }
  return runs;
}

/**
 * Lane-divider lines across the carriageway. `offset` is positive to the left
 * of the OSM way direction. Two-way North-American centre lines are yellow;
 * ordinary lane separators remain white and dashed.
 */
export function roadMarkingLayout(spec, region = 'default', drivingSide = 'right') {
  if (!spec || !spec.markings) return [];
  const lanes = clamp(Math.round(Number(spec.lanes) || 0), 0, 16);
  if (lanes < 2) return [];

  const laneWidth = spec.width / lanes;
  const centre = new Set();
  if (!spec.oneway) {
    // OSM's way direction defines forward/backward. On right-driving roads,
    // backward lanes occupy the left side of that way; in left-driving
    // countries forward lanes do. The physical divider must mirror with that
    // rule when the directional counts are asymmetric.
    const leftFlowLanes = drivingSide === 'left' ? spec.lanesForward : spec.lanesBackward;
    if (spec.lanesBothWays > 0) {
      // A shared turn lane has a centre boundary on each side, not one
      // double-line boundary somewhere inside the carriageway.
      const sharedStart = leftFlowLanes || Math.floor((lanes - spec.lanesBothWays) / 2);
      centre.add(sharedStart);
      centre.add(sharedStart + spec.lanesBothWays);
    } else if (leftFlowLanes > 0 && leftFlowLanes < lanes) {
      centre.add(leftFlowLanes);
    } else if (lanes % 2 === 0) {
      centre.add(lanes / 2);
    } else {
      // An unqualified odd count normally means a shared centre turn lane.
      centre.add(Math.floor(lanes / 2));
      centre.add(Math.ceil(lanes / 2));
    }
  }

  const lines = [];
  for (let i = 1; i < lanes; i++) {
    const offset = spec.width / 2 - i * laneWidth;
    if (!centre.has(i)) {
      lines.push({ offset, kind: 'lane-dashed', colour: 0xf1efe7, width: 0.12 });
      continue;
    }
    const colour = NORTH_AMERICAN_MARKINGS.has(region) ? 0xf2c94c : 0xf1efe7;
    // A divided four-lane road gets a double centre line. A three-lane road
    // already has two boundaries around its centre lane, so each stays single.
    if (lanes >= 4 && centre.size === 1) {
      lines.push({ offset: offset - 0.10, kind: 'lane-solid', colour, width: 0.10 });
      lines.push({ offset: offset + 0.10, kind: 'lane-solid', colour, width: 0.10 });
    } else {
      lines.push({ offset, kind: lanes === 2 ? 'lane-dashed' : 'lane-solid', colour, width: 0.11 });
    }
  }
  return lines;
}

/**
 * Geometry-only parking bay layout shared by the renderer and Node tests.
 * Rows follow the lot's minimum-area bounding box and every separator is
 * rejected unless it lies inside both the complete and currently clipped lot.
 */
export function parkingBayLayout(lc, opts = {}) {
  const { stall = 2.7, bayDepth = 5.1 } = opts;
  const parkingType = String(lc.tags?.parking || '').toLowerCase();
  if (parkingType === 'underground' || parkingType === 'multi-storey' ||
      parkingType === 'rooftop' || (lc.area || 0) < 70) return [];

  const whole = lc.__parent || lc;
  const ob = orientedBounds(whole.ring);
  let ux = ob.axisX[0], uz = ob.axisX[1], long = ob.width;
  let vx = ob.axisZ[0], vz = ob.axisZ[1], cross = ob.depth;
  if (cross > long) {
    [ux, vx] = [vx, ux];
    [uz, vz] = [vz, uz];
    [long, cross] = [cross, long];
  }
  if (long < 8 || cross < 6.2) return [];

  const halfLong = long / 2;
  const halfCross = cross / 2;
  const rows = cross >= 17
    ? [{ edge: -halfCross + 0.45, dir: 1 }, { edge: halfCross - 0.45, dir: -1 }]
    : [{ edge: -halfCross + 0.45, dir: 1 }];
  const depth = Math.min(bayDepth, cross - 1.1);
  const out = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    for (let u = -halfLong + stall; u <= halfLong - stall * 0.55; u += stall) {
      const ax = ob.cx + ux * u + vx * row.edge;
      const az = ob.cz + uz * u + vz * row.edge;
      const bx = ax + vx * depth * row.dir;
      const bz = az + vz * depth * row.dir;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (!pointInPolygon(lc.ring, lc.holes || [], mx, mz) ||
          !pointInPolygon(whole.ring, whole.holes || [], ax, az) ||
          !pointInPolygon(whole.ring, whole.holes || [], bx, bz)) continue;
      const cu = u - stall * 0.5;
      const cv = row.edge + row.dir * Math.min(2.75, depth * 0.55);
      out.push({
        ax, az, bx, bz, ux, uz,
        rowIndex,
        bayIndex: Math.round((u + halfLong) / stall),
        car: {
          x: ob.cx + ux * cu + vx * cv,
          z: ob.cz + uz * cu + vz * cv,
          dx: vx * row.dir,
          dz: vz * row.dir,
        },
      });
    }
  }
  return out;
}

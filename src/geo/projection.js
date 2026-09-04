// Geodesy: WGS-84 <-> local metric game space, and slippy-tile arithmetic.
//
// The world uses a local East-North-Up tangent plane anchored at an origin
// lat/lon. Three.js is Y-up and right-handed, so:
//     +x = East      +y = Up      -z = North   (i.e. +z = South)
// Distances stay in metres. Over the few-kilometre range a walker can cover
// the tangent-plane error is well under a centimetre, and the world re-anchors
// (see World.rebase) if the player ever wanders far enough for that to matter.

import { DEG, RAD, clamp } from '../core/util.js';

export const EARTH_RADIUS = 6378137;                 // WGS-84 semi-major axis
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
export const MAX_MERC_LAT = 85.0511287798;

/** Metres per degree of latitude at `lat` (WGS-84 meridian arc derivative). */
export function metresPerDegLat(lat) {
  const p = lat * DEG;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

/** Metres per degree of longitude at `lat`. */
export function metresPerDegLon(lat) {
  const p = lat * DEG;
  return 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p);
}

export class Projection {
  constructor(lat, lon) { this.setOrigin(lat, lon); }

  setOrigin(lat, lon) {
    this.lat0 = lat;
    this.lon0 = lon;
    this.mPerLat = metresPerDegLat(lat);
    this.mPerLon = metresPerDegLon(lat);
    // Guard against the poles, where longitude collapses.
    if (Math.abs(this.mPerLon) < 1) this.mPerLon = this.mPerLon < 0 ? -1 : 1;
  }

  /** lat/lon -> {x, z} local metres. */
  toLocal(lat, lon, out = {}) {
    out.x = (lon - this.lon0) * this.mPerLon;
    out.z = -(lat - this.lat0) * this.mPerLat;
    return out;
  }

  toLocalX(lon) { return (lon - this.lon0) * this.mPerLon; }
  toLocalZ(lat) { return -(lat - this.lat0) * this.mPerLat; }

  /** Local metres -> {lat, lon}. */
  toGeo(x, z, out = {}) {
    out.lon = this.lon0 + x / this.mPerLon;
    out.lat = this.lat0 - z / this.mPerLat;
    return out;
  }

  /** Bounding box in lat/lon that contains a local-metre rect. */
  localRectToBBox(minX, minZ, maxX, maxZ) {
    const a = this.toGeo(minX, maxZ);   // maxZ = south -> min lat
    const b = this.toGeo(maxX, minZ);
    return { south: a.lat, west: a.lon, north: b.lat, east: b.lon };
  }
}

// --- Web Mercator / slippy tiles -------------------------------------------

export function lonToTileX(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }

export function latToTileY(lat, z) {
  const l = clamp(lat, -MAX_MERC_LAT, MAX_MERC_LAT) * DEG;
  return ((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2) * Math.pow(2, z);
}

export function tileXToLon(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }

export function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return RAD * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Ground resolution in metres/pixel for a 256px tile scheme. */
export function metresPerPixel(lat, z) {
  return (EARTH_CIRCUMFERENCE * Math.cos(lat * DEG)) / (256 * Math.pow(2, z));
}

/** Smallest zoom whose ground resolution is at least as fine as `targetMpp`. */
export function zoomForResolution(lat, targetMpp, minZ = 1, maxZ = 19) {
  for (let z = minZ; z <= maxZ; z++) if (metresPerPixel(lat, z) <= targetMpp) return z;
  return maxZ;
}

/** Integer tile range covering a lat/lon bbox at zoom `z`, inclusive. */
export function tileRange(bbox, z) {
  const n = Math.pow(2, z);
  const x0 = Math.floor(lonToTileX(bbox.west, z));
  const x1 = Math.floor(lonToTileX(bbox.east, z));
  const y0 = Math.floor(latToTileY(bbox.north, z));
  const y1 = Math.floor(latToTileY(bbox.south, z));
  return {
    z,
    x0: Math.max(0, Math.min(x0, x1)),
    x1: Math.min(n - 1, Math.max(x0, x1)),
    y0: Math.max(0, Math.min(y0, y1)),
    y1: Math.min(n - 1, Math.max(y0, y1)),
  };
}

/** Great-circle distance in metres (haversine). */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing in degrees from point 1 to point 2. */
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG, p2 = lat2 * DEG, dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * RAD + 360) % 360;
}

/** Grow a bbox by `metres` on every side. */
export function padBBox(bbox, metres) {
  const midLat = (bbox.north + bbox.south) / 2;
  const dLat = metres / metresPerDegLat(midLat);
  const dLon = metres / Math.max(1, Math.abs(metresPerDegLon(midLat)));
  return {
    south: clamp(bbox.south - dLat, -90, 90),
    north: clamp(bbox.north + dLat, -90, 90),
    west: bbox.west - dLon,
    east: bbox.east + dLon,
  };
}

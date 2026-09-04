// Small numeric helpers shared across the project.

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
export const smootherstep = (t) => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
export const mod = (a, n) => ((a % n) + n) % n;

// Shortest signed difference between two angles, in radians.
export function angleDelta(a, b) { return mod(b - a + Math.PI, Math.PI * 2) - Math.PI; }

// Frame-rate independent exponential approach. `rate` is roughly "per second".
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export function dampAngle(current, target, rate, dt) {
  return current + angleDelta(current, target) * (1 - Math.exp(-rate * dt));
}

export const roundTo = (v, step) => Math.round(v / step) * step;

/** Format a metre distance for the HUD. */
export function formatDistance(m) {
  if (!isFinite(m)) return '--';
  if (Math.abs(m) < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/** Format decimal degrees as a human readable DMS coordinate pair. */
export function formatLatLon(lat, lon) {
  const f = (v, pos, neg) => {
    const hemi = v >= 0 ? pos : neg;
    v = Math.abs(v);
    const d = Math.floor(v);
    const mF = (v - d) * 60;
    const mi = Math.floor(mF);
    const s = (mF - mi) * 60;
    return `${d}\u00b0${String(mi).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${hemi}`;
  };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}

/** Parse "48.8584, 2.2945", "48.8584 2.2945" or a DMS-ish string into [lat, lon]. */
export function parseLatLon(text) {
  if (!text) return null;
  const s = String(text).trim();
  const dec = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (dec) {
    const lat = parseFloat(dec[1]), lon = parseFloat(dec[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lat, lon];
    return null;
  }
  const dms = /(\d+(?:\.\d+)?)[^\d]+(\d+(?:\.\d+)?)?[^\d]*(\d+(?:\.\d+)?)?[^NSEW]*([NSEW])/gi;
  const parts = [];
  let m;
  while ((m = dms.exec(s)) && parts.length < 2) {
    const d = parseFloat(m[1] || 0), mi = parseFloat(m[2] || 0), se = parseFloat(m[3] || 0);
    let v = d + mi / 60 + se / 3600;
    const hemi = m[4].toUpperCase();
    if (hemi === 'S' || hemi === 'W') v = -v;
    parts.push({ v, axis: hemi === 'N' || hemi === 'S' ? 'lat' : 'lon' });
  }
  if (parts.length === 2) {
    const lat = parts.find((p) => p.axis === 'lat');
    const lon = parts.find((p) => p.axis === 'lon');
    if (lat && lon) return [lat.v, lon.v];
  }
  return null;
}

/** Chainable promise timeout that rejects rather than hanging forever. */
export function withTimeout(promise, ms, label = 'operation') {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cheap deep clone for plain JSON-ish config objects. */
export function deepClone(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(deepClone);
  const out = {};
  for (const k in o) out[k] = deepClone(o[k]);
  return out;
}

/** Merge `src` into `dst` in place, only for keys that already exist in `dst`. */
export function mergeKnown(dst, src) {
  if (!src || typeof src !== 'object') return dst;
  for (const k in dst) {
    if (!(k in src)) continue;
    if (dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) mergeKnown(dst[k], src[k]);
    else if (typeof src[k] === typeof dst[k] || dst[k] === null) dst[k] = src[k];
  }
  return dst;
}

// Deterministic pseudo-random numbers and value noise.
//
// Everything procedural in the world (tree placement, facade colours, interior
// layouts) is seeded from stable geographic identity - an OSM id, or a rounded
// lat/lon - so the same place always regenerates identically between sessions.

/** 32-bit integer hash (from Chris Wellons' triple32 / xxhash-ish mixing). */
export function hash32(x) {
  x |= 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/** Hash an arbitrary string to a uint32. FNV-1a. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combine several numbers into one uint32 seed. */
export function hashCombine(...nums) {
  let h = 0x9e3779b9;
  for (const n of nums) {
    h = (h ^ hash32(Math.imul(Math.round(n * 1000) | 0, 0x85ebca6b))) >>> 0;
    h = (Math.imul(h, 0x9e3779b1) ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

/** Mulberry32 - small, fast, good enough statistical quality for content gen. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
  rng.bool = (p = 0.5) => rng() < p;
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  rng.shuffle = (arr) => {
    const a2 = arr.slice();
    for (let i = a2.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a2[i], a2[j]] = [a2[j], a2[i]];
    }
    return a2;
  };
  /** Pick from `[{w, ...}]` weighted by `.w`. */
  rng.weighted = (items, weightKey = 'w') => {
    let total = 0;
    for (const it of items) total += it[weightKey] || 0;
    let r = rng() * total;
    for (const it of items) { r -= it[weightKey] || 0; if (r <= 0) return it; }
    return items[items.length - 1];
  };
  /** Standard normal via Box-Muller. */
  rng.gauss = (mean = 0, sd = 1) => {
    const u = Math.max(1e-9, rng()), v = rng();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return rng;
}

// --- Value noise -----------------------------------------------------------

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

function grad2(ix, iy, seed) {
  const h = hash32(Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + seed);
  const a = (h / 4294967296) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
}

/** Perlin-style gradient noise in [-1, 1]. */
export function noise2(x, y, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const u = fade(fx), v = fade(fy);
  const dot = (ix, iy) => {
    const g = grad2(ix, iy, seed);
    return g[0] * (x - ix) + g[1] * (y - iy);
  };
  const n00 = dot(x0, y0), n10 = dot(x0 + 1, y0);
  const n01 = dot(x0, y0 + 1), n11 = dot(x0 + 1, y0 + 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return (nx0 + (nx1 - nx0) * v) * 1.4;
}

/** Fractal Brownian motion over noise2, returns roughly [-1, 1]. */
export function fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5, seed = 0) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / (norm || 1);
}

/** White-noise sample in [0,1) keyed on an integer lattice. */
export function whiteNoise2(ix, iy, seed = 0) {
  return hash32(Math.imul(ix | 0, 73856093) ^ Math.imul(iy | 0, 19349663) ^ seed) / 4294967296;
}

// --- Point scattering ------------------------------------------------------

/**
 * Poisson-disc style scatter inside an axis-aligned rect using a jittered grid.
 * Much cheaper than true Bridson sampling and visually indistinguishable for
 * vegetation, while staying fully deterministic for a given seed.
 *
 * `accept(x, y, r)` may reject candidates (e.g. outside a polygon).
 */
export function jitteredScatter(minX, minY, maxX, maxY, spacing, rng, accept) {
  const pts = [];
  if (spacing <= 0) return pts;
  const cols = Math.ceil((maxX - minX) / spacing);
  const rows = Math.ceil((maxY - minY) / spacing);
  if (cols <= 0 || rows <= 0 || cols * rows > 400000) return pts;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = minX + (i + 0.15 + rng() * 0.7) * spacing;
      const y = minY + (j + 0.15 + rng() * 0.7) * spacing;
      if (x > maxX || y > maxY) continue;
      if (accept && !accept(x, y)) continue;
      pts.push([x, y]);
    }
  }
  return pts;
}

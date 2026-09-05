// Network access: a politeness-limited fetch queue with retries and caching.
//
// The game leans on free, community-run services (Overpass, Nominatim, AWS
// terrain tiles, NASA GIBS). Those deserve rate limiting, so all traffic
// funnels through here and every response lands in the IndexedDB cache.

import { cacheGet, cachePut } from './cache.js';
import { sleep, withTimeout } from '../core/util.js';

/** Per-host concurrency limiter with a minimum gap between request starts. */
class HostQueue {
  constructor(concurrency, minGapMs) {
    this.concurrency = concurrency;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.lastStart = 0;
    this.waiting = [];
    this.timer = null;
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ fn, resolve, reject });
      this.pump();
    });
  }
  pump() {
    if (this.active >= this.concurrency || this.waiting.length === 0) return;
    const gap = this.minGapMs - (Date.now() - this.lastStart);
    if (gap > 0) {
      if (this.timer === null) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, gap);
      }
      return;
    }
    const job = this.waiting.shift();
    this.active++;
    this.lastStart = Date.now();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => { this.active--; this.pump(); });
  }
}

const queues = new Map();
const HOST_LIMITS = {
  'overpass-api.de': [1, 1200],
  'maps.mail.ru': [1, 1000],
  'overpass.private.coffee': [1, 1000],
  'nominatim.openstreetmap.org': [1, 1100],
  'gibs.earthdata.nasa.gov': [4, 0],
  's3.amazonaws.com': [8, 0],
  'server.arcgisonline.com': [6, 0],
  'services.arcgisonline.com': [6, 0],
  'tile.openstreetmap.org': [2, 60],
  'commons.wikimedia.org': [2, 120],
  'www.wikidata.org': [2, 120],
};

function queueFor(url) {
  let host = 'default';
  try { host = new URL(url, location.href).host; } catch (e) { /* relative URL */ }
  if (!queues.has(host)) {
    const [c, gap] = HOST_LIMITS[host] || [6, 0];
    queues.set(host, new HostQueue(c, gap));
  }
  return queues.get(host);
}

export const netStats = { requests: 0, cacheHits: 0, bytes: 0, errors: 0, inflight: 0 };

async function rawFetch(url, opts, timeoutMs) {
  netStats.inflight++;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return res;
    } finally { clearTimeout(t); }
  } finally { netStats.inflight--; }
}

function hashBody(body) {
  const s = String(body);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * Fetch with per-host queueing, exponential backoff and transparent caching.
 * `as` is 'arrayBuffer' | 'json' | 'text' | 'blob'.
 */
export async function fetchCached(url, {
  as = 'arrayBuffer',
  cacheKey = null,
  maxAgeMs = 1000 * 60 * 60 * 24 * 30,
  retries = 2,
  timeoutMs = 20000,
  init = null,
  allowCache = true,
  signal = null,
} = {}) {
  const key = cacheKey ||
    `${init && init.method === 'POST' ? 'P:' : ''}${url}${init && init.body ? ':' + hashBody(init.body) : ''}`;

  if (allowCache) {
    const hit = await cacheGet(key, maxAgeMs);
    if (hit !== undefined) { netStats.cacheHits++; return hit; }
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw new Error('aborted');
    try {
      const res = await queueFor(url).run(() =>
        withTimeout(rawFetch(url, init || {}, timeoutMs), timeoutMs + 2000, url));
      netStats.requests++;
      let value;
      if (as === 'arrayBuffer') { value = await res.arrayBuffer(); netStats.bytes += value.byteLength; }
      else if (as === 'json') value = await res.json();
      else if (as === 'blob') value = await res.blob();
      else value = await res.text();
      if (allowCache && as !== 'blob') await cachePut(key, value);
      return value;
    } catch (e) {
      lastErr = e;
      netStats.errors++;
      // 4xx other than 429 will not improve on retry.
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
      if (attempt < retries) await sleep(600 * Math.pow(2, attempt) + Math.random() * 400);
    }
  }
  throw lastErr || new Error(`fetch failed: ${url}`);
}

/** Decode image bytes into ImageData so pixels can be sampled on the CPU. */
export async function decodeImageData(buffer, mime = 'image/png') {
  const blob = new Blob([buffer], { type: mime });
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch (e) {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.src = url;
    });
  }
  const w = bmp.width, h = bmp.height;
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
  else { canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

/** Decode image bytes into something drawable (ImageBitmap or HTMLImageElement). */
export async function decodeImage(buffer, mime = 'image/png') {
  const blob = new Blob([buffer], { type: mime });
  try {
    return await createImageBitmap(blob);
  } catch (e) {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => resolve(img);
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
      img.src = url;
    });
  }
}

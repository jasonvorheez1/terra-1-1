// A small pannable, zoomable tile map on a 2D canvas.
//
// Used for choosing a place before you travel and for the in-game map. It is
// deliberately not a full mapping library: it draws raster tiles, tracks a
// centre and zoom, and reports where you clicked. Tiles come through the same
// cached, rate-limited fetch queue as everything else.

import { fetchCached, decodeImage } from '../geo/net.js';
import {
  lonToTileX, latToTileY, tileXToLon, tileYToLat, metresPerPixel,
} from '../geo/projection.js';
import { clamp } from '../core/util.js';

const SOURCES = {
  imagery: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 19,
    label: 'Esri World Imagery',
  },
  labels: {
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 13,
    label: 'Esri reference',
  },
};

const TILE = 256;

export class SlippyMap {
  constructor(canvas, { source = 'imagery', minZoom = 2, maxZoom = 18 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.source = SOURCES[source] || SOURCES.imagery;
    this.overlay = SOURCES.labels;
    this.lat = 20;
    this.lon = 0;
    this.zoom = 3;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.tiles = new Map();      // "z/x/y" -> HTMLImageElement | 'pending' | 'failed'
    this.dragging = false;
    this.dragMoved = 0;
    this.onPick = null;
    this.onMove = null;
    this.markers = [];
    this.needsRedraw = true;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.bind();
  }

  bind() {
    const c = this.canvas;
    let lastX = 0, lastY = 0;

    this._down = (e) => {
      this.dragging = true;
      this.dragMoved = 0;
      lastX = e.clientX; lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    };
    this._move = (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.panPixels(-dx, -dy);
    };
    this._up = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      try { c.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
      // A click, not a drag: drop the pin where they clicked.
      if (this.dragMoved < 5 && this.onPick) {
        const rect = c.getBoundingClientRect();
        const pos = this.pixelToLatLon(e.clientX - rect.left, e.clientY - rect.top);
        this.onPick(pos.lat, pos.lon);
      }
    };
    this._wheel = (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      // Zoom toward the cursor, so the point under it stays put.
      const before = this.pixelToLatLon(px, py);
      this.setZoom(this.zoom - Math.sign(e.deltaY) * 0.6);
      const after = this.pixelToLatLon(px, py);
      this.lat += before.lat - after.lat;
      this.lon += before.lon - after.lon;
      this.clampCentre();
      this.invalidate();
    };

    c.addEventListener('pointerdown', this._down);
    c.addEventListener('pointermove', this._move);
    c.addEventListener('pointerup', this._up);
    c.addEventListener('pointercancel', this._up);
    c.addEventListener('wheel', this._wheel, { passive: false });
  }

  dispose() {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this._down);
    c.removeEventListener('pointermove', this._move);
    c.removeEventListener('pointerup', this._up);
    c.removeEventListener('pointercancel', this._up);
    c.removeEventListener('wheel', this._wheel);
    this.tiles.clear();
  }

  setView(lat, lon, zoom) {
    this.lat = lat; this.lon = lon;
    if (zoom != null) this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.clampCentre();
    this.invalidate();
  }

  setZoom(z) {
    this.zoom = clamp(z, this.minZoom, this.maxZoom);
    this.invalidate();
  }

  clampCentre() {
    this.lat = clamp(this.lat, -85, 85);
    this.lon = ((this.lon + 180) % 360 + 360) % 360 - 180;
  }

  panPixels(dx, dy) {
    const z = Math.floor(this.zoom);
    const scale = Math.pow(2, this.zoom - z);
    const cx = lonToTileX(this.lon, z) + dx / (TILE * scale);
    const cy = latToTileY(this.lat, z) + dy / (TILE * scale);
    const n = Math.pow(2, z);
    this.lon = tileXToLon(cx, z);
    this.lat = tileYToLat(clamp(cy, 0, n), z);
    this.clampCentre();
    this.invalidate();
    if (this.onMove) this.onMove(this.lat, this.lon, this.zoom);
  }

  /** Canvas pixel -> lat/lon. */
  pixelToLatLon(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    const z = Math.floor(this.zoom);
    const scale = Math.pow(2, this.zoom - z);
    const cx = lonToTileX(this.lon, z);
    const cy = latToTileY(this.lat, z);
    const tx = cx + (px - rect.width / 2) / (TILE * scale);
    const ty = cy + (py - rect.height / 2) / (TILE * scale);
    return { lat: tileYToLat(ty, z), lon: tileXToLon(tx, z) };
  }

  /** lat/lon -> canvas pixel. */
  latLonToPixel(lat, lon) {
    const rect = this.canvas.getBoundingClientRect();
    const z = Math.floor(this.zoom);
    const scale = Math.pow(2, this.zoom - z);
    const cx = lonToTileX(this.lon, z), cy = latToTileY(this.lat, z);
    return {
      x: rect.width / 2 + (lonToTileX(lon, z) - cx) * TILE * scale,
      y: rect.height / 2 + (latToTileY(lat, z) - cy) * TILE * scale,
    };
  }

  invalidate() { this.needsRedraw = true; }

  tileKey(src, z, x, y) { return `${src}/${z}/${x}/${y}`; }

  requestTile(srcName, src, z, x, y) {
    const key = this.tileKey(srcName, z, x, y);
    const have = this.tiles.get(key);
    if (have) return have === 'pending' || have === 'failed' ? null : have;
    const n = Math.pow(2, z);
    if (x < 0 || y < 0 || x >= n || y >= n) return null;

    this.tiles.set(key, 'pending');
    fetchCached(src.url(z, x, y), {
      as: 'arrayBuffer', maxAgeMs: 1000 * 60 * 60 * 24 * 60, retries: 1, timeoutMs: 12000,
    })
      .then((buf) => decodeImage(buf, 'image/jpeg'))
      .then((img) => { this.tiles.set(key, img); this.invalidate(); })
      .catch(() => { this.tiles.set(key, 'failed'); });

    // Bound the tile cache; a long session panning the world can accumulate.
    if (this.tiles.size > 400) {
      let i = 0;
      for (const k of this.tiles.keys()) { if (i++ > 150) break; this.tiles.delete(k); }
    }
    return null;
  }

  /** Draw one frame. Call from a rAF loop while the map is on screen. */
  draw() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const w = Math.round(rect.width * this.dpr);
    const h = Math.round(rect.height * this.dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      this.needsRedraw = true;
    }
    if (!this.needsRedraw) return;
    this.needsRedraw = false;

    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.fillStyle = '#0d1116';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = true;

    const z = clamp(Math.floor(this.zoom), 0, this.source.maxZoom);
    const scale = Math.pow(2, this.zoom - z);
    const cx = lonToTileX(this.lon, z), cy = latToTileY(this.lat, z);
    const size = TILE * scale;
    const cols = Math.ceil(rect.width / size) + 2;
    const rows = Math.ceil(rect.height / size) + 2;
    const x0 = Math.floor(cx - cols / 2), y0 = Math.floor(cy - rows / 2);

    for (const [srcName, src] of [['imagery', this.source], ['labels', this.overlay]]) {
      const sz = Math.min(z, src.maxZoom);
      const sScale = Math.pow(2, this.zoom - sz);
      const sSize = TILE * sScale;
      const scx = lonToTileX(this.lon, sz), scy = latToTileY(this.lat, sz);
      const sCols = Math.ceil(rect.width / sSize) + 2;
      const sRows = Math.ceil(rect.height / sSize) + 2;
      const sx0 = Math.floor(scx - sCols / 2), sy0 = Math.floor(scy - sRows / 2);
      for (let ty = sy0; ty < sy0 + sRows + 1; ty++) {
        for (let tx = sx0; tx < sx0 + sCols + 1; tx++) {
          const n = Math.pow(2, sz);
          const wrappedX = ((tx % n) + n) % n;
          const img = this.requestTile(srcName, src, sz, wrappedX, ty);
          if (!img) continue;
          const px = rect.width / 2 + (tx - scx) * sSize;
          const py = rect.height / 2 + (ty - scy) * sSize;
          ctx.drawImage(img, px, py, sSize + 1, sSize + 1);
        }
      }
    }

    // Markers.
    for (const m of this.markers) {
      const p = this.latLonToPixel(m.lat, m.lon);
      if (p.x < -20 || p.y < -20 || p.x > rect.width + 20 || p.y > rect.height + 20) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, m.radius || 5, 0, Math.PI * 2);
      ctx.fillStyle = m.colour || '#d9a441';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.stroke();
    }

    // Scale bar, because a map without one is a picture.
    const mpp = metresPerPixel(this.lat, this.zoom);
    const targets = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
    let barMetres = targets[targets.length - 1];
    for (const t of targets) { if (t / mpp <= 110) barMetres = t; }
    const barPx = barMetres / mpp;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rect.width - 16 - barPx, rect.height - 16);
    ctx.lineTo(rect.width - 16, rect.height - 16);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(barMetres >= 1000 ? `${barMetres / 1000} km` : `${barMetres} m`,
                 rect.width - 16, rect.height - 22);

    ctx.restore();
  }
}

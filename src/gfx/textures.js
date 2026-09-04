// Procedural textures.
//
// The game ships no image files. Every surface in it - facades, roof tiles,
// tarmac, lane markings, bark, foliage, water - is drawn into a canvas at load
// time and uploaded as a texture. That keeps the download to just the code, and
// it means a texture can be generated to fit the thing it is going on: a
// six-storey building gets a facade with six rows of windows, not a stretched
// approximation of one.
//
// Facade and roof textures are greyscale masks. Colour comes from per-vertex
// attributes on the mesh, which is what lets every building in a chunk share
// one material and collapse into a single draw call.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import { clamp } from '../core/util.js';

const cache = new Map();

/** Create a 2D canvas, preferring OffscreenCanvas where it exists. */
export function makeCanvas(w, h) {
  let c;
  if (typeof OffscreenCanvas !== 'undefined') c = new OffscreenCanvas(w, h);
  else { c = document.createElement('canvas'); c.width = w; c.height = h; }
  return { canvas: c, ctx: c.getContext('2d') };
}

function finish(canvas, { repeat = true, aniso = 4, srgb = false, mips = true } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.generateMipmaps = mips;
  tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Memoise a generated texture by key. */
function cached(key, build) {
  if (cache.has(key)) return cache.get(key);
  const v = build();
  cache.set(key, v);
  return v;
}

export function disposeTextures() {
  for (const v of cache.values()) {
    if (v && v.dispose) v.dispose();
    else if (v && typeof v === 'object') for (const k in v) if (v[k] && v[k].dispose) v[k].dispose();
  }
  cache.clear();
}

// --- helpers ---------------------------------------------------------------

/** Fill with fine value noise, for grain and weathering. */
function grain(ctx, w, h, amount, seed, scale = 1) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const rng = makeRng(seed);
  if (scale <= 1) {
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * amount * 255;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
    }
  } else {
    // Blocky noise for coarse materials like gravel and render.
    const bw = Math.max(1, Math.ceil(w / scale));
    const cells = new Float32Array(bw * bw);
    for (let i = 0; i < cells.length; i++) cells[i] = (rng() - 0.5) * amount * 255;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = cells[Math.min(bw - 1, (y / scale) | 0) * bw + Math.min(bw - 1, (x / scale) | 0)];
        const i = (y * w + x) * 4;
        d[i] = clamp(d[i] + n, 0, 255);
        d[i + 1] = clamp(d[i + 1] + n, 0, 255);
        d[i + 2] = clamp(d[i + 2] + n, 0, 255);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

const grey = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;

// --- facades ---------------------------------------------------------------

export const FACADE_TILE = 512;      // texture size
export const FACADE_BAYS = 4;        // bays across, floors down, per tile
export const BAY_WIDTH = 3.6;        // metres of facade per window bay
export const FLOOR_HEIGHT = 3.2;     // metres per storey in texture space

/**
 * Facade mask for upper storeys: a 4x4 grid of window bays.
 *
 * Four different bays across and down means the pattern only visibly repeats
 * every 14 metres of facade and every 13 metres of height, which is enough to
 * stop a long terrace reading as a photocopy. The returned object carries the
 * albedo mask and a matching emissive mask for lit windows after dark.
 */
export function facadeTexture(style = 'plain') {
  return cached(`facade:${style}`, () => {
    const S = FACADE_TILE, N = FACADE_BAYS;
    const cell = S / N;
    const { canvas, ctx } = makeCanvas(S, S);
    const { canvas: emCanvas, ctx: emCtx } = makeCanvas(S, S);
    const rng = makeRng(style.length * 7919 + 13);

    ctx.fillStyle = grey(232);
    ctx.fillRect(0, 0, S, S);
    emCtx.fillStyle = '#000';
    emCtx.fillRect(0, 0, S, S);

    // Window proportions per style, as a fraction of the bay.
    const cfg = {
      plain:     { w: 0.44, h: 0.52, top: 0.16, sill: true, mullionV: 1, mullionH: 1, arch: false },
      // Domestic glazing is small, set well down from the eaves, and divided
      // into panes. It is most of what separates a house from a small office
      // at a glance - the office window is wide and flush, the house window is
      // a punched hole with a sill under it.
      house:     { w: 0.32, h: 0.40, top: 0.24, sill: true, mullionV: 2, mullionH: 2, arch: false },
      tall:      { w: 0.38, h: 0.66, top: 0.11, sill: true, mullionV: 1, mullionH: 2, arch: false },
      grid:      { w: 0.62, h: 0.60, top: 0.14, sill: false, mullionV: 2, mullionH: 2, arch: false },
      curtain:   { w: 0.86, h: 0.78, top: 0.08, sill: false, mullionV: 2, mullionH: 1, arch: false },
      arched:    { w: 0.40, h: 0.58, top: 0.14, sill: true, mullionV: 1, mullionH: 1, arch: true },
      industrial:{ w: 0.72, h: 0.44, top: 0.22, sill: false, mullionV: 4, mullionH: 2, arch: false },
      slit:      { w: 0.18, h: 0.62, top: 0.14, sill: false, mullionV: 1, mullionH: 1, arch: false },
      none:      { w: 0, h: 0, top: 0, sill: false, mullionV: 0, mullionH: 0, arch: false },
    }[style] || { w: 0.44, h: 0.52, top: 0.16, sill: true, mullionV: 1, mullionH: 1, arch: false };

    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        const ox = gx * cell, oy = gy * cell;

        // A faint per-bay wall tone so panels are not perfectly uniform.
        ctx.fillStyle = grey(226 + rng() * 12);
        ctx.fillRect(ox, oy, cell, cell);

        if (cfg.w <= 0) continue;

        const ww = cell * cfg.w, wh = cell * cfg.h;
        const wx = ox + (cell - ww) / 2;
        const wy = oy + cell * cfg.top;

        // Reveal: the wall is thick, so the opening sits in shadow.
        ctx.fillStyle = grey(150);
        ctx.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);

        // Glass. Dark, with a diagonal sky reflection so it reads as glazing.
        const g = ctx.createLinearGradient(wx, wy, wx + ww, wy + wh);
        g.addColorStop(0, grey(96));
        g.addColorStop(0.45, grey(58));
        g.addColorStop(0.5, grey(112));
        g.addColorStop(0.55, grey(60));
        g.addColorStop(1, grey(44));
        ctx.fillStyle = g;
        if (cfg.arch) {
          ctx.beginPath();
          ctx.moveTo(wx, wy + wh);
          ctx.lineTo(wx, wy + ww / 2);
          ctx.arc(wx + ww / 2, wy + ww / 2, ww / 2, Math.PI, 0);
          ctx.lineTo(wx + ww, wy + wh);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillRect(wx, wy, ww, wh);
        }

        // Frame and glazing bars.
        ctx.strokeStyle = grey(238);
        ctx.lineWidth = Math.max(1.5, cell * 0.018);
        ctx.strokeRect(wx, wy, ww, wh);
        ctx.lineWidth = Math.max(1, cell * 0.011);
        for (let m = 1; m < cfg.mullionV; m++) {
          const mx = wx + (ww * m) / cfg.mullionV;
          ctx.beginPath(); ctx.moveTo(mx, wy); ctx.lineTo(mx, wy + wh); ctx.stroke();
        }
        for (let m = 1; m < cfg.mullionH; m++) {
          const my = wy + (wh * m) / cfg.mullionH;
          ctx.beginPath(); ctx.moveTo(wx, my); ctx.lineTo(wx + ww, my); ctx.stroke();
        }

        // Sill and lintel.
        if (cfg.sill) {
          ctx.fillStyle = grey(246);
          ctx.fillRect(wx - cell * 0.05, wy + wh, ww + cell * 0.1, cell * 0.035);
          ctx.fillStyle = grey(214);
          ctx.fillRect(wx - cell * 0.05, wy + wh + cell * 0.035, ww + cell * 0.1, cell * 0.012);
        }

        // Emissive: only some windows are lit, at varying warmth.
        if (rng() < 0.42) {
          const lit = 0.45 + rng() * 0.55;
          const warm = 0.72 + rng() * 0.28;
          emCtx.fillStyle = `rgba(${Math.round(255 * lit)},${Math.round(232 * lit * warm)},${Math.round(180 * lit * warm)},1)`;
          if (cfg.arch) {
            emCtx.beginPath();
            emCtx.moveTo(wx, wy + wh);
            emCtx.lineTo(wx, wy + ww / 2);
            emCtx.arc(wx + ww / 2, wy + ww / 2, ww / 2, Math.PI, 0);
            emCtx.lineTo(wx + ww, wy + wh);
            emCtx.closePath();
            emCtx.fill();
          } else {
            emCtx.fillRect(wx, wy, ww, wh);
          }
        }
      }

      // A floor line between storeys.
      ctx.fillStyle = grey(206);
      ctx.fillRect(0, gy * cell + cell - 2, S, 2);
    }

    grain(ctx, S, S, 0.06, 4242, 2);
    return { map: finish(canvas, { srgb: true }), emissive: finish(emCanvas, { srgb: true }) };
  });
}

/**
 * Ground-floor facade: shopfronts, doors and a plinth. Kept as its own texture
 * because the ground storey of a real building never looks like the ones above.
 */
export function groundFloorTexture(style = 'shop') {
  return cached(`ground:${style}`, () => {
    const S = FACADE_TILE, N = FACADE_BAYS;
    const cell = S / N;
    const { canvas, ctx } = makeCanvas(S, S);
    const { canvas: emCanvas, ctx: emCtx } = makeCanvas(S, S);
    const rng = makeRng(style.length * 104729 + 7);

    ctx.fillStyle = grey(228);
    ctx.fillRect(0, 0, S, S);
    emCtx.fillStyle = '#000';
    emCtx.fillRect(0, 0, S, S);

    for (let gx = 0; gx < N; gx++) {
      const ox = gx * cell;
      const isDoor = style === 'residential' ? gx % 2 === 1 : rng() < 0.28;

      ctx.fillStyle = grey(222 + rng() * 14);
      ctx.fillRect(ox, 0, cell, S);

      if (style === 'blank') continue;

      if (isDoor) {
        const dw = cell * 0.34, dh = S * 0.74;
        const dx = ox + (cell - dw) / 2, dy = S - dh - S * 0.06;
        ctx.fillStyle = grey(150);
        ctx.fillRect(dx - 4, dy - 4, dw + 8, dh + 8);
        ctx.fillStyle = grey(74);
        ctx.fillRect(dx, dy, dw, dh);
        ctx.strokeStyle = grey(232);
        ctx.lineWidth = 3;
        ctx.strokeRect(dx, dy, dw, dh);
        // A glazed panel in the upper half of the door.
        ctx.fillStyle = grey(52);
        ctx.fillRect(dx + dw * 0.16, dy + dh * 0.1, dw * 0.68, dh * 0.32);
        // Handle.
        ctx.fillStyle = grey(200);
        ctx.fillRect(dx + dw * 0.8, dy + dh * 0.52, dw * 0.06, dh * 0.09);
      } else {
        // Shopfront glazing, wide and low-silled.
        const gw = cell * 0.82, gh = S * 0.6;
        const gxp = ox + (cell - gw) / 2, gyp = S * 0.16;
        ctx.fillStyle = grey(140);
        ctx.fillRect(gxp - 5, gyp - 5, gw + 10, gh + 10);
        const g = ctx.createLinearGradient(gxp, gyp, gxp + gw, gyp + gh);
        g.addColorStop(0, grey(88));
        g.addColorStop(0.5, grey(48));
        g.addColorStop(1, grey(70));
        ctx.fillStyle = g;
        ctx.fillRect(gxp, gyp, gw, gh);
        ctx.strokeStyle = grey(224);
        ctx.lineWidth = 4;
        ctx.strokeRect(gxp, gyp, gw, gh);
        ctx.lineWidth = 2;
        const mid = gxp + gw / 2;
        ctx.beginPath(); ctx.moveTo(mid, gyp); ctx.lineTo(mid, gyp + gh); ctx.stroke();
        // Fascia above the window, where a shop sign would go.
        ctx.fillStyle = grey(120);
        ctx.fillRect(ox + cell * 0.05, S * 0.02, cell * 0.9, S * 0.11);

        if (rng() < 0.7) {
          const lit = 0.6 + rng() * 0.4;
          emCtx.fillStyle = `rgba(${Math.round(255 * lit)},${Math.round(244 * lit)},${Math.round(214 * lit)},1)`;
          emCtx.fillRect(gxp, gyp, gw, gh);
        }
      }
    }

    // A darker plinth along the bottom, where buildings meet the pavement.
    ctx.fillStyle = grey(186);
    ctx.fillRect(0, S * 0.93, S, S * 0.07);
    grain(ctx, S, S, 0.07, 99, 2);
    return { map: finish(canvas, { srgb: true }), emissive: finish(emCanvas, { srgb: true }) };
  });
}

// --- roofs -----------------------------------------------------------------

/** Roof surface masks: tiles, slate, shingles, metal seams, gravel, thatch. */
export function roofTexture(pattern = 'flat') {
  return cached(`roof:${pattern}`, () => {
    const S = 256;
    const { canvas, ctx } = makeCanvas(S, S);
    const rng = makeRng(pattern.length * 31337 + 5);
    ctx.fillStyle = grey(215);
    ctx.fillRect(0, 0, S, S);

    if (pattern === 'tile' || pattern === 'shingle') {
      const rows = pattern === 'tile' ? 10 : 14;
      const rh = S / rows;
      for (let r = 0; r < rows; r++) {
        const y = r * rh;
        const cols = pattern === 'tile' ? 12 : 9;
        const cw = S / cols;
        const offset = (r % 2) * cw * 0.5;
        for (let c = -1; c <= cols; c++) {
          const x = c * cw + offset;
          const tone = 196 + rng() * 52;
          ctx.fillStyle = grey(tone);
          if (pattern === 'tile') {
            ctx.beginPath();
            ctx.moveTo(x, y + rh);
            ctx.lineTo(x, y + rh * 0.45);
            ctx.quadraticCurveTo(x + cw / 2, y - rh * 0.15, x + cw, y + rh * 0.45);
            ctx.lineTo(x + cw, y + rh);
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.fillRect(x, y, cw - 1, rh - 1);
          }
        }
        // Shadow under each course.
        ctx.fillStyle = 'rgba(0,0,0,0.20)';
        ctx.fillRect(0, y + rh - 2, S, 2);
      }
    } else if (pattern === 'slate') {
      const rows = 16, rh = S / rows, cols = 10, cw = S / cols;
      for (let r = 0; r < rows; r++) {
        for (let c = -1; c <= cols; c++) {
          const x = c * cw + (r % 2) * cw * 0.5;
          ctx.fillStyle = grey(180 + rng() * 55);
          ctx.fillRect(x, r * rh, cw - 1.5, rh - 1.5);
        }
      }
    } else if (pattern === 'panel' || pattern === 'corrugated') {
      const step = pattern === 'corrugated' ? 8 : 32;
      for (let x = 0; x < S; x += step) {
        const g = ctx.createLinearGradient(x, 0, x + step, 0);
        g.addColorStop(0, grey(196));
        g.addColorStop(0.5, grey(228));
        g.addColorStop(1, grey(190));
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, step, S);
      }
      if (pattern === 'panel') {
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 2;
        for (let y = 0; y < S; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
      }
    } else if (pattern === 'gravel') {
      ctx.fillStyle = grey(198);
      ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < 3600; i++) {
        ctx.fillStyle = grey(150 + rng() * 96);
        const r = 1 + rng() * 2.4;
        ctx.beginPath();
        ctx.arc(rng() * S, rng() * S, r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (pattern === 'thatch') {
      for (let i = 0; i < 2400; i++) {
        const x = rng() * S, y = rng() * S;
        const len = 8 + rng() * 18;
        ctx.strokeStyle = grey(170 + rng() * 70);
        ctx.lineWidth = 1 + rng();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rng() - 0.5) * 4, y + len);
        ctx.stroke();
      }
    } else {
      // Flat: bitumen sheet with seams and a bit of ponding.
      ctx.fillStyle = grey(206);
      ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = grey(184);
      ctx.lineWidth = 3;
      for (let y = 24; y < S; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke(); }
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = `rgba(0,0,0,${0.03 + rng() * 0.05})`;
        ctx.beginPath();
        ctx.ellipse(rng() * S, rng() * S, 20 + rng() * 40, 14 + rng() * 26, rng() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    grain(ctx, S, S, 0.09, 606, pattern === 'gravel' ? 1 : 2);
    return finish(canvas, { srgb: true });
  });
}

// --- ground and roads ------------------------------------------------------

/** Road, pavement and natural ground surfaces. */
export function surfaceTexture(kind = 'asphalt') {
  return cached(`surface:${kind}`, () => {
    const S = 256;
    const { canvas, ctx } = makeCanvas(S, S);
    const rng = makeRng(kind.length * 7717 + 3);
    ctx.fillStyle = grey(210);
    ctx.fillRect(0, 0, S, S);

    switch (kind) {
      case 'asphalt': {
        for (let i = 0; i < 14000; i++) {
          ctx.fillStyle = grey(170 + rng() * 80);
          ctx.fillRect(rng() * S, rng() * S, 1 + rng() * 1.6, 1 + rng() * 1.6);
        }
        // Occasional patch repairs and cracks.
        for (let i = 0; i < 5; i++) {
          ctx.fillStyle = `rgba(0,0,0,${0.04 + rng() * 0.05})`;
          ctx.fillRect(rng() * S, rng() * S, 24 + rng() * 60, 18 + rng() * 40);
        }
        break;
      }
      case 'paving_stones': case 'sett': case 'cobblestone': case 'unhewn_cobblestone': {
        const n = kind === 'paving_stones' ? 6 : 12;
        const c = S / n;
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const off = kind === 'paving_stones' ? 0 : (y % 2) * c * 0.5;
            ctx.fillStyle = grey(178 + rng() * 62);
            if (kind === 'paving_stones') {
              ctx.fillRect(x * c + 1.5, y * c + 1.5, c - 3, c - 3);
            } else {
              ctx.beginPath();
              ctx.ellipse(x * c + off + c / 2, y * c + c / 2, c * 0.44, c * 0.4, rng() * 3, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        break;
      }
      case 'bricks': {
        const rows = 12, rh = S / rows, cols = 5, cw = S / cols;
        for (let r = 0; r < rows; r++) {
          for (let c = -1; c <= cols; c++) {
            ctx.fillStyle = grey(190 + rng() * 55);
            ctx.fillRect(c * cw + (r % 2) * cw * 0.5 + 1, r * rh + 1, cw - 2, rh - 2);
          }
        }
        break;
      }
      case 'gravel': case 'fine_gravel': case 'compacted': case 'pebblestone': {
        const count = kind === 'fine_gravel' ? 9000 : 4200;
        const size = kind === 'fine_gravel' ? 1.6 : 3.2;
        for (let i = 0; i < count; i++) {
          ctx.fillStyle = grey(160 + rng() * 90);
          ctx.beginPath();
          ctx.arc(rng() * S, rng() * S, 0.8 + rng() * size, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'sand': {
        for (let i = 0; i < 9000; i++) {
          ctx.fillStyle = grey(200 + rng() * 55);
          ctx.fillRect(rng() * S, rng() * S, 1.4, 1.4);
        }
        // Wind ripples.
        ctx.globalAlpha = 0.12;
        for (let y = 0; y < S; y += 7) {
          ctx.strokeStyle = grey(150);
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let x = 0; x <= S; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.08 + y) * 2.5);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        break;
      }
      case 'grass': {
        // A lawn is not one shade with blades drawn on it. Real turf reads as
        // patches - mown bands, thin bits, dry bits - and without that low
        // frequency the vertex colour comes through as flat paint, which is
        // what a park looked like from any distance at all.
        ctx.fillStyle = grey(150);
        ctx.fillRect(0, 0, S, S);
        for (let i = 0; i < 34; i++) {
          const x = rng() * S, y = rng() * S, r = 18 + rng() * 62;
          const tone = 118 + rng() * 92;
          const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
          grad.addColorStop(0, `rgba(${tone},${tone},${tone},0.55)`);
          grad.addColorStop(1, `rgba(${tone},${tone},${tone},0)`);
          ctx.fillStyle = grad;
          // Wrap the blotches so the tile still meets itself at the seam.
          for (const [ox, oy] of [[0, 0], [S, 0], [-S, 0], [0, S], [0, -S]]) {
            ctx.save(); ctx.translate(ox, oy);
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
          }
        }
        // Understory first, then brighter tips over it, so the turf has depth
        // rather than one even scatter of strokes.
        for (const [count, lo, span, len] of [[9000, 96, 70, 3.5], [7000, 168, 88, 5]]) {
          for (let i = 0; i < count; i++) {
            const x = rng() * S, y = rng() * S;
            ctx.strokeStyle = grey(lo + rng() * span);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + (rng() - 0.5) * 3, y - 1.5 - rng() * len);
            ctx.stroke();
          }
        }
        break;
      }
      case 'dirt': case 'ground': case 'earth': case 'mud': {
        for (let i = 0; i < 6000; i++) {
          ctx.fillStyle = grey(170 + rng() * 78);
          ctx.beginPath();
          ctx.arc(rng() * S, rng() * S, 1 + rng() * 4, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'wood': {
        for (let p = 0; p < 8; p++) {
          const y = (p * S) / 8;
          ctx.fillStyle = grey(190 + rng() * 45);
          ctx.fillRect(0, y + 1, S, S / 8 - 2);
          // Grain lines along each plank.
          for (let i = 0; i < 26; i++) {
            ctx.strokeStyle = `rgba(0,0,0,${0.03 + rng() * 0.06})`;
            ctx.lineWidth = 1;
            const gy = y + rng() * (S / 8);
            ctx.beginPath();
            for (let x = 0; x <= S; x += 12) ctx.lineTo(x, gy + Math.sin(x * 0.05 + p) * 1.5);
            ctx.stroke();
          }
        }
        break;
      }
      case 'snow': case 'ice': {
        ctx.fillStyle = grey(244);
        ctx.fillRect(0, 0, S, S);
        for (let i = 0; i < 2500; i++) {
          ctx.fillStyle = grey(228 + rng() * 27);
          ctx.beginPath();
          ctx.arc(rng() * S, rng() * S, 1 + rng() * 3, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'concrete': default: {
        ctx.fillStyle = grey(214);
        ctx.fillRect(0, 0, S, S);
        for (let i = 0; i < 5000; i++) {
          ctx.fillStyle = grey(196 + rng() * 46);
          ctx.fillRect(rng() * S, rng() * S, 1.5, 1.5);
        }
        // Expansion joints.
        ctx.strokeStyle = 'rgba(0,0,0,0.16)';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(S / 2, 0); ctx.lineTo(S / 2, S); ctx.stroke();
        break;
      }
    }

    grain(ctx, S, S, 0.07, 4711, 1);
    return finish(canvas, { srgb: true });
  });
}

/**
 * Lane markings, drawn as an RGBA overlay so it can sit on any surface.
 * `v` runs along the road, `u` across it, so one texture serves every width.
 */
export function roadMarkingTexture(kind = 'dashed') {
  return cached(`marking:${kind}`, () => {
    const S = 128;
    const { canvas, ctx } = makeCanvas(S, S * 4);
    ctx.clearRect(0, 0, S, S * 4);
    ctx.fillStyle = 'rgba(238,236,226,0.92)';
    const cx = S / 2;
    if (kind === 'dashed') {
      for (let y = 0; y < S * 4; y += 96) ctx.fillRect(cx - 4, y, 8, 52);
    } else if (kind === 'solid') {
      ctx.fillRect(cx - 4, 0, 8, S * 4);
    } else if (kind === 'double') {
      ctx.fillRect(cx - 11, 0, 7, S * 4);
      ctx.fillRect(cx + 4, 0, 7, S * 4);
    } else if (kind === 'crossing') {
      // Zebra stripes run across the carriageway.
      for (let y = 0; y < S * 4; y += 40) ctx.fillRect(0, y, S, 22);
    }
    return finish(canvas, { srgb: true });
  });
}

// --- nature ----------------------------------------------------------------

/** Bark, as a greyscale mask tinted per species by vertex colour. */
export function barkTexture(kind = 'rough') {
  return cached(`bark:${kind}`, () => {
    const S = 256;
    const { canvas, ctx } = makeCanvas(S, S);
    const rng = makeRng(kind.length * 977);
    ctx.fillStyle = grey(190);
    ctx.fillRect(0, 0, S, S);
    if (kind === 'birch') {
      ctx.fillStyle = grey(238);
      ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = `rgba(30,28,26,${0.35 + rng() * 0.45})`;
        const w = 6 + rng() * 34, h = 2 + rng() * 4;
        ctx.fillRect(rng() * S, rng() * S, w, h);
      }
    } else if (kind === 'palm') {
      for (let y = 0; y < S; y += 16) {
        ctx.fillStyle = grey(170 + rng() * 50);
        ctx.fillRect(0, y, S, 13);
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.fillRect(0, y + 13, S, 3);
      }
    } else {
      // Vertical fissures, the default for most trunks.
      for (let i = 0; i < 260; i++) {
        const x = rng() * S;
        ctx.strokeStyle = `rgba(0,0,0,${0.06 + rng() * 0.22})`;
        ctx.lineWidth = 1 + rng() * 3.5;
        ctx.beginPath();
        let y = 0;
        let cxp = x;
        ctx.moveTo(cxp, y);
        while (y < S) {
          y += 12 + rng() * 20;
          cxp += (rng() - 0.5) * 8;
          ctx.lineTo(cxp, y);
        }
        ctx.stroke();
      }
    }
    grain(ctx, S, S, 0.12, 313, 2);
    return finish(canvas, { srgb: true });
  });
}

/**
 * A foliage card: a cluster of leaves on transparent background.
 * Crossed quads using this read as a canopy from any angle at a fraction of
 * the cost of modelled leaves.
 */
export function foliageTexture(kind = 'broadleaf') {
  return cached(`foliage:${kind}`, () => {
    const S = 256;
    const { canvas, ctx } = makeCanvas(S, S);
    const rng = makeRng(kind.length * 2749 + 17);
    ctx.clearRect(0, 0, S, S);

    const leaf = (x, y, r, rot, tone) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.fillStyle = `rgb(${Math.round(tone * 0.55)},${Math.round(tone)},${Math.round(tone * 0.42)})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.52, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    if (kind === 'needle') {
      for (let i = 0; i < 900; i++) {
        const x = S / 2 + (rng() - 0.5) * S * 0.9;
        const y = rng() * S;
        const spread = 1 - Math.abs(x - S / 2) / (S / 2);
        if (rng() > spread * 0.9 + 0.1) continue;
        ctx.strokeStyle = `rgba(${30 + rng() * 40},${70 + rng() * 60},${34 + rng() * 30},0.95)`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rng() - 0.5) * 26, y + 8 + rng() * 16);
        ctx.stroke();
      }
    } else if (kind === 'palm') {
      for (let f = 0; f < 9; f++) {
        const a = (f / 9) * Math.PI * 2 + rng() * 0.3;
        const len = S * (0.36 + rng() * 0.14);
        ctx.save();
        ctx.translate(S / 2, S / 2);
        ctx.rotate(a);
        ctx.strokeStyle = `rgb(${40 + rng() * 30},${110 + rng() * 50},${44 + rng() * 25})`;
        for (let i = 0; i < 24; i++) {
          const t = i / 24;
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.moveTo(len * t, 0);
          ctx.lineTo(len * t + 4, (1 - t) * 22 * (i % 2 ? 1 : -1));
          ctx.stroke();
        }
        ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(len, 0); ctx.stroke();
        ctx.restore();
      }
    } else {
      const count = kind === 'sparse' ? 130 : 320;
      for (let i = 0; i < count; i++) {
        // Cluster toward the middle so the card silhouette is round.
        const a = rng() * Math.PI * 2;
        const rr = Math.pow(rng(), 0.55) * S * 0.46;
        const x = S / 2 + Math.cos(a) * rr;
        const y = S / 2 + Math.sin(a) * rr * 0.9;
        leaf(x, y, 7 + rng() * 12, rng() * Math.PI, 110 + rng() * 110);
      }
    }
    return finish(canvas, { repeat: false, srgb: true });
  });
}

/** A single grass blade cluster, alpha-cut, for the ground-cover instances. */
export function grassBladeTexture() {
  return cached('grassblade', () => {
    const S = 128;
    const { canvas, ctx } = makeCanvas(S, S);
    const rng = makeRng(8081);
    ctx.clearRect(0, 0, S, S);
    for (let i = 0; i < 22; i++) {
      const x = 8 + rng() * (S - 16);
      const h = S * (0.5 + rng() * 0.48);
      const w = 3 + rng() * 4;
      const lean = (rng() - 0.5) * 26;
      // Near-greyscale, like every other surface texture here, because the
      // instance colour carries the hue. Painting the blade green as well
      // multiplied one green by another and left a bright lawn covered in
      // near-black tufts.
      const tone = 150 + rng() * 86;
      ctx.fillStyle = `rgb(${Math.round(tone * 0.86)},${Math.round(tone)},${Math.round(tone * 0.72)})`;
      ctx.beginPath();
      ctx.moveTo(x - w / 2, S);
      ctx.quadraticCurveTo(x - w / 4 + lean * 0.5, S - h * 0.5, x + lean, S - h);
      ctx.quadraticCurveTo(x + w / 4 + lean * 0.5, S - h * 0.5, x + w / 2, S);
      ctx.closePath();
      ctx.fill();
    }
    return finish(canvas, { repeat: false, srgb: true });
  });
}

/** Animated-looking water normals: two summed wave trains, tileable. */
export function waterNormalTexture() {
  return cached('waternormal', () => {
    const S = 256;
    const { canvas, ctx } = makeCanvas(S, S);
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const height = (x, y) =>
      Math.sin((x * 0.11) + Math.cos(y * 0.07) * 2.2) * 0.5 +
      Math.sin((x * 0.043 - y * 0.061) * 2.1) * 0.3 +
      Math.sin((y * 0.13) + Math.sin(x * 0.05) * 1.6) * 0.2;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const hx = height(x + 1, y) - height(x - 1, y);
        const hy = height(x, y + 1) - height(x, y - 1);
        // Pack the surface normal into RGB the way a normal map expects.
        let nx = -hx * 0.6, ny = -hy * 0.6, nz = 1;
        const l = Math.hypot(nx, ny, nz);
        nx /= l; ny /= l; nz /= l;
        const i = (y * S + x) * 4;
        d[i] = (nx * 0.5 + 0.5) * 255;
        d[i + 1] = (ny * 0.5 + 0.5) * 255;
        d[i + 2] = (nz * 0.5 + 0.5) * 255;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return finish(canvas);
  });
}

/** Soft round sprite, for rain splashes, dust motes and light glows. */
export function radialSprite(hardness = 0.35, tint = '255,255,255') {
  return cached(`radial:${hardness}:${tint}`, () => {
    const S = 64;
    const { canvas, ctx } = makeCanvas(S, S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, `rgba(${tint},1)`);
    g.addColorStop(clamp(hardness, 0.01, 0.95), `rgba(${tint},0.55)`);
    g.addColorStop(1, `rgba(${tint},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return finish(canvas, { repeat: false, srgb: true });
  });
}

/** A star field for the night sky, as an equirectangular map. */
export function starfieldTexture() {
  return cached('starfield', () => {
    const W = 2048, H = 1024;
    const { canvas, ctx } = makeCanvas(W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const rng = makeRng(20260903);

    // The Milky Way as a broad diffuse band across the sphere.
    for (let i = 0; i < 22000; i++) {
      const u = rng();
      const bandCentre = 0.5 + Math.sin(u * Math.PI * 2) * 0.16;
      const v = bandCentre + rng.gauss(0, 0.045);
      if (v < 0 || v > 1) continue;
      const a = 0.05 + rng() * 0.12;
      ctx.fillStyle = `rgba(200,206,235,${a})`;
      ctx.fillRect(u * W, v * H, 2, 2);
    }
    // Individual stars, with a realistic magnitude distribution.
    for (let i = 0; i < 5200; i++) {
      const x = rng() * W;
      const y = rng() * H;
      const mag = Math.pow(rng(), 3.2);
      const r = 0.5 + mag * 2.4;
      const b = 0.35 + mag * 0.65;
      // Colour by spectral class: mostly white, some blue, some orange.
      const t = rng();
      const col = t < 0.12 ? [170, 195, 255] : t < 0.72 ? [255, 253, 246] : [255, 214, 176];
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${b})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return finish(canvas, { repeat: false, srgb: true, aniso: 1 });
  });
}

// Block types, and the texture atlas they are drawn from.
//
// Voxel mode renders the same real terrain the walking world does, but as
// metre cubes you can dig out and stack back up. The table is deliberately
// small: every entry is either something the terrain generator can justify
// placing, or something you can obviously build with.

import * as THREE from 'three';
import { makeCanvas } from '../gfx/textures.js';

export const AIR = 0;

// Tiles in the atlas, in the order they are painted.
const TILE = {
  stone: 0, dirt: 1, grassTop: 2, grassSide: 3, sand: 4, gravel: 5, snow: 6,
  logSide: 7, logTop: 8, leaves: 9, planks: 10, cobble: 11, brick: 12,
  glass: 13, water: 14, concrete: 15, asphalt: 16, clay: 17,
  coalOre: 18, ironOre: 19, copperOre: 20, goldOre: 21,
  benchTop: 22, benchSide: 23, furnaceFront: 24, furnaceSide: 25,
};

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;
const TILE_PX = 32;
const PAD = 2;
const CELL = TILE_PX + PAD * 2;

/**
 * The block table. `id` is what is stored in the chunk arrays and in a save,
 * so this order is a format: append, never reorder.
 *
 * `solid` stops you walking through it. `cull` is whether it hides the face of
 * the block behind it - glass and water are solid to walk on but must not hide
 * what is behind them. `falls` is the one Minecraft rule that makes digging
 * something you have to think about. `hardness` is seconds of mining.
 */
export const BLOCKS = [
  { id: 0,  name: 'Air',      solid: false, cull: false },
  { id: 1,  name: 'Stone',    tiles: TILE.stone,    hardness: 1.5, drops: 10 },
  { id: 2,  name: 'Dirt',     tiles: TILE.dirt,     hardness: 0.5 },
  { id: 3,  name: 'Grass',    top: TILE.grassTop, side: TILE.grassSide, bottom: TILE.dirt, hardness: 0.6, drops: 2 },
  { id: 4,  name: 'Sand',     tiles: TILE.sand,     hardness: 0.5, falls: true },
  { id: 5,  name: 'Gravel',   tiles: TILE.gravel,   hardness: 0.6, falls: true },
  { id: 6,  name: 'Snow',     tiles: TILE.snow,     hardness: 0.3 },
  { id: 7,  name: 'Wood',     top: TILE.logTop, side: TILE.logSide, bottom: TILE.logTop, hardness: 1.2 },
  { id: 8,  name: 'Leaves',   tiles: TILE.leaves,   hardness: 0.2 },
  { id: 9,  name: 'Planks',   tiles: TILE.planks,   hardness: 1.0 },
  { id: 10, name: 'Cobble',   tiles: TILE.cobble,   hardness: 1.8 },
  { id: 11, name: 'Brick',    tiles: TILE.brick,    hardness: 1.8 },
  { id: 12, name: 'Glass',    tiles: TILE.glass,    hardness: 0.3, translucent: true, cull: false },
  { id: 13, name: 'Water',    tiles: TILE.water,    solid: false, translucent: true, cull: false, liquid: true },
  { id: 14, name: 'Concrete', tiles: TILE.concrete, hardness: 1.6 },
  { id: 15, name: 'Asphalt',  tiles: TILE.asphalt,  hardness: 1.4 },
  { id: 16, name: 'Clay',     tiles: TILE.clay,     hardness: 0.7 },

  // Ores. `needs` is the pickaxe tier that can actually take one home;
  // anything softer breaks the rock and leaves nothing, which is the whole
  // reason to go looking for iron before you go looking for gold.
  { id: 17, name: 'Coal ore',   tiles: TILE.coalOre,   hardness: 2.2, tool: 'pickaxe', needs: 1, item: 'coal' },
  { id: 18, name: 'Iron ore',   tiles: TILE.ironOre,   hardness: 3.0, tool: 'pickaxe', needs: 2, item: 'iron_ore' },
  { id: 19, name: 'Copper ore', tiles: TILE.copperOre, hardness: 2.6, tool: 'pickaxe', needs: 1, item: 'copper_ore' },
  { id: 20, name: 'Gold ore',   tiles: TILE.goldOre,   hardness: 3.4, tool: 'pickaxe', needs: 3, item: 'gold_ore' },

  // Stations. Standing near one unlocks the recipes that need it, which is
  // what turns "I have materials" into "I need a base".
  { id: 21, name: 'Workbench', top: TILE.benchTop, side: TILE.benchSide, bottom: TILE.planks, hardness: 1.2, tool: 'axe', station: 'bench' },
  { id: 22, name: 'Furnace',   top: TILE.furnaceSide, side: TILE.furnaceFront, bottom: TILE.furnaceSide, hardness: 2.0, tool: 'pickaxe', station: 'furnace' },
];

// Which tool family each block yields to. Digging dirt with a pickaxe should
// feel wrong, and a shovel should be the fastest way through a hillside.
const DEFAULT_TOOL = {
  1: 'pickaxe', 2: 'shovel', 3: 'shovel', 4: 'shovel', 5: 'shovel', 6: 'shovel',
  7: 'axe', 8: 'axe', 9: 'axe', 10: 'pickaxe', 11: 'pickaxe', 12: 'pickaxe',
  14: 'pickaxe', 15: 'pickaxe', 16: 'shovel',
};

// Footstep surface per block, by the ids in physics/collider.js.
const FOOTSTEP_ID = {
  1: 1, 2: 3, 3: 4, 4: 5, 5: 2, 6: 8, 7: 6, 8: 4, 9: 6,
  10: 1, 11: 1, 12: 11, 13: 9, 14: 0, 15: 0, 16: 3,
  17: 1, 18: 1, 19: 1, 20: 1, 21: 6, 22: 1,
};

// Fill the defaults in once rather than repeating them on every row.
for (const b of BLOCKS) {
  if (b.solid === undefined) b.solid = true;
  if (b.cull === undefined) b.cull = b.solid;
  if (b.hardness === undefined) b.hardness = 1;
  if (b.falls === undefined) b.falls = false;
  if (b.translucent === undefined) b.translucent = false;
  if (b.liquid === undefined) b.liquid = false;
  if (b.drops === undefined) b.drops = b.id;
  // Which tool family mines it quickly, and the tier needed to keep the drop.
  if (b.tool === undefined) b.tool = DEFAULT_TOOL[b.id] || null;
  if (b.needs === undefined) b.needs = 0;
  if (b.station === undefined) b.station = null;
  if (b.tiles !== undefined) { b.top = b.side = b.bottom = b.tiles; }
  // Footstep surface id, matching physics/collider.js's SURFACE_IDS. Baked
  // into the collision mesh per triangle so stone sounds like stone.
  if (b.footstep === undefined) b.footstep = FOOTSTEP_ID[b.id] ?? 0;
}

export const isSolid = (id) => BLOCKS[id].solid;
export const isCulling = (id) => BLOCKS[id].cull;
export const isLiquid = (id) => BLOCKS[id].liquid;
export const isTranslucent = (id) => BLOCKS[id].translucent;

/** Blocks offered in the creative palette, in hotbar order. */
export const PALETTE = [1, 10, 2, 3, 4, 5, 7, 9, 11, 12, 14, 15, 16, 6, 8, 21, 22];

/** Blocks that act as a crafting station when you stand near one. */
export const STATIONS = BLOCKS.filter((b) => b.station).map((b) => b.id);

// --- atlas -----------------------------------------------------------------

let atlasTexture = null;

/**
 * One canvas holding every block face.
 *
 * A single texture means the terrain is one draw call per material, which
 * matters when a view holds a few hundred thousand faces. Each tile is padded
 * with a copy of its own edge so mipmapping and anisotropy cannot bleed one
 * block's colour into its neighbour - the same failure that turned the trees
 * black, and far more obvious here, where grass sits directly against stone.
 */
export function blockAtlas() {
  if (atlasTexture) return atlasTexture;
  const { canvas, ctx } = makeCanvas(ATLAS_COLS * CELL, ATLAS_ROWS * CELL);
  ctx.imageSmoothingEnabled = false;

  for (const name of Object.keys(TILE)) {
    const index = TILE[name];
    const cx = (index % ATLAS_COLS) * CELL + PAD;
    const cy = Math.floor(index / ATLAS_COLS) * CELL + PAD;
    const tile = paintTile(name);
    ctx.drawImage(tile, cx, cy);
    ctx.drawImage(tile, 0, 0, 1, TILE_PX, cx - PAD, cy, PAD, TILE_PX);
    ctx.drawImage(tile, TILE_PX - 1, 0, 1, TILE_PX, cx + TILE_PX, cy, PAD, TILE_PX);
    ctx.drawImage(tile, 0, 0, TILE_PX, 1, cx, cy - PAD, TILE_PX, PAD);
    ctx.drawImage(tile, 0, TILE_PX - 1, TILE_PX, 1, cx, cy + TILE_PX, TILE_PX, PAD);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Nearest magnification is the whole look: a block you stand against should
  // read as pixels, not as a smeared photograph.
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  atlasTexture = tex;
  return tex;
}

/** UV rectangle for a tile index, inside its padding. */
export function tileUv(index) {
  const w = ATLAS_COLS * CELL, h = ATLAS_ROWS * CELL;
  const cx = (index % ATLAS_COLS) * CELL + PAD;
  const cy = Math.floor(index / ATLAS_COLS) * CELL + PAD;
  return {
    u0: cx / w, u1: (cx + TILE_PX) / w,
    v0: 1 - (cy + TILE_PX) / h, v1: 1 - cy / h,
  };
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function paintTile(name) {
  const S = TILE_PX;
  const { canvas, ctx } = makeCanvas(S, S);
  const r = rng(name.length * 7919 + name.charCodeAt(0) * 131 + name.charCodeAt(name.length - 1));

  const speckle = (base, spread, count) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < count; i++) {
      const v = (r() - 0.5) * spread;
      const c = v > 0 ? 255 : 0;
      ctx.fillStyle = 'rgba(' + c + ',' + c + ',' + c + ',' + (Math.abs(v) / 255).toFixed(3) + ')';
      ctx.fillRect(Math.floor(r() * S), Math.floor(r() * S), 1 + Math.floor(r() * 2), 1 + Math.floor(r() * 2));
    }
  };

  if (name === 'stone') speckle('#8a8a8a', 90, 220);
  else if (name === 'dirt') speckle('#7a5a3c', 70, 260);
  else if (name === 'clay') speckle('#9aa0ab', 40, 160);
  else if (name === 'sand') speckle('#dcd0a0', 45, 200);
  else if (name === 'gravel') speckle('#8d8880', 110, 300);
  else if (name === 'snow') speckle('#f2f6fa', 26, 120);
  else if (name === 'concrete') speckle('#b9b7b0', 26, 120);
  else if (name === 'asphalt') speckle('#3f4145', 40, 240);
  else if (name === 'grassTop') speckle('#6aa03c', 60, 300);
  else if (name === 'cobble') {
    ctx.fillStyle = '#6f6f6f';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 14; i++) {
      const w = 5 + Math.floor(r() * 8), h = 4 + Math.floor(r() * 7);
      const g = 120 + Math.floor(r() * 60);
      ctx.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')';
      ctx.fillRect(Math.floor(r() * (S - w)), Math.floor(r() * (S - h)), w, h);
    }
  } else if (name === 'grassSide') {
    // Soil with a ragged green cap, so a cut bank reads as turf over dirt.
    speckle('#7a5a3c', 70, 200);
    ctx.fillStyle = '#6aa03c';
    ctx.fillRect(0, 0, S, 5);
    for (let x = 0; x < S; x++) ctx.fillRect(x, 5, 1, Math.floor(r() * 5));
  } else if (name === 'logTop') {
    ctx.fillStyle = '#8a6a44';
    ctx.fillRect(0, 0, S, S);
    for (let i = 6; i > 0; i--) {
      ctx.strokeStyle = i % 2 ? '#6d5334' : '#9c7a50';
      ctx.beginPath();
      ctx.arc(S / 2, S / 2, i * 2.4, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (name === 'logSide') {
    ctx.fillStyle = '#6d5334';
    ctx.fillRect(0, 0, S, S);
    for (let x = 0; x < S; x += 2) {
      const g = 90 + Math.floor(r() * 50);
      ctx.fillStyle = 'rgb(' + g + ',' + Math.floor(g * 0.76) + ',' + Math.floor(g * 0.5) + ')';
      ctx.fillRect(x, 0, 1 + Math.floor(r() * 2), S);
    }
  } else if (name === 'leaves') {
    ctx.fillStyle = '#3f6b2a';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 90; i++) {
      const g = 70 + Math.floor(r() * 90);
      ctx.fillStyle = 'rgb(' + Math.floor(g * 0.55) + ',' + g + ',' + Math.floor(g * 0.4) + ')';
      ctx.fillRect(Math.floor(r() * S), Math.floor(r() * S), 2 + Math.floor(r() * 3), 2 + Math.floor(r() * 3));
    }
  } else if (name === 'planks') {
    ctx.fillStyle = '#b08a55';
    ctx.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 8) {
      ctx.fillStyle = '#8a6a3f';
      ctx.fillRect(0, y + 7, S, 1);
      for (let i = 0; i < 10; i++) {
        const g = 150 + Math.floor(r() * 50);
        ctx.fillStyle = 'rgba(' + g + ',' + Math.floor(g * 0.78) + ',' + Math.floor(g * 0.5) + ',0.5)';
        ctx.fillRect(Math.floor(r() * S), y + Math.floor(r() * 7), 3 + Math.floor(r() * 6), 1);
      }
    }
  } else if (name === 'brick') {
    ctx.fillStyle = '#9c9188';               // mortar
    ctx.fillRect(0, 0, S, S);
    for (let row = 0, y = 0; y < S; y += 8, row++) {
      const offset = row % 2 ? -8 : 0;
      for (let x = offset; x < S; x += 16) {
        const g = 150 + Math.floor(r() * 40);
        ctx.fillStyle = 'rgb(' + g + ',' + Math.floor(g * 0.5) + ',' + Math.floor(g * 0.4) + ')';
        ctx.fillRect(x + 1, y + 1, 14, 6);
      }
    }
  } else if (name === 'glass') {
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(210,232,244,0.20)';
    ctx.fillRect(2, 2, S - 4, S - 4);
    ctx.strokeStyle = 'rgba(222,238,246,0.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, S - 2, S - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(5, 5, 8, 2);
    ctx.fillRect(5, 5, 2, 8);
  } else if (name === 'water') {
    ctx.fillStyle = 'rgba(48,104,150,0.78)';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = 'rgba(120,180,220,' + (0.10 + r() * 0.18).toFixed(3) + ')';
      ctx.fillRect(Math.floor(r() * S), Math.floor(r() * S), 3 + Math.floor(r() * 6), 1);
    }
  } else if (name === 'coalOre' || name === 'ironOre' || name === 'copperOre' || name === 'goldOre') {
    // Ore is stone with something in it, so it is painted on the stone tile -
    // a seam has to read as part of the rock face, not as a decal on it.
    speckle('#8a8a8a', 90, 220);
    const vein = { coalOre: '#231f1c', ironOre: '#c08a63', copperOre: '#5aa88a', goldOre: '#e8c04a' }[name];
    const edge = { coalOre: '#3a3430', ironOre: '#e6b48c', copperOre: '#8ad0b4', goldOre: '#fff0a8' }[name];
    for (let i = 0; i < 7; i++) {
      const bx = 3 + Math.floor(r() * (S - 12)), by = 3 + Math.floor(r() * (S - 12));
      const w = 4 + Math.floor(r() * 5), h = 4 + Math.floor(r() * 5);
      ctx.fillStyle = vein; ctx.fillRect(bx, by, w, h);
      ctx.fillStyle = edge; ctx.fillRect(bx, by, w - 2, 2);
    }
  } else if (name === 'benchTop') {
    ctx.fillStyle = '#b08a55'; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#8a6a3f';
    for (let y = 0; y < S; y += 8) ctx.fillRect(0, y, S, 1);
    ctx.fillStyle = '#6b5333';
    ctx.fillRect(3, 3, S - 6, 2); ctx.fillRect(3, S - 8, S - 6, 2);   // tool marks
    ctx.fillRect(S - 12, 8, 8, 2);
  } else if (name === 'benchSide') {
    ctx.fillStyle = '#8a6a3f'; ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#b08a55'; ctx.fillRect(0, 0, S, 7);              // worktop
    ctx.fillStyle = '#6b5333';
    ctx.fillRect(3, 10, 5, S - 12); ctx.fillRect(S - 8, 10, 5, S - 12); // legs
  } else if (name === 'furnaceSide') {
    speckle('#6f6f6f', 70, 200);
    ctx.fillStyle = '#585858'; ctx.fillRect(0, 0, S, 3); ctx.fillRect(0, S - 3, S, 3);
  } else if (name === 'furnaceFront') {
    speckle('#6f6f6f', 70, 200);
    ctx.fillStyle = '#2a2724'; ctx.fillRect(7, 12, S - 14, S - 16);   // the mouth
    ctx.fillStyle = '#d4762a'; ctx.fillRect(9, S - 10, S - 18, 4);    // embers
    ctx.fillStyle = '#f4b64a'; ctx.fillRect(12, S - 9, S - 24, 2);
    ctx.fillStyle = '#484848'; ctx.fillRect(6, 9, S - 12, 3);
  } else {
    speckle('#a0a0a0', 40, 100);
  }
  return canvas;
}

/** Drop the cached atlas so a settings change can rebuild it. */
export function disposeAtlas() {
  if (atlasTexture) { atlasTexture.dispose(); atlasTexture = null; }
}

// Voxel mode: the same Earth, as blocks you can take apart and build with.
//
// This is a second world laid over the first rather than a separate game. The
// terrain comes from the elevation tiles the walking world already sampled, so
// the hill you were standing on is the hill you dig into; the character
// controller, the sky, the weather and the audio are all the ones you were
// already using. What changes is what the ground is made of, and that you can
// pick it up.

import * as THREE from 'three';
import { AIR, BLOCKS, PALETTE, blockAtlas } from './blocks.js';
import { CHUNK, HEIGHT, FLOOR_BELOW_SPAWN, VoxelGrid, chunkKey } from './grid.js';
import { meshChunk } from './mesher.js';
import { TerrainSampler } from './sampler.js';
import { raycastVoxels } from './raycast.js';
import { SURFACE_IDS } from '../physics/collider.js';

const REACH = 5.5;                 // metres you can reach to break or place
const HOTBAR_SLOTS = 9;
const FALL_TICK = 0.12;            // seconds between steps of falling sand

/**
 * Chunks loaded around the player, by graphics quality.
 *
 * Sixteen metres a chunk, so ten is a 160 m view - short next to the walking
 * world's 1.4 km, but a blocky world costs its triangles at the near end
 * rather than the far one, and a fully streamed radius of ten is already
 * 800,000 of them.
 */
const RADIUS_BY_QUALITY = { potato: 5, low: 6, medium: 8, high: 10, ultra: 12 };

/** Which footstep sound a block should make. */
const FOOTSTEP = {
  1: SURFACE_IDS.stone, 2: SURFACE_IDS.dirt, 3: SURFACE_IDS.grass,
  4: SURFACE_IDS.sand, 5: SURFACE_IDS.gravel, 6: SURFACE_IDS.snow,
  7: SURFACE_IDS.wood, 8: SURFACE_IDS.grass, 9: SURFACE_IDS.wood,
  10: SURFACE_IDS.stone, 11: SURFACE_IDS.stone, 12: SURFACE_IDS.tile,
  14: SURFACE_IDS.concrete, 15: SURFACE_IDS.concrete, 16: SURFACE_IDS.dirt,
};

export class VoxelMode {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.grid = null;
    this.sampler = null;
    this.group = null;
    this.materials = null;
    this.chunkMeshes = new Map();       // chunk key -> { opaque, glass, water }
    this.radius = 8;                    // chunks loaded around the player
    this.buildQueue = [];
    this.creative = false;

    this.hotbar = new Array(HOTBAR_SLOTS).fill(null);   // { id, count } or null
    this.selected = 0;
    this.mining = null;                 // { x, y, z, progress, id }
    this.fallTimer = 0;
    this.falling = new Set();           // "x,y,z" of blocks that may drop
    this.dom = null;
    this.highlight = null;
  }

  // --- lifecycle -----------------------------------------------------------

  toggle() {
    if (this.active) this.exit();
    else this.enter();
  }

  enter() {
    if (this.active) return;
    const game = this.game;
    const world = game.world;
    if (!world || !world.ready) {
      game.ui.toast('Not yet', 'The world is still loading.');
      return;
    }
    // Interiors and voxels are both worlds that replace the outdoor one; being
    // in two at once would leave the collision layer pointing at whichever was
    // entered last.
    if (game.interiors && game.interiors.isInside) game.exitInterior();

    const settings = game.ui ? game.ui.settings : null;
    const quality = settings ? settings.graphics.quality : 'high';
    this.radius = RADIUS_BY_QUALITY[quality] || 8;

    const p = game.controller.position;
    this.sampler = new TerrainSampler(world, {
      treeDensity: settings ? settings.graphics.vegetationDensity : 1,
    });
    this.grid = new VoxelGrid(this.sampler);
    this.grid.baseY = Math.floor(world.terrainAt(p.x, p.z)) - FLOOR_BELOW_SPAWN;

    this.group = new THREE.Group();
    this.group.name = 'voxels';
    game.scene.add(this.group);
    this.materials = makeMaterials();

    this.highlight = makeHighlight();
    this.group.add(this.highlight);

    world.setVisible(false);
    world.collisionWorld.useLayer('voxel');
    this.active = true;

    // Build the ground under your feet before handing control back, so you are
    // never standing on nothing for the frame it takes to mesh.
    this.streamChunks(p.x, p.z, Infinity, 2);
    const surface = this.grid.surfaceY(Math.floor(p.x), Math.floor(p.z));
    game.controller.teleport(Math.floor(p.x) + 0.5,
      (surface === null ? p.y : surface + 2.2), Math.floor(p.z) + 0.5);

    this.buildDom();
    if (this.creative) this.fillCreativeHotbar();
    this.refreshDom();
    game.ui.toast('Voxel mode', 'Left click mines, right click places. G for creative, V to leave.');
  }

  exit() {
    if (!this.active) return;
    const game = this.game;
    this.active = false;

    for (const key of [...this.chunkMeshes.keys()]) this.unloadChunk(key);
    this.chunkMeshes.clear();
    if (this.group) {
      game.scene.remove(this.group);
      this.group.clear();
      this.group = null;
    }
    if (this.materials) {
      for (const m of Object.values(this.materials)) m.dispose();
      this.materials = null;
    }
    if (this.highlight) {
      this.highlight.geometry.dispose();
      this.highlight.material.dispose();
      this.highlight = null;
    }
    if (this.dom) { this.dom.root.remove(); this.dom = null; }
    if (this.grid) { this.grid.dispose(); this.grid = null; }
    this.buildQueue.length = 0;
    this.falling.clear();
    this.mining = null;

    game.world.collisionWorld.clear('voxel');
    game.world.collisionWorld.useLayer('world');
    game.world.setVisible(true);

    // Put the player back on the polygon ground, which may sit up to half a
    // block away from where the voxel surface was.
    const p = game.controller.position;
    game.controller.placeAt(p.x, p.z, p.y + 40);
    game.ui.toast('Back to walking', 'The world is itself again.');
  }

  // --- streaming -----------------------------------------------------------

  /**
   * Keep the chunks around the player loaded, meshed and collidable.
   *
   * Generation and meshing are both budgeted per frame: a full chunk column is
   * 40,000 blocks to fill and a few thousand faces to mesh, and doing a ring of
   * them in one frame is a visible stall. Nearest first, so the ground you are
   * about to walk onto arrives before the view at the horizon fills in.
   */
  streamChunks(px, pz, budgetMs = 6, forceRadius = 0) {
    const grid = this.grid;
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    const R = forceRadius || this.radius;

    // Evict first so the memory is back before we ask for more. Walk the
    // grid rather than the meshes: a chunk that meshed to nothing - open sky
    // above a valley - still holds its 40,000 blocks.
    const keep = R + 1;
    for (const [key, c] of [...grid.chunks]) {
      if (Math.abs(c.cx - pcx) > keep || Math.abs(c.cz - pcz) > keep) {
        this.unloadChunk(key);
        grid.chunks.delete(key);
      }
    }

    const wanted = [];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        const key = chunkKey(cx, cz);
        const c = grid.chunks.get(key);
        if (c && c.generated && !c.dirty) continue;
        wanted.push({ cx, cz, key, d: dx * dx + dz * dz });
      }
    }
    wanted.sort((a, b) => a.d - b.d);

    const start = performance.now();
    for (const w of wanted) {
      const chunk = grid.ensure(w.cx, w.cz);
      if (chunk.dirty) this.remeshChunk(chunk);
      if (budgetMs !== Infinity && performance.now() - start > budgetMs) break;
    }
  }

  remeshChunk(chunk) {
    const game = this.game;
    const key = chunk.key;
    this.unloadChunk(key, true);
    chunk.dirty = false;
    if (chunk.empty) return;

    const { opaque, glass, water } = meshChunk(this.grid, chunk);

    const entry = {};
    const addMesh = (buffers, material, castShadow) => {
      if (buffers.isEmpty) return null;
      const mesh = new THREE.Mesh(buffers.geometry(), material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrixWorld(true);
      this.group.add(mesh);
      return mesh;
    };
    entry.opaque = addMesh(opaque, this.materials.opaque, true);
    entry.glass = addMesh(glass, this.materials.glass, false);
    entry.water = addMesh(water, this.materials.water, false);

    // Only what you can stand on goes into the collider: water is walked into,
    // not onto.
    const cw = game.world.collisionWorld;
    if (!opaque.isEmpty) cw.set('vox:' + key, opaque.collider('vox ' + key), 'voxel');
    if (!glass.isEmpty) cw.set('vox:' + key + ':glass', glass.collider('vox glass ' + key), 'voxel');

    this.chunkMeshes.set(key, entry);
  }

  unloadChunk(key, meshesOnly = false) {
    const entry = this.chunkMeshes.get(key);
    if (entry) {
      for (const mesh of [entry.opaque, entry.glass, entry.water]) {
        if (!mesh) continue;
        this.group.remove(mesh);
        mesh.geometry.dispose();
      }
      this.chunkMeshes.delete(key);
    }
    const cw = this.game.world.collisionWorld;
    cw.remove('vox:' + key, 'voxel');
    cw.remove('vox:' + key + ':glass', 'voxel');
    if (!meshesOnly) {
      const c = this.grid && this.grid.chunks.get(key);
      if (c) c.generated = false;
    }
  }

  // --- per-frame -----------------------------------------------------------

  update(dt) {
    if (!this.active) return;
    const game = this.game;
    const c = game.controller;

    this.streamChunks(c.position.x, c.position.z, game.fps < 40 ? 3 : 7);
    this.handleHotbarInput();
    this.updateTargeting(dt);
    this.tickFalling(dt);

    // New polygon chunks stream in behind our back and arrive visible.
    if (game.world.visible) game.world.setVisible(false);
  }

  // --- targeting, mining, placing -----------------------------------------

  /** The block the camera is pointed at, and the empty space in front of it. */
  target() {
    const game = this.game;
    const origin = game.camera.getWorldPosition(new THREE.Vector3());
    const dir = game.camera.getWorldDirection(new THREE.Vector3());
    return raycastVoxels(this.grid, origin, dir, REACH);
  }

  updateTargeting(dt) {
    const game = this.game;
    const input = game.input;
    const hit = this.target();

    if (hit) {
      this.highlight.visible = true;
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      this.highlight.visible = false;
    }

    // Mining is held, not clicked, and the time it takes is the block's
    // hardness - which is what makes stone feel different from dirt.
    if (hit && input.mouseDown(0)) {
      if (!this.mining || this.mining.x !== hit.x || this.mining.y !== hit.y || this.mining.z !== hit.z) {
        this.mining = { x: hit.x, y: hit.y, z: hit.z, progress: 0, id: hit.id };
      }
      const hardness = this.creative ? 0.05 : BLOCKS[hit.id].hardness;
      this.mining.progress += dt / hardness;
      if (this.mining.progress >= 1) {
        this.breakBlock(hit.x, hit.y, hit.z, hit.id);
        this.mining = null;
      }
    } else {
      this.mining = null;
    }
    this.updateHighlightProgress();

    if (input.mouseWasPressed(2) && hit) {
      this.placeBlock(hit);
    }
  }

  breakBlock(x, y, z, id) {
    const touched = this.grid.set(x, y, z, AIR);
    if (!touched.length) return;
    this.collect(BLOCKS[id].drops);
    this.remeshTouched(touched);
    this.wake(x, y, z);
    this.game.audio && this.game.audio.footstep && this.game.audio.footstep(FOOTSTEP[id] ?? 0, 0.5);
  }

  placeBlock(hit) {
    const slot = this.hotbar[this.selected];
    if (!slot || slot.count <= 0) return;
    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    const existing = this.grid.get(x, y, z);
    if (existing !== AIR && !BLOCKS[existing].liquid) return;
    // Never seal yourself inside a block: the capsule would resolve out of it
    // in a random direction, which reads as being flung.
    if (this.intersectsPlayer(x, y, z)) return;

    const touched = this.grid.set(x, y, z, slot.id);
    if (!touched.length) return;
    if (!this.creative) {
      slot.count--;
      if (slot.count <= 0) this.hotbar[this.selected] = null;
    }
    this.remeshTouched(touched);
    this.wake(x, y + 1, z);
    this.wake(x, y, z);
    this.refreshDom();
  }

  intersectsPlayer(x, y, z) {
    const c = this.game.controller;
    const r = (c.radius || 0.35) + 0.02;
    const feet = c.position.y - (c.height || 1.75) * 0.5;
    const head = feet + (c.height || 1.75);
    return x + 1 > c.position.x - r && x < c.position.x + r &&
           z + 1 > c.position.z - r && z < c.position.z + r &&
           y + 1 > feet && y < head;
  }

  remeshTouched(chunks) {
    for (const chunk of chunks) this.remeshChunk(chunk);
  }

  // --- falling blocks ------------------------------------------------------

  /** Mark a column as worth checking for unsupported sand or gravel. */
  wake(x, y, z) {
    for (let i = 0; i < 6; i++) this.falling.add(x + ',' + (y + i) + ',' + z);
  }

  /**
   * Sand and gravel drop when what was holding them up goes away.
   *
   * A block moves one step per tick rather than travelling as an entity: at
   * one-metre blocks the difference is a frame or two, and a discrete step
   * keeps the grid the only source of truth about where anything is.
   */
  tickFalling(dt) {
    if (!this.falling.size) return;
    this.fallTimer += dt;
    if (this.fallTimer < FALL_TICK) return;
    this.fallTimer = 0;

    const pending = [...this.falling];
    this.falling.clear();
    const touched = new Set();

    // Lowest first, so a column of sand collapses from the bottom instead of
    // each grain trying to move into the one below it.
    pending.sort((a, b) => +a.split(',')[1] - +b.split(',')[1]);

    for (const key of pending) {
      const p = key.split(',');
      const x = +p[0], y = +p[1], z = +p[2];
      const id = this.grid.get(x, y, z);
      if (id === AIR || !BLOCKS[id].falls) continue;
      const below = this.grid.get(x, y - 1, z);
      if (below !== AIR && !BLOCKS[below].liquid) continue;

      for (const t of this.grid.set(x, y, z, AIR)) touched.add(t);
      for (const t of this.grid.set(x, y - 1, z, id)) touched.add(t);
      // It may still have further to fall, and whatever was resting on it now
      // has nothing underneath.
      this.falling.add(x + ',' + (y - 1) + ',' + z);
      this.falling.add(x + ',' + (y + 1) + ',' + z);
    }
    for (const chunk of touched) this.remeshChunk(chunk);
  }

  // --- inventory -----------------------------------------------------------

  collect(id) {
    if (id === AIR) return;
    for (const slot of this.hotbar) {
      if (slot && slot.id === id && slot.count < 999) { slot.count++; this.refreshDom(); return; }
    }
    const free = this.hotbar.indexOf(null);
    if (free === -1) return;                       // hotbar full; the block is lost
    this.hotbar[free] = { id, count: 1 };
    this.refreshDom();
  }

  fillCreativeHotbar() {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      this.hotbar[i] = { id: PALETTE[i % PALETTE.length], count: 999 };
    }
  }

  handleHotbarInput() {
    const input = this.game.input;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      if (input.pressedThisFrame.has('Digit' + (i + 1))) { this.selected = i; this.refreshDom(); }
    }
    if (input.wheel) {
      this.selected = (this.selected + input.wheel + HOTBAR_SLOTS) % HOTBAR_SLOTS;
      this.refreshDom();
    }
    if (input.pressedThisFrame.has('KeyG')) {
      this.creative = !this.creative;
      if (this.creative) this.fillCreativeHotbar();
      this.game.ui.toast(this.creative ? 'Creative' : 'Survival',
        this.creative ? 'Every block, unlimited.' : 'You keep what you dig.');
      this.refreshDom();
    }
  }

  // --- the bar along the bottom -------------------------------------------

  buildDom() {
    const root = document.createElement('div');
    root.id = 'voxel-hud';
    root.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
      'display:flex', 'gap:4px', 'padding:4px', 'border-radius:6px',
      'background:rgba(12,14,18,0.55)', 'z-index:40', 'pointer-events:none',
      'font:11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace', 'color:#e8e6e0',
    ].join(';');

    const slots = [];
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const cell = document.createElement('div');
      cell.style.cssText = [
        'position:relative', 'width:46px', 'height:46px', 'border-radius:4px',
        'border:2px solid rgba(255,255,255,0.18)', 'background:rgba(0,0,0,0.35)',
        'display:flex', 'align-items:flex-end', 'justify-content:center',
      ].join(';');
      const swatch = document.createElement('div');
      swatch.style.cssText = 'position:absolute;inset:6px;border-radius:2px;image-rendering:pixelated';
      const count = document.createElement('span');
      count.style.cssText = 'position:relative;padding:0 3px;text-shadow:0 1px 2px #000';
      cell.append(swatch, count);
      root.append(cell);
      slots.push({ cell, swatch, count });
    }
    document.body.append(root);
    this.dom = { root, slots };
  }

  refreshDom() {
    if (!this.dom) return;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const { cell, swatch, count } = this.dom.slots[i];
      const slot = this.hotbar[i];
      cell.style.borderColor = i === this.selected ? '#e8c46a' : 'rgba(255,255,255,0.18)';
      if (!slot) {
        swatch.style.background = 'transparent';
        count.textContent = '';
        cell.title = '';
      } else {
        swatch.style.background = swatchFor(slot.id);
        count.textContent = this.creative ? '' : String(slot.count);
        cell.title = BLOCKS[slot.id].name;
      }
    }
  }

  updateHighlightProgress() {
    if (!this.highlight) return;
    const p = this.mining ? Math.min(1, this.mining.progress) : 0;
    // The outline tightens and brightens as the block gives way, which is the
    // only feedback there is that holding the button is doing something.
    this.highlight.material.opacity = 0.35 + p * 0.5;
    const s = 1.002 - p * 0.12;
    this.highlight.scale.set(s, s, s);
  }

  /** Footstep surface for the block under the player. */
  surfaceUnderfoot() {
    if (!this.active || !this.grid) return null;
    const c = this.game.controller;
    const y = Math.floor(c.position.y - (c.height || 1.75) * 0.5 - 0.2);
    const id = this.grid.get(Math.floor(c.position.x), y, Math.floor(c.position.z));
    return id === AIR ? null : (FOOTSTEP[id] ?? SURFACE_IDS.dirt);
  }

  get stats() {
    return {
      chunks: this.chunkMeshes.size,
      blocks: this.grid ? this.grid.chunks.size * CHUNK * CHUNK * HEIGHT : 0,
      edits: this.grid ? this.grid.edits.size : 0,
      creative: this.creative,
    };
  }
}

// --- helpers ---------------------------------------------------------------

function makeMaterials() {
  const map = blockAtlas();
  const opaque = new THREE.MeshStandardMaterial({
    map,
    // The geometry does carry a colour attribute here - it is the baked ambient
    // occlusion - so this flag is doing real work, unlike the foliage case.
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  const glass = new THREE.MeshStandardMaterial({
    map, vertexColors: true, transparent: true, opacity: 0.55,
    roughness: 0.1, metalness: 0, side: THREE.DoubleSide, depthWrite: false,
  });
  const water = new THREE.MeshStandardMaterial({
    map, vertexColors: true, transparent: true, opacity: 0.72,
    roughness: 0.15, metalness: 0.05, side: THREE.DoubleSide, depthWrite: false,
  });
  return { opaque, glass, water };
}

function makeHighlight() {
  const geo = new THREE.BoxGeometry(1.002, 1.002, 1.002);
  const edges = new THREE.EdgesGeometry(geo);
  geo.dispose();
  const mat = new THREE.LineBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.4, depthTest: true,
  });
  const box = new THREE.LineSegments(edges, mat);
  box.visible = false;
  box.matrixAutoUpdate = true;
  return box;
}

/** A flat colour standing in for a block in the hotbar. */
const SWATCH = {
  1: '#8a8a8a', 2: '#7a5a3c', 3: '#6aa03c', 4: '#dcd0a0', 5: '#8d8880',
  6: '#f2f6fa', 7: '#6d5334', 8: '#3f6b2a', 9: '#b08a55', 10: '#6f6f6f',
  11: '#96604d', 12: 'rgba(210,232,244,0.5)', 13: '#306896',
  14: '#b9b7b0', 15: '#3f4145', 16: '#9aa0ab',
};
function swatchFor(id) { return SWATCH[id] || '#a0a0a0'; }

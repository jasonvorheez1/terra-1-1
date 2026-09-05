// Voxel mode: the same Earth, as blocks you can take apart and build with.
//
// This is a second world laid over the first rather than a separate game. The
// terrain comes from the elevation tiles the walking world already sampled, so
// the hill you were standing on is the hill you dig into; the character
// controller, the sky, the weather and the audio are all the ones you were
// already using. What changes is what the ground is made of, that you can pick
// it up, and that what you pick up can be made into something else.

import * as THREE from 'three';
import { settings } from '../core/settings.js';
import { AIR, BLOCKS, PALETTE, blockAtlas } from './blocks.js';
import { CHUNK, FLOOR_BELOW_SPAWN, VoxelGrid, chunkKey } from './grid.js';
import { meshChunk } from './mesher.js';
import { TerrainSampler } from './sampler.js';
import { raycastVoxels } from './raycast.js';
import { Inventory, HOTBAR, SLOTS } from './inventory.js';
import {
  ITEMS, blockItem, digSpeed, dropFor, itemColour, itemName, maxDurability,
} from './items.js';
import { RECIPES, canCraft, craft } from './crafting.js';

const REACH = 5.5;                 // metres you can reach to break or place
const FALL_TICK = 0.12;            // seconds between steps of falling sand
const STATION_RANGE = 5;           // how close a bench has to be to count

/**
 * Chunks loaded around the player, by graphics quality.
 *
 * Sixteen metres a chunk, so ten is a 160 m view - short next to the walking
 * world's 1.4 km, but a blocky world spends its triangles at the near end
 * rather than the far one, and a fully streamed radius of ten is already
 * 1.5 million of them.
 */
const RADIUS_BY_QUALITY = { potato: 5, low: 6, medium: 8, high: 10, ultra: 12 };

export class VoxelMode {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.grid = null;
    this.sampler = null;
    this.group = null;
    this.materials = null;
    this.chunkMeshes = new Map();       // chunk key -> { opaque, glass, water }
    this.radius = 8;
    this.creative = false;

    this.inventory = new Inventory();
    this.mining = null;                 // { x, y, z, progress, id }
    this.fallTimer = 0;
    this.falling = new Set();           // "x,y,z" of blocks that may drop
    this.lastShot = 0;
    this.stations = new Set();
    this.stationTimer = 0;
    this.craftOpen = false;
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
    // Interiors and voxels both replace the outdoor world; being in two at once
    // would leave the collision layer pointing at whichever was entered last.
    if (game.interiors && game.interiors.isInside) game.exitInterior();

    this.radius = RADIUS_BY_QUALITY[settings.graphics.quality] || 8;

    const p = game.controller.position;
    this.sampler = new TerrainSampler(world, {
      treeDensity: settings.graphics.vegetationDensity,
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
    const surface = this.grid.surfaceY(Math.floor(p.x), Math.floor(p.z), { standable: true });
    game.controller.teleport(Math.floor(p.x) + 0.5,
      (surface === null ? p.y : surface + 2.2), Math.floor(p.z) + 0.5);

    this.buildDom();
    if (this.creative) this.fillCreative();
    this.refreshDom();
    game.ui.toast('Voxel mode',
      'Punch a tree, then press Tab to craft. Left click digs, right click builds.');
  }

  exit() {
    if (!this.active) return;
    const game = this.game;
    this.active = false;
    if (this.craftOpen) this.closeCraft();

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
    this.falling.clear();
    this.mining = null;

    game.world.collisionWorld.clear('voxel');
    game.world.collisionWorld.useLayer('world');
    game.world.setVisible(true);

    // Put the player back on the polygon ground, which may sit up to half a
    // block from where the voxel surface was.
    const p = game.controller.position;
    game.controller.placeAt(p.x, p.z, p.y + 40);
    game.ui.toast('Back to walking', 'The world is itself again.');
  }

  // --- streaming -----------------------------------------------------------

  /**
   * Keep the chunks around the player loaded, meshed and collidable.
   *
   * Generation and meshing are both budgeted per frame: a chunk column is
   * 40,000 blocks to fill and a few thousand faces to mesh, and doing a ring of
   * them in one frame is a visible stall. Nearest first, so the ground you are
   * about to walk onto arrives before the horizon fills in.
   */
  streamChunks(px, pz, budgetMs = 6, forceRadius = 0) {
    const grid = this.grid;
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    const R = forceRadius || this.radius;

    // Evict first so the memory is back before we ask for more. Walk the grid
    // rather than the meshes: a chunk that meshed to nothing - open sky above a
    // valley - still holds its 40,000 blocks.
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
        const c = grid.chunks.get(chunkKey(cx, cz));
        if (c && c.generated && !c.dirty) continue;
        wanted.push({ cx, cz, d: dx * dx + dz * dz });
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
    const cw = this.game.world.collisionWorld;
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
    this.handleKeys();
    if (this.craftOpen) {
      this.highlight.visible = false;
      this.mining = null;
    } else {
      this.updateTargeting(dt);
    }
    this.tickFalling(dt);
    this.tickStations(dt);

    // New polygon chunks stream in behind our back and arrive visible.
    if (game.world.visible) game.world.setVisible(false);
  }

  /**
   * Which crafting stations are within reach, checked a few times a second.
   *
   * Standing near a bench is what unlocks most of the recipe list, so this has
   * to be live rather than checked when the menu opens - walking up to a
   * furnace with the menu already open should light the smelting recipes up.
   */
  tickStations(dt) {
    this.stationTimer -= dt;
    if (this.stationTimer > 0) return;
    this.stationTimer = 0.25;
    const p = this.game.controller.position;
    const found = new Set();
    const px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
    for (let y = -3; y <= 3; y++) {
      for (let z = -STATION_RANGE; z <= STATION_RANGE; z++) {
        for (let x = -STATION_RANGE; x <= STATION_RANGE; x++) {
          const b = BLOCKS[this.grid.get(px + x, py + y, pz + z)];
          if (b && b.station) found.add(b.station);
        }
      }
    }
    const changed = found.size !== this.stations.size ||
      [...found].some((s) => !this.stations.has(s));
    this.stations = found;
    if (changed) {
      this.refreshDom();
      if (this.craftOpen) this.refreshCraft();
    }
  }

  // --- targeting, mining, placing -----------------------------------------

  /** The block the camera is pointed at. */
  target(range = REACH) {
    const game = this.game;
    const origin = game.camera.getWorldPosition(new THREE.Vector3());
    const dir = game.camera.getWorldDirection(new THREE.Vector3());
    return raycastVoxels(this.grid, origin, dir, range);
  }

  updateTargeting(dt) {
    const input = this.game.input;
    const held = this.inventory.heldId;
    const heldItem = held ? ITEMS[held] : null;
    const hit = this.target();

    if (hit) {
      this.highlight.visible = true;
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    } else {
      this.highlight.visible = false;
    }

    // A gun does not mine. Holding one turns the left button into a trigger.
    if (heldItem && heldItem.gun) {
      if (input.mouseDown(0)) this.fireGun(heldItem);
      this.mining = null;
      this.updateHighlightProgress();
      return;
    }

    // Mining is held rather than clicked, and how long it takes is the block's
    // hardness divided by what is in your hand - which is what makes a better
    // pickaxe feel like progress rather than a number going up.
    if (hit && input.mouseDown(0)) {
      const block = BLOCKS[hit.id];
      if (!this.mining || this.mining.x !== hit.x || this.mining.y !== hit.y || this.mining.z !== hit.z) {
        this.mining = { x: hit.x, y: hit.y, z: hit.z, progress: 0, id: hit.id };
      }
      const rate = this.creative ? 20 : digSpeed(block, held);
      this.mining.progress += (dt * rate) / Math.max(0.05, block.hardness);
      if (this.mining.progress >= 1) {
        const area = heldItem && heldItem.melee && heldItem.melee.area ? heldItem.melee.area : 0;
        if (area) this.breakArea(hit, area);
        else this.breakBlock(hit.x, hit.y, hit.z, hit.id);
        this.mining = null;
      }
    } else {
      this.mining = null;
    }
    this.updateHighlightProgress();

    if (input.mouseWasPressed(2) && hit) {
      if (heldItem && heldItem.wand) this.useWand(hit, heldItem);
      else this.placeBlock(hit);
    }
  }

  /**
   * Take one block out of the world and give the player whatever it yields.
   *
   * What it yields depends on what it was hit with: ore needs a pickaxe of at
   * least its tier, or the rock breaks and leaves nothing behind. That is the
   * rule that sends you back for iron before you go looking for gold.
   */
  breakBlock(x, y, z, id) {
    const block = BLOCKS[id];
    const touched = this.grid.set(x, y, z, AIR);
    if (!touched.length) return false;

    if (!this.creative) {
      const drop = dropFor(block, this.inventory.heldId);
      if (drop) this.inventory.add(drop, 1);
      if (this.inventory.wearHeld(1)) this.game.ui.toast('Broken', 'Your tool gave out.');
    }
    this.remeshTouched(touched);
    this.wake(x, y, z);
    this.refreshDom();
    return true;
  }

  /** The sledgehammer: a three-by-three bite out of the face you are hitting. */
  breakArea(hit, radius) {
    const touched = new Set();
    // Work in the plane of the face, so hitting a wall takes a square out of
    // the wall rather than a cube out of the room behind it.
    for (let a = -radius; a <= radius; a++) {
      for (let b = -radius; b <= radius; b++) {
        let dx = 0, dy = 0, dz = 0;
        if (hit.nx) { dy = a; dz = b; }
        else if (hit.ny) { dx = a; dz = b; }
        else { dx = a; dy = b; }
        const x = hit.x + dx, y = hit.y + dy, z = hit.z + dz;
        const id = this.grid.get(x, y, z);
        if (id === AIR || BLOCKS[id].liquid) continue;
        const block = BLOCKS[id];
        for (const t of this.grid.set(x, y, z, AIR)) touched.add(t);
        if (!this.creative) {
          const drop = dropFor(block, this.inventory.heldId);
          if (drop) this.inventory.add(drop, 1);
        }
        this.wake(x, y, z);
      }
    }
    if (!this.creative) this.inventory.wearHeld(2);
    for (const t of touched) this.remeshChunk(t);
    this.refreshDom();
  }

  placeBlock(hit) {
    const slot = this.inventory.held;
    if (!slot) return;
    const def = ITEMS[slot.id];
    if (!def || !def.block) return;
    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    if (!this.canPlaceAt(x, y, z)) return;
    const touched = this.grid.set(x, y, z, def.block);
    if (!touched.length) return;
    if (!this.creative) this.inventory.consumeHeld(1);
    this.remeshTouched(touched);
    this.wake(x, y + 1, z);
    this.wake(x, y, z);
    this.refreshDom();
  }

  canPlaceAt(x, y, z) {
    const existing = this.grid.get(x, y, z);
    if (existing !== AIR && !BLOCKS[existing].liquid) return false;
    // Never seal yourself inside a block: the capsule would resolve out of it
    // in whatever direction it found first, which reads as being flung.
    return !this.intersectsPlayer(x, y, z);
  }

  /**
   * The builder's wand: extend the surface you are pointing at.
   *
   * It copies whatever it is aimed at rather than whatever you are holding, so
   * pointing at a stone wall and clicking makes more stone wall. The blocks
   * still come out of your inventory - a wand is a way of laying blocks you
   * already have quickly, not a way of getting blocks you do not.
   */
  useWand(hit, wandItem) {
    const sourceId = hit.id;
    const itemId = blockItem(sourceId);
    const have = this.creative ? wandItem.wand.max : this.inventory.count(itemId);
    if (!have) {
      this.game.ui.toast('Nothing to extend with',
        'You are not carrying any ' + BLOCKS[sourceId].name.toLowerCase() + '.');
      return;
    }

    // Walk outward across the face, collecting the empty cell in front of every
    // matching block, breadth first so the extension grows evenly rather than
    // shooting off in one direction.
    const budget = Math.min(wandItem.wand.max, have);
    const seen = new Set([hit.x + ',' + hit.y + ',' + hit.z]);
    const queue = [[hit.x, hit.y, hit.z]];
    const targets = [];
    while (queue.length && targets.length < budget) {
      const cell = queue.shift();
      const cx = cell[0], cy = cell[1], cz = cell[2];
      if (this.grid.get(cx, cy, cz) !== sourceId) continue;
      const tx = cx + hit.nx, ty = cy + hit.ny, tz = cz + hit.nz;
      if (this.canPlaceAt(tx, ty, tz)) targets.push([tx, ty, tz]);
      for (const n of NEIGHBOURS) {
        // Stay in the plane of the face.
        if (hit.nx && n[0]) continue;
        if (hit.ny && n[1]) continue;
        if (hit.nz && n[2]) continue;
        const nx = cx + n[0], ny = cy + n[1], nz = cz + n[2];
        const key = nx + ',' + ny + ',' + nz;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push([nx, ny, nz]);
      }
    }
    if (!targets.length) return;

    const touched = new Set();
    let placed = 0;
    for (const t of targets) {
      if (!this.creative && !this.inventory.remove(itemId, 1)) break;
      for (const c of this.grid.set(t[0], t[1], t[2], sourceId)) touched.add(c);
      placed++;
    }
    if (!this.creative && placed) this.inventory.wearHeld(1);
    for (const c of touched) this.remeshChunk(c);
    this.refreshDom();
  }

  // --- guns ----------------------------------------------------------------

  /**
   * Fire whatever is in hand.
   *
   * Hitscan, and what it hits is the world: a round takes a bite out of the
   * blocks it lands in. Nothing lives here, so a gun is a demolition tool with
   * recoil, and the rubble is destroyed rather than collected - it is a fast
   * way through a hillside, not a fast way to fill your pockets.
   */
  fireGun(itemDef) {
    const spec = itemDef.gun;
    const now = performance.now();
    if (now - this.lastShot < 60000 / spec.rpm) return;
    if (!this.creative && !this.inventory.remove(spec.ammo, 1)) {
      if (now - this.lastShot > 500) {
        this.lastShot = now;
        this.game.ui.toast('Empty', 'No ' + itemName(spec.ammo).toLowerCase() + ' left.');
      }
      return;
    }
    this.lastShot = now;

    const game = this.game;
    const origin = game.camera.getWorldPosition(new THREE.Vector3());
    const base = game.camera.getWorldDirection(new THREE.Vector3());
    const touched = new Set();
    const dir = new THREE.Vector3();
    for (let i = 0; i < spec.pellets; i++) {
      dir.copy(base);
      dir.x += (Math.random() - 0.5) * spec.spread * 2;
      dir.y += (Math.random() - 0.5) * spec.spread * 2;
      dir.z += (Math.random() - 0.5) * spec.spread * 2;
      dir.normalize();
      const hit = raycastVoxels(this.grid, origin, dir, spec.range);
      if (hit) this.blastAt(hit.x, hit.y, hit.z, spec.dig, touched);
    }
    for (const t of touched) this.remeshChunk(t);

    // Recoil and a flash on the crosshair. There is no view model to animate,
    // so the kick is the whole of the feedback that the thing went off.
    game.controller.pitch = Math.min(Math.PI / 2 - 0.02,
      game.controller.pitch + spec.recoil * (0.7 + Math.random() * 0.6));
    this.flash(spec.recoil);
    this.refreshDom();
  }

  /** Remove every block within `radius` of one, whatever it was made of. */
  blastAt(x, y, z, radius, touched) {
    const r = Math.floor(radius);
    const r2 = radius * radius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const bx = x + dx, by = y + dy, bz = z + dz;
          const id = this.grid.get(bx, by, bz);
          if (id === AIR || BLOCKS[id].liquid) continue;
          for (const t of this.grid.set(bx, by, bz, AIR)) touched.add(t);
          this.wake(bx, by, bz);
        }
      }
    }
  }

  flash(strength) {
    if (!this.dom) return;
    this.dom.flash.style.opacity = String(Math.min(1, 0.35 + strength * 4));
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => {
      if (this.dom) this.dom.flash.style.opacity = '0';
    }, 55);
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
   * keeps the grid the only thing that knows where anything is.
   */
  tickFalling(dt) {
    if (!this.falling.size) return;
    this.fallTimer += dt;
    if (this.fallTimer < FALL_TICK) return;
    this.fallTimer = 0;

    const pending = [...this.falling];
    this.falling.clear();
    const touched = new Set();

    // Lowest first, so a column of sand collapses from the bottom rather than
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
      this.falling.add(x + ',' + (y - 1) + ',' + z);
      this.falling.add(x + ',' + (y + 1) + ',' + z);
    }
    for (const chunk of touched) this.remeshChunk(chunk);
  }

  // --- keys ----------------------------------------------------------------

  handleKeys() {
    const input = this.game.input;
    const inv = this.inventory;

    for (let i = 0; i < HOTBAR; i++) {
      if (input.pressedThisFrame.has('Digit' + (i + 1))) {
        inv.selected = i;
        this.refreshDom();
      }
    }
    if (input.wheel && !this.craftOpen) {
      inv.selected = (inv.selected + input.wheel + HOTBAR) % HOTBAR;
      this.refreshDom();
    }
    if (input.wasPressed('craft')) {
      if (this.craftOpen) this.closeCraft();
      else this.openCraft();
    }
    if (input.wasPressed('creative')) {
      this.creative = !this.creative;
      if (this.creative) this.fillCreative();
      this.game.ui.toast(this.creative ? 'Creative' : 'Survival',
        this.creative ? 'Every block, nothing wears out.' : 'You keep what you dig.');
      this.refreshDom();
      if (this.craftOpen) this.refreshCraft();
    }
  }

  fillCreative() {
    for (let i = 0; i < HOTBAR; i++) {
      this.inventory.slots[i] = { id: blockItem(PALETTE[i % PALETTE.length]), count: 999, wear: 0 };
    }
  }

  // --- the bar along the bottom -------------------------------------------

  buildDom() {
    const root = document.createElement('div');
    root.id = 'voxel-hud';
    root.style.cssText = css({
      position: 'fixed', inset: '0', 'z-index': '40', 'pointer-events': 'none',
      font: '11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace', color: '#e8e6e0',
    });

    // Muzzle flash: a wash over the middle of the screen, which is as much of a
    // gun as a world with no view model can show you.
    const flash = document.createElement('div');
    flash.style.cssText = css({
      position: 'absolute', left: '50%', top: '50%', width: '340px', height: '340px',
      transform: 'translate(-50%,-50%)', 'border-radius': '50%', opacity: '0',
      background: 'radial-gradient(circle,rgba(255,226,150,0.55),rgba(255,180,60,0) 62%)',
      transition: 'opacity 60ms linear',
    });

    const bar = document.createElement('div');
    bar.style.cssText = css({
      position: 'absolute', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
      display: 'flex', gap: '4px', padding: '4px', 'border-radius': '6px',
      background: 'rgba(12,14,18,0.55)',
    });
    const slots = [];
    for (let i = 0; i < HOTBAR; i++) slots.push(makeSlot(bar, 46));

    const readout = document.createElement('div');
    readout.style.cssText = css({
      position: 'absolute', left: '50%', bottom: '74px', transform: 'translateX(-50%)',
      padding: '2px 8px', 'border-radius': '4px', background: 'rgba(12,14,18,0.5)',
      'text-shadow': '0 1px 2px #000', 'white-space': 'nowrap',
    });

    root.append(flash, bar, readout);
    document.body.append(root);
    this.dom = { root, bar, slots, readout, flash, craft: null };
  }

  refreshDom() {
    if (!this.dom) return;
    const inv = this.inventory;
    for (let i = 0; i < HOTBAR; i++) {
      paintSlot(this.dom.slots[i], inv.slots[i], i === inv.selected, this.creative);
    }

    // One line saying what is in your hand and what it needs, which saves a
    // trip into the menu to discover you are out of shells.
    const held = inv.held;
    let text = '';
    if (held) {
      const def = ITEMS[held.id];
      text = itemName(held.id);
      if (def && def.gun) {
        text += '  ·  ' + inv.count(def.gun.ammo) + ' ' + itemName(def.gun.ammo).toLowerCase();
      } else if (def && def.tool) {
        text += '  ·  ' + def.tool;
      }
      const max = maxDurability(held.id);
      if (max && !this.creative) {
        text += '  ·  ' + Math.max(0, max - (held.wear || 0)) + '/' + max;
      }
    }
    if (this.stations.size) {
      text += (text ? '     ' : '') + [...this.stations].join(' + ') + ' in reach';
    }
    this.dom.readout.textContent = text;
  }

  updateHighlightProgress() {
    if (!this.highlight) return;
    const p = this.mining ? Math.min(1, this.mining.progress) : 0;
    // The outline tightens and brightens as the block gives way, which is the
    // only sign that holding the button is doing anything.
    this.highlight.material.opacity = 0.35 + p * 0.5;
    const s = 1.002 - p * 0.12;
    this.highlight.scale.set(s, s, s);
  }

  // --- crafting screen -----------------------------------------------------

  openCraft() {
    if (this.craftOpen || !this.dom) return;
    this.craftOpen = true;
    this.game.input.exitPointerLock();
    const panel = buildCraftPanel();
    this.dom.root.append(panel.root);
    this.dom.craft = panel;
    panel.close.addEventListener('click', () => this.closeCraft());
    this.refreshCraft();
  }

  closeCraft() {
    this.craftOpen = false;
    if (this.dom && this.dom.craft) {
      this.dom.craft.root.remove();
      this.dom.craft = null;
    }
    if (this.active) this.game.input.requestPointerLock();
  }

  refreshCraft() {
    const panel = this.dom && this.dom.craft;
    if (!panel) return;
    const inv = this.inventory;
    const have = inv.tally();

    panel.grid.innerHTML = '';
    for (let i = 0; i < SLOTS; i++) {
      const cell = makeSlot(panel.grid, 38);
      paintSlot(cell, inv.slots[i], i === inv.selected && i < HOTBAR, this.creative);
      if (i === HOTBAR - 1) {
        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex-basis:100%;height:10px';
        panel.grid.append(spacer);
      }
    }

    // A station you are not standing at greys the recipe out but still shows
    // it, because knowing a furnace would let you smelt this is the thing that
    // makes you go and build one.
    panel.list.innerHTML = '';
    const stations = this.creative ? new Set(['bench', 'furnace']) : this.stations;
    for (const recipe of RECIPES) {
      const ok = canCraft(recipe, have, stations);
      const row = document.createElement('button');
      row.style.cssText = css({
        display: 'flex', 'align-items': 'flex-start', gap: '8px', width: '100%',
        padding: '5px 7px', margin: '0 0 3px', 'border-radius': '4px',
        border: '1px solid ' + (ok ? 'rgba(232,196,106,0.55)' : 'rgba(255,255,255,0.10)'),
        background: ok ? 'rgba(232,196,106,0.10)' : 'rgba(255,255,255,0.03)',
        color: ok ? '#f2ead6' : '#8d8b86', font: 'inherit', 'text-align': 'left',
        cursor: ok ? 'pointer' : 'default',
      });

      const chip = document.createElement('span');
      chip.style.cssText = css({
        width: '16px', height: '16px', 'border-radius': '3px', flex: '0 0 auto',
        'margin-top': '2px', background: itemColour(recipe.out),
        border: '1px solid rgba(0,0,0,0.4)',
      });

      const label = document.createElement('span');
      label.style.cssText = 'flex:1 1 auto';
      const times = recipe.count > 1 ? ' ×' + recipe.count : '';
      const needText = recipe.needs
        .map((n) => itemName(n[0]) + ' ' + Math.min(have[n[0]] || 0, n[1]) + '/' + n[1])
        .join(',  ');
      const wants = recipe.station && !stations.has(recipe.station)
        ? ' — needs a ' + recipe.station : '';
      label.append(strong(itemName(recipe.out) + times), text(wants), br(),
        dim(needText), recipe.note ? dim('  ·  ' + recipe.note) : text(''));

      row.append(chip, label);
      if (ok) {
        row.addEventListener('click', () => {
          craft(recipe, this.inventory);
          this.refreshCraft();
          this.refreshDom();
        });
      }
      panel.list.append(row);
    }

    panel.hint.textContent = this.creative
      ? 'Creative: every station counts as in reach.'
      : (this.stations.size
        ? 'In reach: ' + [...this.stations].join(', ')
        : 'Stand next to a workbench or furnace to unlock the rest.');
  }

  /** Footstep surface for the block under the player. */
  surfaceUnderfoot() {
    if (!this.active || !this.grid) return null;
    const c = this.game.controller;
    const y = Math.floor(c.position.y - (c.height || 1.75) * 0.5 - 0.2);
    const id = this.grid.get(Math.floor(c.position.x), y, Math.floor(c.position.z));
    return id === AIR ? null : BLOCKS[id].footstep;
  }

  get stats() {
    return {
      chunks: this.chunkMeshes.size,
      edits: this.grid ? this.grid.edits.size : 0,
      creative: this.creative,
      stations: [...this.stations],
    };
  }
}

// --- helpers ---------------------------------------------------------------

const NEIGHBOURS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

function css(obj) {
  return Object.keys(obj).map((k) => k + ':' + obj[k]).join(';');
}

function text(s) { return document.createTextNode(s); }
function br() { return document.createElement('br'); }
function strong(s) {
  const el = document.createElement('b');
  el.textContent = s;
  return el;
}
function dim(s) {
  const el = document.createElement('span');
  el.style.opacity = '0.62';
  el.textContent = s;
  return el;
}

function makeSlot(parent, size) {
  const cell = document.createElement('div');
  cell.style.cssText = css({
    position: 'relative', width: size + 'px', height: size + 'px', 'border-radius': '4px',
    border: '2px solid rgba(255,255,255,0.18)', background: 'rgba(0,0,0,0.35)',
    display: 'flex', 'align-items': 'flex-end', 'justify-content': 'center',
    'box-sizing': 'border-box', flex: '0 0 auto',
  });
  const swatch = document.createElement('div');
  swatch.style.cssText = 'position:absolute;inset:5px;border-radius:2px';
  const count = document.createElement('span');
  count.style.cssText = 'position:relative;padding:0 3px;text-shadow:0 1px 2px #000';
  const wear = document.createElement('div');
  wear.style.cssText = css({
    position: 'absolute', left: '4px', right: '4px', bottom: '3px', height: '3px',
    'border-radius': '2px', background: 'rgba(0,0,0,0.55)', display: 'none',
  });
  const wearFill = document.createElement('div');
  wearFill.style.cssText = 'height:100%;border-radius:2px;background:#7ec46a';
  wear.append(wearFill);
  cell.append(swatch, count, wear);
  parent.append(cell);
  return { cell, swatch, count, wear, wearFill };
}

function paintSlot(slot, entry, selected, creative) {
  slot.cell.style.borderColor = selected ? '#e8c46a' : 'rgba(255,255,255,0.18)';
  if (!entry) {
    slot.swatch.style.background = 'transparent';
    slot.count.textContent = '';
    slot.wear.style.display = 'none';
    slot.cell.title = '';
    return;
  }
  slot.swatch.style.background = itemColour(entry.id);
  slot.count.textContent = entry.count > 1 ? String(entry.count) : '';
  slot.cell.title = itemName(entry.id);
  const max = maxDurability(entry.id);
  if (max && !creative) {
    const left = Math.max(0, 1 - (entry.wear || 0) / max);
    slot.wear.style.display = 'block';
    slot.wearFill.style.width = (left * 100).toFixed(0) + '%';
    slot.wearFill.style.background = left > 0.5 ? '#7ec46a' : (left > 0.2 ? '#e0c05a' : '#d4685a');
  } else {
    slot.wear.style.display = 'none';
  }
}

function buildCraftPanel() {
  const root = document.createElement('div');
  root.style.cssText = css({
    position: 'absolute', inset: '0', display: 'flex', 'align-items': 'center',
    'justify-content': 'center', background: 'rgba(6,8,12,0.72)',
    'pointer-events': 'auto',
  });

  const panel = document.createElement('div');
  panel.style.cssText = css({
    display: 'flex', gap: '18px', padding: '16px', 'border-radius': '10px',
    background: '#14171d', border: '1px solid rgba(255,255,255,0.10)',
    'box-shadow': '0 18px 60px rgba(0,0,0,0.6)', 'max-height': '82vh',
  });

  const left = document.createElement('div');
  const title = document.createElement('div');
  title.textContent = 'Carrying';
  title.style.cssText = 'margin:0 0 8px;opacity:.7;letter-spacing:.08em;text-transform:uppercase';
  const grid = document.createElement('div');
  grid.style.cssText = css({ display: 'flex', 'flex-wrap': 'wrap', gap: '4px', width: '390px' });
  const hint = document.createElement('div');
  hint.style.cssText = 'margin:10px 0 0;opacity:.6;max-width:390px';
  left.append(title, grid, hint);

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;flex-direction:column;width:360px;max-height:74vh';
  const rTitle = document.createElement('div');
  rTitle.textContent = 'Craft';
  rTitle.style.cssText = 'margin:0 0 8px;opacity:.7;letter-spacing:.08em;text-transform:uppercase';
  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;padding-right:4px;flex:1 1 auto';
  const close = document.createElement('button');
  close.textContent = 'Close  (Tab)';
  close.style.cssText = css({
    'margin-top': '10px', padding: '7px', 'border-radius': '5px', cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.06)',
    color: '#e8e6e0', font: 'inherit',
  });
  right.append(rTitle, list, close);

  panel.append(left, right);
  root.append(panel);
  return { root, grid, list, hint, close };
}

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
  return box;
}

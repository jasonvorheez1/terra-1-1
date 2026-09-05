// Terra Ambulate — entry point.
//
// Owns the renderer, the frame loop and the state machine that moves between
// the title screen, loading, walking and paused. Everything else lives in its
// own module; this file is the wiring.

import * as THREE from 'three';
import { settings } from './core/settings.js';
import { Input } from './core/input.js';
import { UI } from './ui/ui.js';
import { World, CHUNK_SIZE } from './world/world.js';
import { MaterialLibrary } from './gfx/materials.js';
import { SkySystem } from './gfx/sky.js';
import { WeatherSystem, plausibleWeather } from './gfx/weather.js';
import { CharacterController } from './physics/controller.js';
import { SURFACE_NAMES } from './physics/collider.js';
import { InteriorManager } from './interior/interior.js';
import { AudioEngine } from './audio/audio.js';
import { starfieldTexture } from './gfx/textures.js';
import { fetchCached, decodeImage, netStats } from './geo/net.js';
import { reverseGeocode } from './geo/nominatim.js';
import { formatLatLon, formatDistance, clamp, lerp, damp, DEG, RAD } from './core/util.js';
import { elevation } from './geo/elevation.js';
import { ndvi } from './geo/nasa.js';
import { VoxelMode } from './voxel/mode.js';

const FIXED_STEP = 1 / 90;          // physics tick
const MAX_SUBSTEPS = 6;

// Wind. A full bar is about eleven seconds of flat-out running, which is short
// enough to be a decision and long enough to cross a street; getting it all
// back from empty takes seventeen seconds standing still, half again as long
// if you walk it off.
const STAMINA_DRAIN = 1 / 11;
const STAMINA_REGEN = 1 / 17;
const STAMINA_HOLD = 1.1;           // seconds after a sprint before recovery
const STAMINA_RECOVERED = 0.34;     // how much you need back before running again
const JUMP_COST = 0.06;

class Game {
  constructor() {
    this.canvas = document.getElementById('viewport');
    this.clock = new THREE.Clock();
    this.state = 'title';           // title | loading | playing | paused
    this.session = null;
    this.accumulator = 0;
    this.frames = 0;
    this.fps = 0;
    this.fpsTimer = 0;
    this.showHud = true;
    this.showDebug = false;
    this.photoMode = false;
    this.loadAbort = null;
    this.stepPhase = 0;
    this.bobPhase = 0;
    this.viewBob = new THREE.Vector3();
    this.currentRoom = null;
    this.lastPlaceCheck = 0;

    this.initRenderer();
    this.initScene();

    this.input = new Input(settings, this.canvas);
    this.audio = new AudioEngine(settings);
    this.materials = new MaterialLibrary(settings);
    this.world = new World(this.scene, settings, this.materials);
    this.sky = new SkySystem(this.scene, this.renderer, settings);
    this.weather = new WeatherSystem(this.scene, settings);
    this.controller = new CharacterController(this.world.collisionWorld, settings);
    this.interiors = new InteriorManager(this.scene, this.world, this.interiorContext());
    this.voxel = new VoxelMode(this);
    this.ui = new UI(settings, this.input, this);

    // Say so when map data does not arrive. Terrain without OSM renders as bare
    // ground, which is indistinguishable from genuinely empty countryside - so
    // without this the honest answer ("the map server refused") looks instead
    // like the game deciding that central Paris is a field. Rate-limited to one
    // notice per outage so a run of failing regions is not a wall of toasts.
    this.world.regions.onFailure = (region, outcome) => {
      const now = performance.now();
      if (outcome === 'retrying') {
        if (now - (this._lastMapWarn || -1e9) < 30000) return;
        this._lastMapWarn = now;
        this.ui.toast('Map data delayed', 'The OpenStreetMap server is busy — retrying');
      } else {
        if (now - (this._lastMapGiveUp || -1e9) < 30000) return;
        this._lastMapGiveUp = now;
        this.ui.toast('No map data here', 'Every mirror refused — this ground is terrain only');
      }
    };

    this.buildTitleGlobe();
    this.bindEvents();

    if (settings.isFirstRun) {
      const preset = settings.autoDetectQuality();
      settings.applyPreset(preset);
      this.ui.toast(`Graphics set to "${preset}"`, 'Change this any time in Settings.');
    }
    this.applyGraphicsSettings();

    this.clock.start();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // --- setup ---------------------------------------------------------------

  initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: settings.graphics.antialias,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x0a0c10);
    this.renderer.shadowMap.enabled = settings.graphics.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.72;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.graphics.fov, 1, 0.1, 6000);
    this.camera.rotation.order = 'YXZ';

    // A separate, tiny scene for the title-screen globe, rendered by the same
    // context so there is only ever one WebGL surface to manage.
    this.menuScene = new THREE.Scene();
    this.menuCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.menuCamera.position.set(0, 0, 7.4);

    this.dynamicLights = [];
    this.resize();
  }

  /** The title globe: a real sphere, with NASA Blue Marble wrapped round it. */
  buildTitleGlobe() {
    const geo = new THREE.SphereGeometry(2.5, 64, 48);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a4a68, roughness: 0.92, metalness: 0 });
    this.globe = new THREE.Mesh(geo, mat);
    this.globe.rotation.z = -23.44 * DEG;      // real axial tilt
    this.menuScene.add(this.globe);

    // Atmosphere: a slightly larger sphere, back faces only, fading at the rim.
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(2.66, 48, 32),
      new THREE.MeshBasicMaterial({
        color: 0x5590d0, transparent: true, opacity: 0.14,
        side: THREE.BackSide, depthWrite: false,
      }));
    this.menuScene.add(atmo);

    const stars = new THREE.Mesh(
      new THREE.SphereGeometry(40, 32, 20),
      new THREE.MeshBasicMaterial({ map: starfieldTexture(), side: THREE.BackSide, depthWrite: false }));
    this.menuScene.add(stars);
    this.menuStars = stars;

    const sun = new THREE.DirectionalLight(0xfff4e6, 3.2);
    sun.position.set(-4, 1.6, 4);
    this.menuScene.add(sun, new THREE.AmbientLight(0x6688aa, 0.35));

    this.loadBlueMarble(mat);
  }

  /**
   * NASA GIBS serves Blue Marble in EPSG:4326, which is plate carree - exactly
   * the equirectangular layout a sphere's UVs want, so the tiles composite
   * straight onto the globe with no reprojection.
   */
  async loadBlueMarble(material) {
    const base = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/500m';
    // GIBS's EPSG:4326 matrix sets are not a power-of-two pyramid: level 0 is
    // 640x320 pixels, doubling from there, so tile counts run 2x1, 3x2, 5x3,
    // 10x5 rather than 2x1, 4x2, 8x4. Asking for the tiles a standard scheme
    // would predict just returns 400s.
    const z = 3;
    const TILE = 512;
    const pixelWidth = 640 * Math.pow(2, z);
    const pixelHeight = 320 * Math.pow(2, z);
    const cols = Math.ceil(pixelWidth / TILE), rows = Math.ceil(pixelHeight / TILE);
    const canvas = document.createElement('canvas');
    // Size the canvas to the true extent, so the partial edge tiles clip
    // correctly and the result is exactly 2:1 equirectangular.
    canvas.width = pixelWidth; canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#12314f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let loaded = 0;
    await Promise.all(Array.from({ length: cols * rows }, async (_, i) => {
      const x = i % cols, y = Math.floor(i / cols);
      try {
        const buf = await fetchCached(`${base}/${z}/${y}/${x}.jpeg`, {
          as: 'arrayBuffer', maxAgeMs: 1000 * 60 * 60 * 24 * 365, retries: 1, timeoutMs: 15000,
        });
        const img = await decodeImage(buf, 'image/jpeg');
        ctx.drawImage(img, x * TILE, y * TILE, TILE, TILE);
        if (img.close) img.close();
        loaded++;
      } catch (e) { /* a missing tile just leaves ocean blue */ }
    }));
    if (!loaded) return;

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    material.map = tex;
    material.color.setHex(0xffffff);
    material.needsUpdate = true;
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });

    // Audio can only start from a gesture.
    const wake = () => { this.audio.start(); };
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });

    this.input.onPointerLockChange = (locked) => {
      if (locked) { this.hadPointerLock = true; return; }
      // Losing lock is Escape, which should pause. Never having had it means
      // the browser refused the request, and pausing then just traps you in
      // a menu you cannot leave.
      // Voxel mode's crafting screen gives the pointer back deliberately so
      // you can click a recipe; pausing on top of it would close it again.
      if (this.hadPointerLock && this.state === 'playing' && !this.photoMode &&
          !(this.voxel && this.voxel.craftOpen)) this.pause();
    };

    this.canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.pointerLocked && !this.transitioning) {
        this.input.requestPointerLock();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote') { this.showDebug = !this.showDebug; }
    });

    settings.onChange((section, key) => this.onSettingsChanged(section, key));
  }

  resize() {
    const scale = clamp(settings.graphics.resolutionScale, 0.4, 2);
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * scale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.menuCamera.aspect = w / h;
    this.menuCamera.updateProjectionMatrix();
  }

  interiorContext() {
    return {
      settings,
      materials: this.materials,
      groundYFor: (b) => (b.groundY != null ? b.groundY : this.world.terrainAt(b.centroid[0], b.centroid[1])),
    };
  }

  // --- settings ------------------------------------------------------------

  onSettingsChanged(section, key) {
    if (section === 'graphics' || section === '*') this.applyGraphicsSettings();
    if (section === 'gameplay' || section === '*') this.controller.applySettings();
    if (section === 'world' && key === 'weather') this.applyWeather();
    if (section === 'world' && key === 'interiorsEnabled' &&
        !settings.world.interiorsEnabled && this.interiors.isInside) {
      this.exitInterior();
    }
    if (section === 'data' && key === 'regionSize') this.world.regions.sizeM = settings.data.regionSize;
    if (section === 'gameplay' && (key === 'hudOpacity' || key === 'crosshair')) {
      this.ui.setHudVisible(this.showHud && this.state === 'playing');
    }
  }

  applyGraphicsSettings() {
    const g = settings.graphics;
    this.renderer.shadowMap.enabled = g.shadows;
    this.camera.fov = g.fov;
    this.camera.far = clamp(g.renderDistance * 2.5, 1200, 12000);
    this.camera.updateProjectionMatrix();
    this.sky.applySettings();
    this.sky.fitToCamera(this.camera);
    this.materials.refreshFiltering();
    this.resize();
    this.trimDynamicLights();
  }

  trimDynamicLights() {
    const want = settings.graphics.dynamicLights;
    while (this.dynamicLights.length > want) {
      const l = this.dynamicLights.pop();
      this.scene.remove(l);
      l.dispose();
    }
    while (this.dynamicLights.length < want) {
      const l = new THREE.PointLight(0xffd9a0, 0, 20, 2);
      l.visible = false;
      l.castShadow = false;
      this.scene.add(l);
      this.dynamicLights.push(l);
    }
  }

  /**
   * Is there a ceiling over this point?
   *
   * The cheapest honest test for "am I indoors": look up. A street has nothing
   * above it for tens of metres; a room, an archway or an entrance canopy
   * answers immediately. It costs one ray and needs no knowledge of which
   * building we might be in, which matters because the footprint test cannot
   * see the cases that actually bite - an arcade, a covered court, a building
   * mapped only as parts.
   */
  hasCeiling(p, reach = 26) {
    const hit = this.world.collisionWorld.raycast(
      new THREE.Vector3(p.x, p.y + 0.25, p.z), new THREE.Vector3(0, 1, 0), reach);
    return !!hit;
  }

  /**
   * Stand the player on the first candidate that is genuinely outdoors.
   *
   * Two things used to go wrong here. The drop started 120 m up, so the ray
   * found the first roof under it and the game began on top of a building; and
   * nothing checked the result, so when the candidate was inside a footprint
   * after all, that was simply where you woke up. Now the ray starts just above
   * the local ground - below the rooftops, so they cannot intercept it - and a
   * spot with a ceiling over it is rejected in favour of the next one.
   */
  spawnInto(spawns, elevation) {
    const c = this.controller;
    let fallback = null;
    for (const s of spawns) {
      const base = this.world.terrainAt(s.x, s.z);
      const from = (Number.isFinite(base) ? base : elevation) + 3;
      if (!c.placeAt(s.x, s.z, from)) continue;
      if (!this.hasCeiling(c.position)) return true;
      // Playable, but indoors or under something. Keep it only as a last resort.
      if (!fallback) fallback = { x: c.position.x, y: c.position.y, z: c.position.z };
    }
    if (fallback) { c.teleport(fallback.x, fallback.y, fallback.z); return true; }
    // Nothing could be placed - the chunk under every candidate is still empty.
    // Stand on the *terrain* here, not on the elevation of the point that was
    // asked for: those differ by however much the ground rises between the two,
    // and using the wrong one drops the player under the surface, where the
    // world above reads as a solid green ceiling and there is no way out.
    const s = spawns[0];
    const base = this.world.terrainAt(s.x, s.z);
    c.teleport(s.x, (Number.isFinite(base) ? base : elevation) + 2, s.z);
    return false;
  }

  // --- flow ----------------------------------------------------------------

  async travelTo(place, options) {
    this.audio.start();
    this.audio.click('confirm');
    this.state = 'loading';
    this.ui.show('loading', { push: false });
    this.ui.setLoading(0, 'Contacting map servers…', `Travelling to ${place.name || 'your point'}`);

    this.interiors.clear();
    // Travelling out of a voxel session drops its blocks: the grid is anchored
    // to the local metre grid of the place you were in, and that origin moves.
    if (this.voxel.active) this.voxel.exit();
    this.loadAbort = { cancelled: false };
    const abort = this.loadAbort;

    try {
      // Time: real local time there, a chosen hour, or an accelerated cycle.
      const baseDate = options.date || new Date();
      settings.values.world.timeMode = options.timeMode;
      settings.values.world.fixedHour = options.fixedHour;
      this.session = {
        lat: place.lat, lon: place.lon,
        placeName: place.name || null,
        countryCode: place.countryCode || null,
        startedAt: performance.now(),
        timeMode: options.timeMode,
        fixedHour: options.fixedHour,
        mode: options.mode === 'voxel' ? 'voxel' : 'walk',
        baseDate,
        elapsed: 0,
      };

      // Search results carry a country code. Typed coordinates do not, so run
      // reverse-geocoding alongside the heavier terrain/OSM load and apply the
      // answer before the first chunk is generated. That keeps asymmetric lane
      // layouts correct in left-driving countries without slowing normal
      // named-place travel.
      const locationLookup = place.countryCode
        ? Promise.resolve(null)
        : reverseGeocode(place.lat, place.lon);
      const [info, resolvedPlace] = await Promise.all([
        this.world.setLocation(place.lat, place.lon, {
          date: baseDate,
          countryCode: place.countryCode,
          onProgress: (p, msg) => { if (!abort.cancelled) this.ui.setLoading(p, msg); },
        }),
        locationLookup,
      ]);
      if (abort.cancelled) return;

      if (resolvedPlace?.countryCode && !place.countryCode) {
        this.session.countryCode = resolvedPlace.countryCode;
        this.world.setCountryCode(resolvedPlace.countryCode);
      }
      if (!this.session.placeName && resolvedPlace?.name) {
        this.session.placeName = resolvedPlace.name;
      }

      this.session.biome = info.biome;
      this.session.elevation = info.elevation;
      this.session.ndvi = info.ndvi;

      // Weather, either chosen or plausible for the place and season.
      this.session.weatherChoice = options.weather;
      this.applyWeather();

      this.ui.setLoading(0.7, 'Building the ground you stand on…');
      // Put you on a street rather than inside whichever building happens to
      // sit on the exact coordinates you asked for.
      const spawns = this.world.spawnCandidates(0, 0);
      const spawn = spawns[0];
      this.controller.teleport(spawn.x, info.elevation + 2, spawn.z);

      // Build the chunks around the spawn before showing anything, so you do
      // not appear in mid-air over a void.
      const spawnChunkKey = `${Math.floor(spawn.x / CHUNK_SIZE)},${Math.floor(spawn.z / CHUNK_SIZE)}`;
      for (let i = 0; i < 90; i++) {
        this.world.update(spawn.x, spawn.z, 0.016, 26);
        if (this.world.chunks.has(spawnChunkKey)) break;
        await new Promise((r) => setTimeout(r, 16));
        if (abort.cancelled) return;
      }
      this.ui.setLoading(0.9, 'Finding you somewhere to stand…');
      this.spawnInto(spawns, info.elevation);
      this.controller.yaw = Math.random() * Math.PI * 2;
      this.controller.pitch = 0;
      this.controller.distanceWalked = 0;

      // A name for the HUD, if the picker did not supply one.
      if (!this.session.placeName) {
        reverseGeocode(place.lat, place.lon).then((r) => {
          if (r && this.session) this.session.placeName = r.name;
        }).catch(() => {});
      }

      // Build the block world while the loading screen is still up, rather
      // than dropping you into the polygon one for the half second it takes.
      if (this.session.mode === 'voxel') {
        this.ui.setLoading(0.95, 'Cutting the world into blocks…');
        this.voxel.enter();
      }

      this.ui.setLoading(1, 'Ready');
      if (abort.cancelled) return;
      this.startPlaying();
    } catch (err) {
      console.error(err);
      this.ui.show('place', { push: false });
      this.ui.toast('Could not load that place', err.message || 'The map servers may be busy. Try again, or pick somewhere else.');
    } finally {
      this.loadAbort = null;
    }
  }

  applyWeather() {
    if (!this.session) return;
    const choice = settings.world.weather !== 'auto'
      ? settings.world.weather
      : (this.session.weatherChoice && this.session.weatherChoice !== 'auto'
        ? this.session.weatherChoice
        : plausibleWeather(this.session.lat, this.session.baseDate,
                           this.session.biome ? this.session.biome.id : 'temperateBroadleaf'));
    this.weather.set(choice);
  }

  startPlaying() {
    this.state = 'playing';
    this.hadPointerLock = false;
    this.ui.hideAll();
    this.ui.setHudVisible(this.showHud);
    this.input.setEnabled(true);
    this.input.requestPointerLock();
    this.audio.resume();
    document.getElementById('btn-resume').hidden = false;
    const biome = this.session.biome ? this.session.biome.label : '';
    this.ui.toast(this.session.placeName || 'Somewhere on Earth',
      `${biome}${this.session.elevation != null ? ` · ${Math.round(this.session.elevation)} m` : ''}`);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.ui.setHudVisible(false);
    this.ui.show('pause', { push: false });
    this.ui.screenStack = [];
    this.audio.click('back');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.ui.hideAll();
    this.ui.setHudVisible(this.showHud);
    this.input.setEnabled(true);
    this.input.requestPointerLock();
    this.audio.click();
  }

  quitToTitle() {
    if (this.voxel.active) this.voxel.exit();
    this.state = 'title';
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.ui.setHudVisible(false);
    this.interiors.clear();
    this.world.setVisible(true);
    this.world.clear();
    this.session = null;
    this.ui.screenStack = [];
    this.ui.show('title', { push: false });
  }

  cancelLoad() {
    if (this.loadAbort) this.loadAbort.cancelled = true;
    this.world.clear();
    this.ui.show('place', { push: false });
  }

  togglePhotoMode() {
    this.photoMode = !this.photoMode;
    settings.values.gameplay.fly = this.photoMode;
    this.showHud = !this.photoMode;
    if (this.photoMode) {
      this.state = 'playing';
      this.ui.hideAll();
      this.ui.setHudVisible(false);
      this.input.setEnabled(true);
      this.input.requestPointerLock();
      this.ui.toast('Photo mode', 'Free flight. P to leave, Shift to move faster.');
    } else {
      this.ui.setHudVisible(true);
    }
  }

  // --- frame ---------------------------------------------------------------

  /**
   * Swap between walking the world and mining it.
   *
   * Both are the same session - same place, same time of day, same weather -
   * so this is a change of what the ground is made of rather than a new game.
   */
  toggleVoxelMode() {
    if (this.state !== 'playing' && !this.session) return;
    this.voxel.toggle();
    if (this.state === 'paused') this.resume();
  }

  frame() {
    const raw = this.clock.getDelta();
    const dt = Math.min(raw, 0.1);          // never let a stall become a teleport

    this.fpsTimer += raw;
    this.frames++;
    if (this.fpsTimer >= 0.5) {
      this.fps = this.frames / this.fpsTimer;
      this.frames = 0; this.fpsTimer = 0;
    }

    if (this.state === 'title' || (this.state !== 'playing' && !this.session)) {
      this.updateTitle(dt);
      this.renderer.render(this.menuScene, this.menuCamera);
      this.input.endFrame();
      return;
    }

    if (this.state === 'playing') this.updatePlaying(dt);
    else this.updatePausedOrLoading(dt);

    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }

  updateTitle(dt) {
    this.globe.rotation.y += dt * 0.045;
    this.menuStars.rotation.y -= dt * 0.004;
    this.audio.update(dt);
  }

  updatePausedOrLoading(dt) {
    // Keep streaming while paused so resuming is instant, but do not simulate -
    // and not at all while inside an interior, where the outdoor world is
    // deliberately unloaded.
    if (this.session && this.world.ready && !this.interiors.isInside) {
      const p = this.controller.position;
      this.world.update(p.x, p.z, dt, 3);
      this.updateSky(dt, 0);
    }
    this.audio.update(dt);
  }

  updatePlaying(dt) {
    const c = this.controller;

    // --- look -------------------------------------------------------------
    this.input.pollGamepad(dt);
    const look = this.input.drainLook();
    const smoothing = settings.controls.smoothing;
    if (smoothing > 0) {
      this._smoothLook = this._smoothLook || { x: 0, y: 0 };
      this._smoothLook.x = lerp(look.x, this._smoothLook.x, smoothing);
      this._smoothLook.y = lerp(look.y, this._smoothLook.y, smoothing);
      c.yaw -= this._smoothLook.x;
      c.pitch -= this._smoothLook.y;
    } else {
      c.yaw -= look.x;
      c.pitch -= look.y;
    }
    c.pitch = clamp(c.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    // --- intent -----------------------------------------------------------
    const move = this.input.moveVector();
    const sprintHeld = this.input.isSprinting();
    const stamina = this.updateStamina(dt, sprintHeld, move);
    const wish = {
      jump: this.input.wasPressed('jump') || this.input.gamepadPressed(0),
      // Held state as well as the press: releasing early cuts the jump short.
      jumpHeld: this.input.isDown('jump') || this.input.gamepadButton(0),
      jumpPower: this.jumpPower(),
      sprint: sprintHeld && !this.exhausted && stamina > 0.02,
      crouch: this.input.isCrouching(),
      up: this.input.isDown('flyUp'),
      down: this.input.isDown('flyDown'),
    };

    if (this.input.wasPressed('interact') || this.input.gamepadPressed(2)) {
      // No early return: the frame still owes the player its movement and its
      // camera update, and skipping them makes every interaction feel like a
      // hitch.
      this.tryInteract();
    }
    if (this.input.wasPressed('pause')) { this.pause(); return; }
    if (this.input.wasPressed('map')) { this.openMap(); return; }
    if (this.input.wasPressed('photo')) this.togglePhotoMode();
    if (this.input.wasPressed('voxel')) { this.toggleVoxelMode(); return; }
    if (this.input.wasPressed('toggleHud')) {
      this.showHud = !this.showHud;
      this.ui.setHudVisible(this.showHud);
    }

    // --- physics ----------------------------------------------------------
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      c.step(FIXED_STEP, move, wish);
      // Leaving the ground costs wind, which is what stops bunny-hopping being
      // a free way to cross a hillside faster than running up it.
      if (c.jumpedThisStep && settings.gameplay.stamina) {
        this.stamina = clamp(this.stamina - JUMP_COST, 0, 1);
        this.staminaHold = Math.max(this.staminaHold || 0, STAMINA_HOLD * 0.6);
        if (this.stamina <= 0.001) this.exhausted = true;
      }
      this.accumulator -= FIXED_STEP;
      steps++;
      wish.jump = false;              // a buffered jump fires once
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    // Water: wading slows you down and changes what your feet sound like.
    const water = this.world.waterAt(c.position.x, c.position.z);
    c.inWater = !!(water && water.depth > 0.15 && c.position.y < water.level - 0.1);
    c.waterDepth = water ? water.depth : 0;

    // Falling out of the world (a gap in the terrain, a failed chunk) should
    // put you back on the ground, not end the session.
    if (c.position.y < (this.session.elevation || 0) - 900) {
      const ok = c.placeAt(c.position.x, c.position.z, (this.session.elevation || 0) + 200);
      if (!ok) c.teleport(0, (this.session.elevation || 0) + 2, 0);
      this.ui.toast('Caught you', 'You fell out of the world and were put back.');
    }

    // --- streaming --------------------------------------------------------
    // Inside a cell the outdoor world is hidden and uncollided, so there is
    // nothing to be gained by continuing to stream it - and a great deal of
    // frame time to be saved by not doing so.
    if (this.voxel.active) {
      // The polygon world is hidden and uncollided in voxel mode, so streaming
      // it would be paying for a world nobody can see - but its elevation data
      // is still what the blocks are generated from, and that comes from the
      // terrain tiles rather than the chunks, so nothing is lost by stopping.
      this.voxel.update(dt);
    } else if (!this.interiors.isInside) {
      // Load what is in front of you first. Use the facing direction rather
      // than the velocity: standing still and looking down a street should
      // still bring that street in.
      const heading = { x: -Math.sin(c.yaw), z: -Math.cos(c.yaw) };
      const speed = Math.hypot(c.velocity.x, c.velocity.z);
      if (speed > 0.8) {
        heading.x = c.velocity.x / speed;
        heading.z = c.velocity.z / speed;
      }
      this.world.update(c.position.x, c.position.z, dt, this.fps < 40 ? 3 : 7, heading);
    }

    // --- camera -----------------------------------------------------------
    this.updateCamera(dt, move, sprintHeld);
    this.updateSky(dt, dt);
    this.weather.update(dt, this.camera.position, this.interiors.isInside);
    this.updateLights();
    this.updateAudio(dt, move);
    this.updateHud(dt);

    this.materials.updateForSun(this.sky.state.elevation, dt);
  }

  // --- interiors as cells --------------------------------------------------

  /**
   * What, if anything, the interact key would act on right now.
   *
   * Outdoors that is a front door within reach and roughly in front of you;
   * indoors it is the way back out. Returns `{ kind, label, building }`.
   */
  interactTarget() {
    if (!settings.world.interiorsEnabled) return null;
    const c = this.controller;
    const p = c.position;

    if (this.interiors.isInside) {
      if (this.interiors.distanceToExit(p.x, p.y, p.z) > 2.6) return null;
      const name = this.interiors.current.building.name;
      return { kind: 'exit', label: name ? `Leave ${name}` : 'Go outside' };
    }

    const near = this.world.nearbyDoors(p.x, p.z, 2.8);
    if (!near.length) return null;
    // Only offer a door you are actually facing, so walking past a terrace
    // does not flicker a prompt for every house on it.
    const forwardX = -Math.sin(c.yaw), forwardZ = -Math.cos(c.yaw);
    for (const { building, distance } of near) {
      const d = building.door;
      const toDoorX = d.x - p.x, toDoorZ = d.z - p.z;
      const len = Math.hypot(toDoorX, toDoorZ) || 1;
      if ((toDoorX / len) * forwardX + (toDoorZ / len) * forwardZ < 0.35) continue;
      if (this.interiors.failed.has(building.source)) continue;
      const name = building.name || describeBuilding(building);
      return { kind: 'enter', label: `Enter ${name}`, building, distance };
    }
    return null;
  }

  tryInteract() {
    const target = this.interactTarget();
    if (!target) return;
    if (target.kind === 'enter') this.enterInterior(target.building);
    else this.exitInterior();
  }

  /**
   * Fade out, swap the world for the cell (or back), fade in.
   *
   * The fade is not decoration: generating a building's interior takes a few
   * milliseconds and the frame it lands on will stutter, so the transition
   * hides the seam and gives the swap somewhere to happen.
   */
  async cellTransition(swap) {
    if (this.transitioning) return;
    this.transitioning = true;
    this.ui.setFade(true);
    await new Promise((r) => setTimeout(r, 190));
    try {
      swap();
    } catch (e) {
      console.error(e);
      this.ui.toast('That door would not open', e.message || 'Something went wrong generating the interior.');
    }
    // Let a frame render the new contents before revealing them - but never
    // wait on rAF alone. Browsers throttle or stop it entirely for a
    // backgrounded tab, and a fade that waits forever leaves the player
    // staring at a black screen with no way out.
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(finish);
      setTimeout(finish, 250);
    });
    this.ui.setFade(false);
    this.transitioning = false;
  }

  enterInterior(building) {
    this.cellTransition(() => {
      this.audio.door(true);
      const planSpawn = this.interiors.enter(building);
      if (!planSpawn) {
        this.ui.toast('Locked', 'There is no way into this building.');
        return;
      }
      // Arrive just inside the door rather than in the middle of the room:
      // it is where you would actually be, and the doorway is the one part of
      // a room the furnishing pass reliably leaves clear.
      const exitPoint = this.interiors.current.exit;
      const spawn = exitPoint ? { ...exitPoint.standInside } : planSpawn;
      // Drop onto the interior floor rather than trusting the plan's height.
      this.controller.teleport(spawn.x, spawn.y + 0.1, spawn.z);
      if (!this.controller.placeAt(spawn.x, spawn.z, spawn.y + 3)) {
        this.controller.teleport(spawn.x, spawn.y + 0.1, spawn.z);
      }
      // Turn to face into the room rather than at the door you came through.
      if (exitPoint) {
        this.controller.yaw = Math.atan2(
          -(spawn.x - exitPoint.doorway.x), -(spawn.z - exitPoint.doorway.z));
      }
      this.controller.velocity.set(0, 0, 0);
      const label = building.name || describeBuilding(building);
      const floors = this.interiors.current.floorCount;
      this.ui.toast(label, floors > 1 ? `${floors} floors — stairs somewhere inside` : null);
    });
  }

  exitInterior() {
    this.cellTransition(() => {
      this.audio.door(false);
      const out = this.interiors.leave();
      if (!out) return;
      // Start the drop just above the pavement, not 140 m up. The exit point is
      // a step from the wall of the building being left, so a ray from above
      // the rooftops finds that building's own roof, its cornice or its
      // entrance canopy long before it finds the street - which is how walking
      // out of a door put you on top of the place you had just been inside.
      const base = this.world.terrainAt(out.x, out.z);
      const from = (Number.isFinite(base) ? base : (this.session.elevation || 0)) + 3;
      if (!this.controller.placeAt(out.x, out.z, from)) {
        this.controller.teleport(out.x, (this.session.elevation || 0) + 2, out.z);
      }
      this.controller.velocity.set(0, 0, 0);
      // Face away from the building you have just come out of.
      this.controller.yaw += Math.PI;
    });
  }

  /**
   * Wind, and running out of it.
   *
   * The old version drained over twenty-two seconds and refilled while you
   * were still walking at full pace, so it never once decided anything. Three
   * changes make it a real constraint: running costs enough to notice, uphill
   * costs more than flat, and recovery does not begin the instant you stop
   * sprinting - you have to actually ease off.
   *
   * The exhaustion latch is the important one. Cutting sprint off at zero and
   * restoring it the moment the bar ticks above zero makes the last stretch of
   * a run stutter between running and walking several times a second. Once you
   * are spent you stay spent until you have a third of it back.
   */
  updateStamina(dt, sprinting, move) {
    if (!settings.gameplay.stamina) {
      this.stamina = 1;
      this.exhausted = false;
      return 1;
    }
    if (this.stamina == null) { this.stamina = 1; this.exhausted = false; this.staminaHold = 0; }
    const c = this.controller;
    const moving = Math.hypot(move.x, move.y) > 0.1;
    const running = sprinting && moving && c.grounded && !this.exhausted;

    if (running) {
      // Ground normal tilts away from vertical on a slope; on a 30 degree
      // hillside this roughly doubles the cost of running up it.
      const slope = clamp(1 - c.groundNormal.y, 0, 0.4);
      this.stamina -= dt * STAMINA_DRAIN * (1 + slope * 3);
      this.staminaHold = STAMINA_HOLD;
    } else {
      this.staminaHold = Math.max(0, (this.staminaHold || 0) - dt);
      if (this.staminaHold <= 0) {
        // Standing still gets your breath back; walking it off is slower, and
        // in the air you are not recovering at all.
        const rate = !c.grounded ? STAMINA_REGEN * 0.35
          : (moving ? STAMINA_REGEN * 0.6 : STAMINA_REGEN);
        this.stamina += dt * rate;
      }
    }

    this.stamina = clamp(this.stamina, 0, 1);
    if (this.stamina <= 0.001) this.exhausted = true;
    else if (this.exhausted && this.stamina >= STAMINA_RECOVERED) this.exhausted = false;
    return this.stamina;
  }

  /** Take the wind out of a jump, and tell us how high it can be. */
  jumpPower() {
    if (!settings.gameplay.stamina) return 1;
    if (this.exhausted) return 0.72;
    return this.stamina < JUMP_COST ? 0.72 : 1;
  }

  updateCamera(dt, move, sprinting) {
    const c = this.controller;
    const eye = c.eyePosition;

    // Head bob, tied to distance walked rather than time, so it stays in step
    // with the feet at any speed.
    const bobAmount = settings.controls.headBob;
    if (bobAmount > 0 && c.grounded && !settings.gameplay.fly) {
      const speed = Math.hypot(c.velocity.x, c.velocity.z);
      this.bobPhase += (speed * dt) / 0.78;      // one cycle per stride
      const strength = clamp(speed / 3, 0, 1) * bobAmount;
      this.viewBob.x = damp(this.viewBob.x, Math.sin(this.bobPhase * Math.PI * 2) * 0.028 * strength, 12, dt);
      this.viewBob.y = damp(this.viewBob.y, Math.abs(Math.cos(this.bobPhase * Math.PI)) * 0.036 * strength, 12, dt);
    } else {
      this.viewBob.x = damp(this.viewBob.x, 0, 8, dt);
      this.viewBob.y = damp(this.viewBob.y, 0, 8, dt);
    }

    this.camera.position.set(eye.x + this.viewBob.x, eye.y + this.viewBob.y, eye.z);
    this.camera.rotation.set(c.pitch, c.yaw, 0, 'YXZ');
    // A slight roll when strafing sells the weight of the body.
    this.camera.rotation.z = damp(this.camera.rotation.z, -move.x * 0.012, 8, dt);

    const targetFov = settings.graphics.fov *
      (settings.controls.fovKick && sprinting && !settings.gameplay.fly ? 1.06 : 1);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, targetFov, 8, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  /** The date and time being simulated, per the chosen time mode. */
  currentDate() {
    const s = this.session;
    if (!s) return new Date();
    if (s.timeMode === 'fixed') {
      const d = new Date(s.baseDate);
      // The chosen hour is local solar-ish time, so offset by longitude.
      const utcHour = s.fixedHour - s.lon / 15;
      d.setUTCHours(0, 0, 0, 0);
      return new Date(d.getTime() + utcHour * 3600000);
    }
    if (s.timeMode === 'cycle') {
      const dayMs = settings.world.dayLengthMinutes * 60000;
      const t = ((performance.now() - s.startedAt) / dayMs) % 1;
      const d = new Date(s.baseDate);
      d.setUTCHours(0, 0, 0, 0);
      return new Date(d.getTime() + (t * 24 - s.lon / 15) * 3600000);
    }
    // 'local': real time now, which is what the place is actually experiencing.
    return new Date();
  }

  updateSky(dt) {
    const s = this.session;
    if (!s) return;
    const date = this.currentDate();
    this.skyState = this.sky.update(date, s.lat, s.lon, {
      overcast: this.weather.overcast,
      fogDensity: this.weather.fogDensity,
    }, dt);
    this.sky.followCamera(this.camera.position);
  }

  /**
   * Place the pool of point lights on the nearest lamps and ceiling fittings.
   * Recycling a fixed pool keeps the shader permutations stable, which matters
   * far more for frame time than the number of lights does.
   */
  updateLights() {
    const pool = this.dynamicLights;
    if (!pool.length) return;
    const p = this.camera.position;
    const night = this.sky.state ? this.sky.state.night : 0;

    const candidates = [];
    // Street lamps from nearby chunks, but only once it is getting dark.
    if (night > 0.08 && !this.interiors.isInside) {
      const cx = Math.floor(p.x / CHUNK_SIZE), cz = Math.floor(p.z / CHUNK_SIZE);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const chunk = this.world.chunks.get(`${cx + dx},${cz + dz}`);
          if (!chunk) continue;
          for (const l of chunk.lights) {
            const d = Math.hypot(l.x - p.x, l.z - p.z);
            if (d < 46) candidates.push({ ...l, distance: d, scale: night });
          }
        }
      }
    }
    // Interior lights, but only while you are actually inside. Point lights
    // here do not cast shadows, so a ceiling fitting left switched on would
    // shine straight up through the roof and pool on the tiles outside.
    if (this.interiors.isInside) {
      // Point lights here cast no shadows, so a fitting two rooms away still
      // shines through the wall. Keeping the radius tight and the count low is
      // what stops a corridor of lit rooms washing out the one you are in.
      for (const l of this.interiors.nearbyLights(p.x, p.y, p.z, 11, 6)) {
        candidates.push({ ...l, scale: 1 });
      }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < pool.length; i++) {
      const light = pool[i];
      const c = candidates[i];
      if (!c) { light.visible = false; light.intensity = 0; continue; }
      light.visible = true;
      light.position.set(c.x, c.y, c.z);
      light.color.setHex(c.colour);
      // `range` is how far the lamp throws; `distance` is how far away it is
      // from the player, which is only used for choosing which lamps to light.
      light.distance = c.range || 22;
      light.decay = 2;
      light.intensity = (c.intensity || 10) * (c.scale != null ? c.scale : 1);
    }
  }

  updateAudio(dt, move) {
    const c = this.controller;
    const p = c.position;

    // Footsteps: fire on stride distance, not on a timer, so they track pace.
    const speed = Math.hypot(c.velocity.x, c.velocity.z);
    if (c.grounded && speed > 0.35) {
      const stride = c.crouching ? 0.62 : speed > 2.6 ? 1.12 : 0.78;
      this.stepPhase += (speed * dt) / stride;
      if (this.stepPhase >= 1) {
        this.stepPhase -= 1;
        let surface = c.inWater ? 'water' : this.surfaceUnderfoot();
        this.audio.footstep(surface, clamp(speed / 2.2, 0.45, 1.4) * (c.crouching ? 0.5 : 1));
      }
    } else {
      this.stepPhase = Math.min(this.stepPhase, 0.92);
    }
    if (c.grounded && !c.wasGrounded && c.landingImpact > 0.15) {
      this.audio.land(c.landingImpact);
      c.landingImpact = 0;
    }

    // The ambient mix, from what is actually around the player.
    const indoors = this.currentRoom ? 1 : 0;
    const night = this.sky.state ? this.sky.state.night : 0;
    const geo = this.world.projection.toGeo(p.x, p.z);
    const green = ndvi.sample(geo.lat, geo.lon);
    const roadDensity = this.estimateRoadDensity(p.x, p.z);
    const water = this.world.waterAt(p.x, p.z);

    this.audio.setEnvironment({
      wind: clamp(this.weather.windSpeed / 12, 0.05, 1) * (indoors ? 0.25 : 1),
      traffic: clamp(roadDensity, 0, 1) * (1 - night * 0.55),
      birds: clamp(green * 1.4, 0, 1) * (1 - night) * (indoors ? 0.15 : 1) * (1 - this.weather.precipitation * 0.8),
      rain: this.weather.precipitation * (this.weather.state.rain > this.weather.state.snow ? 1 : 0.25),
      indoor: indoors,
      water: water ? clamp(1 - Math.hypot(0, 0) / 30, 0.2, 0.8) : 0,
    });
    this.audio.update(dt);
  }

  /** Read the surface tag off the triangle under the player's feet. */
  surfaceUnderfoot() {
    const c = this.controller;
    const hit = this.world.collisionWorld.raycast(
      new THREE.Vector3(c.position.x, c.position.y + 0.4, c.position.z),
      new THREE.Vector3(0, -1, 0), 1.4);
    if (!hit || !hit.collider || !hit.collider.userData.surfaces) return 'concrete';
    const id = hit.collider.userData.surfaces[hit.faceIndex];
    return SURFACE_NAMES[id] || 'concrete';
  }

  /** Rough measure of how built-up it is here, for the traffic bed. */
  estimateRoadDensity(x, z) {
    const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    const fs = this.world.chunkFeatures.get(key);
    if (!fs) return 0;
    let score = 0;
    for (const r of fs.roads) {
      const w = r.spec.width;
      score += (r.spec.kind === 'motorway' || r.spec.kind === 'major') ? w * 0.05 : w * 0.012;
    }
    return clamp(score / 8, 0, 1);
  }

  openMap() {
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.ui.setHudVisible(false);
    this.state = 'paused';
    this.ui.screenStack = ['pause'];
    this.ui.show('map', { push: false });
  }

  updateHud(dt) {
    if (!this.showHud) return;
    const c = this.controller;
    const p = c.position;
    const geo = this.world.projection.toGeo(p.x, p.z);
    const date = this.currentDate();
    const sky = this.sky.state;

    // Which room am I in? Refreshed at a few Hz; it is not cheap and does not
    // need to be per-frame.
    this.lastPlaceCheck += dt;
    if (this.lastPlaceCheck > 0.25) {
      this.lastPlaceCheck = 0;
      this.currentRoom = this.interiors.roomAt(p.x, p.y, p.z);
      this._street = this.world.nearestRoadName(p.x, p.z);
      const pois = this.world.nearbyPois(p.x, p.z, 26);
      this._poi = pois.length ? pois[0] : null;
    }

    const heading = ((-c.yaw * RAD) % 360 + 360) % 360;
    const localHour = (date.getUTCHours() + date.getUTCMinutes() / 60 + this.session.lon / 15 + 24) % 24;
    const timeText = `${String(Math.floor(localHour)).padStart(2, '0')}:${String(Math.floor((localHour % 1) * 60)).padStart(2, '0')}`;

    let phase = sky.phase;
    if (sky.polar === 'day') phase = 'midnight sun';
    else if (sky.polar === 'night') phase = 'polar night';

    const target = this.interactTarget();
    const prompt = target ? target.label : null;

    this.ui.updateHud({
      placeName: this.currentRoom
        ? `${this.currentRoom.label}${this.currentRoom.interior.building.name ? ` — ${this.currentRoom.interior.building.name}` : ''}`
        : (this._poi ? this._poi.name : (this.session.placeName || '')),
      street: this.currentRoom ? '' : (this._street || ''),
      coords: formatLatLon(geo.lat, geo.lon),
      time: timeText,
      phase,
      weather: `${this.weather.label} · ${this.weather.windSpeed.toFixed(1)} m/s`,
      distance: formatDistance(c.distanceWalked),
      heading,
      stamina: settings.gameplay.stamina ? (this.stamina ?? 1) : 1,
      exhausted: !!this.exhausted,
      prompt,
      lookHint: !this.input.pointerLocked,
      loading: this.world.stats.buildQueue > 0 || netStats.inflight > 0
        ? `${netStats.inflight ? 'downloading' : 'building'} ${this.world.stats.buildQueue || netStats.inflight}`
        : null,
    });

    if (this.showDebug) {
      const s = this.world.refreshStats();
      this.ui.setDebug([
        `${this.fps.toFixed(0)} fps   ${this.renderer.info.render.calls} draws   ${(this.renderer.info.render.triangles / 1000).toFixed(0)}k tris`,
        `pos    ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}   ${c.grounded ? 'grounded' : 'airborne'}${c.inWater ? ' wading' : ''}`,
        `geo    ${geo.lat.toFixed(6)} ${geo.lon.toFixed(6)}   elev ${this.world.terrainAt(p.x, p.z).toFixed(1)} m`,
        `chunks ${s.chunks} loaded, ${s.buildQueue} queued, last ${s.lastBuildMs.toFixed(1)} ms`,
        `geom   ${(s.triangles / 1000).toFixed(0)}k world  ${(this.interiors.stats.triangles / 1000).toFixed(0)}k interior`,
        `collide ${(s.collisionTriangles / 1000).toFixed(0)}k tris in ${this.world.collisionWorld.colliders.size} BVHs`,
        `regions ${s.regions}   ${this.interiors.isInside ? `INSIDE ${this.interiors.current.building.name || this.interiors.current.building.source} (${this.interiors.stats.lastBuildMs.toFixed(0)} ms to build)` : 'outdoors'}`,
        `net    ${netStats.requests} req, ${netStats.cacheHits} cached, ${netStats.errors} errors, ${netStats.inflight} live`,
        `sun    ${sky.elevation.toFixed(1)}° elev, ${sky.azimuth.toFixed(0)}° az, ${phase}`,
        `biome  ${this.session.biome ? this.session.biome.label : '?'}  ndvi ${ndvi.sample(geo.lat, geo.lon).toFixed(2)}`,
        this.world.errors.length ? `errors: ${this.world.errors.slice(-2).join(' | ')}` : '',
      ].filter(Boolean).join('\n'));
    } else {
      this.ui.setDebug(null);
    }
  }
}

/** A readable name for a building that OSM never gave one. */
function describeBuilding(building) {
  const labels = {
    house: 'the house', apartments: 'the apartments', office: 'the offices',
    retail: 'the shop', hotel: 'the hotel', worship: 'the church',
    school: 'the school', hospital: 'the hospital', civic: 'the building',
    industrial: 'the works', barn: 'the barn', shed: 'the shed',
    station: 'the station', parking: 'the car park', castle: 'the castle',
    tower: 'the tower', stadium: 'the stadium',
  };
  return labels[building.kind] || 'the building';
}

// Surface any module-level failure to the player rather than a blank screen.
window.addEventListener('error', (e) => {
  const el = document.getElementById('loading-detail');
  if (el && document.getElementById('screen-loading').classList.contains('active')) {
    el.textContent = `Something went wrong: ${e.message}`;
  }
});

try {
  window.game = new Game();
} catch (err) {
  console.error(err);
  document.body.innerHTML =
    `<div style="position:fixed;inset:0;display:grid;place-items:center;padding:2rem;
       font:16px/1.7 system-ui;color:#e8e4da;background:#14161a;text-align:center">
       <div><h1 style="font-weight:400">Terra Ambulate could not start</h1>
       <p style="color:#a8a396">${err.message}</p>
       <p style="color:#6f6b60;font-size:.85rem">This game needs WebGL 2. Try a current
       Chrome, Edge, Firefox or Safari, and check that hardware acceleration is on.</p></div></div>`;
}

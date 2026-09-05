// Settings: schema, persistence, and quality presets.
//
// Everything the settings menu can change lives here in one declarative schema,
// so the menu builds itself and nothing can drift out of sync. Values persist
// to localStorage and survive a schema change: unknown keys are dropped and
// missing ones fall back to the default.

import { deepClone, mergeKnown, clamp } from './util.js';

const STORAGE_KEY = 'earthwalk.settings.v1';

export const DEFAULTS = {
  graphics: {
    renderDistance: 900,        // metres of world kept resident
    quality: 'medium',          // preset name, or 'custom'
    resolutionScale: 1.0,       // render at a fraction of display resolution
    shadows: true,
    shadowResolution: 2048,
    shadowDistance: 140,
    antialias: true,
    fov: 72,
    maxFps: 0,                  // 0 = uncapped
    anisotropy: 4,
    buildingDetail: 'high',     // low | medium | high - roofs, parts, facades
    vegetationDensity: 1.0,
    grass: true,
    grassDistance: 45,
    propDensity: 1.0,
    ambientOcclusion: true,
    bloom: true,
    motionBlur: false,
    terrainDetail: 'medium',    // controls elevation sampling resolution
    groundStyle: 'landscape',   // landscape | aerial
    waterReflections: true,
    dynamicLights: 24,
  },
  controls: {
    mouseSensitivity: 0.0022,
    invertY: false,
    smoothing: 0.0,
    toggleSprint: false,
    toggleCrouch: false,
    gamepadEnabled: true,
    gamepadSensitivity: 2.4,
    gamepadDeadzone: 0.16,
    headBob: 0.65,
    fovKick: true,
  },
  audio: {
    master: 0.8,
    ambience: 0.7,
    footsteps: 0.8,
    ui: 0.6,
    wind: 0.6,
    muteWhenUnfocused: true,
  },
  world: {
    timeMode: 'local',          // local | fixed | cycle
    fixedHour: 10.5,
    dayLengthMinutes: 24,       // when timeMode is 'cycle'
    dateMode: 'today',          // today | custom
    customDate: '',
    weather: 'auto',            // auto | clear | cloudy | overcast | rain | snow | fog
    windSpeed: 3.5,
    useNasaVegetation: true,
    inferHousing: true,         // invent houses where a suburb is mapped but unbuilt
    interiorsEnabled: true,
    interiorDetail: 'high',
    trafficSigns: true,
    showNames: true,
  },
  gameplay: {
    walkSpeed: 1.45,            // metres per second, a real walking pace
    runSpeed: 4.2,
    crouchSpeed: 0.85,
    stamina: true,
    jump: true,
    fly: false,
    collision: true,
    autoStep: 0.42,             // maximum kerb/stair height you walk up
    slopeLimit: 52,             // degrees
    // Which game the title screen starts: 'walk' or 'voxel'. Remembered so
    // the menu comes back offering whichever you played last.
    startMode: 'walk',
    compass: true,
    hudOpacity: 0.9,
    crosshair: true,
    metricUnits: true,
  },
  data: {
    overpassTimeout: 90,
    regionSize: 1200,
    prefetchRadius: 1,
    useOvertureBuildings: true,
    useOverturePlaces: true,
    cacheEnabled: true,
  },
};

/** Quality presets. Each is a partial patch over the graphics block. */
export const PRESETS = {
  potato: {
    renderDistance: 350, resolutionScale: 0.7, shadows: false, shadowResolution: 512,
    antialias: false, anisotropy: 1, buildingDetail: 'low', vegetationDensity: 0.25,
    grass: false, grassDistance: 0, propDensity: 0.3, ambientOcclusion: false,
    bloom: false, terrainDetail: 'low', groundStyle: 'landscape', waterReflections: false,
    dynamicLights: 4,
  },
  low: {
    renderDistance: 500, resolutionScale: 0.85, shadows: false, shadowResolution: 1024,
    shadowDistance: 70, antialias: false, anisotropy: 2, buildingDetail: 'low',
    vegetationDensity: 0.5, grass: false, grassDistance: 20, propDensity: 0.5,
    ambientOcclusion: false, bloom: false, terrainDetail: 'low',
    groundStyle: 'landscape', waterReflections: false, dynamicLights: 8,
  },
  medium: {
    renderDistance: 900, resolutionScale: 1.0, shadows: true, shadowResolution: 2048,
    shadowDistance: 140, antialias: true, anisotropy: 4, buildingDetail: 'high',
    vegetationDensity: 1.0, grass: true, grassDistance: 45, propDensity: 1.0,
    ambientOcclusion: true, bloom: true, terrainDetail: 'medium',
    groundStyle: 'landscape', waterReflections: true, dynamicLights: 24,
  },
  high: {
    renderDistance: 1400, resolutionScale: 1.0, shadows: true, shadowResolution: 4096,
    shadowDistance: 220, antialias: true, anisotropy: 8, buildingDetail: 'high',
    vegetationDensity: 1.4, grass: true, grassDistance: 70, propDensity: 1.3,
    ambientOcclusion: true, bloom: true, terrainDetail: 'high',
    groundStyle: 'landscape', waterReflections: true, dynamicLights: 48,
  },
  ultra: {
    renderDistance: 2000, resolutionScale: 1.0, shadows: true, shadowResolution: 4096,
    shadowDistance: 320, antialias: true, anisotropy: 16, buildingDetail: 'high',
    vegetationDensity: 1.8, grass: true, grassDistance: 110, propDensity: 1.6,
    ambientOcclusion: true, bloom: true, terrainDetail: 'high',
    groundStyle: 'landscape', waterReflections: true, dynamicLights: 64,
  },
};

/**
 * The menu schema. Each entry describes one control; the settings screen walks
 * this to build itself, so adding a setting here is all it takes to expose it.
 */
export const SCHEMA = [
  {
    id: 'graphics', label: 'Graphics', items: [
      { key: 'quality', label: 'Quality preset', type: 'select', options: ['potato', 'low', 'medium', 'high', 'ultra', 'custom'], note: 'Changing this overwrites the settings below.' },
      { key: 'renderDistance', label: 'Render distance', type: 'range', min: 250, max: 2500, step: 50, unit: 'm' },
      { key: 'resolutionScale', label: 'Resolution scale', type: 'range', min: 0.5, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'fov', label: 'Field of view', type: 'range', min: 55, max: 110, step: 1, unit: '°' },
      { key: 'maxFps', label: 'Frame rate limit', type: 'select', options: [0, 30, 60, 75, 120, 144, 240], format: (v) => (v ? `${v} fps` : 'Unlimited') },
      { key: 'shadows', label: 'Shadows', type: 'toggle' },
      { key: 'shadowResolution', label: 'Shadow resolution', type: 'select', options: [512, 1024, 2048, 4096], format: (v) => `${v}px` },
      { key: 'shadowDistance', label: 'Shadow distance', type: 'range', min: 40, max: 400, step: 10, unit: 'm' },
      { key: 'antialias', label: 'Anti-aliasing', type: 'toggle' },
      { key: 'anisotropy', label: 'Texture filtering', type: 'select', options: [1, 2, 4, 8, 16], format: (v) => `${v}x` },
      { key: 'buildingDetail', label: 'Building detail', type: 'select', options: ['low', 'medium', 'high'] },
      { key: 'terrainDetail', label: 'Terrain detail', type: 'select', options: ['low', 'medium', 'high'] },
      { key: 'groundStyle', label: 'Ground appearance', type: 'select', options: ['landscape', 'aerial'], format: (v) => ({ landscape: 'Natural landscape', aerial: 'Aerial photograph' }[v]), note: 'Natural landscape uses OSM land cover and local biome textures. Aerial photograph uses Esri World Imagery.' },
      { key: 'vegetationDensity', label: 'Vegetation density', type: 'range', min: 0, max: 2, step: 0.1, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'grass', label: 'Ground cover', type: 'toggle' },
      { key: 'grassDistance', label: 'Ground cover distance', type: 'range', min: 0, max: 140, step: 5, unit: 'm' },
      { key: 'propDensity', label: 'Street furniture', type: 'range', min: 0, max: 2, step: 0.1, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'ambientOcclusion', label: 'Ambient occlusion', type: 'toggle' },
      { key: 'bloom', label: 'Bloom', type: 'toggle' },
      { key: 'waterReflections', label: 'Water reflections', type: 'toggle' },
      { key: 'dynamicLights', label: 'Dynamic lights', type: 'range', min: 0, max: 64, step: 4 },
    ],
  },
  {
    id: 'controls', label: 'Controls', items: [
      { key: 'mouseSensitivity', label: 'Mouse sensitivity', type: 'range', min: 0.0004, max: 0.008, step: 0.0002, format: (v) => (v * 1000).toFixed(1) },
      { key: 'invertY', label: 'Invert vertical look', type: 'toggle' },
      { key: 'smoothing', label: 'Look smoothing', type: 'range', min: 0, max: 0.85, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'toggleSprint', label: 'Sprint is a toggle', type: 'toggle' },
      { key: 'toggleCrouch', label: 'Crouch is a toggle', type: 'toggle' },
      { key: 'headBob', label: 'Head bob', type: 'range', min: 0, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'fovKick', label: 'Field of view kick when running', type: 'toggle' },
      { key: 'gamepadEnabled', label: 'Gamepad', type: 'toggle' },
      { key: 'gamepadSensitivity', label: 'Gamepad look speed', type: 'range', min: 0.5, max: 6, step: 0.1 },
      { key: 'gamepadDeadzone', label: 'Gamepad deadzone', type: 'range', min: 0, max: 0.5, step: 0.02, format: (v) => `${Math.round(v * 100)}%` },
      { key: '__bindings', label: 'Key bindings', type: 'bindings' },
    ],
  },
  {
    id: 'audio', label: 'Audio', items: [
      { key: 'master', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'ambience', label: 'Ambience', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'wind', label: 'Wind', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'footsteps', label: 'Footsteps', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'ui', label: 'Interface', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'muteWhenUnfocused', label: 'Mute when the window loses focus', type: 'toggle' },
    ],
  },
  {
    id: 'world', label: 'World', items: [
      { key: 'timeMode', label: 'Time of day', type: 'select', options: ['local', 'fixed', 'cycle'], format: (v) => ({ local: 'Real time at location', fixed: 'Fixed hour', cycle: 'Accelerated cycle' }[v]) },
      { key: 'fixedHour', label: 'Hour', type: 'range', min: 0, max: 23.75, step: 0.25, format: (v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}` },
      { key: 'dayLengthMinutes', label: 'Day length', type: 'range', min: 2, max: 120, step: 1, unit: ' min' },
      { key: 'weather', label: 'Weather', type: 'select', options: ['auto', 'clear', 'cloudy', 'overcast', 'rain', 'snow', 'fog'] },
      { key: 'windSpeed', label: 'Wind speed', type: 'range', min: 0, max: 18, step: 0.5, unit: ' m/s' },
      { key: 'useNasaVegetation', label: 'NASA vegetation data', type: 'toggle', note: 'Uses MODIS NDVI to plant the world from satellite measurements.' },
      { key: 'inferHousing', label: 'Fill in unmapped suburbs', type: 'toggle', note: 'Where OpenStreetMap has residential streets but no buildings, lay out plausible houses along them. Invented, not surveyed - turn this off to see only what is actually mapped.' },
      { key: 'interiorsEnabled', label: 'Enterable interiors', type: 'toggle' },
      { key: 'interiorDetail', label: 'Interior detail', type: 'select', options: ['low', 'medium', 'high'] },
      { key: 'showNames', label: 'Show place names', type: 'toggle' },
    ],
  },
  {
    id: 'gameplay', label: 'Gameplay', items: [
      { key: 'walkSpeed', label: 'Walk speed', type: 'range', min: 0.6, max: 4, step: 0.05, unit: ' m/s' },
      { key: 'runSpeed', label: 'Run speed', type: 'range', min: 2, max: 12, step: 0.1, unit: ' m/s' },
      { key: 'stamina', label: 'Stamina', type: 'toggle' },
      { key: 'jump', label: 'Jumping', type: 'toggle' },
      { key: 'collision', label: 'Collision', type: 'toggle', note: 'Turning this off lets you walk through the world.' },
      { key: 'fly', label: 'Free flight', type: 'toggle' },
      { key: 'autoStep', label: 'Step height', type: 'range', min: 0.1, max: 1.2, step: 0.02, unit: ' m' },
      { key: 'slopeLimit', label: 'Maximum slope', type: 'range', min: 20, max: 85, step: 1, unit: '°' },
      { key: 'compass', label: 'Compass', type: 'toggle' },
      { key: 'crosshair', label: 'Crosshair', type: 'toggle' },
      { key: 'hudOpacity', label: 'HUD opacity', type: 'range', min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%` },
      { key: 'metricUnits', label: 'Metric units', type: 'toggle' },
    ],
  },
  {
    id: 'data', label: 'Data', items: [
      { key: 'regionSize', label: 'Map region size', type: 'select', options: [800, 1000, 1200, 1600, 2000], format: (v) => `${v} m`, note: 'Larger regions mean fewer, bigger downloads.' },
      { key: 'prefetchRadius', label: 'Prefetch radius', type: 'select', options: [0, 1, 2], format: (v) => ['Current region only', 'One region ahead', 'Two regions ahead'][v] },
      { key: 'useOvertureBuildings', label: 'Complete building coverage', type: 'toggle', note: 'Fills gaps in live OpenStreetMap with real footprints from the monthly Overture Maps buildings release.' },
      { key: 'useOverturePlaces', label: 'Complete restaurant coverage', type: 'toggle', note: 'Fills missing restaurant POIs worldwide from the monthly Overture Maps Places release. Live OpenStreetMap remains preferred.' },
      { key: 'overpassTimeout', label: 'Map server timeout', type: 'range', min: 30, max: 180, step: 10, unit: ' s' },
      { key: 'cacheEnabled', label: 'Cache downloaded map data', type: 'toggle' },
      { key: '__cache', label: 'Storage', type: 'cache' },
    ],
  },
];

export const DEFAULT_BINDINGS = {
  forward:   ['KeyW', 'ArrowUp'],
  back:      ['KeyS', 'ArrowDown'],
  left:      ['KeyA', 'ArrowLeft'],
  right:     ['KeyD', 'ArrowRight'],
  jump:      ['Space'],
  sprint:    ['ShiftLeft', 'ShiftRight'],
  crouch:    ['ControlLeft', 'KeyC'],
  interact:  ['KeyE'],
  map:       ['KeyM'],
  photo:     ['KeyP'],
  flyUp:     ['KeyR'],
  flyDown:   ['KeyF'],
  toggleHud: ['KeyH'],
  voxel:     ['KeyV'],
  craft:     ['Tab', 'KeyQ'],
  creative:  ['KeyG'],
  pause:     ['Escape'],
};

export class Settings {
  constructor() {
    this.values = deepClone(DEFAULTS);
    this.bindings = deepClone(DEFAULT_BINDINGS);
    this.listeners = new Set();
    this.load();
  }

  get graphics() { return this.values.graphics; }
  get controls() { return this.values.controls; }
  get audio() { return this.values.audio; }
  get world() { return this.values.world; }
  get gameplay() { return this.values.gameplay; }
  get data() { return this.values.data; }

  /** Read a value with `'graphics.shadows'` style paths. */
  get(path) {
    const parts = path.split('.');
    let v = this.values;
    for (const p of parts) {
      if (v == null) return undefined;
      v = v[p];
    }
    return v;
  }

  set(section, key, value) {
    const block = this.values[section];
    if (!block || !(key in block)) return false;
    const before = block[key];
    block[key] = value;
    // Editing any graphics value by hand means we are no longer on a preset.
    if (section === 'graphics' && key !== 'quality' && before !== value) {
      this.values.graphics.quality = 'custom';
    }
    this.save();
    this.emit(section, key, value);
    return true;
  }

  applyPreset(name) {
    const preset = PRESETS[name];
    if (!preset) return false;
    Object.assign(this.values.graphics, deepClone(preset));
    this.values.graphics.quality = name;
    this.save();
    this.emit('graphics', '*', name);
    return true;
  }

  setBinding(action, codes) {
    if (!(action in this.bindings)) return false;
    this.bindings[action] = codes.slice(0, 3);
    this.save();
    this.emit('bindings', action, codes);
    return true;
  }

  resetBindings() {
    this.bindings = deepClone(DEFAULT_BINDINGS);
    this.save();
    this.emit('bindings', '*', null);
  }

  resetAll() {
    this.values = deepClone(DEFAULTS);
    this.bindings = deepClone(DEFAULT_BINDINGS);
    this.save();
    this.emit('*', '*', null);
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(section, key, value) {
    for (const fn of this.listeners) {
      try { fn(section, key, value); } catch (e) { console.warn('settings listener failed', e); }
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        values: this.values, bindings: this.bindings,
      }));
    } catch (e) { /* private browsing, quota - the session still works */ }
  }

  load() {
    let raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      // mergeKnown drops keys that no longer exist and keeps defaults for new
      // ones, so an old save never breaks a newer build.
      if (parsed.values) mergeKnown(this.values, parsed.values);
      if (parsed.bindings) {
        for (const action in this.bindings) {
          if (Array.isArray(parsed.bindings[action])) this.bindings[action] = parsed.bindings[action];
        }
      }
    } catch (e) { /* corrupt save: fall back to defaults */ }
    this.clampAll();
  }

  /** Keep loaded values inside the ranges the schema advertises. */
  clampAll() {
    for (const section of SCHEMA) {
      const block = this.values[section.id];
      if (!block) continue;
      for (const item of section.items) {
        if (item.key.startsWith('__')) continue;
        const v = block[item.key];
        if (item.type === 'range' && typeof v === 'number') {
          block[item.key] = clamp(v, item.min, item.max);
        } else if (item.type === 'select' && item.options && !item.options.includes(v)) {
          block[item.key] = DEFAULTS[section.id][item.key];
        } else if (item.type === 'toggle' && typeof v !== 'boolean') {
          block[item.key] = DEFAULTS[section.id][item.key];
        }
      }
    }
  }

  /**
   * Pick a starting preset from what the device looks capable of. Only used
   * the very first time, before the player has expressed a preference.
   */
  autoDetectQuality() {
    const mem = navigator.deviceMemory || 4;
    const cores = navigator.hardwareConcurrency || 4;
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
    const dpr = window.devicePixelRatio || 1;
    let name = 'medium';
    if (mobile || mem <= 2 || cores <= 2) name = 'low';
    else if (mem >= 8 && cores >= 8 && dpr <= 2) name = 'high';
    if (mem <= 1) name = 'potato';
    return name;
  }

  /** True the first time the game is ever launched on this browser. */
  get isFirstRun() {
    try { return !localStorage.getItem(STORAGE_KEY); } catch (e) { return true; }
  }
}

export const settings = new Settings();

// The material library.
//
// The single biggest lever on performance in a city is draw calls, so this
// deliberately keeps the material count tiny and pushes per-feature variation
// into vertex colours instead. Every building in a chunk shares one facade
// material and one roof material per roofing pattern, which lets the chunk
// builder merge thousands of buildings into a couple of meshes.
//
// Materials are created once and reused for the life of the session; only
// their time-of-day-dependent uniforms change.

import * as THREE from 'three';
import {
  facadeTexture, groundFloorTexture, roofTexture, surfaceTexture,
  roadMarkingTexture, barkTexture, foliageTexture, grassBladeTexture,
  waterNormalTexture, radialSprite, signGlyphTexture,
} from './textures.js';
import { FACADE_BAYS, BAY_WIDTH, FLOOR_HEIGHT } from './textures.js';
import { clamp, smoothstep } from '../core/util.js';

/** Surfaces that share a look get one material between them. */
const SURFACE_FAMILY = {
  asphalt: 'asphalt', tar_paper: 'asphalt', rubber: 'asphalt',
  concrete: 'concrete', metal: 'concrete',
  paving_stones: 'paving_stones', sett: 'sett', cobblestone: 'cobblestone',
  unhewn_cobblestone: 'cobblestone', bricks: 'bricks',
  gravel: 'gravel', fine_gravel: 'fine_gravel', pebblestone: 'gravel', compacted: 'compacted',
  dirt: 'dirt', ground: 'dirt', earth: 'dirt', mud: 'dirt',
  sand: 'sand', grass: 'grass', grass_paver: 'grass',
  wood: 'wood', snow: 'snow', ice: 'snow',
};

export function surfaceFamily(id) {
  return SURFACE_FAMILY[id] || 'concrete';
}

/** Fine ground texture used beneath the more specific OSM land-cover areas. */
export function terrainFamilyForBiome(biomeId) {
  if (biomeId === 'desert') return 'sand';
  if (biomeId === 'polar') return 'snow';
  if (biomeId === 'tundra' || biomeId === 'alpine') return 'gravel';
  if (biomeId === 'savanna' || biomeId === 'mediterranean') return 'dirt';
  return 'grass';
}

/**
 * The two ends of a biome's ground, which NDVI mixes between.
 *
 * The satellite already tells us how much is growing at every point on Earth,
 * and that measurement was only being used to tint one texture - so a parched
 * hillside and the irrigated valley below it were the same grass in different
 * colours. Giving the biome a bare end and a living end and letting the
 * measurement choose between them puts the satellite in charge of what the
 * ground *is*, not merely what shade it takes.
 */
export function terrainBareFamily(biomeId) {
  if (biomeId === 'desert') return 'sand';
  if (biomeId === 'polar') return 'snow';
  if (biomeId === 'tundra' || biomeId === 'alpine') return 'gravel';
  return 'dirt';
}

export function terrainLushFamily(biomeId) {
  if (biomeId === 'polar') return 'snow';
  if (biomeId === 'desert') return 'dirt';       // an oasis is damp ground, not lawn
  return 'grass';
}

export class MaterialLibrary {
  constructor(settings) {
    this.settings = settings;
    this.cache = new Map();
    this.nightFactor = 0;        // 0 = day, 1 = fully dark
    this.tracked = [];           // materials whose emissive follows the clock
    this.waterTime = 0;
  }

  anisotropy() { return this.settings.graphics.anisotropy; }

  get(key, build) {
    if (this.cache.has(key)) return this.cache.get(key);
    const m = build();
    this.cache.set(key, m);
    return m;
  }

  /**
   * Facade material. `band` is 'ground' or 'upper'; `style` selects the window
   * pattern. Colour is per-vertex, so one material covers every building.
   */
  facade(band, style) {
    return this.get(`facade:${band}:${style}`, () => {
      const t = band === 'ground' ? groundFloorTexture(style) : facadeTexture(style);
      t.map.anisotropy = this.anisotropy();
      const mat = new THREE.MeshStandardMaterial({
        map: t.map,
        emissiveMap: t.emissive,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0,
        vertexColors: true,
        roughness: style === 'curtain' ? 0.22 : 0.86,
        metalness: style === 'curtain' ? 0.35 : 0.02,
        side: THREE.FrontSide,
      });
      mat.userData.litAtNight = true;
      this.tracked.push(mat);
      return mat;
    });
  }

  roof(pattern) {
    return this.get(`roof:${pattern}`, () => {
      const map = roofTexture(pattern);
      map.anisotropy = this.anisotropy();
      return new THREE.MeshStandardMaterial({
        map,
        vertexColors: true,
        roughness: pattern === 'panel' ? 0.42 : 0.9,
        metalness: pattern === 'panel' || pattern === 'corrugated' ? 0.6 : 0.0,
        side: THREE.DoubleSide,
      });
    });
  }

  /** Ground, roads and paved areas. `family` comes from surfaceFamily(). */
  surface(family) {
    return this.get(`surface:${family}`, () => {
      const map = surfaceTexture(family);
      map.anisotropy = this.anisotropy();
      map.repeat.set(1, 1);
      return new THREE.MeshStandardMaterial({
        map,
        vertexColors: true,
        roughness: family === 'snow' ? 0.75 : 0.95,
        metalness: 0,
        side: THREE.FrontSide,
      });
    });
  }

  /** Road markings, drawn slightly above the carriageway. */
  markings(kind) {
    return this.get(`markings:${kind}`, () => {
      const map = roadMarkingTexture(kind);
      map.anisotropy = this.anisotropy();
      return new THREE.MeshStandardMaterial({
        map,
        transparent: true,
        roughness: 0.85,
        metalness: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        side: THREE.FrontSide,
      });
    });
  }

  /**
   * Terrain. The default is a repeating, biome-appropriate ground texture;
   * aerial imagery is still accepted per chunk when the user asks for it.
   */
  terrain(map = null, biomeId = 'temperateBroadleaf') {
    if (!map) {
      return this.get(`terrain:landscape:${biomeId}`, () => {
        // Surface textures are shared elsewhere at a different UV scale. Clone
        // the texture object while retaining its canvas so this repeat does not
        // turn a park or footpath into the same 8-metre-scale pattern.
        const clone = (family, repeat) => {
          const t = surfaceTexture(family).clone();
          t.anisotropy = this.anisotropy();
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(repeat, repeat);
          t.needsUpdate = true;
          return t;
        };
        const bareFamily = terrainBareFamily(biomeId);
        const bare = clone(bareFamily, 32);
        const lush = clone(terrainLushFamily(biomeId), 32);

        const mat = new THREE.MeshStandardMaterial({
          map: bare, vertexColors: true,
          roughness: bareFamily === 'snow' ? 0.78 : 0.97,
          metalness: 0,
        });

        // Two things the stock material cannot do on its own: mix a second
        // ground by the satellite's vegetation reading, and break up the tiling.
        // One texture repeated 32 times across a chunk is a visible 8 m grid
        // from any distance, so each ground is also sampled at a much coarser
        // scale and the two are averaged - the low frequency hides the seam of
        // the high one without needing a third texture.
        mat.onBeforeCompile = (shader) => {
          shader.uniforms.uLush = { value: lush };
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>',
                     '#include <common>\nattribute float aVeg;\nvarying float vVeg;')
            .replace('#include <begin_vertex>',
                     '#include <begin_vertex>\n\tvVeg = aVeg;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>',
                     '#include <common>\nuniform sampler2D uLush;\nvarying float vVeg;')
            .replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec4 bareTex = mix(texture2D(map, vMapUv), texture2D(map, vMapUv * 0.1734), 0.42);
  vec4 lushTex = mix(texture2D(uLush, vMapUv), texture2D(uLush, vMapUv * 0.2113), 0.42);
  diffuseColor *= mix(bareTex, lushTex, clamp(vVeg, 0.0, 1.0));
#endif
            `);
          mat.userData.shader = shader;
        };
        // Anything that changes the program has to be part of the cache key, or
        // three will reuse a compiled program from a differently patched clone.
        mat.customProgramCacheKey = () => `terrain-veg:${biomeId}`;
        return mat;
      });
    }
    map.anisotropy = this.anisotropy();
    return new THREE.MeshStandardMaterial({
      map, vertexColors: true, roughness: 0.95, metalness: 0,
    });
  }

  /**
   * Flat roofs draped with the chunk's aerial photograph.
   *
   * Satellite imagery is a top-down view, which is exactly what a flat roof
   * looks like - so rather than inventing a roof texture we can use the real
   * one, aligned to the building because the UVs come from world position.
   * A fresh material per chunk, since each carries its own texture.
   */
  aerialRoof(map) {
    map.anisotropy = this.anisotropy();
    return new THREE.MeshStandardMaterial({
      map, vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide,
    });
  }

  water() {
    return this.get('water', () => {
      const normalMap = waterNormalTexture();
      normalMap.repeat.set(24, 24);
      normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
      const mat = new THREE.MeshStandardMaterial({
        color: 0x2c4f66,
        normalMap,
        normalScale: new THREE.Vector2(0.55, 0.55),
        roughness: 0.08,
        metalness: 0.15,
        transparent: true,
        opacity: 0.86,
        side: THREE.DoubleSide,
      });
      mat.userData.animatedNormals = normalMap;
      return mat;
    });
  }

  /** Tree trunks. Colour per instance via instanceColor. */
  bark(kind = 'rough') {
    return this.get(`bark:${kind}`, () => {
      const map = barkTexture(kind);
      map.anisotropy = this.anisotropy();
      map.repeat.set(1, 3);
      return new THREE.MeshStandardMaterial({
        map, vertexColors: true, roughness: 0.94, metalness: 0,
      });
    });
  }

  /** Canopy cards. Alpha-tested rather than blended, so they sort correctly. */
  foliage(kind = 'broadleaf') {
    return this.get(`foliage:${kind}`, () => {
      const map = foliageTexture(kind);
      map.anisotropy = this.anisotropy();
      return new THREE.MeshStandardMaterial({
        map,
        vertexColors: true,
        transparent: false,
        alphaTest: 0.42,
        roughness: 0.88,
        metalness: 0,
        side: THREE.DoubleSide,
      });
    });
  }

  grass() {
    return this.get('grass', () => {
      const map = grassBladeTexture();
      return new THREE.MeshStandardMaterial({
        map,
        vertexColors: true,
        transparent: false,
        alphaTest: 0.35,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
      });
    });
  }

  /** Untextured, vertex-coloured material for props, walls and interiors. */
  solid(opts = {}) {
    const key = `solid:${opts.roughness ?? 0.85}:${opts.metalness ?? 0}:${opts.side ?? 0}:${opts.flat ? 1 : 0}`;
    return this.get(key, () => new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: opts.roughness ?? 0.85,
      metalness: opts.metalness ?? 0,
      side: opts.side === 2 ? THREE.DoubleSide : THREE.FrontSide,
      flatShading: !!opts.flat,
    }));
  }

  glass() {
    return this.get('glass', () => new THREE.MeshStandardMaterial({
      color: 0x9fb6c4, roughness: 0.08, metalness: 0.2,
      transparent: true, opacity: 0.32, side: THREE.DoubleSide,
    }));
  }

  /** Emissive material for lamps and lit signage. */
  emissive(colour = 0xffe6b8) {
    return this.get(`emissive:${colour}`, () => {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x111111,
        emissive: new THREE.Color(colour),
        emissiveIntensity: 1,
        roughness: 0.5,
      });
      mat.userData.lampAtNight = true;
      this.tracked.push(mat);
      return mat;
    });
  }

  /** Shared transparent glyph atlas for every named storefront sign. */
  restaurantSignText() {
    return this.get('restaurant-sign-text', () => {
      const map = signGlyphTexture();
      map.anisotropy = this.anisotropy();
      const mat = new THREE.MeshStandardMaterial({
        map,
        emissiveMap: map,
        emissive: new THREE.Color(0xfff0cc),
        emissiveIntensity: 0,
        vertexColors: true,
        transparent: true,
        alphaTest: 0.18,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        roughness: 0.58,
        metalness: 0,
        side: THREE.FrontSide,
      });
      mat.userData.litAtNight = true;
      this.tracked.push(mat);
      return mat;
    });
  }

  sprite(hardness, tint) {
    return this.get(`sprite:${hardness}:${tint}`, () => new THREE.SpriteMaterial({
      map: radialSprite(hardness, tint), transparent: true, depthWrite: false,
    }));
  }

  /**
   * Update everything that depends on the sun.
   * `sunElevation` is in degrees; windows come on as the sun goes down.
   */
  updateForSun(sunElevationDeg, dt = 0) {
    // Fade the night factor in across civil twilight rather than snapping.
    const night = 1 - smoothstep((sunElevationDeg + 6) / 12);
    this.nightFactor = night;
    for (const mat of this.tracked) {
      if (mat.userData.litAtNight) mat.emissiveIntensity = night * 1.15;
      else if (mat.userData.lampAtNight) mat.emissiveIntensity = 0.12 + night * 1.6;
    }
    const water = this.cache.get('water');
    if (water && water.userData.animatedNormals && dt) {
      this.waterTime += dt;
      const n = water.userData.animatedNormals;
      n.offset.x = this.waterTime * 0.014;
      n.offset.y = this.waterTime * 0.021;
    }
  }

  /** Anisotropy changed in the settings menu: push it to every texture. */
  refreshFiltering() {
    const a = this.anisotropy();
    for (const mat of this.cache.values()) {
      for (const slot of ['map', 'emissiveMap', 'normalMap', 'roughnessMap']) {
        if (mat[slot]) { mat[slot].anisotropy = a; mat[slot].needsUpdate = true; }
      }
    }
  }

  dispose() {
    for (const m of this.cache.values()) if (m.dispose) m.dispose();
    this.cache.clear();
    this.tracked.length = 0;
  }
}

/**
 * Facade UV scale.
 *
 * A facade texture holds FACADE_BAYS window bays across and the same number of
 * storeys down, so one texture repeat covers `BAY_WIDTH * FACADE_BAYS` metres
 * of frontage. Mapping real metres through this is what makes a window look
 * like a window at any building size, rather than a stretched rectangle.
 */
export const FACADE_U_PER_METRE = 1 / (BAY_WIDTH * FACADE_BAYS);
export const FACADE_V_PER_METRE = 1 / (FLOOR_HEIGHT * FACADE_BAYS);

/** Pick a window style from a building's class, height and materials. */
export function facadeStyleFor(building) {
  const kind = building.kind;
  const levels = building.levels;
  const mat = building.facade.material;
  // A curtain wall is a post-war invention, and `building:architecture` and
  // `start_date` are the tags that say so. Without them a nineteenth-century
  // palais tagged as offices was glazed like a bank tower.
  const era = building.era;
  const old = !!(era && (era.period === 'historic' || era.ornate));
  if (mat && mat.pattern === 'curtain' && !old) return 'curtain';
  if (kind === 'industrial' || kind === 'barn') return 'industrial';
  if (kind === 'shed' || kind === 'parking' || kind === 'canopy') return 'none';
  if (kind === 'worship') return 'arched';
  if (old) return levels >= 3 ? 'tall' : 'plain';
  if (kind === 'office' && levels >= 8) return 'curtain';
  if (kind === 'office') return 'grid';
  if (kind === 'castle' || kind === 'tower') return 'slit';
  if (kind === 'apartments' && levels >= 4) return 'tall';
  if (kind === 'hotel') return 'grid';
  if (kind === 'house') return 'house';
  return 'plain';
}

/** Pick the ground-floor treatment. */
export function groundStyleFor(building) {
  const kind = building.kind;
  if (building.groundUse === 'restaurant' || building.restaurant) return 'shop';
  if (kind === 'retail' || kind === 'office' || kind === 'hotel') return 'shop';
  if (kind === 'house' || kind === 'apartments') return 'residential';
  if (kind === 'industrial' || kind === 'shed' || kind === 'barn' ||
      kind === 'parking' || kind === 'canopy') return 'blank';
  return 'shop';
}

/** Map an OSM roof material to one of the roof texture patterns. */
export function roofPatternFor(building) {
  const spec = building.heights.roof;
  if (spec.material && spec.material.pattern) {
    const p = spec.material.pattern;
    if (['tile', 'slate', 'shingle', 'panel', 'corrugated', 'gravel', 'thatch'].includes(p)) return p;
  }
  const shape = spec.shape;
  if (shape === 'flat') return building.levels > 3 ? 'flat' : 'gravel';
  if (building.kind === 'industrial' || building.kind === 'barn') return 'corrugated';
  if (building.kind === 'house') return 'tile';
  // Slate is the grander covering, and grandeur is what a listed nineteenth
  // century block of any size has over a modern one of the same shape.
  const era = building.era;
  if (era && (era.period === 'historic' || era.listed) && building.levels >= 4) return 'slate';
  return 'tile';
}

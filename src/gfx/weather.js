// Weather: cloud cover, precipitation, fog and wind.
//
// Rain and snow are one instanced particle system that follows the camera in a
// box, recycling particles that fall out of the bottom. That keeps a convincing
// downpour to a single draw call and constant memory, and means precipitation
// costs the same whether you are in a field or a city.

import * as THREE from 'three';
import { makeRng } from '../core/rng.js';
import { clamp, lerp, damp } from '../core/util.js';
import { seasonalPhase } from '../geo/nasa.js';

export const PRESETS = {
  clear:    { overcast: 0.05, rain: 0, snow: 0, fog: 0.00035, wind: 2.0, label: 'Clear' },
  cloudy:   { overcast: 0.42, rain: 0, snow: 0, fog: 0.00065, wind: 4.0, label: 'Cloudy' },
  overcast: { overcast: 0.85, rain: 0, snow: 0, fog: 0.0011,  wind: 5.0, label: 'Overcast' },
  rain:     { overcast: 0.92, rain: 1, snow: 0, fog: 0.0022,  wind: 6.5, label: 'Rain' },
  snow:     { overcast: 0.88, rain: 0, snow: 1, fog: 0.0030,  wind: 3.5, label: 'Snow' },
  fog:      { overcast: 0.55, rain: 0, snow: 0, fog: 0.0125,  wind: 1.0, label: 'Fog' },
};

/**
 * Pick weather that suits the place and time of year, so "auto" gives you
 * Reykjavik in November rather than an eternal blue sky.
 */
export function plausibleWeather(lat, date, biomeId, rng = Math.random) {
  const season = seasonalPhase(date, lat);
  const absLat = Math.abs(lat);
  const cold = absLat > 45 && season < 0.35;
  const wet = { tropicalRainforest: 0.55, tropicalSeasonal: 0.35, temperateBroadleaf: 0.3,
                borealConifer: 0.3, tundra: 0.28, alpine: 0.3, mediterranean: 0.12,
                savanna: 0.14, desert: 0.02, polar: 0.2, temperateGrass: 0.2 }[biomeId] ?? 0.25;
  const r = rng();
  if (cold && r < wet + 0.12) return 'snow';
  if (r < wet) return 'rain';
  if (r < wet + 0.22) return 'overcast';
  if (r < wet + 0.48) return 'cloudy';
  return 'clear';
}

const MAX_PARTICLES = 9000;
const BOX = 34;                 // half-extent of the precipitation volume

export class WeatherSystem {
  constructor(scene, settings) {
    this.scene = scene;
    this.settings = settings;
    this.state = { ...PRESETS.clear };
    this.target = { ...PRESETS.clear };
    this.kind = 'clear';
    this.time = 0;
    this.windAngle = Math.random() * Math.PI * 2;

    this.buildParticles();
  }

  buildParticles() {
    // A stretched box reads as a falling streak; for snow it is scaled square.
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xdfe9f2,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 900;
    this.scene.add(this.mesh);

    const rng = makeRng(90210);
    this.particles = new Float32Array(MAX_PARTICLES * 4);   // x, y, z, speedJitter
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles[i * 4] = rng.range(-BOX, BOX);
      this.particles[i * 4 + 1] = rng.range(-BOX * 0.5, BOX);
      this.particles[i * 4 + 2] = rng.range(-BOX, BOX);
      this.particles[i * 4 + 3] = rng.range(0.75, 1.35);
    }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  /** Choose the weather. `kind` may be any PRESETS key. */
  set(kind) {
    const preset = PRESETS[kind] || PRESETS.clear;
    this.kind = kind;
    this.target = { ...preset };
    // On a first set, snap rather than crossfade.
    if (!this._initialised) { this.state = { ...preset }; this._initialised = true; }
  }

  get label() { return PRESETS[this.kind] ? PRESETS[this.kind].label : 'Clear'; }

  /** Values the sky and audio systems read. */
  get overcast() { return this.state.overcast; }
  get fogDensity() { return this.state.fog; }
  get windSpeed() { return this.state.wind * (this.settings.world.windSpeed / 3.5); }
  get precipitation() { return Math.max(this.state.rain, this.state.snow); }

  update(dt, cameraPosition, indoors = false) {
    this.time += dt;
    // Ease between weather states so a change is a change in the sky, not a cut.
    for (const key of ['overcast', 'rain', 'snow', 'fog', 'wind']) {
      this.state[key] = damp(this.state[key], this.target[key], 0.6, dt);
    }
    // Wind wanders slowly rather than blowing from one fixed bearing forever.
    this.windAngle += Math.sin(this.time * 0.043) * dt * 0.12;

    // Rain does not fall inside a building.
    const amount = indoors ? 0 : this.precipitation;
    if (amount < 0.01) { this.mesh.count = 0; return; }

    const isSnow = this.state.snow > this.state.rain;
    const density = clamp(amount, 0, 1) *
                    clamp(this.settings.graphics.vegetationDensity * 0.5 + 0.5, 0.3, 1.4);
    const count = Math.floor(MAX_PARTICLES * density);
    this.mesh.count = count;

    const fall = isSnow ? 1.6 : 22;
    const windX = Math.cos(this.windAngle) * this.windSpeed * (isSnow ? 0.55 : 0.32);
    const windZ = Math.sin(this.windAngle) * this.windSpeed * (isSnow ? 0.55 : 0.32);

    const mat = this.mesh.material;
    mat.opacity = isSnow ? 0.75 : 0.34;
    mat.color.setHex(isSnow ? 0xffffff : 0xcfe0ee);

    const cx = cameraPosition.x, cy = cameraPosition.y, cz = cameraPosition.z;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const jitter = this.particles[o + 3];
      this.particles[o] += windX * dt * jitter;
      this.particles[o + 1] -= fall * dt * jitter;
      this.particles[o + 2] += windZ * dt * jitter;
      if (isSnow) {
        // Snow drifts; rain does not.
        this.particles[o] += Math.sin(this.time * 1.7 + i) * dt * 0.5;
        this.particles[o + 2] += Math.cos(this.time * 1.3 + i * 0.7) * dt * 0.5;
      }
      // Recycle anything that leaves the box, keeping it camera-relative.
      if (this.particles[o + 1] < -BOX * 0.5) {
        this.particles[o + 1] += BOX * 1.5;
        this.particles[o] = ((this.particles[o] + BOX) % (BOX * 2) + BOX * 2) % (BOX * 2) - BOX;
        this.particles[o + 2] = ((this.particles[o + 2] + BOX) % (BOX * 2) + BOX * 2) % (BOX * 2) - BOX;
      }
      if (Math.abs(this.particles[o]) > BOX) this.particles[o] -= Math.sign(this.particles[o]) * BOX * 2;
      if (Math.abs(this.particles[o + 2]) > BOX) this.particles[o + 2] -= Math.sign(this.particles[o + 2]) * BOX * 2;

      this._p.set(cx + this.particles[o], cy + this.particles[o + 1], cz + this.particles[o + 2]);
      if (isSnow) {
        this._s.set(0.055, 0.055, 0.055);
        this._q.identity();
      } else {
        // Streak along the direction of travel.
        this._s.set(0.016, 0.62 * jitter, 1);
        this._q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(windX, fall));
      }
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

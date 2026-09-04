// Sky, sun, moon and atmosphere rendering.
//
// Positions come from solar.js; this module is only concerned with turning them
// into light, colour and fog.

import * as THREE from 'three';
import { Sky } from 'three/addons/Sky.js';
import { starfieldTexture } from './textures.js';
import { DEG, clamp, smoothstep, lerp } from '../core/util.js';
import { solarPosition, lunarPosition, sunriseSunset, julianDay, azElToDirection } from './solar.js';

export * from './solar.js';

// --- the rendered sky ------------------------------------------------------

// The sky dome and star sphere have to sit inside the camera's far plane or
// they are simply clipped away and you get a black void where the sky should
// be. Render distance is a setting, so this is recomputed whenever it changes
// rather than being a fixed constant.
const DEFAULT_SKY_RADIUS = 4000;

export class SkySystem {
  constructor(scene, renderer, settings) {
    this.scene = scene;
    this.renderer = renderer;
    this.settings = settings;
    this.skyRadius = DEFAULT_SKY_RADIUS;

    this.sky = new Sky();
    this.sky.scale.setScalar(this.skyRadius);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sunDirection = new THREE.Vector3(0, 1, 0);
    this.moonDirection = new THREE.Vector3(0, -1, 0);

    // Key light. The shadow camera is retargeted every frame to follow the
    // player, which is what keeps 4k shadow maps sharp in a city.
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 800;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.06;
    this.sunTarget = new THREE.Object3D();
    scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    // Sky fill and bounce. Hemisphere light is cheap and reads convincingly as
    // skylight plus ground bounce, which matters far more than it sounds in
    // narrow streets where the sun never reaches.
    this.hemi = new THREE.HemisphereLight(0x9fc0e8, 0x6a6558, 1.0);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.15);
    scene.add(this.ambient);

    this.moon = new THREE.DirectionalLight(0xbfd0ff, 0);
    scene.add(this.moon);

    this.buildStars();

    this.fog = new THREE.FogExp2(0xbfd4e6, 0.0011);
    scene.fog = this.fog;

    this.state = {
      elevation: 45, azimuth: 180, night: 0, phase: 'day',
      sunrise: null, sunset: null, polar: null, moonPhase: 0.5,
    };
    this.turbidity = 3.2;
    this.overcast = 0;
  }

  buildStars() {
    // Unit sphere, scaled to fit the far plane by fitToCamera().
    const geo = new THREE.SphereGeometry(1, 32, 20);
    const mat = new THREE.MeshBasicMaterial({
      map: starfieldTexture(),
      side: THREE.BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.stars = new THREE.Mesh(geo, mat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1000;
    this.scene.add(this.stars);

    // A visible moon disc, drawn as a sprite so it always faces the camera.
    const moonMat = new THREE.SpriteMaterial({
      color: 0xf5f2e8, transparent: true, opacity: 0, depthWrite: false, fog: false,
    });
    this.moonSprite = new THREE.Sprite(moonMat);
    this.moonSprite.scale.setScalar(this.skyRadius * 0.035);
    this.moonSprite.renderOrder = -999;
    this.scene.add(this.moonSprite);
  }

  /**
   * Place the sun and moon and grade the whole scene for the time of day.
   * `date` is a real Date; `lat`/`lon` the player's actual coordinates.
   */
  update(date, lat, lon, weather = null, dt = 0) {
    const sun = solarPosition(date, lat, lon);
    const moon = lunarPosition(date, lat, lon);
    const rs = sunriseSunset(date, lat, lon);

    azElToDirection(sun.azimuth, sun.elevation, this.sunDirection);
    azElToDirection(moon.azimuth, moon.elevation, this.moonDirection);

    const elev = sun.elevation;
    // Night ramps across civil twilight rather than snapping at the horizon.
    const night = 1 - smoothstep((elev + 6) / 12);
    // Golden hour: how close the sun is to the horizon while still up.
    const golden = elev > -2 && elev < 12 ? 1 - Math.abs(elev - 4) / 8 : 0;

    const overcast = this.overcast = weather ? weather.overcast || 0 : 0;

    // Sky shader parameters.
    const u = this.sky.material.uniforms;
    u.turbidity.value = lerp(2.4, 12, overcast) + golden * 3;
    u.rayleigh.value = lerp(lerp(2.6, 0.4, overcast), 0.15, night);
    u.mieCoefficient.value = lerp(0.004, 0.02, overcast) + golden * 0.008;
    u.mieDirectionalG.value = lerp(0.8, 0.92, overcast);
    u.sunPosition.value.copy(this.sunDirection);

    // Sun light: colour warms and dims as it approaches the horizon, and the
    // atmosphere it has to cross gets thicker the lower it goes.
    const above = clamp(elev / 90, -1, 1);
    const airMass = elev > 0 ? 1 / Math.max(0.05, Math.sin(Math.max(elev, 1) * DEG)) : 40;
    const extinction = Math.exp(-0.16 * Math.min(airMass, 12));
    const sunIntensity = clamp(above * 7.5, 0, 7.5) * extinction * (1 - overcast * 0.72);
    this.sun.intensity = Math.max(0, sunIntensity);
    this.sun.visible = elev > -1.5 && this.sun.intensity > 0.005;
    this.sun.color.setRGB(
      1,
      lerp(0.62, 1, clamp(elev / 22, 0, 1)),
      lerp(0.32, 0.98, clamp(elev / 30, 0, 1)));

    // Moonlight is faint, blue, and only worth having once it is properly dark.
    const moonUp = clamp(moon.elevation / 25, 0, 1);
    this.moon.position.copy(this.moonDirection).multiplyScalar(1000);
    this.moon.intensity = moonUp * night * (0.25 + moon.phase * 0.45);
    this.moon.visible = this.moon.intensity > 0.004;
    this.moonSprite.material.opacity = clamp(moonUp * 1.4, 0, 1) * (0.25 + moon.phase * 0.75) * (1 - overcast * 0.9);

    // Sky fill.
    const daySky = new THREE.Color(0x8fb6e0);
    const nightSky = new THREE.Color(0x1a2436);
    const duskSky = new THREE.Color(0xd8a074);
    const skyCol = daySky.clone().lerp(duskSky, golden * 0.7).lerp(nightSky, night);
    const groundCol = new THREE.Color(0x6a6558).lerp(new THREE.Color(0x14161c), night);
    this.hemi.color.copy(skyCol);
    this.hemi.groundColor.copy(groundCol);
    // Skylight is the only thing lighting a shadowed street, and in a city
    // that is most of what you are looking at. Under-doing it is what makes
    // shadows read as holes rather than as shade.
    // Skylight is the only thing lighting a shadowed street, and in a city
    // that is most of what you are looking at. Under-doing it is what makes
    // shadows read as holes rather than as shade.
    this.hemi.intensity = lerp(lerp(1.9, 2.4, overcast), 0.13, night);
    // Ambient stands in for the light that has bounced off everything else.
    // Without a meaningful amount of it a sunlit street between six-storey
    // buildings renders as a black trench, which is not what it looks like.
    this.ambient.intensity = lerp(0.5, 0.06, night);

    // Stars fade in through twilight and are washed out by cloud.
    this.stars.material.opacity = clamp(night * 1.15 - 0.1, 0, 1) * (1 - overcast * 0.95);
    this.stars.visible = this.stars.material.opacity > 0.01;
    this.stars.rotation.y = (julianDay(date) % 1) * Math.PI * 2;

    // Fog: distance haze by day, deeper and cooler at night.
    let density = lerp(0.00028, 0.0026, overcast);
    if (weather) density = Math.max(density, weather.fogDensity || 0);
    this.fog.density = density * lerp(1, 1.5, night);
    const fogCol = skyCol.clone().lerp(new THREE.Color(0xffffff), overcast * 0.35);
    this.fog.color.copy(fogCol);
    if (this.renderer) this.renderer.setClearColor(fogCol);

    this.state = {
      elevation: elev,
      azimuth: sun.azimuth,
      night,
      golden,
      phase: elev > 6 ? 'day' : elev > -0.833 ? 'golden' : elev > -6 ? 'civil' :
             elev > -12 ? 'nautical' : elev > -18 ? 'astronomical' : 'night',
      sunrise: rs.sunrise, sunset: rs.sunset, polar: rs.polar,
      moonPhase: moon.phase, moonElevation: moon.elevation,
    };
    return this.state;
  }

  /**
   * Point the shadow camera at the player, sized to the shadow distance.
   * Re-centring every frame is what lets a modest shadow map stay crisp.
   */
  followCamera(position) {
    const d = this.settings.graphics.shadowDistance;
    const cam = this.sun.shadow.camera;
    if (cam.right !== d) {
      cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
      cam.far = d * 4 + 200;
      cam.updateProjectionMatrix();
    }
    // Snap to texel-sized steps so shadows do not shimmer as you walk.
    const texel = (d * 2) / this.sun.shadow.mapSize.x;
    const sx = Math.round(position.x / texel) * texel;
    const sz = Math.round(position.z / texel) * texel;
    this.sunTarget.position.set(sx, position.y, sz);
    this.sun.position.copy(this.sunDirection).multiplyScalar(d * 2.2).add(this.sunTarget.position);
    this.sun.updateMatrixWorld();
    this.sunTarget.updateMatrixWorld();

    this.sky.position.set(position.x, 0, position.z);
    this.stars.position.set(position.x, position.y, position.z);
    this.moonSprite.position.copy(this.moonDirection).multiplyScalar(this.skyRadius * 0.86).add(position);
  }

  /**
   * Size the sky and stars to sit just inside the camera's far plane.
   * Called whenever render distance changes.
   */
  fitToCamera(camera) {
    const radius = Math.max(600, camera.far * 0.88);
    if (Math.abs(radius - this.skyRadius) < 1) return;
    this.skyRadius = radius;
    this.sky.scale.setScalar(radius);
    this.stars.scale.setScalar(radius * 0.94);
    this.moonSprite.scale.setScalar(radius * 0.035);
  }

  applySettings() {
    const g = this.settings.graphics;
    this.sun.castShadow = g.shadows;
    if (this.sun.shadow.mapSize.x !== g.shadowResolution) {
      this.sun.shadow.mapSize.set(g.shadowResolution, g.shadowResolution);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
  }

  dispose() {
    this.scene.remove(this.sky, this.sun, this.sunTarget, this.hemi, this.ambient, this.moon, this.stars, this.moonSprite);
    this.sky.geometry.dispose();
    this.sky.material.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.moonSprite.material.dispose();
  }
}

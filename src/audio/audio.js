// Sound, synthesised.
//
// The game ships no audio files. Wind, rain, city rumble, birdsong and every
// footstep are generated with the Web Audio API at runtime, which keeps the
// download to nothing and lets the soundscape respond continuously to where you
// are: footsteps change with the surface under the capsule, birds only sing
// where NDVI says something grows, traffic rumble rises with road density.

import { clamp, lerp, damp } from '../core/util.js';
import { makeRng } from '../core/rng.js';

/** A short noise buffer, reused as the source for most textures here. */
function makeNoiseBuffer(ctx, seconds = 3, kind = 'white') {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rng = makeRng(kind === 'white' ? 7 : 13);
  if (kind === 'brown') {
    // Integrated white noise: much more like wind and distant traffic than
    // white noise, which reads as hiss.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const w = rng() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
  } else if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < length; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
    }
  } else {
    for (let i = 0; i < length; i++) data[i] = rng() * 2 - 1;
  }
  return buffer;
}

/** Per-surface footstep character: filter shape, decay and pitch. */
const FOOTSTEPS = {
  concrete: { freq: 1500, q: 1.1, decay: 0.10, gain: 0.55, noise: 'white', thump: 90 },
  stone:    { freq: 1900, q: 1.4, decay: 0.09, gain: 0.6,  noise: 'white', thump: 110 },
  gravel:   { freq: 3400, q: 0.7, decay: 0.16, gain: 0.5,  noise: 'white', thump: 70 },
  dirt:     { freq: 700,  q: 0.9, decay: 0.11, gain: 0.42, noise: 'brown', thump: 62 },
  grass:    { freq: 2600, q: 0.6, decay: 0.13, gain: 0.3,  noise: 'white', thump: 48 },
  sand:     { freq: 1800, q: 0.5, decay: 0.17, gain: 0.34, noise: 'white', thump: 44 },
  wood:     { freq: 1000, q: 2.2, decay: 0.13, gain: 0.5,  noise: 'white', thump: 140 },
  metal:    { freq: 2400, q: 4.0, decay: 0.22, gain: 0.42, noise: 'white', thump: 220 },
  snow:     { freq: 1100, q: 0.6, decay: 0.14, gain: 0.36, noise: 'white', thump: 40 },
  water:    { freq: 900,  q: 0.8, decay: 0.24, gain: 0.55, noise: 'white', thump: 55 },
  carpet:   { freq: 600,  q: 0.7, decay: 0.09, gain: 0.24, noise: 'brown', thump: 46 },
  tile:     { freq: 2200, q: 2.6, decay: 0.11, gain: 0.55, noise: 'white', thump: 130 },
};

export class AudioEngine {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.started = false;
    this.enabled = true;
    this.rng = makeRng(31337);
    this.nextBird = 0;
    this.time = 0;
    this.env = { wind: 0.3, traffic: 0, birds: 0, rain: 0, indoor: 0, water: 0 };
    this.targetEnv = { ...this.env };
  }

  /**
   * Browsers will not start audio without a gesture, so this is called from
   * the first click or key press rather than at load.
   */
  start() {
    if (this.started) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    try { this.ctx = new Ctx(); } catch (e) { this.enabled = false; return; }
    this.started = true;

    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.settings.audio.master;
    // A gentle limiter stops a busy moment from clipping.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;
    this.master.connect(this.limiter).connect(ctx.destination);

    this.buffers = {
      white: makeNoiseBuffer(ctx, 3, 'white'),
      brown: makeNoiseBuffer(ctx, 4, 'brown'),
      pink: makeNoiseBuffer(ctx, 4, 'pink'),
    };

    this.buildAmbience();
  }

  bus(name, initialGain = 0) {
    const g = this.ctx.createGain();
    g.gain.value = initialGain;
    g.connect(this.master);
    this[`${name}Bus`] = g;
    return g;
  }

  loopNoise(buffer, destination, { type = 'bandpass', freq = 500, q = 0.7, gain = 1 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(destination);
    src.start(0);
    return { src, filter, gain: g };
  }

  buildAmbience() {
    const ctx = this.ctx;

    // Wind: brown noise through a moving bandpass, plus a higher hiss layer
    // that only comes up when it is genuinely blowing.
    this.windBus = this.bus('wind', 0);
    this.wind = this.loopNoise(this.buffers.brown, this.windBus, { freq: 320, q: 0.55, gain: 1 });
    this.windHiss = this.loopNoise(this.buffers.white, this.windBus, { freq: 2600, q: 0.4, gain: 0.06 });

    // Distant traffic: low brown rumble.
    this.trafficBus = this.bus('traffic', 0);
    this.traffic = this.loopNoise(this.buffers.brown, this.trafficBus, { type: 'lowpass', freq: 220, q: 0.7, gain: 1 });

    // Rain: broadband hiss with a low-frequency body.
    this.rainBus = this.bus('rain', 0);
    this.rain = this.loopNoise(this.buffers.white, this.rainBus, { type: 'highpass', freq: 900, q: 0.5, gain: 0.5 });
    this.rainBody = this.loopNoise(this.buffers.pink, this.rainBus, { type: 'lowpass', freq: 700, q: 0.6, gain: 0.35 });

    // Water lapping, for standing near or in it.
    this.waterBus = this.bus('water', 0);
    this.water = this.loopNoise(this.buffers.pink, this.waterBus, { type: 'bandpass', freq: 480, q: 0.8, gain: 0.5 });

    this.birdBus = this.bus('bird', 0);
    this.stepBus = this.bus('step', 1);
    this.uiBus = this.bus('ui', 1);

    // Room tone indoors: a very quiet low hum, which is mostly the absence of
    // everything else but reads as "inside".
    this.indoorBus = this.bus('indoor', 0);
    this.indoor = this.loopNoise(this.buffers.brown, this.indoorBus, { type: 'lowpass', freq: 120, q: 0.6, gain: 0.5 });
  }

  /**
   * Tell the engine about the world around the player. Values are 0..1 and are
   * eased internally, so this can be called every frame with jumpy inputs.
   */
  setEnvironment(env) {
    Object.assign(this.targetEnv, env);
  }

  update(dt) {
    if (!this.started || !this.enabled) return;
    this.time += dt;
    const a = this.settings.audio;
    const muted = a.muteWhenUnfocused && document.hidden;
    this.master.gain.value = damp(this.master.gain.value, muted ? 0 : a.master, 6, dt);
    if (muted) return;

    for (const key in this.targetEnv) {
      this.env[key] = damp(this.env[key], this.targetEnv[key], 1.4, dt);
    }

    const amb = a.ambience;
    const indoorMuffle = 1 - this.env.indoor * 0.78;

    this.windBus.gain.value = this.env.wind * a.wind * amb * 0.34 * indoorMuffle;
    // The wind's voice rises with its speed, and breathes.
    const gust = 0.5 + 0.5 * Math.sin(this.time * 0.31) * Math.sin(this.time * 0.13 + 1.7);
    this.wind.filter.frequency.value = lerp(180, 900, this.env.wind * (0.6 + gust * 0.4));
    this.windHiss.gain.gain.value = 0.02 + this.env.wind * 0.11 * gust;

    this.trafficBus.gain.value = this.env.traffic * amb * 0.3 * indoorMuffle;
    this.traffic.filter.frequency.value = lerp(140, 300, this.env.traffic);

    this.rainBus.gain.value = this.env.rain * amb * 0.42 * indoorMuffle;
    this.waterBus.gain.value = this.env.water * amb * 0.5;
    this.indoorBus.gain.value = this.env.indoor * amb * 0.16;
    this.birdBus.gain.value = amb;

    // Birds, occasionally, where there is greenery and it is light.
    if (this.env.birds > 0.06 && this.time > this.nextBird) {
      this.chirp(this.env.birds);
      this.nextBird = this.time + this.rng.range(0.5, 5.5) / clamp(this.env.birds, 0.1, 1);
    }
  }

  /** A short FM chirp. Randomised enough that no two are quite the same. */
  chirp(strength) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = this.rng.int(2, 5);
    const baseFreq = this.rng.range(1900, 4200);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = this.rng.range(-0.85, 0.85); pan.connect(this.birdBus); }
    const dest = pan || this.birdBus;

    for (let n = 0; n < notes; n++) {
      const t = now + n * this.rng.range(0.06, 0.15);
      const osc = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const modGain = ctx.createGain();
      const g = ctx.createGain();
      osc.type = 'sine';
      mod.type = 'sine';
      mod.frequency.value = this.rng.range(24, 90);
      modGain.gain.value = this.rng.range(120, 700);
      mod.connect(modGain).connect(osc.frequency);

      const f0 = baseFreq * this.rng.range(0.85, 1.2);
      const f1 = f0 * this.rng.range(0.72, 1.5);
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(200, f1), t + 0.07);

      const peak = 0.05 * strength * this.rng.range(0.6, 1.2);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + this.rng.range(0.07, 0.16));

      osc.connect(g).connect(dest);
      osc.start(t); mod.start(t);
      osc.stop(t + 0.25); mod.stop(t + 0.25);
    }
  }

  /**
   * One footstep on a named surface. `intensity` scales with speed, so running
   * is louder and heavier than a stroll.
   */
  footstep(surface = 'concrete', intensity = 1) {
    if (!this.started || !this.enabled) return;
    const spec = FOOTSTEPS[surface] || FOOTSTEPS.concrete;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const vol = this.settings.audio.footsteps * spec.gain * clamp(intensity, 0.2, 1.6);
    if (vol <= 0.001) return;

    // The scuff: filtered noise burst.
    const src = ctx.createBufferSource();
    src.buffer = this.buffers[spec.noise] || this.buffers.white;
    src.playbackRate.value = this.rng.range(0.85, 1.2);
    const offset = this.rng() * (src.buffer.duration - spec.decay - 0.05);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = spec.freq * this.rng.range(0.85, 1.18);
    filter.Q.value = spec.q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + spec.decay);
    src.connect(filter).connect(g).connect(this.stepBus);
    src.start(now, Math.max(0, offset), spec.decay + 0.05);

    // The thump: the body of the foot landing.
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(spec.thump * this.rng.range(0.9, 1.15), now);
    osc.frequency.exponentialRampToValueAtTime(spec.thump * 0.55, now + 0.07);
    og.gain.setValueAtTime(0.0001, now);
    og.gain.exponentialRampToValueAtTime(vol * 0.55, now + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(og).connect(this.stepBus);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** Landing after a fall: heavier, with a bit of knee in it. */
  land(intensity = 1) {
    if (!this.started) return;
    this.footstep('concrete', 1.2 + intensity);
  }

  /** Interface blip. */
  click(kind = 'tick') {
    if (!this.started || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const vol = this.settings.audio.ui * 0.22;
    if (vol <= 0.001) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    const f = kind === 'confirm' ? 660 : kind === 'back' ? 320 : 480;
    osc.frequency.setValueAtTime(f, now);
    osc.frequency.exponentialRampToValueAtTime(f * (kind === 'confirm' ? 1.5 : 0.8), now + 0.05);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(g).connect(this.uiBus);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** Door opening: a latch click and a low swing. */
  door(opening = true) {
    if (!this.started || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const vol = this.settings.audio.ui * 0.4;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.white;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = opening ? 1200 : 900;
    filter.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    src.connect(filter).connect(g).connect(this.uiBus);
    src.start(now, this.rng() * 2, 0.4);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
}

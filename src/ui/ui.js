// The interface: screens, menus, settings, HUD.
//
// The settings screen builds itself from the schema in core/settings.js, so
// adding a setting there is all it takes to expose it here. Everything else is
// plain DOM: no framework, no build step.

import { SCHEMA, PRESETS as QUALITY_PRESETS, DEFAULT_BINDINGS } from '../core/settings.js';
import { keyLabel } from '../core/input.js';
import { searchPlaces, reverseGeocode, PRESETS, randomPlace } from '../geo/nominatim.js';
import { SlippyMap } from './slippymap.js';
import { cacheStats, cacheClear } from '../geo/cache.js';
import { formatLatLon, formatDistance, parseLatLon, clamp } from '../core/util.js';
import { netStats } from '../geo/net.js';

const TIPS = [
  'Every building height, roof shape and material you see was tagged by a volunteer mapper. Where they left it blank, the game guesses from the building type.',
  'The sun is where it really is: computed from the date, the time and your coordinates. Shadows point the right way.',
  'How densely the world is planted comes from NASA satellite measurements of how green that exact spot actually was.',
  'Press E at a door to go inside. Interiors load as their own cell: the street outside is unloaded while you are in there, so the building can afford to be detailed.',
  'Kerbs are 14 cm high and you really do step up them.',
  'Hold Shift to run. A comfortable walk is 1.4 metres per second, which is the default.',
  'Press M for the map, P for photo mode, H to hide the interface.',
  'Tunnels are worked out from the terrain: through a hill the road stays level and the ground rises over it.',
  'Try somewhere with weather you would not choose. Reykjavik in December is a different game.',
  'Map data is cached, so walking back through somewhere you have been is instant.',
  'Interiors are invented, but never randomly: the same building always generates the same rooms, because the seed is its OpenStreetMap id.',
];

export class UI {
  constructor(settings, input, game) {
    this.settings = settings;
    this.input = input;
    this.game = game;
    this.screenStack = [];
    this.current = 'title';
    this.el = {};
    this.map = null;
    this.selected = null;
    this.searchAbort = null;
    this.searchTimer = null;
    this.activeTab = 'graphics';
    this.mapRaf = null;

    this.cache();
    this.wire();
    this.buildPresets();
    this.buildSettings();
    this.buildBindings();
  }

  cache() {
    const ids = [
      'hud', 'debug', 'crosshair', 'compass', 'compass-strip', 'place-name', 'street-name',
      'coords', 'clock-time', 'clock-phase', 'weather-line', 'stamina-wrap', 'stamina-bar',
      'distance-walked', 'interact-prompt', 'toast-stack', 'loading-pip', 'loading-pip-text',
      'title-menu', 'btn-resume', 'place-query', 'place-results', 'preset-list', 'minimap',
      'map-pin', 'place-info', 'btn-start', 'opt-time', 'opt-hour', 'opt-hour-out',
      'opt-hour-field', 'opt-date', 'opt-weather', 'settings-tabs', 'settings-body',
      'bindings-body', 'btn-reset-settings', 'btn-reset-bindings', 'loading-title',
      'loading-bar', 'loading-detail', 'loading-tip', 'btn-cancel-load', 'pause-summary',
      'worldmap', 'map-legend',
      'restaurant-media-credits',
    ];
    for (const id of ids) this.el[id] = document.getElementById(id);
    this.screens = {};
    for (const s of document.querySelectorAll('.screen')) {
      this.screens[s.id.replace('screen-', '')] = s;
    }
  }

  // --- screen management ---------------------------------------------------

  show(name, { push = true } = {}) {
    if (this.current === name) return;
    if (push && this.current) this.screenStack.push(this.current);
    for (const key in this.screens) this.screens[key].classList.toggle('active', key === name);
    this.current = name;
    document.body.dataset.screen = name;

    if (name === 'place') this.enterPlaceScreen();
    else this.stopMapLoop();
    if (name === 'map') this.startWorldMap();
    if (name === 'loading') {
      this.el['loading-tip'].textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
    }
    if (name === 'settings') this.refreshSettings();
    if (name === 'pause') this.refreshPauseSummary();
    if (name === 'about') this.refreshRestaurantMediaCredits();
    if (name === 'none') this.hideAll();
  }

  hideAll() {
    for (const key in this.screens) this.screens[key].classList.remove('active');
    this.current = 'none';
    this.stopMapLoop();
  }

  back() {
    const prev = this.screenStack.pop() || 'title';
    this.show(prev, { push: false });
  }

  get inMenu() { return this.current !== 'none'; }

  // --- wiring --------------------------------------------------------------

  wire() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      this.handleAction(action);
    });

    this.el['btn-reset-settings'].addEventListener('click', () => {
      if (!confirm('Reset every setting and key binding to its default?')) return;
      this.settings.resetAll();
      this.buildSettings();
      this.buildBindings();
      this.game.onSettingsChanged('*', '*');
      this.toast('Settings reset');
    });

    this.el['btn-reset-bindings'].addEventListener('click', () => {
      this.settings.resetBindings();
      this.buildBindings();
      this.toast('Key bindings restored');
    });

    // Place search, debounced so we stay inside Nominatim's rate limit.
    this.el['place-query'].addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      const q = this.el['place-query'].value.trim();
      if (q.length < 2) { this.el['place-results'].innerHTML = ''; return; }
      const coords = parseLatLon(q);
      if (coords) {
        this.renderResults([{
          name: 'Go to these coordinates',
          short: formatLatLon(coords[0], coords[1]),
          lat: coords[0], lon: coords[1], raw: true,
        }]);
        return;
      }
      this.el['place-results'].innerHTML = '<div class="searching">Searching…</div>';
      this.searchTimer = setTimeout(() => this.runSearch(q), 420);
    });

    this.el['place-query'].addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = this.el['place-results'].querySelector('.result');
        if (first) first.click();
      }
    });

    this.el['btn-start'].addEventListener('click', () => {
      if (!this.selected) return;
      this.game.travelTo(this.selected, this.readStartOptions());
    });

    this.el['opt-time'].addEventListener('change', () => {
      this.el['opt-hour-field'].hidden = this.el['opt-time'].value !== 'fixed';
    });
    this.el['opt-hour'].addEventListener('input', () => {
      const v = parseFloat(this.el['opt-hour'].value);
      this.el['opt-hour-out'].textContent =
        `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
    });

    this.el['btn-cancel-load'].addEventListener('click', () => this.game.cancelLoad());
  }

  handleAction(action) {
    switch (action) {
      case 'new': this.show('place'); break;
      case 'back': this.back(); break;
      case 'settings': this.show('settings'); break;
      case 'controls': this.show('controls'); break;
      case 'about': this.show('about'); break;
      case 'resume': this.game.resume(); break;
      case 'title': this.game.quitToTitle(); break;
      case 'place': this.show('place'); break;
      case 'photo': this.game.togglePhotoMode(); break;
      case 'voxel': this.game.toggleVoxelMode(); break;
      case 'random': {
        const p = randomPlace();
        this.selectPlace({ ...p, name: `Somewhere near ${p.near}` });
        this.show('place');
        break;
      }
      default: break;
    }
  }

  // --- place picker --------------------------------------------------------

  enterPlaceScreen() {
    if (!this.map) {
      this.map = new SlippyMap(this.el.minimap, { minZoom: 2, maxZoom: 18 });
      this.map.onPick = (lat, lon) => this.pickCoords(lat, lon);
      this.map.onMove = () => this.updatePin();
      this.map.setView(20, 6, 2.4);
    }
    if (!this.el['opt-date'].value) {
      this.el['opt-date'].value = new Date().toISOString().slice(0, 10);
    }
    this.startMapLoop();
    this.updatePin();
  }

  startMapLoop() {
    if (this.mapRaf) return;
    const tick = () => {
      this.mapRaf = requestAnimationFrame(tick);
      if (this.map) { this.map.draw(); this.updatePin(); }
    };
    this.mapRaf = requestAnimationFrame(tick);
  }

  stopMapLoop() {
    if (this.mapRaf) { cancelAnimationFrame(this.mapRaf); this.mapRaf = null; }
  }

  updatePin() {
    if (!this.selected || !this.map) { this.el['map-pin'].style.display = 'none'; return; }
    const p = this.map.latLonToPixel(this.selected.lat, this.selected.lon);
    const rect = this.el.minimap.getBoundingClientRect();
    const visible = p.x > -20 && p.y > -20 && p.x < rect.width + 20 && p.y < rect.height + 20;
    this.el['map-pin'].style.display = visible ? 'block' : 'none';
    this.el['map-pin'].style.left = `${p.x}px`;
    this.el['map-pin'].style.top = `${p.y}px`;
  }

  async runSearch(query) {
    if (this.searchAbort) this.searchAbort.abort();
    this.searchAbort = new AbortController();
    try {
      const results = await searchPlaces(query, { signal: this.searchAbort.signal });
      if (this.el['place-query'].value.trim() !== query) return;   // superseded
      this.renderResults(results);
    } catch (e) {
      this.el['place-results'].innerHTML =
        '<div class="empty">Search is unavailable right now. You can still type coordinates, or pick a preset.</div>';
    }
  }

  renderResults(results) {
    const box = this.el['place-results'];
    box.innerHTML = '';
    if (!results.length) {
      box.innerHTML = '<div class="empty">Nothing found. Try a different spelling, or coordinates.</div>';
      return;
    }
    for (const r of results) {
      const b = document.createElement('button');
      b.className = 'result';
      b.innerHTML = `<span class="r-name"></span><span class="r-detail"></span>`;
      b.querySelector('.r-name').textContent = r.name;
      b.querySelector('.r-detail').textContent = r.short || formatLatLon(r.lat, r.lon);
      b.addEventListener('click', () => {
        box.querySelectorAll('.result').forEach((n) => n.classList.remove('selected'));
        b.classList.add('selected');
        this.selectPlace(r);
      });
      box.appendChild(b);
    }
  }

  buildPresets() {
    const box = this.el['preset-list'];
    box.innerHTML = '';
    for (const p of PRESETS) {
      const b = document.createElement('button');
      b.className = 'preset';
      b.innerHTML = '<strong></strong><small></small>';
      b.querySelector('strong').textContent = p.name;
      b.querySelector('small').textContent = p.detail;
      b.addEventListener('click', () => this.selectPlace({ ...p, short: p.detail }));
      box.appendChild(b);
    }
  }

  selectPlace(place) {
    this.selected = place;
    this.el['btn-start'].disabled = false;
    const info = this.el['place-info'];
    info.querySelector('.place-info-name').textContent = place.name || 'Selected point';
    info.querySelector('.place-info-coords').textContent = formatLatLon(place.lat, place.lon);
    const meta = [];
    if (place.short && place.short !== place.name) meta.push(place.short);
    if (place.country) meta.push(place.country);
    info.querySelector('.place-info-meta').textContent = meta.join(' · ');
    if (this.map) {
      this.map.setView(place.lat, place.lon, Math.max(this.map.zoom, 15));
      this.map.markers = [{ lat: place.lat, lon: place.lon }];
    }
    this.updatePin();
  }

  async pickCoords(lat, lon) {
    this.selectPlace({ name: 'Loading…', lat, lon, short: formatLatLon(lat, lon) });
    const found = await reverseGeocode(lat, lon);
    // Only apply if the user has not moved the pin again in the meantime.
    if (!this.selected || Math.abs(this.selected.lat - lat) > 1e-9) return;
    this.selectPlace({
      name: found ? found.name : 'Unnamed point',
      short: found ? found.short : formatLatLon(lat, lon),
      country: found ? found.country : null,
      countryCode: found ? found.countryCode : null,
      lat, lon,
    });
  }

  readStartOptions() {
    const timeMode = this.el['opt-time'].value;
    const dateStr = this.el['opt-date'].value;
    return {
      timeMode,
      fixedHour: parseFloat(this.el['opt-hour'].value),
      date: dateStr ? new Date(`${dateStr}T12:00:00Z`) : new Date(),
      weather: this.el['opt-weather'].value,
    };
  }

  // --- settings ------------------------------------------------------------

  buildSettings() {
    const tabs = this.el['settings-tabs'];
    tabs.innerHTML = '';
    for (const section of SCHEMA) {
      const b = document.createElement('button');
      b.className = 'tab' + (section.id === this.activeTab ? ' active' : '');
      b.textContent = section.label;
      b.addEventListener('click', () => {
        this.activeTab = section.id;
        this.buildSettings();
      });
      tabs.appendChild(b);
    }
    this.renderSettingsBody();
  }

  renderSettingsBody() {
    const section = SCHEMA.find((s) => s.id === this.activeTab) || SCHEMA[0];
    const body = this.el['settings-body'];
    body.innerHTML = '';

    for (const item of section.items) {
      if (item.key === '__bindings') { body.appendChild(this.bindingsShortcut()); continue; }
      if (item.key === '__cache') { body.appendChild(this.cacheRow()); continue; }

      const row = document.createElement('div');
      row.className = 'setting';
      row.dataset.key = item.key;

      const label = document.createElement('div');
      label.className = 'setting-label';
      label.textContent = item.label;
      if (item.note) {
        const note = document.createElement('small');
        note.className = 'setting-note';
        note.textContent = item.note;
        label.appendChild(note);
      }

      const control = document.createElement('div');
      control.className = 'setting-control';
      const value = document.createElement('div');
      value.className = 'setting-value';

      const current = this.settings.values[section.id][item.key];
      const render = (v) => {
        value.textContent = item.format ? item.format(v) : `${v}${item.unit || ''}`;
      };

      if (item.type === 'toggle') {
        const sw = document.createElement('div');
        sw.className = 'switch';
        sw.setAttribute('role', 'switch');
        sw.tabIndex = 0;
        sw.setAttribute('aria-checked', String(!!current));
        const flip = () => {
          const next = sw.getAttribute('aria-checked') !== 'true';
          sw.setAttribute('aria-checked', String(next));
          this.applySetting(section.id, item.key, next);
          value.textContent = next ? 'On' : 'Off';
        };
        sw.addEventListener('click', flip);
        sw.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
        });
        control.appendChild(sw);
        value.textContent = current ? 'On' : 'Off';
      } else if (item.type === 'range') {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = item.min; input.max = item.max; input.step = item.step;
        input.value = current;
        input.addEventListener('input', () => {
          const v = parseFloat(input.value);
          render(v);
          this.applySetting(section.id, item.key, v);
        });
        control.appendChild(input);
        render(current);
      } else if (item.type === 'select') {
        const sel = document.createElement('select');
        for (const opt of item.options) {
          const o = document.createElement('option');
          o.value = String(opt);
          o.textContent = item.format ? item.format(opt) : String(opt);
          if (String(opt) === String(current)) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          const raw = sel.value;
          const typed = typeof item.options[0] === 'number' ? parseFloat(raw) : raw;
          this.applySetting(section.id, item.key, typed);
          // Choosing a quality preset rewrites the whole graphics block.
          if (item.key === 'quality' && QUALITY_PRESETS[typed]) {
            this.settings.applyPreset(typed);
            this.game.onSettingsChanged('graphics', '*');
            this.renderSettingsBody();
          }
          render(typed);
        });
        control.appendChild(sel);
        value.textContent = '';
      }

      row.append(label, control, value);
      body.appendChild(row);
    }
  }

  applySetting(section, key, value) {
    this.settings.set(section, key, value);
    this.game.onSettingsChanged(section, key);
    // Hand-editing a graphics value drops the preset to "custom"; reflect that.
    if (section === 'graphics' && key !== 'quality') {
      const sel = this.el['settings-body'].querySelector('[data-key="quality"] select');
      if (sel) sel.value = 'custom';
    }
  }

  refreshSettings() { this.renderSettingsBody(); }

  bindingsShortcut() {
    const row = document.createElement('div');
    row.className = 'setting';
    row.innerHTML = '<div class="setting-label">Key bindings<small class="setting-note">Rebind movement, interaction and interface keys.</small></div>';
    const control = document.createElement('div');
    control.className = 'setting-control';
    const b = document.createElement('button');
    b.textContent = 'Edit bindings';
    b.addEventListener('click', () => this.show('controls'));
    control.appendChild(b);
    row.appendChild(control);
    row.appendChild(document.createElement('div'));
    return row;
  }

  cacheRow() {
    const row = document.createElement('div');
    row.className = 'setting';
    row.innerHTML = '<div class="setting-label">Cached map data<small class="setting-note">Everything downloaded is kept locally so revisiting a place is instant.</small></div>';
    const control = document.createElement('div');
    control.className = 'setting-control cache-row';
    const info = document.createElement('span');
    info.className = 'cache-info';
    info.textContent = 'measuring…';
    const clear = document.createElement('button');
    clear.textContent = 'Clear cache';
    clear.addEventListener('click', async () => {
      clear.disabled = true;
      await cacheClear();
      info.textContent = 'cleared';
      this.toast('Local map cache cleared');
      clear.disabled = false;
    });
    cacheStats().then((s) => {
      const mb = s.bytes ? `${(s.bytes / 1048576).toFixed(1)} MB` : 'unknown size';
      info.textContent = `${s.entries} items · ${mb}${s.persistent ? '' : ' (memory only)'}`;
    }).catch(() => { info.textContent = 'unavailable'; });
    control.append(info, clear);
    row.appendChild(control);
    row.appendChild(document.createElement('div'));
    return row;
  }

  // --- bindings ------------------------------------------------------------

  buildBindings() {
    const labels = {
      forward: 'Walk forward', back: 'Walk back', left: 'Step left', right: 'Step right',
      jump: 'Jump', sprint: 'Run', crouch: 'Crouch', interact: 'Interact / open door',
      map: 'Map', photo: 'Photo mode', flyUp: 'Fly up', flyDown: 'Fly down',
      toggleHud: 'Hide interface', voxel: 'Voxel mode', pause: 'Pause',
    };
    const body = this.el['bindings-body'];
    body.innerHTML = '';
    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      const row = document.createElement('div');
      row.className = 'binding-row';
      const name = document.createElement('div');
      name.className = 'binding-name';
      name.textContent = labels[action] || action;
      row.appendChild(name);

      const codes = this.settings.bindings[action];
      for (let slot = 0; slot < 2; slot++) {
        const key = document.createElement('button');
        key.className = 'key';
        key.textContent = codes[slot] ? keyLabel(codes[slot]) : '—';
        key.addEventListener('click', () => {
          if (key.classList.contains('listening')) {
            this.input.cancelCapture();
            key.classList.remove('listening');
            key.textContent = codes[slot] ? keyLabel(codes[slot]) : '—';
            return;
          }
          body.querySelectorAll('.key.listening').forEach((k) => k.classList.remove('listening'));
          key.classList.add('listening');
          key.textContent = 'press a key';
          this.input.captureKey((code) => {
            key.classList.remove('listening');
            if (code === 'Escape') { key.textContent = codes[slot] ? keyLabel(codes[slot]) : '—'; return; }
            const next = codes.slice();
            next[slot] = code;
            this.settings.setBinding(action, next.filter(Boolean));
            this.buildBindings();
          });
        });
        row.appendChild(key);
      }
      body.appendChild(row);
    }
  }

  // --- loading -------------------------------------------------------------

  setLoading(progress, detail, title) {
    if (title) this.el['loading-title'].textContent = title;
    if (detail != null) this.el['loading-detail'].textContent = detail;
    this.el['loading-bar'].style.width = `${clamp(progress, 0, 1) * 100}%`;
  }

  // --- HUD -----------------------------------------------------------------

  setHudVisible(v) {
    this.el.hud.classList.toggle('hidden', !v);
    this.el.hud.style.opacity = this.settings.gameplay.hudOpacity;
    this.el.crosshair.style.display = this.settings.gameplay.crosshair ? 'block' : 'none';
  }

  updateHud(state) {
    const el = this.el;
    if (state.placeName !== undefined) el['place-name'].textContent = state.placeName || '';
    if (state.street !== undefined) el['street-name'].textContent = state.street || '';
    if (state.coords !== undefined) el.coords.textContent = state.coords || '';
    if (state.time !== undefined) el['clock-time'].textContent = state.time;
    if (state.phase !== undefined) el['clock-phase'].textContent = state.phase;
    if (state.weather !== undefined) el['weather-line'].textContent = state.weather;
    if (state.distance !== undefined) el['distance-walked'].textContent = state.distance;

    if (state.heading !== undefined && this.settings.gameplay.compass) {
      el.compass.style.display = 'block';
      this.drawCompass(state.heading);
    } else if (!this.settings.gameplay.compass) {
      el.compass.style.display = 'none';
    }

    if (state.stamina !== undefined) {
      const wrap = el['stamina-wrap'];
      wrap.classList.toggle('visible', state.stamina < 0.999);
      el['stamina-bar'].style.width = `${state.stamina * 100}%`;
      el['stamina-bar'].classList.toggle('low', state.stamina < 0.25);
    }

    if (state.prompt !== undefined) {
      const p = el['interact-prompt'];
      if (state.prompt) {
        p.innerHTML = `<kbd>${keyLabel(this.settings.bindings.interact[0])}</kbd>${state.prompt}`;
        p.classList.remove('hidden');
      } else {
        p.classList.add('hidden');
      }
    }

    if (state.lookHint !== undefined) {
      if (!this.el['look-hint']) this.el['look-hint'] = document.getElementById('look-hint');
      if (this.el['look-hint']) this.el['look-hint'].classList.toggle('hidden', !state.lookHint);
    }

    if (state.loading !== undefined) {
      el['loading-pip'].classList.toggle('hidden', !state.loading);
      if (state.loading) el['loading-pip-text'].textContent = state.loading;
    }
  }

  /** A ticker strip of headings, so the compass reads like a real one. */
  drawCompass(headingDeg) {
    const strip = this.el['compass-strip'];
    const width = this.el.compass.clientWidth || 300;
    const pxPerDeg = width / 130;
    let html = '';
    const marks = [
      [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
      [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW'],
    ];
    for (const [deg, label] of marks) {
      for (const wrap of [-360, 0, 360]) {
        const delta = deg + wrap - headingDeg;
        if (Math.abs(delta) > 70) continue;
        const x = width / 2 + delta * pxPerDeg;
        const isCardinal = label.length === 1;
        html += `<span style="position:absolute;left:${x.toFixed(1)}px;top:8px;transform:translateX(-50%);
                 font:${isCardinal ? '600 12px' : '10px'} var(--ui);
                 color:${isCardinal ? '#f4f0e6' : 'rgba(255,255,255,.55)'}">${label}</span>`;
      }
    }
    for (let deg = 0; deg < 360; deg += 15) {
      for (const wrap of [-360, 0, 360]) {
        const delta = deg + wrap - headingDeg;
        if (Math.abs(delta) > 70) continue;
        const x = width / 2 + delta * pxPerDeg;
        html += `<span style="position:absolute;left:${x.toFixed(1)}px;top:0;width:1px;height:5px;
                 background:rgba(255,255,255,.3)"></span>`;
      }
    }
    strip.innerHTML = html;
  }

  toast(title, sub) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<div class="t-title"></div>';
    t.querySelector('.t-title').textContent = title;
    if (sub) {
      const s = document.createElement('div');
      s.className = 't-sub';
      s.textContent = sub;
      t.appendChild(s);
    }
    this.el['toast-stack'].appendChild(t);
    setTimeout(() => {
      t.classList.add('fading');
      setTimeout(() => t.remove(), 600);
    }, 4200);
    // Never let toasts stack off the screen.
    while (this.el['toast-stack'].children.length > 5) {
      this.el['toast-stack'].firstChild.remove();
    }
  }

  /** Black out the screen while an interior cell loads or unloads. */
  setFade(on) {
    if (!this.el.fade) this.el.fade = document.getElementById('fade');
    if (this.el.fade) this.el.fade.classList.toggle('on', !!on);
  }

  setDebug(text) {
    this.el.debug.classList.toggle('hidden', !text);
    if (text) this.el.debug.textContent = text;
  }

  refreshPauseSummary() {
    const g = this.game;
    if (!g.session) return;
    const lines = [
      `${g.session.placeName || 'Unknown place'}`,
      formatLatLon(g.session.lat, g.session.lon),
      `walked ${formatDistance(g.controller ? g.controller.distanceWalked : 0)}`,
      `${g.world.stats.chunks} chunks · ${(g.world.stats.triangles / 1000).toFixed(0)}k triangles`,
      `${netStats.requests} requests · ${netStats.cacheHits} from cache`,
    ];
    this.el['pause-summary'].textContent = lines.join('\n');
  }

  /** Render licence/creator credit for every Commons image used this session. */
  refreshRestaurantMediaCredits() {
    const box = this.el['restaurant-media-credits'];
    if (!box) return;
    const credits = Array.from(this.game.world?.restaurantMediaCredits?.values() || []);
    box.replaceChildren();
    if (!credits.length) {
      const p = document.createElement('p');
      p.textContent = 'No licensed restaurant images have been loaded in this session yet.';
      box.appendChild(p);
      return;
    }
    const intro = document.createElement('p');
    intro.textContent = 'Restaurant signs or photo panels loaded from Wikimedia Commons:';
    box.appendChild(intro);
    const list = document.createElement('ul');
    for (const credit of credits) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = credit.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = credit.restaurant;
      item.appendChild(link);
      item.appendChild(document.createTextNode(
        ` — ${credit.artist || 'Unknown creator'} · ${credit.licence || 'licence on source page'} · resized for facade display`));
      if (credit.licenceUrl && /^https:\/\//i.test(credit.licenceUrl)) {
        const licence = document.createElement('a');
        licence.href = credit.licenceUrl;
        licence.target = '_blank';
        licence.rel = 'noopener';
        licence.textContent = ' licence';
        item.appendChild(licence);
      }
      list.appendChild(item);
    }
    box.appendChild(list);
  }

  // --- in-game map ---------------------------------------------------------

  startWorldMap() {
    const canvas = this.el.worldmap;
    const draw = () => {
      if (this.current !== 'map') return;
      this.drawWorldMap(canvas);
      this.worldMapRaf = requestAnimationFrame(draw);
    };
    draw();
  }

  /**
   * Top-down plan of the loaded world: buildings, streets, water, and you.
   * Drawn from the same feature data the 3D world was built from, so it is a
   * map of what is actually there rather than a separate tile fetch.
   */
  drawWorldMap(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#0d1014';
    ctx.fillRect(0, 0, rect.width, rect.height);

    const game = this.game;
    if (!game.world || !game.controller) { ctx.restore(); return; }
    const px = game.controller.position.x, pz = game.controller.position.z;
    const span = 700;
    const scale = Math.min(rect.width, rect.height) / (span * 2);
    const tx = (x) => rect.width / 2 + (x - px) * scale;
    const tz = (z) => rect.height / 2 + (z - pz) * scale;

    const seen = new Set();
    for (const [key, fs] of game.world.chunkFeatures) {
      if (!game.world.chunks.has(key)) continue;
      ctx.fillStyle = '#1b2733';
      for (const wtr of fs.waterAreas) {
        ctx.beginPath();
        for (let i = 0; i < wtr.ring.length; i++) {
          const p = wtr.ring[i];
          if (i === 0) ctx.moveTo(tx(p[0]), tz(p[1])); else ctx.lineTo(tx(p[0]), tz(p[1]));
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = '#4c5766';
      for (const r of fs.roads) {
        if (r.spec.tunnel) continue;
        ctx.lineWidth = Math.max(0.6, r.spec.width * scale * 0.9);
        ctx.beginPath();
        for (let i = 0; i < r.pts.length; i++) {
          const p = r.pts[i];
          if (i === 0) ctx.moveTo(tx(p[0]), tz(p[1])); else ctx.lineTo(tx(p[0]), tz(p[1]));
        }
        ctx.stroke();
      }
      ctx.fillStyle = '#39414d';
      for (const b of fs.buildings) {
        if (seen.has(b.source)) continue;
        seen.add(b.source);
        ctx.beginPath();
        for (let i = 0; i < b.ring.length; i++) {
          const p = b.ring[i];
          if (i === 0) ctx.moveTo(tx(p[0]), tz(p[1])); else ctx.lineTo(tx(p[0]), tz(p[1]));
        }
        ctx.closePath(); ctx.fill();
      }
    }

    // The player, with a facing wedge.
    const yaw = game.controller.yaw;
    ctx.save();
    ctx.translate(rect.width / 2, rect.height / 2);
    ctx.rotate(-yaw);
    ctx.fillStyle = '#d9a441';
    ctx.beginPath();
    ctx.moveTo(0, -8); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.restore();

    this.el['map-legend'].innerHTML =
      '<span style="color:#39414d">Buildings</span>' +
      '<span style="color:#4c5766">Streets</span>' +
      '<span style="color:#1b2733">Water</span>' +
      '<span style="color:#d9a441">You</span>';
  }
}

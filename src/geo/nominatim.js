// Place search and reverse geocoding, via OpenStreetMap Nominatim.
//
// Nominatim asks for an identifying User-Agent or Referer and no more than one
// request a second. Browsers will not let us set User-Agent, but the Referer
// header identifies the deployment, and the shared request queue in net.js
// enforces the rate limit.

import { fetchCached } from './net.js';
import { haversine } from './projection.js';

const BASE = 'https://nominatim.openstreetmap.org';

/** Search for a place by name. Returns up to `limit` candidates. */
export async function searchPlaces(query, { limit = 8, signal = null } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const url = `${BASE}/search?format=jsonv2&limit=${limit}&addressdetails=1&extratags=1&q=${encodeURIComponent(q)}`;
  const json = await fetchCached(url, {
    as: 'json',
    maxAgeMs: 1000 * 60 * 60 * 24 * 30,
    retries: 1,
    timeoutMs: 12000,
    signal,
  });
  if (!Array.isArray(json)) return [];
  return json.map(normalise);
}

/** What is at these coordinates? */
export async function reverseGeocode(lat, lon, { zoom = 16, signal = null } = {}) {
  const url = `${BASE}/reverse?format=jsonv2&zoom=${zoom}&addressdetails=1&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`;
  try {
    const json = await fetchCached(url, {
      as: 'json',
      maxAgeMs: 1000 * 60 * 60 * 24 * 30,
      retries: 1,
      timeoutMs: 12000,
      signal,
    });
    if (!json || json.error) return null;
    return normalise(json);
  } catch (e) {
    return null;
  }
}

function normalise(r) {
  const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
  const addr = r.address || {};
  const locality = addr.city || addr.town || addr.village || addr.hamlet ||
                   addr.suburb || addr.municipality || addr.county || null;
  // Nominatim's display_name is exhaustive to the point of unreadability;
  // trim it to the part a person would actually say out loud.
  const parts = (r.display_name || '').split(',').map((s) => s.trim());
  const short = parts.slice(0, 3).join(', ');
  return {
    name: r.name || parts[0] || 'Unnamed place',
    display: r.display_name || '',
    short,
    lat, lon,
    type: r.type || null,
    category: r.category || r.class || null,
    country: addr.country || null,
    countryCode: (addr.country_code || '').toUpperCase() || null,
    locality,
    importance: r.importance || 0,
    boundingbox: r.boundingbox ? r.boundingbox.map(Number) : null,
    osm: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : null,
  };
}

/**
 * Curated starting points. Chosen to span climate, density and terrain, so the
 * first thing a new player sees is not another temperate European street: a
 * medina, a favela hillside, a glacier valley, a hyper-dense grid.
 */
export const PRESETS = [
  { name: 'Manhattan', detail: 'New York — vertical grid', lat: 40.7549, lon: -73.9840 },
  { name: 'Le Marais', detail: 'Paris — dense old quarter', lat: 48.8584, lon: 2.3550 },
  { name: 'Gion', detail: 'Kyoto — machiya lanes', lat: 35.0037, lon: 135.7788 },
  { name: 'Venice', detail: 'Canals and no cars', lat: 45.4341, lon: 12.3388 },
  { name: 'Jemaa el-Fnaa', detail: 'Marrakesh — the medina', lat: 31.6258, lon: -7.9891 },
  { name: 'Santorini', detail: 'Oia — caldera cliffs', lat: 36.4618, lon: 25.3760 },
  { name: 'Reykjavik', detail: 'Iceland — subarctic light', lat: 64.1466, lon: -21.9426 },
  { name: 'Amsterdam Centrum', detail: 'Canal rings', lat: 52.3730, lon: 4.8910 },
  { name: 'Hong Kong Central', detail: 'Density and slope', lat: 22.2830, lon: 114.1580 },
  { name: 'Copacabana', detail: 'Rio de Janeiro', lat: -22.9711, lon: -43.1822 },
  { name: 'Machu Picchu', detail: 'Andes, 2,430 m', lat: -13.1631, lon: -72.5450 },
  { name: 'Chamonix', detail: 'Alps under Mont Blanc', lat: 45.9237, lon: 6.8694 },
  { name: 'Petra', detail: 'Jordan — desert canyon', lat: 30.3285, lon: 35.4444 },
  { name: 'Sydney Harbour', detail: 'Circular Quay', lat: -33.8570, lon: 151.2130 },
  { name: 'Cape Town', detail: 'Under Table Mountain', lat: -33.9249, lon: 18.4241 },
  { name: 'Singapore River', detail: 'Equatorial city', lat: 1.2870, lon: 103.8500 },
  { name: 'Edinburgh Old Town', detail: 'Closes and crags', lat: 55.9490, lon: -3.1900 },
  { name: 'Tromsø', detail: 'Norway — inside the Arctic Circle', lat: 69.6496, lon: 18.9560 },
  { name: 'Varanasi Ghats', detail: 'The Ganges', lat: 25.3080, lon: 83.0100 },
  { name: 'Havana Vieja', detail: 'Cuba — colonial grid', lat: 23.1370, lon: -82.3550 },
  { name: 'Grand Canyon', detail: 'South Rim', lat: 36.0580, lon: -112.1400 },
  { name: 'Ushuaia', detail: 'Tierra del Fuego', lat: -54.8019, lon: -68.3030 },
  { name: 'Lalibela', detail: 'Ethiopian highlands', lat: 12.0317, lon: 39.0417 },
  { name: 'Hallstatt', detail: 'Austria — lake and cliff', lat: 47.5622, lon: 13.6493 },
];

/**
 * Somewhere random, but somewhere worth being: sample near a populated place
 * rather than uniformly over the globe, since two thirds of a uniform sample is
 * open ocean.
 */
export function randomPlace(rng = Math.random) {
  const seed = PRESETS[Math.floor(rng() * PRESETS.length) % PRESETS.length];
  // Wander up to about 40 km from a known city, which usually lands on
  // something mapped but not the exact postcard view.
  const bearing = rng() * Math.PI * 2;
  const distance = 2000 + rng() * 38000;
  const dLat = (distance * Math.cos(bearing)) / 110540;
  const dLon = (distance * Math.sin(bearing)) / (111320 * Math.cos(seed.lat * Math.PI / 180));
  return {
    lat: seed.lat + dLat,
    lon: seed.lon + dLon,
    name: null,
    near: seed.name,
    distance: Math.round(distance),
  };
}

/** Distance in metres between two results, for de-duplicating search hits. */
export function resultDistance(a, b) {
  return haversine(a.lat, a.lon, b.lat, b.lon);
}

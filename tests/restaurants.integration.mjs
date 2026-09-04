// Live restaurant identity check at the Las Vegas test location. This is kept
// out of `npm test` because it reads public OSM and Overture services.

import assert from 'node:assert/strict';
import { Projection } from '../src/geo/projection.js';
import { RegionLoader } from '../src/geo/overpass.js';
import {
  extractFeatures, mergeOvertureBuildings, inferMissingHeights,
  inferBuildingKinds, assignEntrances, assignRestaurantBusinesses,
} from '../src/world/features.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: {
    'User-Agent': 'TerraAmbulate/1.0 (restaurant integration test)',
    ...(init.headers || {}),
  },
});

// Fremont East contains independent restaurants, bars, cafes and the mapped
// Heart Attack Grill landmark, so it exercises far more than chain branding.
const projection = new Projection(36.1716, -115.1391);
const loader = new RegionLoader({ sizeM: 900, marginM: 150, maxRegions: 1 });
const region = loader.request(projection, 0, 0);
await region.structurePromise;

assert.equal(region.failed, null, `OSM failed: ${region.failed?.message}`);
assert.equal(region.overtureError, null,
  `Overture buildings failed: ${region.overtureError?.message}`);

const fs = extractFeatures(region.data, projection);
const merge = mergeOvertureBuildings(fs, region.overtureBuildings, projection);
inferMissingHeights(fs);
inferBuildingKinds(fs);
assignEntrances(fs);
const assigned = assignRestaurantBusinesses(fs);
const buildings = fs.buildings.filter((b) => b.restaurant);
const named = buildings.filter((b) => b.restaurant.name);
const names = named.map((b) => b.restaurant.name);

assert.ok(assigned >= 8, `only ${assigned} restaurant buildings were associated`);
assert.ok(names.includes('Heart Attack Grill'),
  `landmark restaurant missing; found ${names.slice(0, 12).join(', ')}`);
assert.ok(named.every((b) => b.door), 'a signed restaurant has no facade entrance');
assert.ok(named.every((b) => b.restaurant.category), 'restaurant category was lost');

console.log(`Las Vegas restaurants: ${assigned} buildings, ${named.length} named; ` +
            `${merge.added} Overture footprints added`);
console.log(`  ${names.slice(0, 16).join(' · ')}`);
console.log('  ok  live restaurant identity reaches renderable building entrances');

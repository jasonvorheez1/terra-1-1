// Live coverage audit for the U.S. small-town cases that exposed the gap.
// This is intentionally separate from `npm test` because it reads public OSM
// and Overture services.

import assert from 'node:assert/strict';
import { Projection } from '../src/geo/projection.js';
import { RegionLoader } from '../src/geo/overpass.js';
import {
  extractFeatures, mergeOvertureBuildings, inferSuburbanHousing,
} from '../src/world/features.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: { 'User-Agent': 'TerraAmbulate/1.0 (small-town integration test)', ...(init.headers || {}) },
});

const PLACES = [
  { name: 'Monett, Missouri', lat: 36.92895, lon: -93.9277 },
  { name: 'Valentine, Nebraska', lat: 42.87278, lon: -100.55097 },
  { name: 'Marfa, Texas', lat: 30.30946, lon: -104.02062 },
];

let failed = 0;
for (const place of PLACES) {
  const projection = new Projection(place.lat, place.lon);
  const loader = new RegionLoader({ sizeM: 900, marginM: 150, maxRegions: 1 });
  const region = loader.request(projection, 0, 0);
  await region.structurePromise;

  const fs = extractFeatures(region.data, projection);
  const osmBuildings = fs.buildings.length;
  const merge = mergeOvertureBuildings(fs, region.overtureBuildings, projection);
  const synthetic = inferSuburbanHousing(fs);

  console.log(`${place.name}: ${osmBuildings} live OSM + ${merge.added} Overture` +
              ` (${merge.enriched} enriched, ${merge.duplicates} current-OSM duplicates rejected)` +
              ` + ${synthetic} synthetic = ${fs.buildings.length}`);
  if (region.failed) console.log(`  OSM warning: ${region.failed.message}`);
  if (region.overtureError) console.log(`  Overture warning: ${region.overtureError.message}`);

  try {
    assert.equal(region.overtureError, null, 'Overture building tiles failed');
    assert.ok(merge.added >= 50, `only ${merge.added} gap-filling footprints`);
    assert.ok(fs.buildings.length >= 75, `only ${fs.buildings.length} total buildings`);
    // Once real roofprints exist, the older frontage generator should normally
    // have nothing to invent. A few edge-zone houses are tolerated.
    assert.ok(synthetic <= Math.max(8, Math.ceil(merge.added * 0.03)),
              `${synthetic} synthetic houses despite ${merge.added} real gap-fill footprints`);
    console.log('  ok  real footprint coverage is present');
  } catch (error) {
    failed++;
    console.log(`FAIL  ${error.message}`);
  }
}

process.exit(failed ? 1 : 0);

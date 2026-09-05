// Live road-generation audit across different densities and traffic sides.
// Kept out of `npm test` because it reads public OSM/Overture services.

import assert from 'node:assert/strict';
import { Projection } from '../src/geo/projection.js';
import { RegionLoader } from '../src/geo/overpass.js';
import { extractFeatures } from '../src/world/features.js';
import { drivingSideForCountry, roadMarkingLayout } from '../src/world/road-layout.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: {
    'User-Agent': 'TerraAmbulate/1.0 (road integration test)',
    ...(init.headers || {}),
  },
});

const PLACES = [
  { name: 'Las Vegas, US', lat: 36.1147, lon: -115.1728, code: 'US', region: 'southwest', size: 700, minRoads: 350 },
  { name: 'Grandview, US', lat: 38.8858, lon: -94.5330, code: 'US', region: 'northAmerica', size: 700, minRoads: 55 },
  { name: 'Paris, FR', lat: 48.8584, lon: 2.3550, code: 'FR', region: 'europe', size: 500, minRoads: 170 },
  { name: 'Kyoto, JP', lat: 35.0037, lon: 135.7788, code: 'JP', region: 'eastAsia', size: 420, minRoads: 70 },
  { name: 'Sydney, AU', lat: -33.8570, lon: 151.2130, code: 'AU', region: 'oceania', size: 500, minRoads: 70 },
];

for (const place of PLACES) {
  const projection = new Projection(place.lat, place.lon);
  const loader = new RegionLoader({ sizeM: place.size, marginM: 80, maxRegions: 1 });
  const region = loader.request(projection, 0, 0);
  await region.structurePromise;
  assert.equal(region.failed, null, `${place.name}: OSM failed: ${region.failed?.message}`);

  const fs = extractFeatures(region.data, projection);
  const motor = fs.roads.filter((r) =>
    !['foot', 'cycle', 'steps'].includes(r.spec.kind));
  const major = motor.filter((r) => r.spec.cls.priority >= 6);
  const patches = motor.reduce((n, r) => n + (r.junctionPatches?.length || 0), 0);
  const side = drivingSideForCountry(place.code);

  assert.ok(fs.roads.length > place.minRoads,
    `${place.name}: only ${fs.roads.length} roads/paths extracted`);
  assert.ok(motor.length > 20, `${place.name}: only ${motor.length} motor-road sections`);
  assert.ok(patches > 3, `${place.name}: only ${patches} owned motor junction patches`);
  assert.ok(motor.every((r) => r.spec.width >= 0.8 && r.spec.width <= 60),
    `${place.name}: a motor-road width escaped its physical bounds`);
  assert.ok(motor.every((r) => roadMarkingLayout(r.spec, place.region, side)
    .every((line) => Math.abs(line.offset) < r.spec.width / 2)),
  `${place.name}: lane paint escaped its carriageway`);

  console.log(`  ok  ${place.name}: ${fs.roads.length} roads/paths, ${motor.length} motor, ` +
              `${patches} junctions, drives ${side}`);
}

assert.equal(drivingSideForCountry('US'), 'right');
assert.equal(drivingSideForCountry('FR'), 'right');
assert.equal(drivingSideForCountry('JP'), 'left');
assert.equal(drivingSideForCountry('AU'), 'left');
console.log('  ok  road generation is bounded and intersection-aware across all regions');

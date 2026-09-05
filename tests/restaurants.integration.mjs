// Live restaurant identity audit across different densities, languages and
// continents. Kept out of `npm test` because it reads public OSM/Overture data.

import assert from 'node:assert/strict';
import { Projection } from '../src/geo/projection.js';
import { OverpassClient, OsmData } from '../src/geo/overpass.js';
import { overtureBuildings, overturePlaces } from '../src/geo/overture.js';
import {
  extractFeatures, mergeOvertureBuildings, mergeOvertureRestaurantPlaces,
  inferMissingHeights, inferBuildingKinds, assignEntrances, assignRestaurantBusinesses,
} from '../src/world/features.js';
import {
  restaurantSignLabel, restaurantStorefrontStyle,
} from '../src/world/restaurants.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: {
    'User-Agent': 'TerraAmbulate/1.0 (global restaurant integration test)',
    ...(init.headers || {}),
  },
});

// A large US entertainment district, a small Missouri town, and three regions
// with different languages/urban forms. No renderer code is allowed to key off
// these names or coordinates; they are only regression samples of global data.
const PLACES = [
  { name: 'Las Vegas, US', lat: 36.1716, lon: -115.1391, size: 900, minAssigned: 15, minNamed: 12 },
  { name: 'Grandview, US', lat: 38.8894, lon: -94.5330, size: 900, minAssigned: 1, minNamed: 1 },
  { name: 'Paris, FR', lat: 48.8584, lon: 2.3550, size: 600, minAssigned: 8, minNamed: 6 },
  { name: 'Kyoto, JP', lat: 35.0037, lon: 135.7788, size: 600, minAssigned: 2, minNamed: 1 },
  { name: 'Sydney, AU', lat: -33.8570, lon: 151.2130, size: 650, minAssigned: 4, minNamed: 3 },
];

const FOOD = 'restaurant|cafe|fast_food|food_court|ice_cream|bar|pub';

function auditBBox(projection, size) {
  const h = size / 2;
  return projection.localRectToBBox(-h, -h, h, h);
}

function restaurantQuery(box) {
  const b = `${box.south.toFixed(6)},${box.west.toFixed(6)},` +
            `${box.north.toFixed(6)},${box.east.toFixed(6)}`;
  // This purpose-built query is intentionally much lighter than a whole-world
  // gameplay region. It still exercises the production OSM parser and real
  // building association without abusing public Overpass mirrors in CI.
  return `[out:json][timeout:35];
(
  way["building"](${b});
  relation["building"]["type"="multipolygon"](${b});
  node["amenity"~"^(${FOOD})$"](${b});
  way["amenity"~"^(${FOOD})$"](${b});
  relation["amenity"~"^(${FOOD})$"]["type"="multipolygon"](${b});
);
out body qt;
>;
out skel qt;`;
}

let total = 0;
let totalMediaRefs = 0;
const families = new Set();

for (const place of PLACES) {
  const projection = new Projection(place.lat, place.lon);
  const client = new OverpassClient();
  client.timeoutSec = 35;
  const box = auditBBox(projection, place.size);
  const [osmResult, placesResult, buildingsResult] = await Promise.allSettled([
    client.run(restaurantQuery(box), {
      cacheKey: `restaurant-audit:v1:${place.lat},${place.lon}:${place.size}`,
    }),
    overturePlaces.fetchPlaces(box),
    overtureBuildings.fetchBuildings(box),
  ]);
  assert.equal(placesResult.status, 'fulfilled', `${place.name}: Overture Places failed`);
  assert.equal(buildingsResult.status, 'fulfilled', `${place.name}: Overture buildings failed`);
  // This deliberately mirrors production: a dead Overpass mirror is a data
  // degradation, not permission to render an empty town.
  const osm = new OsmData();
  if (osmResult.status === 'fulfilled') osm.ingest(osmResult.value);
  const placeRecords = placesResult.value;
  const buildingRecords = buildingsResult.value;
  const fs = extractFeatures(osm, projection);
  const footprints = mergeOvertureBuildings(fs, buildingRecords, projection);
  const placeMerge = mergeOvertureRestaurantPlaces(fs, placeRecords, projection);
  inferMissingHeights(fs);
  inferBuildingKinds(fs);
  assignEntrances(fs);
  const assigned = assignRestaurantBusinesses(fs);
  const buildings = fs.buildings.filter((b) => b.restaurant);
  const named = buildings.filter((b) => b.restaurant.name);
  const mediaRefs = buildings.filter((b) => {
    const r = b.restaurant;
    return r.commons || r.brandWikidata || r.subjectWikidata || r.wikidata;
  });

  assert.ok(assigned >= place.minAssigned,
    `${place.name}: only ${assigned} restaurant buildings were associated`);
  assert.ok(named.length >= place.minNamed,
    `${place.name}: only ${named.length} associated restaurants have names`);
  assert.ok(named.every((b) => b.door), `${place.name}: a signed restaurant has no entrance`);
  assert.ok(buildings.every((b) => b.restaurant.category),
    `${place.name}: restaurant category was lost`);
  assert.ok(named.every((b) => !/^\?+$/.test(restaurantSignLabel(b.restaurant))),
    `${place.name}: a non-Latin restaurant sign collapsed into question marks`);

  for (const b of buildings) families.add(restaurantStorefrontStyle(b.restaurant).family);
  total += assigned;
  totalMediaRefs += mediaRefs.length;
  console.log(`  ok  ${place.name}: ${assigned} restaurant buildings, ${named.length} named, ` +
              `${mediaRefs.length} media-linked; Overture added ${placeMerge.added} places / ` +
              `${footprints.added} footprints${osmResult.status === 'rejected' ? ' (OSM fallback exercised)' : ''}`);
  console.log(`      ${named.slice(0, 8).map((b) => b.restaurant.name).join(' · ')}`);
}

assert.ok(families.size >= 5,
  `only ${families.size} storefront families appeared globally: ${Array.from(families).join(', ')}`);
console.log(`  ok  ${total} restaurant buildings across five regions; ` +
            `${families.size} architectural families, ${totalMediaRefs} exact media references`);

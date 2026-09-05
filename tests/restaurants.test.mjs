import assert from 'node:assert/strict';
import {
  FeatureSet, restaurantFromTags, assignRestaurantBusinesses,
  mergeOvertureRestaurantPlaces, inferBuildingKinds, assignEntrances,
  inferCommercialSites,
} from '../src/world/features.js';
import {
  buildingHeights, facadeSpec, featureRng, roadSpec,
} from '../src/world/osm-tags.js';
import { Projection } from '../src/geo/projection.js';
import {
  restaurantSignLabel, restaurantPalette, restaurantFacadeRight,
  restaurantStorefrontStyle,
} from '../src/world/restaurants.js';
import { area, bounds, centroid } from '../src/world/geometry.js';

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  try { fn(); passed++; out.push(`  ok  ${name}`); }
  catch (e) { failed++; out.push(`FAIL  ${name}\n        ${e.stack || e.message}`); }
}

function rect(x, z, w, d) {
  return [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
}

function building(id, ring, tags = { building: 'yes' }) {
  const footprint = area(ring);
  const rng = featureRng('test-building', id);
  const heights = buildingHeights(tags, footprint, rng);
  return {
    id, source: `way/${id}`, ring, holes: [], tags,
    area: footprint, bounds: bounds(ring), centroid: centroid(ring),
    heights, facade: facadeSpec(tags, heights.cls, rng),
    kind: heights.cls.kind, levels: heights.levels,
  };
}

test('restaurant metadata retains the real name, cuisine and rendering hints', () => {
  const r = restaurantFromTags({
    amenity: 'restaurant', name: "Homer's Dine In", cuisine: 'american;burger',
    outdoor_seating: 'yes', drive_through: 'no', 'brand:colour': '#8f3229',
    wikimedia_commons: 'File:Homers.jpg',
  }, 77);
  assert.equal(r.name, "Homer's Dine In");
  assert.deepEqual(r.cuisines, ['american', 'burger']);
  assert.equal(r.outdoorSeating, true);
  assert.equal(r.driveThrough, false);
  assert.equal(r.colour, 0x8f3229);
  assert.equal(r.image, 'File:Homers.jpg');
  assert.equal(r.commons, 'File:Homers.jpg');
});

test('a restaurant POI attaches to the smallest footprint containing it', () => {
  const fs = new FeatureSet();
  const block = building(1, rect(0, 0, 40, 30));
  const unit = building(2, rect(6, 5, 12, 10));
  fs.buildings.push(block, unit);
  fs.pois.push({
    id: 100, x: 10, z: 9, name: 'Corner Cafe', category: 'cafe',
    tags: { amenity: 'cafe', name: 'Corner Cafe', cuisine: 'coffee_shop' },
  });
  assert.equal(assignRestaurantBusinesses(fs), 1);
  assert.equal(block.restaurant, null);
  assert.equal(unit.restaurant.name, 'Corner Cafe');
  assert.equal(unit.groundUse, 'restaurant');
  assert.equal(unit.name, 'Corner Cafe');
});

test('a live OSM restaurant can give an Overture footprint its identity', () => {
  const fs = new FeatureSet();
  const b = building('gers-1', rect(0, 0, 16, 12));
  b.source = 'overture/gers-1';
  b.overture = true;
  fs.buildings.push(b);
  fs.pois.push({
    id: 9, x: 8, z: 6, name: "Homer's Dine In", category: 'restaurant',
    tags: { amenity: 'restaurant', name: "Homer's Dine In", cuisine: 'american' },
  });
  assignRestaurantBusinesses(fs);
  assert.equal(b.restaurant.name, "Homer's Dine In");
});

test('an Overture place fills a small-town restaurant gap without special coordinates', () => {
  const projection = new Projection(38.8894, -94.5330);
  const fs = new FeatureSet();
  const b = building('small-town', rect(-12, -8, 24, 16));
  fs.buildings.push(b);
  const at = projection.toGeo(0, 0);
  const stats = mergeOvertureRestaurantPlaces(fs, [{
    id: 'gers-place', lon: at.lon, lat: at.lat,
    name: 'Main Street Kitchen', signName: 'Main Street Kitchen',
    category: 'restaurant', cuisines: ['american'], confidence: 0.9,
    operatingStatus: 'open', sources: [],
  }], projection);
  assert.equal(stats.added, 1);
  assert.equal(assignRestaurantBusinesses(fs), 1);
  assert.equal(b.restaurant.name, 'Main Street Kitchen');
  assert.equal(b.restaurant.tags.source, 'Overture Maps Foundation');
});

test('a restaurant mapped directly on the building needs no separate POI', () => {
  const fs = new FeatureSet();
  const b = building(3, rect(0, 0, 14, 10), {
    building: 'yes', amenity: 'restaurant', name: 'The Blue Plate', cuisine: 'diner',
  });
  fs.buildings.push(b);
  assert.equal(assignRestaurantBusinesses(fs), 1);
  assert.equal(b.restaurant.name, 'The Blue Plate');
  assert.equal(b.restaurant.mappedOnBuilding, true);
});

test('a commercial shell mapped as a restaurant becomes a low retail building', () => {
  const fs = new FeatureSet();
  const b = building('pizza', rect(0, 0, 14, 12), {
    building: 'commercial', amenity: 'restaurant', name: 'Pizza Hut',
  });
  fs.buildings.push(b);
  assignRestaurantBusinesses(fs);
  inferBuildingKinds(fs);
  assert.equal(b.kind, 'retail');
  assert.equal(b.levels, 1);
  assert.ok(b.heights.top <= 5, `restaurant was ${b.heights.top}m tall`);
  assert.equal(b.commercialForm, 'auto-oriented');
});

test('a place point gives an isolated generic footprint low commercial massing', () => {
  const fs = new FeatureSet();
  const b = building('overture-restaurant', rect(-18, -12, 36, 24));
  fs.buildings.push(b);
  fs.pois.push({
    id: 'place/1', x: 0, z: 0, name: "Homer's Dine In", category: 'restaurant',
    tags: { amenity: 'restaurant', name: "Homer's Dine In" },
  });
  assignRestaurantBusinesses(fs);
  inferBuildingKinds(fs);
  assert.equal(b.kind, 'retail');
  assert.equal(b.levels, 1);
  assert.equal(b.kindInferred, 'restaurant-place');
});

test('a restaurant in an explicitly mixed-use building keeps the upper floors', () => {
  const fs = new FeatureSet();
  const b = building('mixed', rect(0, 0, 24, 18), {
    building: 'apartments', 'building:levels': '5',
  });
  fs.buildings.push(b);
  fs.pois.push({
    id: 'place/2', x: 3, z: 3, name: 'Ground Floor Cafe', category: 'cafe',
    tags: { amenity: 'cafe', name: 'Ground Floor Cafe' },
  });
  assignRestaurantBusinesses(fs);
  inferBuildingKinds(fs);
  assert.equal(b.kind, 'apartments');
  assert.equal(b.levels, 5);
  assert.equal(b.commercialForm, 'mixed-use');
});

test('an auto-oriented restaurant gains an asphalt frontage, shrubs and road sign', () => {
  const fs = new FeatureSet();
  const b = building('roadside', rect(-8, -6, 16, 12), {
    building: 'commercial', amenity: 'restaurant', name: 'Roadside Kitchen',
  });
  fs.buildings.push(b);
  const spec = roadSpec({ highway: 'secondary', surface: 'asphalt' });
  fs.roads.push({
    id: 'road', source: 'way/road', pts: [[-60, 25], [60, 25]],
    rawPts: [[-60, 25], [60, 25]], spec, tags: { highway: 'secondary' },
  });
  assignRestaurantBusinesses(fs);
  inferBuildingKinds(fs);
  assignEntrances(fs);
  const result = inferCommercialSites(fs);
  assert.equal(result.sites, 1);
  assert.equal(result.parking, 1);
  assert.equal(result.signs, 1);
  assert.equal(result.shrubs, 2);
  assert.equal(fs.landcover[0].spec.surface.id, 'asphalt');
  assert.equal(fs.landcover[0].synthetic, true);
  assert.ok(b.commercialSite.sign);
  assert.equal(inferCommercialSites(fs).sites, 0, 'site inference is idempotent');
  assert.equal(fs.landcover.length, 1);
});

test('several restaurants in one large block retain separate facade positions', () => {
  const fs = new FeatureSet();
  const b = building('mall', rect(0, 0, 50, 24));
  fs.buildings.push(b);
  fs.pois.push(
    {
      id: 20, x: 2, z: 12, name: 'West Cafe', category: 'cafe',
      tags: { amenity: 'cafe', name: 'West Cafe', cuisine: 'coffee_shop' },
    },
    {
      id: 21, x: 48, z: 12, name: 'East Grill', category: 'restaurant',
      tags: { amenity: 'restaurant', name: 'East Grill', cuisine: 'american' },
    },
  );
  assert.equal(assignRestaurantBusinesses(fs), 1);
  assert.equal(b.restaurants.length, 2);
  assert.ok(b.restaurants.every((r) => r.facadeDoor));
  assert.ok(Math.hypot(
    b.restaurants[0].facadeDoor.x - b.restaurants[1].facadeDoor.x,
    b.restaurants[0].facadeDoor.z - b.restaurants[1].facadeDoor.z,
  ) > 30);
});

test('a restaurant across the street is not attached by guesswork', () => {
  const fs = new FeatureSet();
  const b = building(4, rect(0, 0, 10, 10));
  fs.buildings.push(b);
  fs.pois.push({
    id: 11, x: 40, z: 5, name: 'Far Away', category: 'restaurant',
    tags: { amenity: 'restaurant', name: 'Far Away' },
  });
  assert.equal(assignRestaurantBusinesses(fs), 0);
  assert.equal(b.restaurant, null);
});

test('storefront sign keeps a niche restaurant name legible', () => {
  assert.equal(restaurantSignLabel({ name: "Homer's Dine In" }), "HOMER'S DINE IN");
  assert.equal(restaurantSignLabel({ name: 'Café Déjà Vu' }), 'CAFE DEJA VU');
  assert.ok(restaurantSignLabel({ name: 'A Restaurant With A Needlessly Long Name' }, 18).length <= 18);
});

test('global signs use mapped Latin names and never collapse into question marks', () => {
  const mapped = restaurantFromTags({
    amenity: 'restaurant', name: '一風堂', 'name:en': 'Ippudo', cuisine: 'ramen',
  }, 'node/jp');
  assert.equal(mapped.name, '一風堂');
  assert.equal(mapped.signName, 'Ippudo');
  assert.equal(restaurantSignLabel(mapped), 'IPPUDO');
  assert.equal(restaurantSignLabel({ name: '食堂', cuisines: ['japanese'] }), 'JAPANESE');
  assert.equal(restaurantSignLabel({ name: 'Gion 花', cuisines: ['japanese'] }), 'GION');
});

test('cuisine and explicit brand colours produce distinct storefront palettes', () => {
  const mexican = restaurantPalette({ cuisines: ['mexican'], category: 'restaurant' }, () => 0);
  const sushi = restaurantPalette({ cuisines: ['sushi'], category: 'restaurant' }, () => 0);
  const branded = restaurantPalette({ cuisines: [], category: 'restaurant', colour: 0x123456 }, () => 0);
  assert.notEqual(mexican.panel, sushi.panel);
  assert.equal(branded.panel, 0x123456);
});

test('restaurant lettering runs left-to-right for an outside viewer', () => {
  assert.deepEqual(restaurantFacadeRight(0, 1), [1, -0]);
  assert.deepEqual(restaurantFacadeRight(1, 0), [0, -1]);
});

test('restaurant architecture follows cuisine but stays unique by identity', () => {
  const sushi = restaurantStorefrontStyle({
    name: 'Sakura House', category: 'restaurant', cuisines: ['sushi'],
  });
  const diner = restaurantStorefrontStyle({
    name: "Homer's Dine In", category: 'restaurant', cuisines: ['american', 'diner'],
  });
  const cafeA = restaurantStorefrontStyle({
    name: 'Corner Cup', category: 'cafe', cuisines: ['coffee_shop'],
  });
  const cafeB = restaurantStorefrontStyle({
    name: 'Morning Bell', category: 'cafe', cuisines: ['coffee_shop'],
  });
  assert.equal(sushi.family, 'japanese');
  assert.equal(sushi.curtain, true);
  assert.equal(diner.family, 'diner');
  assert.equal(diner.chrome, true);
  assert.equal(cafeA.family, 'cafe');
  assert.notDeepEqual(cafeA, cafeB);
  assert.deepEqual(cafeA, restaurantStorefrontStyle({
    name: 'Corner Cup', category: 'cafe', cuisines: ['coffee_shop'],
  }));
});

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

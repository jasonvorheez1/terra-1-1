import assert from 'node:assert/strict';
import {
  FeatureSet, restaurantFromTags, assignRestaurantBusinesses,
} from '../src/world/features.js';
import {
  restaurantSignLabel, restaurantPalette, restaurantFacadeRight,
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
  return {
    id, source: `way/${id}`, ring, holes: [], tags,
    area: area(ring), bounds: bounds(ring), centroid: centroid(ring),
    kind: 'generic', levels: 1,
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

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

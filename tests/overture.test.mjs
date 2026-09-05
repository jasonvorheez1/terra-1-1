import assert from 'node:assert/strict';
import { Projection } from '../src/geo/projection.js';
import {
  tilesForBBox, overtureRestaurantCategory, overtureRestaurantRecord,
} from '../src/geo/overture.js';
import {
  FeatureSet, mergeOvertureBuildings, mergeOvertureRestaurantPlaces,
  approximateBuildingIoU,
} from '../src/world/features.js';
import { bounds, centroid, area } from '../src/world/geometry.js';
import { buildingHeights, facadeSpec, featureRng, buildingEra } from '../src/world/osm-tags.js';

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  try { fn(); passed++; out.push(`  ok  ${name}`); }
  catch (e) { failed++; out.push(`FAIL  ${name}\n        ${e.stack || e.message}`); }
}

const projection = new Projection(36.92895, -93.9277);

function localRect(x, z, w = 12, d = 10) {
  return [[x, z], [x + w, z], [x + w, z + d], [x, z + d]];
}

function overtureRecord(id, ring, properties = {}) {
  const outer = ring.concat([ring[0]]).map(([x, z]) => {
    const geo = projection.toGeo(x, z);
    return [geo.lon, geo.lat];
  });
  return {
    id, gersId: id, outer, holes: [],
    properties: { '@geometry_source': 'Microsoft ML Buildings', ...properties },
  };
}

function osmBuilding(id, ring, tags = { building: 'yes' }) {
  const a = area(ring);
  const rng = featureRng('b', id);
  const heights = buildingHeights(tags, a, rng);
  return {
    id, source: `way/${id}`, ring, holes: [], area: a, tags, heights,
    facade: facadeSpec(tags, heights.cls, rng), name: tags.name || null,
    centroid: centroid(ring), bounds: bounds(ring), isPart: false,
    levels: heights.levels, kind: heights.cls.kind, era: buildingEra(tags),
  };
}

test('bbox expands to every intersecting z14 tile', () => {
  const one = tilesForBBox({ south: 36.928, west: -93.929, north: 36.930, east: -93.926 });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { z: 14, x: 3917, y: 6381 });
});

test('adds a real non-OSM footprint with Overture height and shape data', () => {
  const fs = new FeatureSet();
  const rec = overtureRecord('gers-new', localRect(30, 40), {
    class: 'detached', height: 8.4, num_floors: 2,
    roof_shape: 'gabled', roof_height: 2.1, facade_color: '#cab28e',
  });
  const stats = mergeOvertureBuildings(fs, [rec], projection);
  assert.deepEqual(stats, { added: 1, enriched: 0, duplicates: 0, osmGeometry: 0, invalid: 0 });
  assert.equal(fs.buildings.length, 1);
  const b = fs.buildings[0];
  assert.equal(b.source, 'overture/gers-new');
  assert.equal(b.kind, 'house');
  assert.equal(b.synthetic, undefined);
  assert.ok(Math.abs(b.heights.top - 8.4) < 1e-9);
  assert.equal(b.heights.roof.shape, 'gabled');
  assert.equal(b.levels, 2);
});

test('live OSM geometry wins and receives only its missing attributes', () => {
  const fs = new FeatureSet();
  const osm = osmBuilding(42, localRect(0, 0), { building: 'house', name: 'Mapped name' });
  fs.buildings.push(osm);
  const rec = overtureRecord('gers-osm', localRect(0, 0), {
    '@geometry_source': 'OpenStreetMap',
    height: 7.25,
    '@name': 'Stale name',
    sources: JSON.stringify([{ provider: 'osm', dataset: 'OpenStreetMap', record_id: 'w42@3' }]),
  });
  const stats = mergeOvertureBuildings(fs, [rec], projection);
  assert.equal(stats.added, 0);
  assert.equal(stats.enriched, 1);
  assert.equal(fs.buildings.length, 1);
  assert.equal(osm.source, 'way/42');
  assert.equal(osm.name, 'Mapped name');
  assert.ok(Math.abs(osm.heights.top - 7.25) < 1e-9);
  assert.equal(osm.overtureId, 'gers-osm');
});

test('a recent OSM footprint geometrically suppresses a stale ML duplicate', () => {
  const fs = new FeatureSet();
  fs.buildings.push(osmBuilding(99, localRect(0, 0, 14, 11)));
  const almostSame = localRect(0.4, -0.25, 14, 11);
  const stats = mergeOvertureBuildings(fs, [overtureRecord('gers-stale', almostSame)], projection);
  assert.equal(stats.added, 0);
  assert.equal(stats.duplicates, 1);
  assert.equal(fs.buildings.length, 1);
});

test('nearby separate houses are not mistaken for duplicates', () => {
  const a = osmBuilding(1, localRect(0, 0, 10, 10));
  const b = osmBuilding(2, localRect(11, 0, 10, 10));
  assert.equal(approximateBuildingIoU(a, b), 0);
  const fs = new FeatureSet();
  fs.buildings.push(a);
  const stats = mergeOvertureBuildings(fs, [overtureRecord('next-door', b.ring)], projection);
  assert.equal(stats.added, 1);
  assert.equal(fs.buildings.length, 2);
});

test('seen ids prevent a footprint being emitted by overlapping regions', () => {
  const seen = new Set();
  const rec = overtureRecord('gers-shared', localRect(100, 100));
  const first = new FeatureSet(), second = new FeatureSet();
  assert.equal(mergeOvertureBuildings(first, [rec], projection, { seen }).added, 1);
  assert.equal(mergeOvertureBuildings(second, [rec], projection, { seen }).added, 0);
  assert.equal(second.buildings.length, 0);
});

test('underground Overture structures are omitted', () => {
  const fs = new FeatureSet();
  const rec = overtureRecord('underground', localRect(0, 0), { is_underground: true });
  const stats = mergeOvertureBuildings(fs, [rec], projection);
  assert.equal(stats.invalid, 1);
  assert.equal(fs.buildings.length, 0);
});

test('Overture place taxonomy becomes restaurant identity and cuisine hints', () => {
  const props = {
    id: 'place-1',
    names: JSON.stringify({ primary: 'El Rincón', common: { en: 'The Corner' } }),
    taxonomy: JSON.stringify({
      primary: 'mexican_restaurant',
      hierarchy: ['food_and_drink', 'restaurant', 'mexican_restaurant'],
    }),
    basic_category: 'restaurant',
    websites: JSON.stringify(['https://example.test/menu']),
    brand: JSON.stringify({ names: { primary: 'Rincón Group' }, wikidata: 'Q123' }),
    confidence: 0.91,
    operating_status: 'open',
  };
  assert.equal(overtureRestaurantCategory(props), 'restaurant');
  assert.equal(overtureRestaurantCategory({
    taxonomy: JSON.stringify({
      primary: 'music_venue', hierarchy: ['arts_and_entertainment', 'music_venue'],
      alternates: ['bar'],
    }),
  }), null);
  assert.equal(overtureRestaurantCategory({
    taxonomy: JSON.stringify({
      primary: 'oxygen_bar', hierarchy: ['health_and_medical', 'oxygen_bar'],
    }),
  }), null);
  const record = overtureRestaurantRecord(props, [-93.9277, 36.92895]);
  assert.equal(record.name, 'El Rincón');
  assert.equal(record.signName, 'The Corner');
  assert.deepEqual(record.cuisines, ['mexican']);
  assert.equal(record.website, 'https://example.test/menu');
  assert.equal(record.brand, 'Rincón Group');
  assert.equal(record.brandWikidata, 'Q123');
  assert.equal(overtureRestaurantRecord({
    ...props, id: 'not-food', names: JSON.stringify({ primary: 'Downtown Oxygen Bar' }),
  }, [-93.9277, 36.92895]), null);
});

test('confident Overture restaurants fill POI gaps while live OSM wins duplicates', () => {
  const at = projection.toGeo(5, 7);
  const record = {
    id: 'place-gap', lon: at.lon, lat: at.lat, name: 'Small Town Grill',
    signName: 'Small Town Grill', category: 'restaurant', cuisines: ['american'],
    confidence: 0.87, operatingStatus: 'open', sources: [],
  };
  const fs = new FeatureSet();
  let stats = mergeOvertureRestaurantPlaces(fs, [record], projection);
  assert.equal(stats.added, 1);
  assert.equal(fs.pois[0].tags.name, 'Small Town Grill');
  assert.equal(fs.pois[0].tags.source, 'Overture Maps Foundation');

  const withOsm = new FeatureSet();
  withOsm.pois.push({
    id: 4, x: 5.5, z: 7, name: 'Small Town Grill', category: 'restaurant',
    tags: { amenity: 'restaurant', name: 'Small Town Grill' },
  });
  stats = mergeOvertureRestaurantPlaces(withOsm, [record], projection);
  assert.equal(stats.added, 0);
  assert.equal(stats.duplicates, 1);
  assert.equal(withOsm.pois.length, 1);
});

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

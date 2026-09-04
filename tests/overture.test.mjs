import assert from 'node:assert/strict';
import { Projection } from '../src/geo/projection.js';
import { tilesForBBox } from '../src/geo/overture.js';
import {
  FeatureSet, mergeOvertureBuildings, approximateBuildingIoU,
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

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

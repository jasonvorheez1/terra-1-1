// Checks for the OSM tag interpreter.
//   node tests/tags.test.mjs

import assert from 'node:assert/strict';
import * as T from '../src/world/osm-tags.js';
import { inferMissingHeights } from '../src/world/features.js';

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  try { fn(); passed++; out.push(`  ok  ${name}`); }
  catch (e) { failed++; out.push(`FAIL  ${name}\n        ${e.message}`); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

// --- lengths and counts ----------------------------------------------------

test('parseLength handles metres, feet and junk', () => {
  assert.equal(T.parseLength('12'), 12);
  assert.equal(T.parseLength('12 m'), 12);
  assert.equal(T.parseLength('12m'), 12);
  assert.ok(near(T.parseLength("40'"), 12.192, 1e-3));
  assert.ok(near(T.parseLength('40 ft'), 12.192, 1e-3));
  assert.ok(near(T.parseLength(`5'6"`), 1.6764, 1e-3));
  assert.ok(near(T.parseLength('12.5'), 12.5));
  assert.equal(T.parseLength(''), null);
  assert.equal(T.parseLength(null), null);
  assert.equal(T.parseLength('approx 12'), 12, 'falls back to a leading number');
});

test('parseCount reads levels and lanes', () => {
  assert.equal(T.parseCount('4'), 4);
  assert.equal(T.parseCount('2;3'), 2);
  assert.equal(T.parseCount('2.5'), 2.5);
  assert.equal(T.parseCount('none'), null);
});

test('parseColour handles names, hex and rgb', () => {
  assert.equal(T.parseColour('#e8d9c0'), 0xe8d9c0);
  assert.equal(T.parseColour('e8d9c0'), 0xe8d9c0);
  assert.equal(T.parseColour('#fff'), 0xffffff);
  assert.equal(T.parseColour('white'), 0xffffff);
  assert.equal(T.parseColour('light_gray'), 0xd3d3d3);
  assert.equal(T.parseColour('light gray'), 0xd3d3d3);
  assert.equal(T.parseColour('rgb(16, 32, 48)'), 0x102030);
  assert.equal(T.parseColour('not-a-colour'), null);
});

test('lookupMaterial resolves compound values', () => {
  assert.equal(T.lookupMaterial('brick').pattern, 'brick');
  assert.equal(T.lookupMaterial('BRICK').pattern, 'brick');
  assert.equal(T.lookupMaterial('reinforced_concrete').pattern, 'panel');
  assert.equal(T.lookupMaterial('brick;concrete').pattern, 'brick');
  assert.equal(T.lookupMaterial('unobtainium'), null);
});

// --- building heights ------------------------------------------------------

test('explicit height tag wins', () => {
  const h = T.buildingHeights({ building: 'yes', height: '30' }, 400);
  assert.equal(h.top, 30);
});

test('feet-tagged heights convert', () => {
  const h = T.buildingHeights({ building: 'office', height: "100'" }, 900);
  assert.ok(near(h.top, 30.48, 1e-2), `got ${h.top}`);
});

test('levels drive height when no height tag', () => {
  const h = T.buildingHeights({ building: 'apartments', 'building:levels': '8' }, 500);
  assert.equal(h.levels, 8);
  assert.ok(near(h.top, 8 * 3.0), `got ${h.top}`);
});

test('untagged buildings get class-appropriate heights', () => {
  const house = T.buildingHeights({ building: 'house' }, 120);
  const tower = T.buildingHeights({ building: 'office' }, 3000);
  assert.ok(house.top > 3 && house.top < 12, `house ${house.top}`);
  assert.ok(tower.top > house.top * 1.5, `office ${tower.top} vs house ${house.top}`);
});

test('building parts respect min_height and min_level', () => {
  const a = T.buildingHeights({ 'building:part': 'yes', height: '40', min_height: '12' }, 300);
  assert.equal(a.base, 12);
  const b = T.buildingHeights({ 'building:part': 'yes', 'building:levels': '10', 'building:min_level': '4' }, 300);
  assert.ok(b.base > 10 && b.base < 14, `base ${b.base}`);
});

test('height is clamped to physically possible values', () => {
  assert.ok(T.buildingHeights({ building: 'yes', height: '99999' }, 100).top <= 830);
  assert.ok(T.buildingHeights({ building: 'yes', height: '0.1' }, 100).top >= 1.8);
});

test('roof height is subtracted from the wall top', () => {
  const h = T.buildingHeights({ building: 'house', height: '10', 'roof:shape': 'gabled', 'roof:height': '3' }, 100);
  assert.equal(h.top, 10);
  assert.equal(h.roofHeight, 3);
  assert.equal(h.wallTop, 7);
});

test('pitched roofs get a rise even with no roof:height', () => {
  const h = T.buildingHeights({ building: 'house', height: '9', 'roof:shape': 'gabled' }, 100);
  assert.ok(h.roofHeight > 1 && h.roofHeight < 5, `roof ${h.roofHeight}`);
  const flat = T.buildingHeights({ building: 'apartments', height: '20' }, 400);
  assert.equal(flat.roofHeight, 0, 'flat roofs stay flat');
});

test('roof height can never exceed the building', () => {
  const h = T.buildingHeights({ building: 'house', height: '4', 'roof:height': '20' }, 100);
  assert.ok(h.wallTop >= 1.5, `wallTop ${h.wallTop}`);
});

test('buildingClass falls back through amenity and shop', () => {
  assert.equal(T.buildingClass({ building: 'yes', shop: 'bakery' }).kind, 'retail');
  assert.equal(T.buildingClass({ building: 'yes', amenity: 'place_of_worship' }).kind, 'worship');
  assert.equal(T.buildingClass({ building: 'yes', tourism: 'hotel' }).kind, 'hotel');
  assert.equal(T.buildingClass({ building: 'apartments' }).kind, 'apartments');
  assert.equal(T.buildingClass({ building: 'nonsense' }).kind, 'generic');
});

test('facade colour prefers tags, then material, then palette', () => {
  const cls = T.buildingClass({ building: 'house' });
  assert.equal(T.facadeSpec({ 'building:colour': '#ff0000' }, cls).colour, 0xff0000);
  assert.equal(T.facadeSpec({ 'building:material': 'brick' }, cls).colour, T.MATERIALS.brick.tint);
  const rng = () => 0.5;
  const c = T.facadeSpec({}, cls, rng).colour;
  assert.ok(typeof c === 'number' && c >= 0 && c <= 0xffffff);
});

test('same feature id always generates the same look', () => {
  const a = T.featureRng('way', 12345)();
  const b = T.featureRng('way', 12345)();
  const c = T.featureRng('way', 12346)();
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// --- roads -----------------------------------------------------------------

test('road width comes from width, then lanes, then class', () => {
  assert.equal(T.roadSpec({ highway: 'residential', width: '7.5' }).width, 7.5);
  const fourLane = T.roadSpec({ highway: 'primary', lanes: '4' });
  assert.ok(near(fourLane.width, 4 * 3.35), `got ${fourLane.width}`);
  assert.equal(T.roadSpec({ highway: 'residential' }).width, 6.0);
  assert.equal(T.roadSpec({ highway: 'footway' }).width, 2.0);
});

test('kerbside parking widens the tagged carriageway', () => {
  const plain = T.roadSpec({ highway: 'residential', lanes: '2' });
  const parked = T.roadSpec({ highway: 'residential', lanes: '2', 'parking:both': 'lane' });
  assert.ok(parked.width > plain.width + 4, `${plain.width} -> ${parked.width}`);
  assert.equal(T.roadSpec({ highway: 'residential', 'parking:both': 'no' }).width, plain.width,
               'parking=no must not create two phantom parking lanes');
  assert.equal(T.roadSpec({ highway: 'residential', 'parking:both': 'street_side' }).width, plain.width,
               'off-carriageway parking must not widen the road');
  assert.ok(T.roadSpec({ highway: 'residential', 'parking:left': 'lane' }).width > plain.width + 2,
            'one mapped parking lane widens one side only');
});

test('tunnels and bridges get a layer even when untagged', () => {
  assert.equal(T.roadSpec({ highway: 'primary', tunnel: 'yes' }).layer, -1);
  assert.equal(T.roadSpec({ highway: 'primary', bridge: 'yes' }).layer, 1);
  assert.equal(T.roadSpec({ highway: 'primary', tunnel: 'yes', layer: '-3' }).layer, -3);
  assert.equal(T.roadSpec({ highway: 'primary', tunnel: 'no' }).tunnel, null);
});

test('layerOffset puts bridges up and tunnels down', () => {
  const bridge = T.roadSpec({ highway: 'primary', bridge: 'yes' });
  const tunnel = T.roadSpec({ highway: 'primary', tunnel: 'yes' });
  const deep = T.roadSpec({ highway: 'primary', tunnel: 'yes', layer: '-3' });
  const stack = T.roadSpec({ highway: 'motorway', bridge: 'yes', layer: '2' });
  assert.ok(T.layerOffset(bridge) >= 5, `bridge ${T.layerOffset(bridge)}`);
  assert.ok(T.layerOffset(tunnel) <= -5, `tunnel ${T.layerOffset(tunnel)}`);
  assert.ok(T.layerOffset(deep) < T.layerOffset(tunnel), 'layer -3 is deeper than -1');
  assert.ok(T.layerOffset(stack) > T.layerOffset(bridge), 'layer 2 is higher than layer 1');
  assert.equal(T.layerOffset(T.roadSpec({ highway: 'footway', tunnel: 'building_passage' })), 0,
               'building passages stay at grade');
  assert.equal(T.layerOffset(T.roadSpec({ highway: 'residential' })), 0);
});

test('surfaces resolve with sensible footstep sounds', () => {
  assert.equal(T.roadSpec({ highway: 'footway', surface: 'gravel' }).surface.sound, 'gravel');
  assert.equal(T.roadSpec({ highway: 'residential' }).surface.id, 'asphalt');
  assert.equal(T.roadSpec({ highway: 'living_street' }).surface.id, 'paving_stones');
  assert.equal(T.lookupSurface('cobblestone').sound, 'stone');
  assert.equal(T.lookupSurface(undefined).id, 'asphalt');
});

test('sidewalk=no suppresses generated sidewalks', () => {
  assert.equal(T.roadSpec({ highway: 'secondary' }).sidewalk, true);
  assert.equal(T.roadSpec({ highway: 'secondary', sidewalk: 'no' }).sidewalk, false);
  assert.equal(T.roadSpec({ highway: 'service' }).sidewalk, false);
  assert.equal(T.roadSpec({ highway: 'secondary', tunnel: 'yes' }).sidewalk, false);
  const left = T.roadSpec({ highway: 'secondary', sidewalk: 'left' });
  assert.equal(left.sidewalk, true);
  assert.equal(left.sidewalkLeft, true);
  assert.equal(left.sidewalkRight, false);
  const separate = T.roadSpec({ highway: 'secondary', sidewalk: 'separate' });
  assert.equal(separate.sidewalkLeft, false);
  assert.equal(separate.sidewalkRight, false);
});

test('directional and shared lanes contribute to the total lane count', () => {
  const spec = T.roadSpec({
    highway: 'primary', 'lanes:forward': '2', 'lanes:backward': '1',
    'lanes:both_ways': '1',
  });
  assert.equal(spec.lanes, 4);
  assert.equal(spec.lanesForward, 2);
  assert.equal(spec.lanesBackward, 1);
  assert.equal(spec.lanesBothWays, 1);
  assert.equal(T.roadSpec({ highway: 'primary', lane_markings: 'no' }).markings, false);
});

test('rail specs cover subways and trams', () => {
  assert.equal(T.railSpec({ railway: 'subway' }).layer, -1, 'subways default underground');
  assert.equal(T.railSpec({ railway: 'tram' }).cls.ballast, 0, 'trams sit flush in the street');
  assert.ok(T.railSpec({ railway: 'rail', tracks: '4' }).width > T.railSpec({ railway: 'rail' }).width);
  assert.equal(T.railSpec({ railway: 'nonsense' }), null);
});

// --- barriers and land cover ----------------------------------------------

test('barriers report collidable heights', () => {
  assert.equal(T.barrierSpec({ barrier: 'wall' }).height, 2.2);
  assert.equal(T.barrierSpec({ barrier: 'wall', height: '4' }).height, 4);
  assert.equal(T.barrierSpec({ barrier: 'kerb' }).kind, 'kerb');
  assert.equal(T.barrierSpec({ barrier: 'unknown_thing' }), null);
  assert.equal(T.barrierSpec({}), null);
});

test('land cover resolves and orders overlapping polygons', () => {
  const park = T.landcoverSpec({ leisure: 'park' });
  const resi = T.landcoverSpec({ landuse: 'residential' });
  const pitch = T.landcoverSpec({ leisure: 'pitch' });
  assert.ok(park.z > resi.z, 'a park draws over a residential block');
  assert.ok(pitch.z > park.z, 'a pitch draws over the park it sits in');
  assert.ok(park.veg > resi.veg, 'parks are planted more densely');
  assert.equal(T.landcoverSpec({ building: 'yes' }), null);
});

test('water detection covers the usual tag spellings', () => {
  assert.ok(T.isWater({ natural: 'water' }));
  assert.ok(T.isWater({ landuse: 'reservoir' }));
  assert.ok(T.isWater({ waterway: 'riverbank' }));
  assert.ok(T.isWater({ water: 'lake' }));
  assert.ok(!T.isWater({ landuse: 'grass' }));
});

test('waterway widths scale by class', () => {
  assert.ok(T.waterwayWidth({ waterway: 'river' }) > T.waterwayWidth({ waterway: 'stream' }));
  assert.equal(T.waterwayWidth({ waterway: 'river', width: '55' }), 55);
});


// --- separately-mapped pavements ------------------------------------------

test('footway=sidewalk is a raised pavement, a crossing is not', () => {
  const pave = T.roadSpec({ highway: 'footway', footway: 'sidewalk' });
  assert.equal(pave.pavement, true);
  assert.equal(pave.crossing, false);
  const cross = T.roadSpec({ highway: 'footway', footway: 'crossing' });
  assert.equal(cross.pavement, false, 'a crossing is flush with the road');
  assert.equal(cross.crossing, true);
  assert.equal(T.roadSpec({ highway: 'footway' }).pavement, false, 'a plain path is not a kerb');
  assert.equal(T.roadSpec({ highway: 'path', path: 'sidewalk' }).pavement, true);
  // A pavement carried on a bridge is part of the deck, not a kerb of its own.
  assert.equal(T.roadSpec({ highway: 'footway', footway: 'sidewalk', bridge: 'yes' }).pavement, false);
});

// --- neighbourhood height inference ---------------------------------------

/** A minimal building record of the shape features.js produces. */
function fakeBuilding(id, x, z, tags) {
  const heights = T.buildingHeights(tags, 200, T.featureRng('t', id));
  return { id, source: `way/${id}`, tags, heights, centroid: [x, z], levels: heights.levels };
}

test('an untagged building takes its neighbours height, not the class default', () => {
  const fs = { buildings: [] };
  for (let i = 0; i < 8; i++) {
    fs.buildings.push(fakeBuilding(i, i * 20, 0, { building: 'apartments', 'building:levels': '6' }));
  }
  const gap = fakeBuilding(99, 70, 5, { building: 'yes' });
  const before = gap.heights.top;
  fs.buildings.push(gap);

  const changed = inferMissingHeights(fs);
  assert.equal(changed, 1);
  assert.equal(gap.heights.levels, 6, `inferred ${gap.heights.levels} storeys`);
  assert.ok(gap.heights.top > before * 1.8,
            `height went ${before.toFixed(1)} -> ${gap.heights.top.toFixed(1)}`);
  assert.ok(gap.heights.wallTop <= gap.heights.top);
  assert.equal(gap.heights.inferred, true);
});

test('tagged buildings are never overwritten', () => {
  const fs = { buildings: [] };
  for (let i = 0; i < 6; i++) {
    fs.buildings.push(fakeBuilding(i, i * 15, 0, { building: 'apartments', 'building:levels': '9' }));
  }
  const twoStorey = fakeBuilding(50, 40, 4, { building: 'house', 'building:levels': '2' });
  fs.buildings.push(twoStorey);
  inferMissingHeights(fs);
  assert.equal(twoStorey.heights.levels, 2, 'an explicit storey count stands');
});

test('a building=house keeps its own height among tall neighbours', () => {
  const fs = { buildings: [] };
  for (let i = 0; i < 8; i++) {
    fs.buildings.push(fakeBuilding(i, i * 15, 0, { building: 'apartments', 'building:levels': '7' }));
  }
  // No levels tag, but `building=house` is not silent: it says what it is.
  const house = fakeBuilding(60, 45, 6, { building: 'house' });
  const before = house.heights.levels;
  fs.buildings.push(house);
  inferMissingHeights(fs);
  assert.equal(house.heights.levels, before,
               `a house became ${house.heights.levels} storeys`);
  assert.ok(house.heights.levels <= 3, 'a house stays domestic');
  assert.notEqual(house.heights.inferred, true);
});

test('describesItself separates a named type from building=yes', () => {
  assert.equal(T.describesItself({ building: 'house' }), true);
  assert.equal(T.describesItself({ building: 'detached' }), true);
  assert.equal(T.describesItself({ building: 'yes' }), false);
  assert.equal(T.describesItself({ building: 'nonsense_value' }), false);
  // A shop in a building=yes is still describing itself.
  assert.equal(T.describesItself({ building: 'yes', shop: 'bakery' }), true);
});

test('inference does not fire with too few neighbours', () => {
  const fs = { buildings: [
    fakeBuilding(1, 0, 0, { building: 'apartments', 'building:levels': '7' }),
    fakeBuilding(2, 900, 900, { building: 'yes' }),
  ] };
  assert.equal(inferMissingHeights(fs), 0, 'a lone building keeps its class default');
});

test('inference is bounded by distance', () => {
  const fs = { buildings: [] };
  for (let i = 0; i < 6; i++) {
    fs.buildings.push(fakeBuilding(i, i * 10, 0, { building: 'apartments', 'building:levels': '8' }));
  }
  const far = fakeBuilding(80, 4000, 4000, { building: 'yes' });
  fs.buildings.push(far);
  const beforeLevels = far.heights.levels;
  inferMissingHeights(fs);
  assert.equal(far.heights.levels, beforeLevels, 'a building 4 km away is not a neighbour');
});

console.log(out.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

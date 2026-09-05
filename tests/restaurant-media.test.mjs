import assert from 'node:assert/strict';
import {
  commonsFileTitle, wikidataEntityId, wikidataMedia, mediaLicenceAllowed,
  commonsMedia, commonsApiUrl, restaurantMediaPlacement,
  plainCredit,
} from '../src/world/restaurant-media.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}\n        ${e.stack || e.message}`); }
}

test('Commons references are normalized but arbitrary image URLs are refused', () => {
  assert.equal(commonsFileTitle('File:Homer_Diner.jpg'), 'File:Homer Diner.jpg');
  assert.equal(
    commonsFileTitle('https://commons.wikimedia.org/wiki/File:Homer_Diner.jpg'),
    'File:Homer Diner.jpg');
  assert.equal(commonsFileTitle('Category:Homer Diner'), null);
  assert.equal(commonsFileTitle('https://example.com/photo.jpg'), null);
  assert.equal(commonsFileTitle('Homer Diner'), null);
});

test('Wikidata ids and preferred logo/photo claims are deterministic', () => {
  const json = { entities: { Q42: { claims: {
    P154: [{ rank: 'preferred', mainsnak: { datavalue: { value: 'Real logo.svg' } } }],
    P18: [{ rank: 'normal', mainsnak: { datavalue: { value: 'Real facade.jpg' } } }],
  } } } };
  assert.equal(wikidataEntityId('https://www.wikidata.org/wiki/Q42'), 'Q42');
  assert.deepEqual(wikidataMedia(json, 'Q42', true), {
    title: 'File:Real logo.svg', kind: 'logo', wikidata: 'Q42',
  });
  assert.deepEqual(wikidataMedia(json, 'Q42', false), {
    title: 'File:Real facade.jpg', kind: 'photo', wikidata: 'Q42',
  });
});

test('only free, transformable media licences are accepted', () => {
  for (const value of ['CC0 1.0', 'Public domain', 'CC BY 4.0', 'CC BY-SA 4.0']) {
    assert.equal(mediaLicenceAllowed(value), true, value);
  }
  for (const value of ['', 'All rights reserved', 'CC BY-NC 4.0', 'CC BY-ND 4.0']) {
    assert.equal(mediaLicenceAllowed(value), false, value);
  }
});

test('Commons metadata retains source, creator and licence attribution', () => {
  const parsed = commonsMedia({ query: { pages: { 10: {
    title: 'File:Real facade.jpg',
    imageinfo: [{
      thumburl: 'https://upload.wikimedia.org/real.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Real_facade.jpg',
      thumbwidth: 640, thumbheight: 360, thumbmime: 'image/jpeg',
      extmetadata: {
        Artist: { value: '<a href="/wiki/User:Jane">Jane Mapper</a>' },
        LicenseShortName: { value: 'CC BY 4.0' },
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' },
      },
    }],
  } } } }, 'File:Fallback.jpg');
  assert.equal(parsed.artist, 'Jane Mapper');
  assert.equal(parsed.licence, 'CC BY 4.0');
  assert.equal(parsed.width, 640);
  assert.equal(new URL(commonsApiUrl('File:Real facade.jpg')).searchParams.get('origin'), '*');
  assert.equal(plainCredit('A &amp; B<br>C'), 'A & B · C');
});

test('real media keeps its aspect and uses photos as larger facade panels', () => {
  const media = {
    image: { width: 400, height: 200 },
    width: 400, height: 200, kind: 'logo', title: 'File:Logo.png',
  };
  const target = {
    restaurant: { name: "Homer's Dine In" },
    x: 2, z: 3, baseY: 0, normal: [0, 1], right: [1, 0], depth: 0.2,
    available: 7, signWidth: 5, signHeight: 0.8, signY: 3.6,
  };
  const logo = restaurantMediaPlacement(media, target);
  assert.ok(logo.width / logo.height > 1.99 && logo.width / logo.height < 2.01);
  assert.equal(logo.alongOffset, 0);
  const photo = restaurantMediaPlacement({ ...media, kind: 'photo' }, target);
  assert.ok(photo.height > logo.height);
  assert.ok(photo.alongOffset > 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

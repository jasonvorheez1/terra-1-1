// Live contract test for the no-key Wikimedia/Wikidata enrichment path.

import assert from 'node:assert/strict';
import { resolveRestaurantMediaDescriptor } from '../src/world/restaurant-media.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: {
    'User-Agent': 'TerraAmbulate/1.0 (restaurant media integration test)',
    ...(init.headers || {}),
  },
});

// McDonald's is only a stable, globally mapped test identity. Production uses
// the exact brand:wikidata/wikidata/wikimedia_commons tag on any restaurant.
const media = await resolveRestaurantMediaDescriptor({
  name: "McDonald's",
  brandWikidata: 'Q38076',
});

assert.ok(media, 'Wikidata did not resolve a Commons image');
assert.equal(media.kind, 'logo');
assert.match(media.title, /^File:/);
assert.match(media.thumbUrl, /^https:\/\//);
assert.match(media.sourceUrl, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
assert.ok(media.width > 0 && media.height > 0, 'Commons returned invalid image dimensions');
assert.ok(media.artist, 'creator attribution was lost');
assert.ok(media.licence, 'licence attribution was lost');

console.log(`  ok  Wikidata ${media.wikidata} -> ${media.title}`);
console.log(`      ${media.artist} · ${media.licence}`);

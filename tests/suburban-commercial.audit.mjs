import { Projection } from '../src/geo/projection.js';
import { OverpassClient, OsmData } from '../src/geo/overpass.js';
import { overtureBuildings, overturePlaces } from '../src/geo/overture.js';
import {
  extractFeatures, mergeOvertureBuildings, mergeOvertureRestaurantPlaces,
  inferBuildingKinds, inferMissingHeights, assignRestaurantBusinesses,
  assignEntrances, inferCommercialSites,
} from '../src/world/features.js';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => realFetch(url, {
  ...init,
  headers: {
    'User-Agent': 'TerraAmbulate/1.0 (suburban commercial data audit)',
    ...(init.headers || {}),
  },
});

const SITES = [
  { name: 'in-game screenshot coordinates', lat: 38.971444, lon: -94.690778 },
  { name: '13570-13630 W 87th Street reference', lat: 38.9714, lon: -94.7435 },
];
const FOOD = 'restaurant|cafe|fast_food|food_court|ice_cream|bar|pub';

function query(box) {
  const b = `${box.south.toFixed(6)},${box.west.toFixed(6)},${box.north.toFixed(6)},${box.east.toFixed(6)}`;
  return `[out:json][timeout:40];
(
  way["building"](${b});
  relation["building"]["type"="multipolygon"](${b});
  way["highway"](${b});
  way["landuse"](${b});
  relation["landuse"]["type"="multipolygon"](${b});
  way["amenity"="parking"](${b});
  node["amenity"~"^(${FOOD})$"](${b});
  way["amenity"~"^(${FOOD})$"](${b});
  relation["amenity"~"^(${FOOD})$"]["type"="multipolygon"](${b});
);
out body qt;
>;
out skel qt;`;
}

const compactTags = (tags = {}) => Object.fromEntries(Object.entries(tags).filter(([key]) =>
  ['building', 'building:levels', 'height', 'amenity', 'shop', 'office', 'name',
   'brand', 'surface', 'parking', 'service', 'landuse'].includes(key)));

for (const site of SITES) {
  const projection = new Projection(site.lat, site.lon);
  const box = projection.localRectToBBox(-500, -500, 500, 500);
  const overpass = new OverpassClient();
  overpass.timeoutSec = 40;
  const [osmResult, buildingResult, placeResult] = await Promise.allSettled([
    overpass.run(query(box), { cacheKey: `suburban-commercial-audit:v1:${site.lat},${site.lon}` }),
    overtureBuildings.fetchBuildings(box),
    overturePlaces.fetchPlaces(box),
  ]);
  const osm = new OsmData();
  if (osmResult.status === 'fulfilled') osm.ingest(osmResult.value).indexJunctions();
  const fs = extractFeatures(osm, projection);
  const merge = buildingResult.status === 'fulfilled'
    ? mergeOvertureBuildings(fs, buildingResult.value, projection) : null;
  const places = placeResult.status === 'fulfilled'
    ? mergeOvertureRestaurantPlaces(fs, placeResult.value, projection) : null;

  console.log(`\n=== ${site.name} @ ${site.lat}, ${site.lon} ===`);
  console.log({
    osm: osmResult.status,
    overtureBuildings: buildingResult.status,
    overturePlaces: placeResult.status,
    buildings: fs.buildings.length,
    roads: fs.roads.length,
    landcover: fs.landcover.length,
    parking: fs.landcover.filter((x) => x.spec?.key === 'amenity=parking').length,
    restaurantPois: fs.pois.filter((x) => /restaurant|cafe|fast_food|food_court|ice_cream|bar|pub/.test(x.tags?.amenity || '')).length,
    merge,
    places,
  });
  console.log('LANDCOVER', fs.landcover.map((x) => ({
    source: x.source,
    key: x.spec?.key,
    cover: x.spec?.cover,
    surface: x.spec?.surface?.id,
    area: +x.area.toFixed(1),
    tags: compactTags(x.tags),
  })).sort((a, b) => b.area - a.area).slice(0, 20));

  const foodPois = fs.pois.filter((x) =>
    /restaurant|cafe|fast_food|food_court|ice_cream|bar|pub/.test(x.tags?.amenity || ''));
  for (const poi of foodPois.filter((p) =>
    /pizza|hut/i.test(`${p.name || ''} ${p.tags?.brand || ''}`) || Math.hypot(p.x, p.z) < 180)) {
    console.log('POI', {
      id: poi.id, name: poi.name, x: +poi.x.toFixed(1), z: +poi.z.toFixed(1),
      distance: +Math.hypot(poi.x, poi.z).toFixed(1), tags: compactTags(poi.tags),
      source: poi.tags?.['terra:source'], confidence: poi.tags?.['terra:confidence'],
    });
  }

  assignRestaurantBusinesses(fs);
  inferBuildingKinds(fs);
  inferMissingHeights(fs);
  assignEntrances(fs);
  const siteStats = inferCommercialSites(fs);
  console.log('COMMERCIAL SITES', siteStats);
  const interesting = fs.buildings.filter((b) => b.restaurant || Math.hypot(...b.centroid) < 180)
    .sort((a, b) => Math.hypot(...a.centroid) - Math.hypot(...b.centroid));
  for (const b of interesting.slice(0, 30)) {
    console.log('BUILDING', {
      source: b.source,
      distance: +Math.hypot(...b.centroid).toFixed(1),
      area: +b.area.toFixed(1),
      kind: b.kind,
      kindInferred: b.kindInferred || null,
      levels: b.levels,
      height: +b.heights.top.toFixed(1),
      inferredHeight: !!b.heights.inferred,
      restaurant: b.restaurant?.name || null,
      commercialForm: b.commercialForm || null,
      commercialSite: b.commercialSite ? {
        parking: b.commercialSite.parking,
        synthetic: b.commercialSite.parkingSynthetic,
        sign: !!b.commercialSite.sign,
      } : null,
      tags: compactTags(b.tags),
      geometrySource: b.geometrySource || null,
    });
  }
}

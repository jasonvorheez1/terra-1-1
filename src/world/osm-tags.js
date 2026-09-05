// Interpreting OpenStreetMap tags.
//
// OSM is a folksonomy, not a schema: heights arrive as "12", "12 m", "40'" or
// "40 ft"; colours as "white", "#e8d9c0" or "light_gray"; a building's storey
// count may live in `building:levels`, `levels`, or nowhere at all. Everything
// in this file turns that mess into numbers the geometry builders can trust,
// with defaults chosen so an untagged building still looks like the kind of
// building its `building=*` value says it is.
//
// The height model follows the Simple 3D Buildings scheme:
//   https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings

import { clamp } from '../core/util.js';
import { hashString, makeRng } from '../core/rng.js';

// --- primitives ------------------------------------------------------------

const FEET_RE = /^\s*(-?[\d.]+)\s*(?:'|ft|feet)\s*(?:(-?[\d.]+)\s*(?:"|in|inch(?:es)?)\s*)?$/i;
const METRE_RE = /^\s*(-?[\d.]+)\s*(?:m|metre|meter|metres|meters)?\s*$/i;

/** Parse an OSM length into metres. Returns null if it cannot be read. */
export function parseLength(value) {
  if (value == null) return null;
  if (typeof value === 'number') return isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  const ft = s.match(FEET_RE);
  if (ft) {
    const feet = parseFloat(ft[1]) || 0;
    const inches = parseFloat(ft[2] || '0') || 0;
    return (feet + inches / 12) * 0.3048;
  }
  const m = s.match(METRE_RE);
  if (m) {
    const v = parseFloat(m[1]);
    return isFinite(v) ? v : null;
  }
  // Last resort: a leading number, e.g. "12;15" or "approx 12".
  const loose = s.match(/-?[\d.]+/);
  if (loose) {
    const v = parseFloat(loose[0]);
    return isFinite(v) ? v : null;
  }
  return null;
}

/** Parse an integer-ish tag (levels, lanes). Handles "2;3" and "2.5". */
export function parseCount(value) {
  if (value == null) return null;
  const m = String(value).match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return isFinite(v) ? v : null;
}

export const isTruthy = (v) => v === 'yes' || v === 'true' || v === '1';
export const isFalsy = (v) => v === 'no' || v === 'false' || v === '0';

// CSS/W3C colour names OSM mappers actually use, plus the OSM-flavoured spellings.
const NAMED_COLOURS = {
  white: 0xffffff, black: 0x1a1a1a, grey: 0x808080, gray: 0x808080,
  lightgrey: 0xd3d3d3, lightgray: 0xd3d3d3, light_grey: 0xd3d3d3, light_gray: 0xd3d3d3,
  darkgrey: 0x555555, darkgray: 0x555555, dark_grey: 0x555555, dark_gray: 0x555555,
  silver: 0xc0c0c0, red: 0xb03a2e, darkred: 0x7b241c, dark_red: 0x7b241c,
  lightred: 0xd98880, light_red: 0xd98880, maroon: 0x6e2c00,
  green: 0x4c7a3f, darkgreen: 0x2e4d24, dark_green: 0x2e4d24,
  lightgreen: 0x9ccc8f, light_green: 0x9ccc8f, olive: 0x6b6b23, lime: 0x8fbc45,
  blue: 0x3d6fa5, darkblue: 0x21496b, dark_blue: 0x21496b,
  lightblue: 0xa8c6e0, light_blue: 0xa8c6e0, navy: 0x1b2f47, teal: 0x2f7a78,
  yellow: 0xd7c14a, gold: 0xc9a227, orange: 0xcf7c33, brown: 0x7a5230,
  darkbrown: 0x4e3524, dark_brown: 0x4e3524, lightbrown: 0xa9805a, light_brown: 0xa9805a,
  beige: 0xd9c9a8, cream: 0xe8dcc0, ivory: 0xefe7d4, tan: 0xc8a97e,
  sand: 0xd9c48f, ochre: 0xba8a3d, terracotta: 0xb5643c,
  pink: 0xd9a7b0, purple: 0x6f4a7a, violet: 0x7a5a94,
  turquoise: 0x40b0a6, cyan: 0x54b8c4, magenta: 0xa8478f,
  copper: 0x8a6642, bronze: 0x8c6b3f, brass: 0xb08d3f,
  transparent: 0xcccccc, none: 0xcccccc,
};

/** Parse an OSM colour tag to a 0xRRGGBB int, or null. */
export function parseColour(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();
  const hex = s.match(/^#?([0-9a-f]{6})$/);
  if (hex) return parseInt(hex[1], 16);
  const short = s.match(/^#([0-9a-f]{3})$/);
  if (short) {
    const c = short[1];
    return parseInt(c[0] + c[0] + c[1] + c[1] + c[2] + c[2], 16);
  }
  const rgb = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgb) return (clamp(+rgb[1], 0, 255) << 16) | (clamp(+rgb[2], 0, 255) << 8) | clamp(+rgb[3], 0, 255);
  const key = s.replace(/[\s-]+/g, '_');
  if (key in NAMED_COLOURS) return NAMED_COLOURS[key];
  const nospace = key.replace(/_/g, '');
  if (nospace in NAMED_COLOURS) return NAMED_COLOURS[nospace];
  return null;
}

// --- building materials ----------------------------------------------------

/**
 * Physical look for a facade or roof material. `rough` is PBR roughness,
 * `metal` metalness, `tint` the fallback colour when nothing else is tagged.
 */
export const MATERIALS = {
  brick:        { tint: 0x9c5f4a, rough: 0.92, metal: 0.0, pattern: 'brick' },
  red_brick:    { tint: 0x9c4a3a, rough: 0.92, metal: 0.0, pattern: 'brick' },
  concrete:     { tint: 0xb4b0a8, rough: 0.88, metal: 0.0, pattern: 'panel' },
  cement_block: { tint: 0xb0aca2, rough: 0.9,  metal: 0.0, pattern: 'block' },
  stone:        { tint: 0xb9b0a0, rough: 0.85, metal: 0.0, pattern: 'stone' },
  sandstone:    { tint: 0xcbb187, rough: 0.86, metal: 0.0, pattern: 'stone' },
  limestone:    { tint: 0xd2cbb5, rough: 0.82, metal: 0.0, pattern: 'stone' },
  marble:       { tint: 0xe6e2da, rough: 0.35, metal: 0.0, pattern: 'panel' },
  granite:      { tint: 0x9a938c, rough: 0.6,  metal: 0.0, pattern: 'stone' },
  plaster:      { tint: 0xdfd6c4, rough: 0.9,  metal: 0.0, pattern: 'render' },
  render:       { tint: 0xdcd3c1, rough: 0.9,  metal: 0.0, pattern: 'render' },
  stucco:       { tint: 0xdfd2ba, rough: 0.92, metal: 0.0, pattern: 'render' },
  wood:         { tint: 0x8a6242, rough: 0.85, metal: 0.0, pattern: 'plank' },
  timber_framing: { tint: 0xd8cdb4, rough: 0.88, metal: 0.0, pattern: 'timber' },
  glass:        { tint: 0x8fa6b4, rough: 0.12, metal: 0.25, pattern: 'curtain' },
  mirror:       { tint: 0x9fb4c2, rough: 0.05, metal: 0.6,  pattern: 'curtain' },
  metal:        { tint: 0x9fa3a6, rough: 0.4,  metal: 0.75, pattern: 'panel' },
  steel:        { tint: 0x9aa0a6, rough: 0.35, metal: 0.85, pattern: 'panel' },
  copper:       { tint: 0x6fa38a, rough: 0.5,  metal: 0.7,  pattern: 'panel' },
  zinc:         { tint: 0xa8adb2, rough: 0.45, metal: 0.7,  pattern: 'panel' },
  metal_sheet:  { tint: 0xa5a9ac, rough: 0.45, metal: 0.7,  pattern: 'corrugated' },
  corrugated_iron: { tint: 0x9a9d99, rough: 0.6, metal: 0.6, pattern: 'corrugated' },
  tile:         { tint: 0xa6543f, rough: 0.75, metal: 0.0, pattern: 'tile' },
  roof_tiles:   { tint: 0xa6543f, rough: 0.75, metal: 0.0, pattern: 'tile' },
  slate:        { tint: 0x545a60, rough: 0.7,  metal: 0.0, pattern: 'slate' },
  shingle:      { tint: 0x6b5a48, rough: 0.85, metal: 0.0, pattern: 'shingle' },
  asphalt:      { tint: 0x4a4a4c, rough: 0.95, metal: 0.0, pattern: 'flat' },
  tar_paper:    { tint: 0x3e3e40, rough: 0.95, metal: 0.0, pattern: 'flat' },
  gravel:       { tint: 0x8d8577, rough: 0.98, metal: 0.0, pattern: 'gravel' },
  thatch:       { tint: 0xb59a5e, rough: 0.95, metal: 0.0, pattern: 'thatch' },
  glass_reinforced_plastic: { tint: 0xcfcfc8, rough: 0.5, metal: 0.0, pattern: 'panel' },
  plastic:      { tint: 0xd0cec6, rough: 0.5,  metal: 0.0, pattern: 'panel' },
};

/** Resolve a `*:material` tag to a material spec, or null. */
export function lookupMaterial(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (key in MATERIALS) return MATERIALS[key];
  // OSM often qualifies materials, e.g. "brick;concrete" or "reinforced_concrete".
  for (const part of key.split(/[;,]/)) {
    const p = part.trim();
    if (p in MATERIALS) return MATERIALS[p];
    for (const name in MATERIALS) if (p.includes(name)) return MATERIALS[name];
  }
  return null;
}

// --- buildings -------------------------------------------------------------

/**
 * Typical storey height and default storey count per `building=*` value, plus
 * how the interior generator should treat the space. `floorH` is metres per
 * level; `levels` is the fallback when nothing is tagged.
 */
export const BUILDING_CLASSES = {
  house:        { levels: 2, floorH: 2.9, kind: 'house',      roof: 'gabled' },
  detached:     { levels: 2, floorH: 2.9, kind: 'house',      roof: 'hipped' },
  semidetached_house: { levels: 2, floorH: 2.9, kind: 'house', roof: 'gabled' },
  terrace:      { levels: 2, floorH: 2.9, kind: 'house',      roof: 'gabled' },
  bungalow:     { levels: 1, floorH: 3.0, kind: 'house',      roof: 'hipped' },
  cabin:        { levels: 1, floorH: 2.7, kind: 'house',      roof: 'gabled' },
  hut:          { levels: 1, floorH: 2.4, kind: 'shed',       roof: 'gabled' },
  static_caravan: { levels: 1, floorH: 2.4, kind: 'house',    roof: 'flat' },
  apartments:   { levels: 5, floorH: 3.0, kind: 'apartments', roof: 'flat' },
  residential:  { levels: 3, floorH: 3.0, kind: 'apartments', roof: 'flat' },
  dormitory:    { levels: 4, floorH: 3.0, kind: 'apartments', roof: 'flat' },
  hotel:        { levels: 6, floorH: 3.1, kind: 'hotel',      roof: 'flat' },
  // `building=commercial` is a broad shell description, not evidence of an
  // office tower. Four storeys made every unmeasured suburban shop and clinic
  // into a mid-rise. A named `office=*` still gets the office class below.
  commercial:   { levels: 2, floorH: 3.6, kind: 'office',     roof: 'flat' },
  office:       { levels: 6, floorH: 3.6, kind: 'office',     roof: 'flat' },
  retail:       { levels: 1, floorH: 4.0, kind: 'retail',     roof: 'flat' },
  restaurant:   { levels: 1, floorH: 4.0, kind: 'retail',     roof: 'flat' },
  cafe:         { levels: 1, floorH: 3.6, kind: 'retail',     roof: 'flat' },
  fast_food:    { levels: 1, floorH: 3.8, kind: 'retail',     roof: 'flat' },
  food_court:   { levels: 1, floorH: 4.2, kind: 'retail',     roof: 'flat' },
  ice_cream:    { levels: 1, floorH: 3.5, kind: 'retail',     roof: 'flat' },
  bar:          { levels: 1, floorH: 3.7, kind: 'retail',     roof: 'flat' },
  pub:          { levels: 2, floorH: 3.4, kind: 'retail',     roof: 'gabled' },
  supermarket:  { levels: 1, floorH: 6.0, kind: 'retail',     roof: 'flat' },
  kiosk:        { levels: 1, floorH: 3.0, kind: 'retail',     roof: 'flat' },
  warehouse:    { levels: 1, floorH: 8.0, kind: 'industrial', roof: 'flat' },
  industrial:   { levels: 1, floorH: 7.5, kind: 'industrial', roof: 'flat' },
  factory:      { levels: 2, floorH: 5.5, kind: 'industrial', roof: 'flat' },
  manufacture:  { levels: 2, floorH: 5.5, kind: 'industrial', roof: 'flat' },
  hangar:       { levels: 1, floorH: 12,  kind: 'industrial', roof: 'round' },
  garage:       { levels: 1, floorH: 2.6, kind: 'shed',       roof: 'flat' },
  garages:      { levels: 1, floorH: 2.6, kind: 'shed',       roof: 'flat' },
  carport:      { levels: 1, floorH: 2.6, kind: 'shed',       roof: 'flat' },
  parking:      { levels: 4, floorH: 3.0, kind: 'parking',    roof: 'flat' },
  shed:         { levels: 1, floorH: 2.4, kind: 'shed',       roof: 'skillion' },
  roof:         { levels: 1, floorH: 3.0, kind: 'canopy',     roof: 'flat' },
  greenhouse:   { levels: 1, floorH: 3.5, kind: 'greenhouse', roof: 'round' },
  barn:         { levels: 1, floorH: 6.0, kind: 'barn',       roof: 'gabled' },
  farm:         { levels: 2, floorH: 2.9, kind: 'house',      roof: 'gabled' },
  farm_auxiliary: { levels: 1, floorH: 4.0, kind: 'barn',     roof: 'gabled' },
  stable:       { levels: 1, floorH: 3.5, kind: 'barn',       roof: 'gabled' },
  church:       { levels: 1, floorH: 12,  kind: 'worship',    roof: 'gabled' },
  cathedral:    { levels: 1, floorH: 22,  kind: 'worship',    roof: 'gabled' },
  chapel:       { levels: 1, floorH: 8,   kind: 'worship',    roof: 'gabled' },
  mosque:       { levels: 1, floorH: 12,  kind: 'worship',    roof: 'dome' },
  temple:       { levels: 1, floorH: 10,  kind: 'worship',    roof: 'pyramidal' },
  synagogue:    { levels: 1, floorH: 11,  kind: 'worship',    roof: 'gabled' },
  shrine:       { levels: 1, floorH: 4,   kind: 'worship',    roof: 'pyramidal' },
  school:       { levels: 3, floorH: 3.6, kind: 'school',     roof: 'flat' },
  university:   { levels: 4, floorH: 3.8, kind: 'school',     roof: 'flat' },
  college:      { levels: 3, floorH: 3.8, kind: 'school',     roof: 'flat' },
  kindergarten: { levels: 1, floorH: 3.2, kind: 'school',     roof: 'gabled' },
  hospital:     { levels: 5, floorH: 3.6, kind: 'hospital',   roof: 'flat' },
  civic:        { levels: 3, floorH: 4.0, kind: 'civic',      roof: 'flat' },
  public:       { levels: 3, floorH: 4.0, kind: 'civic',      roof: 'flat' },
  government:   { levels: 4, floorH: 4.0, kind: 'civic',      roof: 'flat' },
  train_station: { levels: 1, floorH: 9,  kind: 'station',    roof: 'round' },
  transportation: { levels: 1, floorH: 7, kind: 'station',    roof: 'flat' },
  stadium:      { levels: 1, floorH: 22,  kind: 'stadium',    roof: 'flat' },
  sports_hall:  { levels: 1, floorH: 11,  kind: 'stadium',    roof: 'round' },
  museum:       { levels: 2, floorH: 5.0, kind: 'civic',      roof: 'flat' },
  castle:       { levels: 3, floorH: 4.5, kind: 'castle',     roof: 'hipped' },
  tower:        { levels: 1, floorH: 20,  kind: 'tower',      roof: 'pyramidal' },
  water_tower:  { levels: 1, floorH: 25,  kind: 'tower',      roof: 'flat' },
  silo:         { levels: 1, floorH: 18,  kind: 'tower',      roof: 'dome' },
  storage_tank: { levels: 1, floorH: 12,  kind: 'tower',      roof: 'flat' },
  bridge:       { levels: 1, floorH: 5,   kind: 'structure',  roof: 'flat' },
  construction: { levels: 2, floorH: 3.2, kind: 'shell',      roof: 'flat' },
  ruins:        { levels: 1, floorH: 3.0, kind: 'shell',      roof: 'none' },
  yes:          { levels: 2, floorH: 3.1, kind: 'generic',    roof: 'flat' },
};

const DEFAULT_CLASS = BUILDING_CLASSES.yes;

/**
 * Does this building say what it is?
 *
 * `building=yes` is a statement that something is there, not what it is, and
 * that is the only case where guessing from the neighbours is an improvement.
 * `building=house` already tells us it is a house of about two storeys - that
 * is real information, and overwriting it with the median of the street is how
 * a house ends up five storeys tall wearing a pitched roof.
 */
export function describesItself(tags) {
  return buildingClass(tags) !== DEFAULT_CLASS;
}

/** Look up the class record for a building's tags. */
export function buildingClass(tags) {
  const b = tags['building'] && tags['building'] !== 'yes' ? tags['building'] : null;
  const p = tags['building:part'] && tags['building:part'] !== 'yes' ? tags['building:part'] : null;
  const shell = b || p;
  // `yes`, `commercial` and `retail` describe a broad shell. A use mapped on
  // that same outline is more specific: this is why a Pizza Hut tagged
  // building=commercial is a one-storey restaurant instead of a four-storey
  // office. Specific shells such as apartments, hotel or warehouse still win,
  // preserving genuine mixed-use buildings with a restaurant on the ground.
  const broadShell = !shell || shell === 'commercial' || shell === 'retail';
  if (broadShell) {
    const amenity = tags['amenity'];
    if (amenity && BUILDING_CLASSES[amenity]) return BUILDING_CLASSES[amenity];
    const shop = tags['shop'];
    if (shop && BUILDING_CLASSES[shop]) return BUILDING_CLASSES[shop];
    if (shop) return BUILDING_CLASSES.retail;
    if (tags['office']) return BUILDING_CLASSES.office;
    if (amenity === 'bank' || amenity === 'clinic' || amenity === 'dentist' ||
        amenity === 'doctors' || amenity === 'veterinary' || amenity === 'post_office') {
      return BUILDING_CLASSES.commercial;
    }
    if (amenity === 'library' || amenity === 'community_centre' ||
        amenity === 'townhall' || amenity === 'police' || amenity === 'fire_station') {
      return BUILDING_CLASSES.civic;
    }
  }
  if (shell && BUILDING_CLASSES[shell]) return BUILDING_CLASSES[shell];
  const key = tags['amenity'] || tags['shop'] || tags['man_made'];
  if (key && BUILDING_CLASSES[key]) return BUILDING_CLASSES[key];
  // Remaining amenity/shop hints when `building=yes`.
  if (tags['shop']) return BUILDING_CLASSES.retail;
  if (tags['office']) return BUILDING_CLASSES.office;
  if (tags['amenity'] === 'place_of_worship') return BUILDING_CLASSES.church;
  if (tags['amenity'] === 'school') return BUILDING_CLASSES.school;
  if (tags['amenity'] === 'hospital') return BUILDING_CLASSES.hospital;
  if (tags['amenity'] === 'parking') return BUILDING_CLASSES.parking;
  if (tags['tourism'] === 'hotel') return BUILDING_CLASSES.hotel;
  return DEFAULT_CLASS;
}

/**
 * Full vertical description of a building or building part, in metres above
 * the ground under it.
 *
 * Returns `{ base, top, wallTop, roofHeight, levels, minLevel, floorH, cls }`
 * where `base` is where the walls start (non-zero for a part that begins on
 * the 5th floor), `wallTop` where they end, and `top` the roof apex.
 */
export function buildingHeights(tags, footprintArea, rng) {
  const cls = buildingClass(tags);
  const floorH = clamp(parseLength(tags['building:level:height']) ||
                       parseLength(tags['level:height']) || cls.floorH, 2.0, 30);

  let levels = parseCount(tags['building:levels']);
  if (levels == null) levels = parseCount(tags['levels']);
  const roofLevels = parseCount(tags['roof:levels']) || 0;

  let height = parseLength(tags['height']) ?? parseLength(tags['building:height']);
  let minHeight = parseLength(tags['min_height']) ?? parseLength(tags['building:min_height']);
  const minLevel = parseCount(tags['building:min_level']) ?? parseCount(tags['min_level']);

  const roof = roofSpec(tags, cls, { area: footprintArea, levels, rng });
  let roofHeight = parseLength(tags['roof:height']);

  // Establish total height from the strongest signal available.
  if (height == null && levels != null) {
    height = levels * floorH + (roofLevels ? roofLevels * floorH : 0);
  }
  if (height == null) {
    // Nothing tagged: vary by class, nudged by footprint size so a big block
    // is not the same height as a corner kiosk, and jittered per building so
    // a street of identical tags is not a street of identical boxes.
    const area = Math.max(20, footprintArea || 120);
    const sizeBoost = clamp(Math.log10(area / 120), -0.35, 0.9);
    const jitter = rng ? rng.range(-0.12, 0.16) : 0;
    levels = Math.max(1, Math.round(cls.levels * (1 + sizeBoost * 0.45 + jitter)));
    height = levels * floorH;
  }
  height = clamp(height, 1.8, 830);   // Burj Khalifa is 828 m; nothing is taller.

  if (levels == null) levels = Math.max(1, Math.round(height / floorH));
  levels = clamp(Math.round(levels), 1, 200);

  // Roof height: explicit tag, else derived from pitch for the shape.
  if (roofHeight == null) {
    if (roofLevels) roofHeight = roofLevels * floorH;
    else roofHeight = defaultRoofHeight(roof.shape, footprintArea, height);
  }
  roofHeight = clamp(roofHeight, 0, Math.max(0, height - 1.5));

  let base = 0;
  if (minHeight != null) base = clamp(minHeight, 0, height - 1);
  else if (minLevel != null) base = clamp(minLevel * floorH, 0, height - 1);

  return {
    base,
    top: height,
    wallTop: height - roofHeight,
    roofHeight,
    levels,
    minLevel: minLevel || 0,
    floorH,
    cls,
    roof,
  };
}

/** A sensible roof rise for a shape, given how big the building is. */
function defaultRoofHeight(shape, area, height) {
  const span = Math.sqrt(Math.max(16, area || 100));
  switch (shape) {
    case 'gabled':
    case 'hipped':
    case 'half-hipped':
    case 'gambrel':
    case 'mansard':
      return clamp(span * 0.28, 1.2, Math.min(9, height * 0.45));
    case 'pyramidal':
      return clamp(span * 0.42, 1.5, Math.min(16, height * 0.6));
    case 'dome':
    case 'onion':
      return clamp(span * 0.5, 2, Math.min(30, height * 0.7));
    case 'round':
      return clamp(span * 0.3, 1.5, Math.min(12, height * 0.5));
    case 'skillion':
      return clamp(span * 0.16, 0.6, Math.min(5, height * 0.35));
    case 'sawtooth':
      return clamp(span * 0.12, 0.6, 4);
    case 'flat':
    default:
      return 0;
  }
}

const ROOF_SHAPES = new Set([
  'flat', 'gabled', 'hipped', 'half-hipped', 'pyramidal', 'skillion', 'gambrel',
  'mansard', 'dome', 'onion', 'round', 'sawtooth', 'none',
  // The saltbox family: asymmetric and cross gables. Drawn as plain gables,
  // which is a rough likeness but a far closer one than the flat slab they
  // used to get - `quadruple_saltbox` was in this set with no case to build it,
  // and `double_saltbox` was not recognised at all. Between them that is 129
  // roofs in Munich alone.
  'saltbox', 'double_saltbox', 'quadruple_saltbox',
]);

// Styles that are deliberately unornamented. Everything else named in
// `building:architecture` - neo-renaissance, classicism, baroque, art nouveau
// and the rest - implies mouldings, a cornice and a pitched roof.
const PLAIN_STYLES = new Set([
  'modern', 'contemporary', 'modernism', 'functionalism', 'international_style',
  'brutalism', 'brutalist', 'postmodern', 'post-modern', 'high-tech', 'bauhaus',
]);

/**
 * When a building is from, and whether it is ornamented.
 *
 * Three tags say this and none of them were being read: `start_date` (286 of
 * 3,750 buildings in central Munich), `building:architecture` (222) and
 * `heritage` (364, and every one of them a protected building). Together they
 * cover a sixth of the stock in an old European city, and they settle things
 * the geometry cannot guess - a nineteenth-century palais should not be given a
 * glass curtain wall because it happens to be tagged as offices, and nothing
 * listed should sprout air handling units on its roof.
 */
export function buildingEra(tags) {
  let year = null;
  const sd = tags['start_date'] || tags['building:start_date'];
  if (sd) {
    const m = String(sd).match(/\d{3,4}/);
    if (m) year = parseInt(m[0], 10);
  }
  const style = (tags['building:architecture'] || '').toLowerCase().trim() || null;
  const listed = !!(tags['heritage'] || tags['heritage:operator'] ||
                    (tags['historic'] && !isFalsy(tags['historic'])));
  const ornate = !!(style && !PLAIN_STYLES.has(style)) ||
                 (year != null && year < 1940 && !PLAIN_STYLES.has(style || ''));
  let period = null;
  if (year != null) {
    period = year < 1900 ? 'historic' : year < 1945 ? 'interwar'
           : year < 1980 ? 'postwar' : 'contemporary';
  } else if (style) {
    period = PLAIN_STYLES.has(style) ? 'contemporary' : 'historic';
  }
  // `heritage` on its own is deliberately not evidence of a period. It says the
  // building is protected, which is a fact about the present, and Bavaria lists
  // plenty of twentieth-century work: the European Patent Office is heritage
  // listed and is eleven storeys of 1970s glass. Protection still suppresses
  // rooftop plant - nothing listed grows air handling units - but the date and
  // the named style are the only things that say what a building looks like.
  return { year, style, listed, ornate, period };
}

/** Roof shape, orientation, colour and material. */
/**
 * Guess a roof for a building nobody has tagged one on.
 *
 * Almost nobody tags `roof:shape`, so falling back to the class default meant
 * falling back to flat, and a town came out as a field of identical boxes with
 * twelve unused roof shapes sitting in the renderer. Nothing here is knowledge
 * about the specific building - it is what the footprint, the height and the
 * date make likely, which is the same reasoning a person uses looking at a map.
 *
 * The rules are about size before type. Tall is flat because above five or six
 * storeys a pitch is a period feature rather than a default; a big low shed is
 * flat or sawtoothed because the roof is the cheapest part of it and it shows;
 * and a small low building is pitched almost everywhere people live. Within
 * each band the choice varies per building from its own seeded rng, so a
 * street of identically tagged houses is not a street of identical houses -
 * but it stays weighted towards the class default, so a terrace still reads as
 * a terrace.
 */
function inferRoofShape(cls, tags, hints) {
  const area = hints.area || 150;
  const storeys = hints.levels || (cls && cls.levels) || 2;
  const kind = (cls && cls.kind) || 'generic';
  const base = (cls && cls.roof) || 'flat';
  const pick = hints.rng ? hints.rng() : 0.5;
  const era = buildingEra(tags);

  if (storeys >= 6) {
    // A nineteenth century block of this height wore a mansard; a modern one
    // does not.
    return (era.period === 'historic' && pick < 0.4) ? 'mansard' : 'flat';
  }

  if (area > 900 && storeys <= 2) {
    if (kind === 'industrial' || kind === 'shed' || kind === 'barn') {
      if (pick < 0.28) return 'sawtooth';
      if (pick < 0.52) return 'skillion';
      return 'flat';
    }
    return 'flat';
  }

  // A class that already expects a pitch varies within its own family: a
  // terrace of houses gets gables and hips, not gables and flat lids.
  if (base !== 'flat' && area < 600 && storeys <= 3) {
    if (pick < 0.54) return base;
    if (pick < 0.74) return base === 'gabled' ? 'hipped' : 'gabled';
    if (pick < 0.87) return 'half-hipped';
    return area < 80 ? 'pyramidal' : 'gambrel';
  }

  // A class that says flat is evidence, not an absence of it: a shop or an
  // apartment block is flat-roofed on purpose. Only a genuinely house-sized
  // footprint is allowed to argue with it, and even then it usually loses -
  // otherwise a dense city comes out as a village, which is what happened when
  // this threshold was 450 m2 and Manhattan turned 54% pitched.
  if (area < 220 && storeys <= 2) {
    if (pick < 0.55) return 'flat';
    if (pick < 0.78) return 'gabled';
    if (pick < 0.92) return 'hipped';
    return 'skillion';
  }

  if (era.period === 'historic') return pick < 0.6 ? 'gabled' : 'mansard';
  return base;
}

export function roofSpec(tags, cls, hints = {}) {
  let shape = (tags['roof:shape'] || tags['building:roof:shape'] || '').toLowerCase().replace(/\s+/g, '_');
  if (shape === 'half_hipped') shape = 'half-hipped';
  if (!ROOF_SHAPES.has(shape)) shape = inferRoofShape(cls, tags, hints);
  const orientation = (tags['roof:orientation'] || 'along').toLowerCase();
  const direction = parseCount(tags['roof:direction']);
  const material = lookupMaterial(tags['roof:material']);
  const colour = parseColour(tags['roof:colour'] || tags['roof:color']);
  return { shape, orientation, direction, material, colour };
}

/** Facade colour and material, resolving the several tags people use. */
export function facadeSpec(tags, cls, rng) {
  const material = lookupMaterial(tags['building:material'] || tags['material'] ||
                                  tags['building:facade:material'] || tags['wall']);
  let colour = parseColour(tags['building:colour'] || tags['building:color'] ||
                           tags['colour'] || tags['color'] ||
                           tags['building:facade:colour']);
  if (colour == null) {
    colour = material ? material.tint : palettedColour(cls, rng);
  }
  return { colour, material };
}

// Believable facade palettes per building kind, sampled deterministically.
const PALETTES = {
  house:      [0xd8cfbe, 0xe3dcc9, 0xc7b9a2, 0xb8a58c, 0xa8927a, 0xd9c4a8, 0xbfae96, 0xe8e0cd],
  apartments: [0xc9c2b4, 0xd6cfc0, 0xb3aa9b, 0xa39a8d, 0xcdbfa8, 0xbdb3a3, 0xdad2c2],
  office:     [0x9aa6ad, 0x8794a0, 0xa9b3b8, 0xb9c0c4, 0x7f8c96, 0xc3c8cb],
  retail:     [0xd2c9b8, 0xc4b8a4, 0xbfb5a6, 0xd9d0bd, 0xb0a493],
  hotel:      [0xd4c8b2, 0xc2b49a, 0xdad0bc, 0xb5a68d],
  industrial: [0xa8a49b, 0x9a968d, 0xb5b1a7, 0x8e8a82],
  civic:      [0xcfc7b6, 0xdbd4c3, 0xbdb4a2, 0xc8bfa9],
  school:     [0xd0c6b0, 0xc3b9a3, 0xdcd3bf],
  hospital:   [0xdcd8cf, 0xe6e2d9, 0xcfcbc2],
  worship:    [0xd6cdb6, 0xc4b89c, 0xb9ab8d, 0xe0d8c4],
  barn:       [0x8b5a3c, 0x9c6b45, 0x7a4f34, 0xa9a094],
  shed:       [0xa9a296, 0x9b9488, 0xb8b1a4],
  castle:     [0xa9a094, 0x968d80, 0xb5aca0],
  station:    [0xc0bab0, 0xaea89e, 0xd0cac0],
  tower:      [0xb0aca4, 0xa09c94, 0xc0bcb4],
  generic:    [0xc6bfb1, 0xb5ada0, 0xd2cbbd, 0xa79f92, 0xdad3c5],
};

/**
 * Where in the world we are building, for the palettes below.
 *
 * Set once per session from the origin rather than threaded through every call
 * site: a session has one location, and the alternative is passing a region
 * through facadeSpec, extractFeatures and every generator that makes a
 * building.
 */
let facadeRegion = 'default';

export function setFacadeRegion(lat, lon) {
  facadeRegion = regionForLatLon(lat, lon);
  return facadeRegion;
}

export function regionForLatLon(lat, lon) {
  // Deliberately coarse. The point is not to draw borders, it is that the
  // building stock of northern Europe does not look like the building stock of
  // Arizona, and picking by continent-sized box gets most of that.
  // Order matters: the narrow boxes are tested before the broad ones they sit
  // inside. Arabia and Iran fall within any sane bounding box for Africa, and
  // an unordered test put Tehran and Riyadh in it.
  if (lat > 12 && lat < 42 && lon > 34 && lon < 63) return 'middleEast';
  if (lat > 5 && lat < 37 && lon > 60 && lon < 92) return 'southAsia';
  if (lat > 26 && lat < 46 && lon > 100 && lon < 146) return 'eastAsia';
  if (lat > -11 && lat < 29 && lon > 92 && lon < 142) return 'southeastAsia';
  if (lat < -9 && lat > -48 && lon > 112 && lon < 180) return 'oceania';

  if (lat > 35 && lat < 72 && lon > -25 && lon < 60) {
    if (lat < 45 && lon > -10 && lon < 30) return 'mediterranean';
    // East to the Urals: Moscow is birch and spruce country, not Bavaria.
    if (lat > 51) return 'northEurope';
    return 'centralEurope';
  }

  // Mexico and the Caribbean belong with Latin America, not with Ohio, so this
  // is tested before the North American box that would otherwise swallow them.
  if (lat < 27 && lat > -56 && lon > -118 && lon < -33) return 'latinAmerica';
  if (lat > 24 && lat < 72 && lon > -170 && lon < -52) {
    // The dry south-west builds in stucco and adobe colours; the rest of North
    // America in painted siding and brick.
    if (lat < 38 && lon > -125 && lon < -96) return 'southwest';
    return 'northAmerica';
  }
  if (lat < 37 && lat > -35 && lon > -18 && lon < 52) return 'africa';
  return 'default';
}

/**
 * Regional facade palettes.
 *
 * Only about one building in twenty carries `building:colour` and one in
 * thirty-five a material, so for the overwhelming majority the colour is ours
 * to choose. It was being chosen from a set that varied in brightness and
 * almost not at all in hue: 2,600 buildings in Manhattan spanned six degrees
 * of hue, which is why a city came out as one shade of beige with the lights
 * turned up and down.
 *
 * These are not per-building truth - that is not in the data and cannot be
 * invented honestly. They are the right *distribution* for a place: Munich is
 * ochre and cream and pale green, Amsterdam is dark brick, the American suburb
 * is painted siding, Phoenix is stucco. A street drawn from the right
 * distribution reads as that city even when no single house is correct.
 */
const REGIONAL_PALETTES = {
  northEurope: {
    house:      [0x9c5f4a, 0x8a4b3c, 0xb08a6a, 0xd9d2c4, 0x7d5442, 0xc4a882, 0x6f4436],
    apartments: [0x8f5340, 0xa66b49, 0x9b6b52, 0xc0a488, 0x7a4a3a],
    generic:    [0x9c5f4a, 0xb08a6a, 0xc9bda8, 0x8a6a52, 0xd2c8b6, 0x7d5442],
  },
  centralEurope: {
    house:      [0xe0cfa8, 0xd8c9a0, 0xc9b68e, 0xe8dcc0, 0xcbb894, 0xdcc8a4],
    apartments: [0xdcc9a2, 0xc9b68e, 0xe6d8b4, 0xbfae8c, 0xd0bfa0, 0xe2d4bc],
    generic:    [0xdcc9a2, 0xd2c0a0, 0xc4b294, 0xe6d8b4, 0xcbbfa8, 0xbaa88c],
  },
  mediterranean: {
    house:      [0xeee4d2, 0xe8dcc4, 0xd9c9a8, 0xe4d2b0, 0xcfa882, 0xf0e8da],
    apartments: [0xe8dcc4, 0xdccbaa, 0xe0cfae, 0xf0e6d4, 0xcfb894],
    generic:    [0xe8dcc4, 0xe0d0b2, 0xd4c2a2, 0xefe6d6, 0xc9b596],
  },
  northAmerica: {
    house:      [0xdcd6c8, 0xc8cec6, 0xb8c0c4, 0xd8cab4, 0xa9b2a6, 0xe4e0d6, 0x9c8f7e, 0xcdd4d8],
    apartments: [0xc4bcae, 0xb2aca0, 0xd0c8ba, 0xa89c8c],
    generic:    [0xc9c2b4, 0xbcc2c0, 0xd2ccbe, 0xaeb4b2, 0xdad3c5, 0xa89c8c],
  },
  southwest: {
    house:      [0xd8be9a, 0xc9a884, 0xe0cba8, 0xb89a76, 0xd2b28c, 0xe8d8bc],
    apartments: [0xd2b48c, 0xc0a078, 0xdec5a2, 0xb59470],
    generic:    [0xd2b48c, 0xc8ab86, 0xdcc4a4, 0xbb9c78, 0xe4d2b6],
  },
  eastAsia: {
    house:      [0xd8d4cc, 0xc4c8c8, 0xb0b6ba, 0xe0dcd4, 0xa8aeb2],
    apartments: [0xc8cccc, 0xb4babc, 0xd4d8d8, 0xa0a8ac],
    generic:    [0xc8cccc, 0xbcc0c0, 0xd4d8d8, 0xacb2b4],
  },
  latinAmerica: {
    house:      [0xe4d2a8, 0xd8b48c, 0xc9d2c0, 0xe8c8a4, 0xbcc8cc, 0xdcc0b0],
    apartments: [0xd8c4a0, 0xc8b490, 0xe0d0b0, 0xbcac90],
    generic:    [0xd8c4a0, 0xcbbca0, 0xe0cfae, 0xbfae94],
  },
};

function palettedColour(cls, rng) {
  const kind = (cls && cls.kind) || 'generic';
  const region = REGIONAL_PALETTES[facadeRegion];
  const pal = (region && (region[kind] || region.generic)) ||
              PALETTES[kind] || PALETTES.generic;
  if (!rng) return pal[0];
  return pal[Math.floor(rng() * pal.length) % pal.length];
}

/** Stable per-feature RNG so a building looks the same every time you visit. */
export function featureRng(type, id, salt = 0) {
  return makeRng(hashString(`${type}/${id}/${salt}`));
}

// --- roads, paths and rail -------------------------------------------------

/**
 * Per-`highway=*` carriageway geometry. `width` is the default full width in
 * metres, `lanes` the default lane count, `kind` groups them for materials and
 * for deciding whether the game draws sidewalks and markings alongside.
 */
export const HIGHWAY_CLASSES = {
  motorway:       { width: 14.0, lanes: 4, kind: 'motorway', surface: 'asphalt', sidewalk: false, markings: true, priority: 9 },
  motorway_link:  { width: 7.0,  lanes: 2, kind: 'motorway', surface: 'asphalt', sidewalk: false, markings: true, priority: 8 },
  trunk:          { width: 12.0, lanes: 4, kind: 'major',    surface: 'asphalt', sidewalk: false, markings: true, priority: 8 },
  trunk_link:     { width: 6.5,  lanes: 2, kind: 'major',    surface: 'asphalt', sidewalk: false, markings: true, priority: 7 },
  primary:        { width: 10.0, lanes: 3, kind: 'major',    surface: 'asphalt', sidewalk: true,  markings: true, priority: 7 },
  primary_link:   { width: 6.0,  lanes: 2, kind: 'major',    surface: 'asphalt', sidewalk: true,  markings: true, priority: 6 },
  secondary:      { width: 9.0,  lanes: 2, kind: 'major',    surface: 'asphalt', sidewalk: true,  markings: true, priority: 6 },
  secondary_link: { width: 5.5,  lanes: 1, kind: 'major',    surface: 'asphalt', sidewalk: true,  markings: true, priority: 5 },
  tertiary:       { width: 8.0,  lanes: 2, kind: 'street',   surface: 'asphalt', sidewalk: true,  markings: true, priority: 5 },
  tertiary_link:  { width: 5.0,  lanes: 1, kind: 'street',   surface: 'asphalt', sidewalk: true,  markings: false, priority: 4 },
  unclassified:   { width: 6.0,  lanes: 2, kind: 'street',   surface: 'asphalt', sidewalk: true,  markings: false, priority: 4 },
  residential:    { width: 6.0,  lanes: 2, kind: 'street',   surface: 'asphalt', sidewalk: true,  markings: false, priority: 4 },
  living_street:  { width: 5.5,  lanes: 1, kind: 'street',   surface: 'paving_stones', sidewalk: false, markings: false, priority: 3 },
  pedestrian:     { width: 8.0,  lanes: 0, kind: 'plaza',    surface: 'paving_stones', sidewalk: false, markings: false, priority: 3 },
  service:        { width: 4.0,  lanes: 1, kind: 'service',  surface: 'asphalt', sidewalk: false, markings: false, priority: 2 },
  track:          { width: 3.0,  lanes: 1, kind: 'track',    surface: 'dirt',    sidewalk: false, markings: false, priority: 2 },
  busway:         { width: 7.0,  lanes: 2, kind: 'street',   surface: 'asphalt', sidewalk: false, markings: true,  priority: 5 },
  footway:        { width: 2.0,  lanes: 0, kind: 'foot',     surface: 'paving_stones', sidewalk: false, markings: false, priority: 1 },
  path:           { width: 1.6,  lanes: 0, kind: 'foot',     surface: 'ground',  sidewalk: false, markings: false, priority: 1 },
  bridleway:      { width: 2.0,  lanes: 0, kind: 'foot',     surface: 'ground',  sidewalk: false, markings: false, priority: 1 },
  cycleway:       { width: 2.5,  lanes: 0, kind: 'cycle',    surface: 'asphalt', sidewalk: false, markings: false, priority: 2 },
  steps:          { width: 2.0,  lanes: 0, kind: 'steps',    surface: 'concrete', sidewalk: false, markings: false, priority: 1 },
  corridor:       { width: 2.0,  lanes: 0, kind: 'foot',     surface: 'concrete', sidewalk: false, markings: false, priority: 1 },
  raceway:        { width: 10.0, lanes: 2, kind: 'major',    surface: 'asphalt', sidewalk: false, markings: true, priority: 5 },
  road:           { width: 6.0,  lanes: 2, kind: 'street',   surface: 'asphalt', sidewalk: false, markings: false, priority: 3 },
};

/** Surface appearance: colour, roughness and the footstep sound to play. */
export const SURFACES = {
  asphalt:        { tint: 0x55575c, rough: 0.94, sound: 'concrete' },
  concrete:       { tint: 0x8e8d88, rough: 0.92, sound: 'concrete' },
  paving_stones:  { tint: 0x968f86, rough: 0.9,  sound: 'stone' },
  sett:           { tint: 0x8a857d, rough: 0.93, sound: 'stone' },
  cobblestone:    { tint: 0x87817a, rough: 0.94, sound: 'stone' },
  unhewn_cobblestone: { tint: 0x76706a, rough: 0.95, sound: 'stone' },
  bricks:         { tint: 0x92604c, rough: 0.92, sound: 'stone' },
  gravel:         { tint: 0x8f887a, rough: 0.98, sound: 'gravel' },
  fine_gravel:    { tint: 0x9b9382, rough: 0.98, sound: 'gravel' },
  pebblestone:    { tint: 0x938b7c, rough: 0.98, sound: 'gravel' },
  compacted:      { tint: 0x8a8071, rough: 0.97, sound: 'gravel' },
  dirt:           { tint: 0x7a6448, rough: 0.98, sound: 'dirt' },
  ground:         { tint: 0x74654e, rough: 0.98, sound: 'dirt' },
  earth:          { tint: 0x74654e, rough: 0.98, sound: 'dirt' },
  mud:            { tint: 0x5f5138, rough: 0.99, sound: 'dirt' },
  sand:           { tint: 0xc4ad82, rough: 0.98, sound: 'sand' },
  grass:          { tint: 0x5d7a42, rough: 0.97, sound: 'grass' },
  grass_paver:    { tint: 0x6b7d54, rough: 0.96, sound: 'grass' },
  wood:           { tint: 0x8a6a48, rough: 0.88, sound: 'wood' },
  metal:          { tint: 0x8f9498, rough: 0.5,  sound: 'metal' },
  rubber:         { tint: 0x5a4a48, rough: 0.9,  sound: 'concrete' },
  snow:           { tint: 0xe8eef2, rough: 0.9,  sound: 'snow' },
  ice:            { tint: 0xcfe0e8, rough: 0.3,  sound: 'snow' },
  water:          { tint: 0x3d5f78, rough: 0.1,  sound: 'water' },
};

export function lookupSurface(value, fallback = 'asphalt') {
  if (value) {
    const k = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (k in SURFACES) return { id: k, ...SURFACES[k] };
    for (const part of k.split(/[;:]/)) if (part in SURFACES) return { id: part, ...SURFACES[part] };
  }
  return { id: fallback, ...(SURFACES[fallback] || SURFACES.asphalt) };
}

/**
 * Everything the road builder needs from a `highway=*` way.
 *
 * Width comes from `width` when tagged, otherwise from the lane count times a
 * lane width that depends on the road class, otherwise from the class default.
 * `layer`, `tunnel`, `bridge` and `level` decide vertical placement.
 */
export function roadSpec(tags) {
  const hw = tags['highway'];
  const cls = HIGHWAY_CLASSES[hw] || HIGHWAY_CLASSES.road;

  const oneway = isTruthy(tags['oneway']) || tags['oneway'] === '-1' ||
                 tags['junction'] === 'roundabout';

  let width = parseLength(tags['width']) ?? parseLength(tags['est_width']) ??
              parseLength(tags['width:carriageway']);
  // `lanes` is frequently absent on ways that carry lanes:forward and
  // lanes:backward instead - common on anything with an asymmetric layout.
  let lanes = parseCount(tags['lanes']);
  const lanesForward = parseCount(tags['lanes:forward']) || 0;
  const lanesBackward = parseCount(tags['lanes:backward']) || 0;
  const lanesBothWays = parseCount(tags['lanes:both_ways']) || 0;
  if (lanes == null) {
    if (lanesForward || lanesBackward || lanesBothWays) {
      lanes = lanesForward + lanesBackward + lanesBothWays;
    }
  }
  // On-street parking is most of a lane either side, and it is tagged far more
  // often than width is - so it belongs on the class default as much as on a
  // lane count. A residential street with parking both sides is nearer eleven
  // metres kerb to kerb than six.
  const parkingSides = parkingLaneSides(tags);
  const parking = (parkingSides.left ? 2.1 : 0) + (parkingSides.right ? 2.1 : 0);

  if (width == null && lanes != null && lanes > 0 && cls.lanes > 0) {
    const laneWidth = cls.kind === 'motorway' ? 3.65 : cls.kind === 'major' ? 3.35 : 3.0;
    width = lanes * laneWidth + parking;
  }
  if (width == null) {
    width = cls.width + parking;
    // `service` covers everything from a supermarket aisle to a house drive,
    // and the difference between them is several metres.
    if (hw === 'service') {
      const svc = tags['service'];
      if (svc === 'driveway') width = 3.0;
      else if (svc === 'parking_aisle') width = 5.5;
      else if (svc === 'alley') width = 3.6;
      else if (svc === 'drive-through') width = 3.4;
    }
    // A one-way street is about half a two-way one. Only the class default is
    // narrowed: an explicit width or lane count already says what is there.
    if (oneway && cls.lanes >= 2) width *= 0.62;
  }
  width = clamp(width, 0.8, 60);
  const tunnel = tags['tunnel'] && !isFalsy(tags['tunnel']) ? tags['tunnel'] : null;
  const bridge = tags['bridge'] && !isFalsy(tags['bridge']) ? tags['bridge'] : null;
  const covered = isTruthy(tags['covered']) || tags['covered'] === 'roof';
  let layer = parseCount(tags['layer']) || 0;
  // A tunnel or bridge with no explicit layer still has to go somewhere.
  if (layer === 0 && tunnel) layer = -1;
  if (layer === 0 && bridge) layer = 1;

  const surface = lookupSurface(tags['surface'], cls.surface);
  const area = isTruthy(tags['area']) || hw === 'pedestrian' && isTruthy(tags['area']);

  // In most European cities the pavement is not a property of the road: it is
  // its own way, tagged `footway=sidewalk`. Those have to be built as raised
  // kerbed pavements rather than flat paths, or a city that maps them properly
  // ends up looking like it has no pavements at all.
  const isPavement = tags['footway'] === 'sidewalk' || tags['path'] === 'sidewalk';
  const isCrossing = tags['footway'] === 'crossing' || tags['path'] === 'crossing' ||
                     tags['cycleway'] === 'crossing';
  const sidewalkSides = resolveSidewalkSides(tags, cls.sidewalk);
  const laneMarkings = !isFalsy(tags['lane_markings']) && !isFalsy(tags['markings']);
  const crossingStyle = String(tags['crossing:markings'] || tags['crossing'] || '').toLowerCase();

  return {
    highway: hw,
    cls,
    kind: cls.kind,
    width,
    lanes: lanes || cls.lanes,
    lanesForward,
    lanesBackward,
    lanesBothWays,
    oneway,
    tunnel,
    bridge,
    covered,
    layer: clamp(layer, -6, 6),
    level: parseCount(tags['level']),
    surface,
    area,
    markings: cls.markings && laneMarkings && !tunnel,
    // The road's own tag beats the class default in both directions. It used
    // to be able to veto a pavement but never ask for one, so a service road
    // or a trunk tagged `sidewalk=both` got none - and, more to the point, the
    // default gave every American residential street a pavement whether or not
    // it has one. Where the tag is silent the class default still decides.
    sidewalk: sidewalkSides.any && !tunnel && !bridge,
    sidewalkLeft: sidewalkSides.left && !tunnel && !bridge,
    sidewalkRight: sidewalkSides.right && !tunnel && !bridge,
    sidewalkTagged: sidewalkSides.tagged,
    // A pavement way is raised on a kerb; a crossing is flush, because that is
    // the point of a crossing.
    pavement: !!isPavement && !isCrossing && !bridge && !tunnel,
    crossing: !!isCrossing,
    crossingMarked: !!isCrossing && crossingStyle !== 'unmarked' && crossingStyle !== 'no',
    name: tags['name'] || tags['ref'] || null,
    maxspeed: parseCount(tags['maxspeed']),
    steps: hw === 'steps',
    stepCount: parseCount(tags['step_count']),
    incline: tags['incline'] || null,
    access: tags['access'] || null,
    indoor: isTruthy(tags['indoor']),
    lit: isTruthy(tags['lit']),
  };
}

/** Preserve which side of the directed way a mapped sidewalk occupies. */
function resolveSidewalkSides(tags, classDefault) {
  const present = (v) => !!(v && !['no', 'none', 'separate'].includes(String(v).toLowerCase()));
  const combined = String(tags['sidewalk'] || tags['sidewalk:both'] || '').toLowerCase();
  if (combined) {
    if (combined === 'left') return { left: true, right: false, any: true, tagged: true };
    if (combined === 'right') return { left: false, right: true, any: true, tagged: true };
    const both = present(combined);
    return { left: both, right: both, any: both, tagged: true };
  }
  const hasLeft = tags['sidewalk:left'] != null;
  const hasRight = tags['sidewalk:right'] != null;
  if (hasLeft || hasRight) {
    const left = hasLeft ? present(tags['sidewalk:left']) : false;
    const right = hasRight ? present(tags['sidewalk:right']) : false;
    return { left, right, any: left || right, tagged: true };
  }
  const fallback = !!classDefault;
  return { left: fallback, right: fallback, any: fallback, tagged: false };
}

/** Count only parking which occupies the carriageway, never `no`/off-street. */
function parkingLaneSides(tags) {
  const lane = (side) => {
    const modern = tags[`parking:${side}`];
    const legacy = tags[`parking:lane:${side}`];
    const value = String(modern != null ? modern : legacy != null ? legacy : '').toLowerCase();
    return ['lane', 'parallel', 'diagonal', 'perpendicular', 'marked', 'yes'].includes(value);
  };
  const bothValue = String(tags['parking:both'] != null ? tags['parking:both']
    : tags['parking:lane:both'] != null ? tags['parking:lane:both'] : '').toLowerCase();
  const both = ['lane', 'parallel', 'diagonal', 'perpendicular', 'marked', 'yes'].includes(bothValue);
  return { left: both || lane('left'), right: both || lane('right') };
}

/** Rail geometry for `railway=*`. */
export const RAILWAY_CLASSES = {
  rail:           { width: 3.2, kind: 'heavy',  ballast: 2.6 },
  light_rail:     { width: 3.0, kind: 'light',  ballast: 2.4 },
  subway:         { width: 3.0, kind: 'metro',  ballast: 2.4 },
  tram:           { width: 2.9, kind: 'tram',   ballast: 0 },
  narrow_gauge:   { width: 2.4, kind: 'light',  ballast: 2.0 },
  monorail:       { width: 2.0, kind: 'mono',   ballast: 0 },
  funicular:      { width: 2.6, kind: 'light',  ballast: 2.0 },
  preserved:      { width: 3.2, kind: 'heavy',  ballast: 2.6 },
  disused:        { width: 3.0, kind: 'heavy',  ballast: 2.4 },
  construction:   { width: 3.0, kind: 'heavy',  ballast: 2.4 },
  miniature:      { width: 1.2, kind: 'light',  ballast: 1.0 },
};

export function railSpec(tags) {
  const cls = RAILWAY_CLASSES[tags['railway']] || null;
  if (!cls) return null;
  const tunnel = tags['tunnel'] && !isFalsy(tags['tunnel']) ? tags['tunnel'] : null;
  const bridge = tags['bridge'] && !isFalsy(tags['bridge']) ? tags['bridge'] : null;
  let layer = parseCount(tags['layer']) || 0;
  if (layer === 0 && tunnel) layer = -1;
  if (layer === 0 && bridge) layer = 1;
  if (tags['railway'] === 'subway' && layer === 0) layer = -1;
  const tracks = parseCount(tags['tracks']) || 1;
  return {
    railway: tags['railway'],
    cls,
    kind: cls.kind,
    width: cls.width * Math.max(1, tracks),
    tracks,
    tunnel,
    bridge,
    layer: clamp(layer, -6, 6),
    electrified: tags['electrified'] && tags['electrified'] !== 'no',
    name: tags['name'] || null,
  };
}

/**
 * How far above or below the surrounding ground a layered way sits.
 *
 * OSM `layer` is only an ordering hint, not a measurement, so we turn it into
 * plausible metres: bridge decks clear what they cross, tunnels sit a storey
 * or more down, and each extra layer stacks another level.
 */
export function layerOffset(spec) {
  if (spec.bridge) {
    const base = spec.kind === 'foot' || spec.kind === 'cycle' ? 5.0 : 6.0;
    return base + Math.max(0, spec.layer - 1) * 5.5;
  }
  if (spec.tunnel) {
    if (spec.tunnel === 'building_passage') return 0;      // a hole through a building
    if (spec.tunnel === 'culvert') return -1.2;
    const base = spec.kind === 'foot' || spec.kind === 'cycle' ? -4.5 : -6.5;
    return base + Math.min(0, spec.layer + 1) * 5.5;
  }
  if (spec.layer > 0) return spec.layer * 5.5;
  if (spec.layer < 0) return spec.layer * 5.0;
  return 0;
}

// --- barriers --------------------------------------------------------------

/** Solid things you cannot walk through: height in metres, plus how to draw them. */
export const BARRIER_CLASSES = {
  wall:          { height: 2.2, thickness: 0.35, kind: 'wall',  tint: 0xa8a296 },
  city_wall:     { height: 6.0, thickness: 1.6,  kind: 'wall',  tint: 0x9d968a },
  retaining_wall:{ height: 1.6, thickness: 0.5,  kind: 'wall',  tint: 0x9a948a },
  fence:         { height: 1.5, thickness: 0.08, kind: 'fence', tint: 0x6f6a60 },
  hedge:         { height: 1.5, thickness: 0.7,  kind: 'hedge', tint: 0x4a6b38 },
  guard_rail:    { height: 0.8, thickness: 0.1,  kind: 'rail',  tint: 0x9aa0a4 },
  handrail:      { height: 1.0, thickness: 0.06, kind: 'rail',  tint: 0x9aa0a4 },
  kerb:          { height: 0.14, thickness: 0.2, kind: 'kerb',  tint: 0x9c9890 },
  bollard:       { height: 0.9, thickness: 0.16, kind: 'post',  tint: 0x55585a },
  gate:          { height: 1.8, thickness: 0.1,  kind: 'fence', tint: 0x6a655c },
  block:         { height: 0.7, thickness: 0.7,  kind: 'post',  tint: 0x8d8a84 },
  chain:         { height: 0.5, thickness: 0.04, kind: 'rail',  tint: 0x6a6a6a },
  wire_fence:    { height: 1.3, thickness: 0.05, kind: 'fence', tint: 0x7a756c },
  hedge_bank:    { height: 1.7, thickness: 1.0,  kind: 'hedge', tint: 0x4a6b38 },
};

export function barrierSpec(tags) {
  const b = tags['barrier'];
  if (!b) return null;
  const cls = BARRIER_CLASSES[b];
  if (!cls) return null;
  const height = parseLength(tags['height']) || cls.height;
  return {
    barrier: b,
    kind: cls.kind,
    height: clamp(height, 0.1, 12),
    thickness: cls.thickness,
    tint: parseColour(tags['colour'] || tags['color']) ?? cls.tint,
    material: lookupMaterial(tags['material']),
  };
}

// --- land cover ------------------------------------------------------------

/**
 * Ground appearance for `landuse`, `natural` and `leisure` polygons.
 * `veg` is a vegetation-density multiplier the planting pass uses on top of
 * the NASA NDVI reading; `z` orders overlapping covers (higher draws on top).
 */
export const LANDCOVER = {
  'natural=wood':          { tint: 0x3f5a2e, veg: 1.0,  z: 2, sound: 'dirt', cover: 'forest' },
  'landuse=forest':        { tint: 0x3f5a2e, veg: 1.0,  z: 2, sound: 'dirt', cover: 'forest' },
  'natural=scrub':         { tint: 0x6a7345, veg: 0.55, z: 2, sound: 'dirt', cover: 'scrub' },
  'natural=heath':         { tint: 0x77704a, veg: 0.3,  z: 2, sound: 'dirt', cover: 'scrub' },
  'natural=grassland':     { tint: 0x6d8447, veg: 0.25, z: 2, sound: 'grass', cover: 'grass' },
  'landuse=grass':         { tint: 0x5f8040, veg: 0.2,  z: 3, sound: 'grass', cover: 'grass' },
  'landuse=meadow':        { tint: 0x6c8a45, veg: 0.28, z: 2, sound: 'grass', cover: 'grass' },
  'landuse=orchard':       { tint: 0x5c7a3d, veg: 0.8,  z: 2, sound: 'grass', cover: 'orchard' },
  'landuse=vineyard':      { tint: 0x6b7c43, veg: 0.5,  z: 2, sound: 'dirt', cover: 'vineyard' },
  'landuse=farmland':      { tint: 0x9a8b52, veg: 0.12, z: 1, sound: 'dirt', cover: 'crop' },
  'landuse=farmyard':      { tint: 0xa2917a, veg: 0.05, z: 2, sound: 'dirt', cover: 'bare' },
  'landuse=allotments':    { tint: 0x6f7f4a, veg: 0.35, z: 2, sound: 'dirt', cover: 'grass' },
  'landuse=cemetery':      { tint: 0x5e7a48, veg: 0.3,  z: 3, sound: 'grass', cover: 'grass' },
  'landuse=recreation_ground': { tint: 0x5f8040, veg: 0.2, z: 3, sound: 'grass', cover: 'grass' },
  'landuse=village_green': { tint: 0x5f8040, veg: 0.25, z: 3, sound: 'grass', cover: 'grass' },
  // These are zoning boundaries, not surveyed surfaces. Keep them in the
  // feature set for morphology and vegetation, but do not paint an entire
  // neighbourhood with one grey/gravel material.
  'landuse=residential':   { tint: 0x8c8577, veg: 0.14, z: 0, sound: 'concrete', cover: 'urban', physical: false },
  'landuse=commercial':    { tint: 0x8a8579, veg: 0.06, z: 0, sound: 'concrete', cover: 'urban', physical: false },
  'landuse=retail':        { tint: 0x8d857a, veg: 0.05, z: 0, sound: 'concrete', cover: 'urban', physical: false },
  'landuse=industrial':    { tint: 0x87837c, veg: 0.03, z: 0, sound: 'concrete', cover: 'urban', physical: false },
  'landuse=railway':       { tint: 0x7c7873, veg: 0.05, z: 1, sound: 'gravel', cover: 'bare' },
  'landuse=construction':  { tint: 0x94897a, veg: 0.04, z: 1, sound: 'dirt', cover: 'bare' },
  'landuse=brownfield':    { tint: 0x8a8064, veg: 0.25, z: 1, sound: 'dirt', cover: 'scrub' },
  'landuse=greenfield':    { tint: 0x778a4f, veg: 0.2,  z: 1, sound: 'grass', cover: 'grass' },
  'landuse=quarry':        { tint: 0xa39a8a, veg: 0.02, z: 1, sound: 'gravel', cover: 'rock' },
  'landuse=basin':         { tint: 0x51707f, veg: 0.05, z: 3, sound: 'water', cover: 'water' },
  'landuse=reservoir':     { tint: 0x3f6076, veg: 0,    z: 4, sound: 'water', cover: 'water' },
  'landuse=military':      { tint: 0x8a8770, veg: 0.15, z: 1, sound: 'dirt', cover: 'bare' },
  'natural=water':         { tint: 0x3f6076, veg: 0,    z: 4, sound: 'water', cover: 'water' },
  'natural=wetland':       { tint: 0x5c7355, veg: 0.4,  z: 3, sound: 'water', cover: 'wetland' },
  'natural=beach':         { tint: 0xc9b489, veg: 0.02, z: 3, sound: 'sand', cover: 'sand' },
  'natural=sand':          { tint: 0xc9b489, veg: 0.01, z: 2, sound: 'sand', cover: 'sand' },
  'natural=shingle':       { tint: 0xa9a494, veg: 0.02, z: 3, sound: 'gravel', cover: 'gravel' },
  'natural=scree':         { tint: 0x9b968c, veg: 0.02, z: 2, sound: 'gravel', cover: 'rock' },
  'natural=bare_rock':     { tint: 0x8f8b84, veg: 0.01, z: 2, sound: 'stone', cover: 'rock' },
  'natural=rock':          { tint: 0x8f8b84, veg: 0.01, z: 3, sound: 'stone', cover: 'rock' },
  'natural=glacier':       { tint: 0xdce9ef, veg: 0,    z: 3, sound: 'snow', cover: 'ice' },
  'natural=mud':           { tint: 0x6f6350, veg: 0.05, z: 3, sound: 'dirt', cover: 'bare' },
  'leisure=park':          { tint: 0x54793d, veg: 0.45, z: 3, sound: 'grass', cover: 'park' },
  'leisure=garden':        { tint: 0x5a7d3f, veg: 0.5,  z: 4, sound: 'grass', cover: 'park' },
  'leisure=nature_reserve':{ tint: 0x4c6b34, veg: 0.7,  z: 1, sound: 'dirt', cover: 'forest' },
  'leisure=pitch':         { tint: 0x4f7d3f, veg: 0.05, z: 5, sound: 'grass', cover: 'pitch' },
  'leisure=golf_course':   { tint: 0x5b8241, veg: 0.25, z: 3, sound: 'grass', cover: 'grass' },
  'leisure=playground':    { tint: 0x94805e, veg: 0.08, z: 5, sound: 'sand', cover: 'bare' },
  'leisure=track':         { tint: 0x8f5f47, veg: 0.02, z: 5, sound: 'gravel', cover: 'track' },
  'leisure=common':        { tint: 0x5f8040, veg: 0.3,  z: 3, sound: 'grass', cover: 'grass' },
  'leisure=dog_park':      { tint: 0x5f8040, veg: 0.2,  z: 4, sound: 'grass', cover: 'grass' },
  'leisure=marina':        { tint: 0x476a7e, veg: 0,    z: 4, sound: 'water', cover: 'water' },
  'amenity=parking':       { tint: 0x55575c, veg: 0.02, z: 5, sound: 'concrete', cover: 'paved', defaultSurface: 'asphalt' },
  'amenity=school':        { tint: 0x8b8674, veg: 0.12, z: 1, sound: 'concrete', cover: 'urban', physical: false },
  'amenity=university':    { tint: 0x8b8674, veg: 0.18, z: 1, sound: 'concrete', cover: 'urban', physical: false },
  'amenity=hospital':      { tint: 0x8d8a80, veg: 0.1,  z: 1, sound: 'concrete', cover: 'urban', physical: false },
  'amenity=grave_yard':    { tint: 0x5e7a48, veg: 0.3,  z: 3, sound: 'grass', cover: 'grass' },
  'amenity=marketplace':   { tint: 0x8d867a, veg: 0.02, z: 5, sound: 'stone', cover: 'paved' },
  'aeroway=apron':         { tint: 0x76736e, veg: 0,    z: 5, sound: 'concrete', cover: 'paved' },
  'aeroway=runway':        { tint: 0x55534f, veg: 0,    z: 6, sound: 'concrete', cover: 'paved' },
  'aeroway=taxiway':       { tint: 0x5d5b57, veg: 0,    z: 6, sound: 'concrete', cover: 'paved' },
};

/** Find the land-cover record for a feature, or null if it does not cover ground. */
export function landcoverSpec(tags) {
  for (const key of ['natural', 'landuse', 'leisure', 'amenity', 'aeroway']) {
    const v = tags[key];
    if (!v) continue;
    const rec = LANDCOVER[`${key}=${v}`];
    if (rec) {
      const fallback = rec.defaultSurface || (rec.sound === 'grass' ? 'grass' : 'ground');
      return { ...rec, key: `${key}=${v}`, surface: lookupSurface(tags['surface'], fallback) };
    }
  }
  return null;
}

/** Is this feature a body of water the player can wade into? */
export function isWater(tags) {
  if (tags['natural'] === 'water' || tags['natural'] === 'bay' || tags['natural'] === 'strait') return true;
  if (tags['landuse'] === 'reservoir' || tags['landuse'] === 'basin') return true;
  if (tags['waterway'] === 'riverbank' || tags['waterway'] === 'dock') return true;
  if (tags['water']) return true;
  return false;
}

/** Width of a linear waterway in metres. */
export function waterwayWidth(tags) {
  const w = parseLength(tags['width']);
  if (w != null) return clamp(w, 0.4, 400);
  switch (tags['waterway']) {
    case 'river': return 24;
    case 'canal': return 12;
    case 'stream': return 3;
    case 'ditch': return 1.2;
    case 'drain': return 1.4;
    default: return 3;
  }
}

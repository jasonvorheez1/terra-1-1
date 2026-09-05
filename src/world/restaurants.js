// Pure restaurant presentation rules. Kept free of Three.js/DOM imports so
// identity and palette decisions can be unit-tested in Node.

/** Compact, deterministic text suitable for the shared ASCII sign atlas. */
export function restaurantSignLabel(restaurant, maxChars = 24) {
  const fallback = restaurant && restaurant.cuisines && restaurant.cuisines[0]
    ? restaurant.cuisines[0].replace(/_/g, ' ')
    : restaurant && restaurant.category ? restaurant.category.replace(/_/g, ' ') : 'restaurant';
  const candidate = String((restaurant &&
    (restaurant.signName || restaurant.name || restaurant.brand)) || fallback)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const unsupported = (candidate.match(/[^ A-Z0-9&'\-.,/+:!?]/g) || []).length;
  // If no mapper supplied a Latin rendering, a cuisine/category sign is more
  // useful than "????". The original Unicode name remains on the interaction
  // prompt and in media attribution.
  const source = candidate && unsupported / candidate.length <= 0.35
    ? candidate : fallback.toUpperCase();
  let text = source.replace(/[^ A-Z0-9&'\-.,/+:!?]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!text) text = 'RESTAURANT';
  if (text.length > maxChars) text = `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}.`;
  return text;
}

/** Cuisine-informed palette; OSM's explicit brand colour wins when present. */
export function restaurantPalette(restaurant, rng = Math.random) {
  if (restaurant && restaurant.colour != null) {
    return { panel: restaurant.colour, accent: 0xf1e6cf };
  }
  const cuisine = new Set((restaurant && restaurant.cuisines) || []);
  if (cuisine.has('mexican') || cuisine.has('taco')) return { panel: 0x9f3328, accent: 0xe4a634 };
  if (cuisine.has('chinese')) return { panel: 0x9d201e, accent: 0xd9ad3f };
  if (cuisine.has('japanese') || cuisine.has('sushi')) return { panel: 0x25282b, accent: 0xb42c2e };
  if (cuisine.has('indian')) return { panel: 0x9a431f, accent: 0xe0a12f };
  if (cuisine.has('italian') || cuisine.has('pizza')) return { panel: 0x315f3d, accent: 0xb22d2c };
  if (cuisine.has('thai') || cuisine.has('vietnamese')) return { panel: 0x356151, accent: 0xd9a83b };
  if (cuisine.has('coffee_shop') || cuisine.has('coffee') ||
      (restaurant && restaurant.category === 'cafe')) {
    return { panel: 0x4b3529, accent: 0xc99c62 };
  }
  if (restaurant && restaurant.category === 'ice_cream') return { panel: 0x477e8a, accent: 0xe7a0aa };
  const choices = [
    { panel: 0x263f59, accent: 0xd8a43a },
    { panel: 0x75332f, accent: 0xe0c07a },
    { panel: 0x315746, accent: 0xd7b65e },
    { panel: 0x4b405f, accent: 0xd39c63 },
  ];
  return choices[Math.floor(rng() * choices.length) % choices.length];
}

/**
 * World-space direction which reads left-to-right to somebody standing in
 * front of a facade and looking back along the outward normal.
 */
export function restaurantFacadeRight(nx, nz) {
  return [nz, -nx];
}

function identityHash(value) {
  const text = String(value || 'restaurant');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic storefront vocabulary selected from real business tags.
 * The family controls recognisable architecture; the identity-derived variant
 * stops unrelated restaurants of the same cuisine becoming clones.
 */
export function restaurantStorefrontStyle(restaurant) {
  const cuisines = new Set((restaurant?.cuisines || []).map((v) => String(v).toLowerCase()));
  const category = String(restaurant?.category || '').toLowerCase();
  const has = (...values) => values.some((v) => cuisines.has(v));
  let family = 'independent';

  if (category === 'pub' || category === 'bar') family = 'pub';
  else if (category === 'ice_cream') family = 'ice-cream';
  else if (category === 'cafe' || has('coffee_shop', 'coffee', 'tea')) family = 'cafe';
  else if (has('japanese', 'sushi', 'ramen', 'udon', 'yakitori')) family = 'japanese';
  else if (has('american', 'diner', 'burger', 'hot_dog', 'steak_house')) family = 'diner';
  else if (has('mexican', 'taco', 'tex-mex')) family = 'mexican';
  else if (has('indian', 'nepalese', 'pakistani', 'bangladeshi')) family = 'south-asian';
  else if (has('italian', 'pizza', 'pasta')) family = 'italian';
  else if (has('thai', 'vietnamese', 'korean', 'chinese')) family = 'east-asian';
  else if (category === 'fast_food') family = 'fast-food';

  const identity = restaurant?.brand || restaurant?.name || restaurant?.id ||
                   `${category}:${Array.from(cuisines).join(',')}`;
  const hash = identityHash(identity);
  return {
    family,
    variant: hash % 5,
    stripes: 3 + ((hash >>> 4) % 4),
    lamps: (hash >>> 7) % 3,
    projectingSign: family === 'pub' || family === 'cafe' || (hash & 3) === 0,
    stripedAwning: ['cafe', 'italian', 'ice-cream'].includes(family) || (hash & 7) === 1,
    curtain: family === 'japanese' || (family === 'east-asian' && (hash & 1) === 0),
    chrome: family === 'diner',
    tiled: family === 'mexican' || family === 'south-asian',
  };
}

// Pure restaurant presentation rules. Kept free of Three.js/DOM imports so
// identity and palette decisions can be unit-tested in Node.

/** Compact, deterministic text suitable for the shared ASCII sign atlas. */
export function restaurantSignLabel(restaurant, maxChars = 24) {
  const fallback = restaurant && restaurant.cuisines && restaurant.cuisines[0]
    ? restaurant.cuisines[0].replace(/_/g, ' ')
    : restaurant && restaurant.category ? restaurant.category.replace(/_/g, ' ') : 'restaurant';
  let text = String((restaurant && (restaurant.name || restaurant.brand)) || fallback)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^ A-Z0-9&'\-.,/+:!?]/g, '?')
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

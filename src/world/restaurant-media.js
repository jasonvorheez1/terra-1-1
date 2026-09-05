// Licensed real-world media for restaurant storefronts.
//
// The renderer never searches the open web by business name: that is both
// ambiguous (there are many "Corner Cafe"s) and impossible to attribute
// reliably. Instead it follows identifiers a mapper attached to the exact OSM
// feature: wikimedia_commons, wikidata or brand:wikidata. Wikimedia's API gives
// us a thumbnail and machine-readable author/licence fields without an API key.

import { fetchCached, decodeImage } from '../geo/net.js';
import { clamp } from '../core/util.js';

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_ENTITY = 'https://www.wikidata.org/wiki/Special:EntityData/';
const MEDIA_MAX_AGE = 1000 * 60 * 60 * 24 * 30;

function textValue(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

/** Strip Commons' small HTML credit fragments before putting them in our UI. */
export function plainCredit(value) {
  return String(textValue(value) || '')
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** A safe Commons File: title, or null for categories/arbitrary web images. */
export function commonsFileTitle(reference) {
  let value = String(reference || '').trim();
  if (!value) return null;
  if (/^category:/i.test(value)) return null;

  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      if (!/(^|\.)wikimedia\.org$/i.test(url.hostname)) return null;
      const marker = '/wiki/File:';
      const at = url.pathname.indexOf(marker);
      if (at < 0) return null;
      value = `File:${decodeURIComponent(url.pathname.slice(at + marker.length))}`;
    } catch (e) { return null; }
  }

  if (/^file:/i.test(value)) value = value.replace(/^file:\s*/i, '');
  // OSM occasionally stores the bare filename. Requiring an image extension
  // avoids interpreting a Commons gallery or a business name as a file.
  if (!/\.(?:avif|gif|jpe?g|png|svg|tiff?|webp)$/i.test(value)) return null;
  value = value.replace(/_/g, ' ').trim();
  if (!value || value.length > 300 || /[\n\r|{}<>]/.test(value)) return null;
  return `File:${value}`;
}

export function wikidataEntityId(value) {
  const match = String(value || '').toUpperCase().match(/(?:^|[^A-Z0-9])(Q\d+)(?:$|[^A-Z0-9])/);
  return match ? match[1] : null;
}

function claimFile(entity, property) {
  const claims = entity && entity.claims && entity.claims[property];
  if (!Array.isArray(claims)) return null;
  const ordered = claims.filter((c) => c.rank !== 'deprecated');
  ordered.sort((a, b) => (a.rank === 'preferred' ? -1 : 0) - (b.rank === 'preferred' ? -1 : 0));
  for (const claim of ordered) {
    const value = claim?.mainsnak?.datavalue?.value;
    const title = commonsFileTitle(value);
    if (title) return title;
  }
  return null;
}

/** Pick a logo (P154) or subject photo (P18) from Wikidata entity JSON. */
export function wikidataMedia(json, entityId, preferLogo = false) {
  const id = wikidataEntityId(entityId);
  if (!id || !json || !json.entities) return null;
  const entity = json.entities[id] || Object.values(json.entities)[0];
  if (!entity || entity.missing !== undefined) return null;
  const order = preferLogo ? [['P154', 'logo'], ['P18', 'photo']]
                           : [['P18', 'photo'], ['P154', 'logo']];
  for (const [property, kind] of order) {
    const title = claimFile(entity, property);
    if (title) return { title, kind, wikidata: id };
  }
  return null;
}

/** Only free licences which allow transformation are accepted. */
export function mediaLicenceAllowed(licence) {
  const value = String(licence || '').trim().toLowerCase();
  if (!value || /noncommercial|no.?derivatives|all rights|(?:^|[- ])(?:nc|nd)(?:[- ]|$)/.test(value)) {
    return false;
  }
  return value.includes('public domain') || value.includes('cc0') ||
         /(?:creative commons|cc)[ -]?by(?:[ -]?sa)?(?:\s|$|-)/.test(value);
}

/** Convert a Commons imageinfo response into a safe rendering descriptor. */
export function commonsMedia(json, fallbackTitle = null) {
  const pages = json?.query?.pages;
  if (!pages || typeof pages !== 'object') return null;
  const page = Object.values(pages).find((p) => p && !p.missing && p.imageinfo?.length);
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata || {};
  const licence = plainCredit(meta.LicenseShortName || meta.UsageTerms);
  if (!mediaLicenceAllowed(licence)) return null;
  const thumbUrl = info.thumburl || info.url;
  if (!/^https:\/\//i.test(thumbUrl || '')) return null;
  const sourceUrl = info.descriptionurl ||
    `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title || fallbackTitle || '')}`;
  return {
    title: page.title || fallbackTitle,
    thumbUrl,
    sourceUrl,
    width: Number(info.thumbwidth || info.width) || 1,
    height: Number(info.thumbheight || info.height) || 1,
    mime: info.thumbmime || info.mime || 'image/jpeg',
    artist: plainCredit(meta.Artist || meta.Credit) || 'Unknown creator',
    attribution: plainCredit(meta.Attribution),
    licence,
    licenceUrl: plainCredit(meta.LicenseUrl),
  };
}

export function commonsApiUrl(title, width = 768) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', redirects: '1',
    prop: 'imageinfo', iiprop: 'url|mime|extmetadata',
    iiurlwidth: String(width), titles: title,
  });
  return `${COMMONS_API}?${params}`;
}

async function mediaFromWikidata(entityId, preferLogo) {
  const id = wikidataEntityId(entityId);
  if (!id) return null;
  const json = await fetchCached(`${WIKIDATA_ENTITY}${id}.json`, {
    as: 'json', maxAgeMs: MEDIA_MAX_AGE, retries: 1, timeoutMs: 10000,
  });
  return wikidataMedia(json, id, preferLogo);
}

/**
 * Resolve the metadata for explicit, identity-safe media attached to this
 * restaurant. Kept separate from image decoding so the live data contract can
 * be audited in Node as well as in the browser.
 */
export async function resolveRestaurantMediaDescriptor(restaurant) {
  if (!restaurant) return null;
  let selected = null;
  const explicit = commonsFileTitle(restaurant.commons || restaurant.image);
  if (explicit) {
    selected = {
      title: explicit,
      kind: /(?:logo|wordmark|sign|emblem)/i.test(explicit) ? 'logo' : 'photo',
      provenance: 'osm',
    };
  }

  if (!selected) {
    const lookups = [
      [restaurant.brandWikidata, true],
      [restaurant.subjectWikidata ||
        (!restaurant.brandWikidata ? restaurant.wikidata : null), false],
    ];
    for (const [id, preferLogo] of lookups) {
      if (!id) continue;
      try {
        selected = await mediaFromWikidata(id, preferLogo);
        if (selected) break;
      } catch (e) { /* a missing enrichment must never block world geometry */ }
    }
  }
  if (!selected) return null;

  let descriptor;
  try {
    const json = await fetchCached(commonsApiUrl(selected.title), {
      as: 'json', maxAgeMs: MEDIA_MAX_AGE, retries: 1, timeoutMs: 12000,
    });
    descriptor = commonsMedia(json, selected.title);
  } catch (e) { return null; }
  if (!descriptor) return null;
  return { ...descriptor, ...selected };
}

/** Resolve and decode only explicit, identity-safe restaurant media. */
export async function resolveRestaurantMedia(restaurant) {
  const descriptor = await resolveRestaurantMediaDescriptor(restaurant);
  if (!descriptor) return null;

  try {
    const bytes = await fetchCached(descriptor.thumbUrl, {
      as: 'arrayBuffer', maxAgeMs: MEDIA_MAX_AGE, retries: 1, timeoutMs: 15000,
    });
    const image = await decodeImage(bytes, descriptor.mime);
    return { ...descriptor, image };
  } catch (e) { return null; }
}

/** Aspect-preserving placement for a fascia logo or mapped facade photo. */
export function restaurantMediaPlacement(media, target) {
  if (!media || !target) return null;
  const aspect = clamp((media.width || media.image?.width || 1) /
                       (media.height || media.image?.height || 1), 0.35, 5);
  let maxWidth = target.signWidth * 0.86;
  let maxHeight = target.signHeight * 0.76;
  let alongOffset = 0;
  let centreY = target.signY;

  // A mapped photo is shown as a framed storefront/window panel beside the
  // entrance. Logos belong on the fascia. Keeping each at its natural aspect
  // avoids the stretched-photo look that is worse than a procedural facade.
  if (media.kind === 'photo' && target.available >= 4.2) {
    maxWidth = Math.min(2.7, Math.max(0.9, (target.available - 1.7) / 2));
    maxHeight = 1.75;
    alongOffset = Math.min(target.available / 2 - maxWidth / 2 - 0.12,
                           1.05 + maxWidth / 2);
    centreY = target.baseY + 1.45;
  }
  let width = Math.min(maxWidth, maxHeight * aspect);
  let height = width / aspect;
  if (height > maxHeight) { height = maxHeight; width = height * aspect; }
  if (width < 0.18 || height < 0.18) return null;
  return { width, height, alongOffset, centreY };
}

# Third-party data notices

Terra Ambulate reads third-party map and media data at runtime. This file
records the notices for the restaurant coverage added on 2026-09-04; the
in-game About screen also shows them.

## Overture Maps

Building, transportation, and Places gap fills use the Overture Maps Foundation
release identified in `src/geo/overture.js`. Overture publishes current source
and licence details at <https://docs.overturemaps.org/attribution/>.

The Places theme contains records under CDLA Permissive 2.0, CC0 1.0, and
Apache License 2.0 depending on their source. A copy of Apache License 2.0 is at
<https://www.apache.org/licenses/LICENSE-2.0>. Foursquare-derived records carry
this notice:

> Copyright 2024 Foursquare Labs, Inc. All rights reserved.

Foursquare data was transformed to the Overture schema by Overture. Terra
Ambulate further filters the data to open, sufficiently confident restaurant
categories; removes nearby OSM duplicates; reprojects point coordinates; and
associates them with building footprints. These changes were made 2026-09-04.

## Wikimedia Commons

Restaurant images are fetched only when an exact OSM or Wikidata identity
points to a Wikimedia Commons file carrying an accepted free licence. Each
file remains subject to the author, attribution, and licence shown on its
Commons description page. Terra Ambulate displays those details in About and
resizes the image without changing its aspect ratio.

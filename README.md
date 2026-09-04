# Terra Ambulate

A walking simulator of the real Earth. Pick any point on the planet, and the
game reconstructs it from open data and lets you walk around at 1.4 metres per
second — the pace of an actual person on an actual street.

No build step, no package install, no API keys. Open it and walk.

```bash
node tools/serve.mjs
# then open http://127.0.0.1:8123
```

---

## What is real, and what is invented

The distinction matters, so it is drawn sharply.

### Measured

| Thing | Source |
|---|---|
| Buildings, streets, tunnels, bridges, walls, steps, trees, benches, lamp posts | [OpenStreetMap](https://www.openstreetmap.org/copyright) via the Overpass API |
| Building heights, storey counts, roof shapes, materials, colours | OSM tags, following the [Simple 3D Buildings](https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings) scheme |
| Terrain elevation | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen terrarium encoding, from SRTM and national DEMs) |
| Vegetation density, greenness, biome | NASA [GIBS](https://nasa-gibs.github.io/gibs-api-docs/) MODIS Terra 16-day NDVI |
| Aerial imagery on the terrain *and on flat roofs* | Esri World Imagery |
| Place search | OpenStreetMap Nominatim |
| Sun and moon position | Computed with the NOAA solar position algorithm from the real date, time and coordinates |

The sun is genuinely where it is. Midsummer in Svalbard never gets dark;
the noon sun in Sydney is in the north; shadows in Nairobi at the equinox fall
almost straight down. Sunrise and sunset land within about ten minutes of the
published times for London.

### Invented

- **Interiors.** OSM knows a building's outline and what it is for, not where
  the kitchen is. Floor plans are generated — corridors, rooms, doorways,
  stairs, furniture — seeded from the building's OSM id, so the same building
  always has the same interior. Walk out and back in and nothing has moved.
  They are discrete cells: press `E` at a door to load one. See below.
- **Everything you can see.** Facade textures, roof tiles, foliage, tarmac,
  street furniture and the entire soundscape are generated at load time. The
  game ships no image or audio files at all.
- **Where mappers left gaps.** An untagged building gets a height inferred from
  its type and footprint, a plausible palette for its class, and a front door on
  the facade nearest the road.

---

## Controls

| | |
|---|---|
| `W A S D` / arrows | Walk |
| Mouse | Look |
| `Shift` | Run |
| `Ctrl` / `C` | Crouch |
| `Space` | Jump |
| `E` | Interact |
| `M` | Map |
| `P` | Photo mode (free flight) |
| `H` | Hide the interface |
| `` ` `` | Debug overlay |
| `Esc` | Pause |

Everything is rebindable, and a gamepad works if one is plugged in.

Click the view to capture the mouse. If the browser refuses pointer lock — an
embedded frame, a policy, a dismissed prompt — hold the left button and drag to
look instead, so you are never stuck unable to turn around.

Buildings are solid from the street. Walk up to a front door, and if it leads
anywhere the prompt offers it: press `E` and you load into that building's
interior.

---

## How it works

### Streaming

Chunks render and unrender continuously around you as you walk; nothing is
downloaded up front beyond the region you are standing in. Two different sizes,
deliberately:

- **Regions** (~1.2 km) are the unit of *download*, sized so one Overpass query
  is worth making. Public Overpass instances serve one query at a time, so the
  region under your feet is always requested first and the ring around it
  follows in the background.
- **Chunks** (256 m) are the unit of *geometry*, sized for culling and smooth
  streaming. A chunk builds from whatever regions have arrived and rebuilds
  itself once the stragglers land, so a dense city fills in around you rather
  than making you wait a minute for four simultaneous multi-megabyte downloads.

Both are loaded **in the direction you are facing or moving**. With one Overpass
query in flight at a time, that ordering is most of what makes travel feel
continuous rather than stop-start: the street you are walking down arrives
before the one behind you. Change direction and the queue re-prioritises
immediately rather than draining the old order first.

Chunks outside the render distance are disposed — geometry, collision BVH and
all — with hysteresis so pacing back and forth across a boundary does not thrash.

Every remote byte is cached in IndexedDB. Walking back somewhere you have been
costs nothing.

### Terrain that agrees with the roads

SRTM elevation and hand-drawn OSM centrelines disagree constantly: a street
crossing a hillside cuts into the slope on one side and floats over it on the
other, because the elevation data has no idea the street is there. So roads are
graded into the landscape — the ground is pulled to the carriageway inside the
road and blended back out over a verge.

The same machinery produces tunnel portals for free. A tunnel approach is graded
down to follow the roadway, which opens a cutting; once the roadway is deeper
than the tunnel is tall, grading stops and the ground closes over the top. The
portal is simply where those two regimes meet.

### Tunnels and bridges

OSM's `layer` tag is an ordering hint, not an elevation, so vertical profiles
have to be invented — and the honest way to do it depends on the terrain:

- A road tunnel through a hill is **not** "the road, six metres down". The road
  runs roughly level between its portals and the *ground* climbs over it.
  Interpolating portal to portal reproduces that exactly.
- An urban underpass has no hill to go under, so the same interpolation leaves
  it flat at street level. When there is not enough ground above the line, a
  smooth dip is dug instead.
- Bridges are the same problem mirrored: over a river the portal-to-portal line
  is already high; over a flat junction it needs a hump.

The profile is a ramp, a plateau, and a ramp — not a bell curve. That matters:
a bell only reaches full clearance at one point, so a bell-shaped flyover clips
the road it is meant to cross everywhere except dead centre. Whether a deck's
ends ramp back to street level is decided by looking at what its end nodes
connect to: a deck meeting another deck stays up, one meeting the street comes
down.

**The clearance is then enforced point by point.** Deciding "is this already
buried?" from the deepest cover anywhere along the way is right for a short bore
through one hill and badly wrong for a Metro line seven hundred points long: it
passes under a single rise, is declared bored, and then surfaces in the middle
of the road every time the ground drops away. A tunnel has to be under the
ground *everywhere*. Scaling that constraint by the ramp shape is what keeps
portals working - at the ends of a bored tunnel the requirement relaxes to zero
and the roadway is allowed to meet daylight exactly where it should.

### Heights come from the neighbours

Roughly 40% of buildings in a well-mapped city carry no height or storey count.
Falling back to the `building=*` default is worse than it sounds: `building=yes`
means two storeys everywhere on Earth, which drops a six-metre box into the
middle of a Haussmann terrace. Being wrong by four storeys in the middle of a
street is far more visible than being wrong about a whole district.

Buildings are overwhelmingly like their neighbours, so an untagged building
takes the median storey count of the tagged buildings within 90 m. In Le Marais
that reassigns 44% of buildings and pulls the 10th-to-90th percentile height
spread from 1.8-24 m down to 12-21 m, around a true Parisian median of 18 m.
Where there are no tagged neighbours - open countryside, a thinly mapped area -
the class default stands.

### Pavements

In most European cities the pavement is not a property of the road: it is its
own way, tagged `footway=sidewalk`, and the road is tagged `sidewalk=separate`.
Le Marais has 614 of them within render distance and only 50 roads that want a
generated pavement.

So there are two paths. A road that carries its pavements as tags gets them
generated alongside the carriageway; a separately-mapped pavement way is built
as what it is - a surface raised on a 14 cm kerb, with the kerb face drawn and
collided. Treating those ways as ordinary footpaths, which is the obvious thing
to do, renders them as paint on the road and makes a properly mapped city look
like it has no pavements at all.

Crossings (`footway=crossing`) stay flush, because that is the point of a
crossing.

### Buildings look like what they are

OSM says what each building is for, and an extruded footprint with windows on it
reads as "a building" but not as a *school* or a *church*. What actually
distinguishes those at a glance is mostly small and additive, so each building
gets the trim its `building=*` value calls for:

| | |
|---|---|
| House | Pitched roof, chimney, porch over the door |
| Apartments | Cornice, balconies on the upper floors, entrance porch |
| Shop | Fascia signboard, projecting awning, roof clutter |
| Office | Cornice, entrance canopy, rooftop plant |
| School / hospital | Wide covered entrance, rooftop plant |
| Church | Belfry tower and a slate spire with a finial |
| Civic | A four-column portico with a pediment, if it is big enough |
| Industrial / barn | Roller shutter door, deep eaves |
| Castle | Crenellations |

All of it goes into the same shared vertex-coloured material as everything else,
so a street of detailed buildings is still the same handful of draw calls as a
street of plain boxes.

The cost has to be watched, though. Detail is emitted per ring edge, and a
hand-traced footprint carries forty edges for what is visually a rectangle, so
the trim runs along a simplified outline. Balconies get a hard per-building
allowance: uncapped, they cost more than every other piece of geometry in the
city combined. As built, detail is around 470 triangles per building.

### Roofs are photographs

Satellite imagery is a view from directly overhead, which is exactly what a flat
roof looks like — so rather than inventing a roof texture, flat roofs are mapped
into the same Esri photograph that is draped over the chunk's terrain. The UVs
come from world position, so the picture lands on the building it is a picture
of, aligned, for no extra download.

Pitched roofs keep their generated tiles and slates: an orthophoto stretched
down a slope would not read correctly.

This is the honest limit of what aerial imagery can do here. It cannot texture
*facades* — those are not visible from above at all. Facades stay procedural,
generated per building from its class, storey count and tagged material.

### Interiors are cells

In the manner of Fallout or Morrowind: one interior exists at a time, and while
you are inside it the entire outdoor world is hidden and its collision layer
switched off. Colliders live in named layers and only one layer is ever tested,
so stepping through a door takes the character controller from a few hundred
thousand triangles across dozens of BVHs down to a few thousand in one.

Measured in Le Marais with the surrounding blocks loaded:

| | Outdoors | Inside a seven-storey building |
|---|---|---|
| Render triangles | ~431,000 | ~5,600 |
| Collision triangles | ~232,000 | ~2,700 |
| Time to generate | streamed | 8 ms |

World streaming stops entirely while you are indoors, because there is nothing
to stream for. The trade is that the cell has to enclose itself — it builds its
own outer wall with glazed windows and its own front door back out — and that
a door is an explicit action rather than something you can just walk through.

That budget is what lets an interior be worth entering: seven floors of rooms,
corridors, stairs and furniture cost less than a single street does, because
only one building's worth ever exists.

### Collision

Triangle-exact, not a proxy. The same walls, kerbs, stairs, bridge parapets and
tunnel linings you can see are the ones you bump into. Each chunk's solid
geometry is merged into one indexed triangle soup with a
[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) bounding volume
hierarchy over it; the character is a capsule swept against those BVHs and
pushed out along the closest-point vector to every triangle it overlaps.

A kerb is 14 cm high and you really do step up it. Three details do most of the
work in making it feel right: substepping so you cannot tunnel through a wall,
an explicit step-up retry so a capsule reliably climbs stairs, and ground
snapping so walking downstairs is not a series of small falls.

### Draw calls

The single biggest cost in a city. Per-feature variation lives in vertex colours
rather than in materials, so every building in a chunk shares one facade
material and one roof material per roofing pattern, and thousands of buildings
collapse into a handful of meshes. Facade UVs are driven by real metres, so a
window is a window whether the building is four metres wide or four hundred.

---

## Layout

```
index.html            shell, import map, all UI markup
styles/ui.css         interface
tools/serve.mjs       dev server (no dependencies, sends no-store)
vendor/               three.js and three-mesh-bvh, vendored so a CDN change
                      can never break the game
data/ndvi-lut.js      NASA's published NDVI colour map, inverted to a LUT

src/
  core/       settings schema and persistence, input, seeded RNG, maths
  geo/        projection, IndexedDB cache, rate-limited fetch queue,
              elevation, NASA NDVI + biomes, Overpass, Nominatim
  world/      OSM tag interpretation, 2D polygon engine, feature extraction
    build/    mesh accumulation, terrain, buildings, roads, props, vegetation
  interior/   floor plan generation, interior geometry, streaming
  physics/    collision BVH, capsule character controller
  gfx/        procedural textures, materials, solar position, sky, weather
  ui/         screens, settings, slippy map
  audio/      synthesised ambience and footsteps
tests/        headless test suites
```

---

## Tests

```bash
npm test              # 116 headless checks, no network
npm run test:live     # end-to-end against live OSM data
```

The unit suites cover the parts where being wrong is invisible until it is
badly wrong: the projection against haversine distance, solar position against
published almanac values, polygon triangulation by area conservation over
hundreds of random polygons, OSM tag parsing, and floor-plan validity (no
overlapping rooms, every room reachable from the front door) across 300
randomly generated footprints.

The live suite fetches real data for Paris and Manhattan and checks that
tunnels stay underground, bridge decks clear what they cross, bridge ends meet
the street, and every building gets a door on its outline.

---

## Being kind to the servers

Overpass, Nominatim and NASA GIBS are free public and community infrastructure.
This game:

- caches everything it downloads, so a second visit costs nothing;
- rate limits itself per host (one Overpass query at a time, with a gap);
- fails over between five Overpass mirrors and benches one that errors;
- splits each region into a *structure* query (what you walk on and bump into)
  and a *detail* query (trees, benches, signs) so you are moving before the
  decoration arrives.

If you plan to run this somewhere busy, please point it at your own Overpass
instance in `src/geo/overpass.js`.

---

## Requirements

A browser with WebGL 2 — any current Chrome, Edge, Firefox or Safari. The world
must be served over HTTP rather than opened from the file system, because it
uses ES modules; `tools/serve.mjs` exists so that needs no dependencies.

## Licence and attribution

The code here is MIT licensed — see [LICENSE](LICENSE). The data is not:

- Map data © OpenStreetMap contributors, available under the
  [Open Database Licence](https://www.openstreetmap.org/copyright). Anything you
  publish that is derived from it must say so.
- Elevation from the AWS Terrain Tiles public dataset, itself assembled from
  SRTM, NED, and other national sources with their own terms.
- NDVI and Blue Marble imagery courtesy of NASA EOSDIS GIBS.
- Aerial imagery © Esri and its imagery partners; check their terms before any
  use beyond looking at it.
- The libraries under `vendor/` are redistributed unmodified and carry their own
  MIT licences — see [vendor/LICENSES.md](vendor/LICENSES.md).

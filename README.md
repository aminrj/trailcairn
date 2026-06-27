# trailcairn

A personal, lifetime hiking diary — a public ledger of hikes, each with a GPX track on a map,
photos placed along that track, derived stats, and a written diary entry.

It's a static site with no backend. The source of truth is plain files: one folder per hike under
`src/content/hikes/`. The full design is in [`SPEC.md`](./SPEC.md).

## Run it

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # static output in dist/ (also builds the search index)
npm run preview    # serve the production build locally
npm run validate   # health-check every hike folder
```

A fresh clone works out of the box: the bundled example hike (`src/content/hikes/_example/`)
renders in dev so you can see the site before adding real data. It's `status: draft`, so it's
excluded from production builds and never deploys.

> Search (Pagefind) is generated at build time. It's live under `npm run preview` and in
> production, but not in `npm run dev`.

## Add a hike

Copy `src/content/hikes/_TEMPLATE/` to a new folder. **The folder name is the URL slug**
(e.g. `2026-06-fulufjallet/` → `/hikes/2026-06-fulufjallet`). Then:

1. Drop in your Garmin export as `track.gpx`.
2. Put photos in a `photos/` subfolder (JPEG and/or HEIC).
3. Fill in the frontmatter in `index.md`.
4. Optionally add `photos/_photos.json` to caption or manually pin photos.

Save, and the dev server hot-reloads the new hike onto the index map and its own page. No other
steps. Run `npm run validate` to confirm it's healthy.

### Frontmatter (`index.md`)

| Field             | Required | Notes                                                            |
| ----------------- | -------- | ---------------------------------------------------------------- |
| `title`           | yes      | Hike title.                                                      |
| `date`            | yes      | `YYYY-MM-DD`, the start date.                                    |
| `location`        | yes      | Human-readable, e.g. `Fulufjället, Sweden`.                      |
| `summary`         | yes      | One or two sentences for cards and lists.                        |
| `track`           | yes      | GPX filename in the folder (usually `track.gpx`).                |
| `cover`           | no       | Photo path; otherwise the first photo is used.                   |
| `tags`            | no       | String array.                                                    |
| `status`          | no       | `draft` \| `published` (default `published`). Drafts never deploy. |
| `distance_km`     | no       | Override the value derived from the GPX.                         |
| `ascent_m`        | no       | Override.                                                        |
| `descent_m`       | no       | Override.                                                        |
| `duration`        | no       | Override, e.g. `6h 20m`.                                         |
| `hidePrecisePins` | no       | `true` omits the start-point pin (privacy).                      |

Stats are **derived from the GPX at build time** (distance by haversine; ascent/descent from
lightly smoothed elevation; duration from first/last timestamps). Any value you set in frontmatter
overrides the derived one — useful when the GPX lacks elevation or the watch paused oddly.

The schema lives in [`src/content.config.ts`](./src/content.config.ts) and is enforced on build.

### Photos and the map

Each photo is placed at the point on the track where it was taken, decided per photo in this order:

1. **EXIF GPS** on the photo → used directly.
2. Else **EXIF timestamp** matched to the nearest GPX trackpoint by time.
3. Else **unplaced** — still shown in the gallery, just no map marker.

Photos get responsive WebP derivatives (thumbnail / medium / full) with lazy-loading and a blur-up
placeholder. GPS EXIF is stripped from the public derivatives; your originals are untouched.

**HEIC and JPEG are both supported.** HEIC is decoded (it can't go straight through Sharp) and
emitted as WebP like everything else. Note that exports from Google Photos often **strip EXIF** —
those photos have no GPS or timestamp and land unplaced until you pin them (below).

### `photos/_photos.json` (manual overrides)

Optional, keyed by photo filename. Anything here wins over EXIF and timestamp inference. This is
how you fix a photo that landed in the wrong place:

```json
{
  "IMG_0421.jpg": { "caption": "Sunrise over the plateau" },
  "IMG_0432.jpg": { "lat": 61.573, "lng": 12.7, "caption": "Camp" },
  "IMG_0440.jpg": { "order": 1 },
  "IMG_0455.jpg": { "place": false }
}
```

- `lat` + `lng` — pin the photo at exact coordinates.
- `caption` — shown in the gallery and marker popup.
- `order` — sort earlier in the gallery (lower first).
- `place: false` — keep it in the gallery but off the map.

### Timezone

EXIF timestamps are often local time without a zone, while GPX is UTC. Modern phone photos usually
include their own offset, which is used automatically. When a photo lacks one, the fallback
`PHOTO_UTC_OFFSET_HOURS` (see [`.env.example`](./.env.example)) is applied. A wrong value shifts
every timestamp-placed photo along the track — `npm run validate` warns when photo and track times
drift far apart.

## Maps

Each map defaults to a keyless outdoor/topographic basemap (OpenTopoMap — hillshading, contours,
trails) and has a small switcher to toggle **Topo / Streets / Satellite** at runtime (all keyless;
the choice is remembered for the session). Basemaps are defined in one list in
[`src/lib/map.ts`](./src/lib/map.ts) — add or remove options there. `MAP_STYLE_URL` overrides the
default topo style.

Per-hike pages also have a **replay player**: press play to send a marker along the track over the
recorded timeline, with the elevation cursor in sync, a scrubber, speed (1×/4×/16×), and a follow
toggle.

## Configuration

Copy `.env.example` to `.env`. Both settings optional:

- `MAP_STYLE_URL` — overrides the default topo basemap (single config point); swap in a self-hosted
  style without touching code.
- `PHOTO_UTC_OFFSET_HOURS` — fallback timezone offset for photo placement (see above).

## Deploy (Cloudflare Pages)

The build output is a plain static `dist/` with no serverless functions.

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Environment variables:** set `MAP_STYLE_URL` (and `PHOTO_UTC_OFFSET_HOURS` if needed).

`npm run build` runs Astro and then Pagefind to generate the search index into `dist/`. Drafts are
excluded from production builds.

## Project layout

```
src/
  content/
    config → content.config.ts   # hikes collection + Zod schema
    hikes/
      _TEMPLATE/                  # copyable starter (not rendered)
      _example/                   # bundled draft hike
  components/                     # Map, Gallery, ElevationProfile, StatsBand, LifetimeBand, Search
  layouts/                        # BaseLayout
  lib/                            # gpx.ts, photos.ts, stats.ts, hikes.ts, map.ts
  pages/                          # index, hikes/[slug], about
scripts/
  validate.mjs                    # npm run validate
public/_gen/                      # generated image derivatives (gitignored, rebuilt on build)
```

Your real hike folders are gitignored by default (only `_example` and `_TEMPLATE` are committed),
so personal photos and GPS tracks stay out of git unless you opt one in.

## Status

Built in vertical slices (see `SPEC.md` §14). All six are in: scaffold + content collection,
GPX-derived stats + per-hike map, the lifetime index map, photo placement + gallery/lightbox,
the stats band + search + validate, and this polish pass. v1 feature-complete; add real hikes and
deploy when it feels good enough.

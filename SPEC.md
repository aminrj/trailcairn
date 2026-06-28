# Hiking Diary — Implementation Spec (v1, local-first)

## 0. Purpose & guiding principles

Build a **personal hiking diary website**: a lifetime, public ledger of hikes, each with a
GPX track on a map, photos placed on that map, stats, and a written diary entry. The owner
records hikes with a Garmin device and shoots photos on a phone/camera.

This spec is for **v1**, which is **local-first**: it must run fully featured on a laptop with
a single command and a hot-reloading dev server, so the owner can drop in real GPX + photos
and immediately see look, feel, rendering, and performance. Deployment to a free static host
(Cloudflare Pages) comes only after the local experience is "good enough."

**Guiding principles — follow these over cleverness:**

1. **Local-first, zero backend.** v1 is a pure static site. No Docker, no database, no running
   services. Everything is plain files + a build step. It must `git clone` and run.
2. **Flat files are the source of truth.** Each hike is a folder of Markdown + GPX + photos.
   The build reads those folders. No CMS, no admin UI.
3. **Fastest possible feedback loop.** Dropping a new hike folder in and seeing it render should
   take seconds, via hot reload. Optimise the authoring loop first.
4. **Don't over-engineer.** No federation, no multi-user, no auth, no route planning, no live
   tracking. If a feature isn't in this spec, don't build it. Leave documented seams (see §10)
   for known future work instead of building it now.
5. **Durability & no lock-in.** Content is portable Markdown/GPX/JPEG. Tools are open and
   community-governed. Nothing ties the data to one vendor.

---

## 1. Stack (fixed — do not substitute)

- **Site generator:** Astro (latest stable). Use Astro Content Collections for hikes.
- **Map rendering:** MapLibre GL JS (MIT). No Mapbox, no API key for rendering.
- **Basemap tiles (dev default):** a free MapLibre-compatible vector style. Use a public demo/
  free-tier style for v1 (e.g. a free outdoor/topo style via an env-keyed tile provider, OR
  the MapLibre demo tiles as a fallback). The tile **style URL must be a single config value**
  (`MAP_STYLE_URL` env var) so it can be swapped for a self-hosted style later without code
  changes.
- **Full-text search:** Pagefind (runs after the Astro build, fully static, no infra).
- **GPX parsing:** a small, well-maintained GPX→GeoJSON library at build time (e.g.
  `@tmcw/togeojson` with `xmldom`, or equivalent). Parse at build time, never ship raw GPX to
  the client for rendering.
- **Image processing:** Sharp for responsive derivatives, driven by a thin build-time helper
  (`lib/photos.ts`) rather than the `<Image>` component. This deviation from a pure `astro:assets`
  flow is deliberate and necessary: (a) source photos include **HEIC**, which Sharp's prebuilt
  binaries can't decode, so HEIC is converted to JPEG first via `heic-convert` (pure JS, no native
  deps) and then resized by Sharp; (b) we need GPS EXIF stripped from derivatives (Sharp drops
  source metadata by default); (c) the per-hike map island needs the derivative URLs as data. Sharp
  is still the engine — we don't hand-roll pixel resizing. All derivative URLs go through one helper
  (the object-storage seam, §10).
- **Photo formats:** ingest both **JPEG** and **HEIC** (the two formats the owner's exports
  produce), plus PNG/WebP. HEIC is decoded as above; everything is emitted as WebP derivatives.
- **EXIF reading:** a maintained EXIF library (`exifr`) at build time to extract photo timestamp
  and GPS. Note: exports from Google Photos frequently **strip EXIF** (commonly the HEIC copies),
  leaving no GPS or timestamp; such photos are simply left unplaced (§6) and can be pinned via
  `_photos.json`.
- **Styling:** plain CSS (or a single lightweight utility layer if preferred). Editorial,
  minimalist. Owner's font preference: a serif display face (Fraunces) for headings + a mono
  (JetBrains Mono) for stats/metadata. Load via self-hosted font files or a font CDN; expose
  the choice in one place.
- **Package manager:** npm.
- **Node:** use the current LTS.

Target deploy: **Cloudflare Pages** (free tier). Build output must be a static `dist/` folder
deployable with zero serverless functions.

---

## 2. Content model — the folder-per-hike convention

All hikes live under `src/content/hikes/`. **One folder per hike.** Folder name is the slug:

```
src/content/hikes/
  2026-06-fulufjallet/
    index.md            # frontmatter + diary entry (Markdown body)
    track.gpx           # the Garmin GPX export
    photos/
      _photos.json      # OPTIONAL manual overrides (see §6)
      IMG_0421.jpg
      IMG_0432.jpg
      ...
```

### 2.1 `index.md` frontmatter schema

Define an Astro Content Collection with a Zod schema enforcing this. Fields:

```yaml
---
title: "Fulufjället wild camp"          # required, string
date: 2026-06-14                          # required, date (start date of hike)
location: "Fulufjället, Sweden"           # required, human-readable
summary: "Two days on the plateau..."     # required, 1-2 sentence teaser for cards/lists
track: "track.gpx"                        # required, filename relative to this folder
cover: "photos/IMG_0432.jpg"              # optional; if absent, auto-pick first photo
tags: ["wild camp", "plateau", "2-day"]   # optional, string array
status: "published"                       # optional enum: draft | published (default published)
# --- all stats below are OPTIONAL; if absent, DERIVE from the GPX at build time ---
distance_km:                              # optional override; else derived
ascent_m:                                 # optional override; else derived
descent_m:                                # optional override; else derived
duration:                                 # optional override (e.g. "6h 20m"); else derived
hidePrecisePins: false                    # optional; if true, fuzz/omit start-point pin (privacy)
---

Markdown diary entry goes here. Free-form. Can reference photos inline.
```

**Derivation rule:** stats are computed from the GPX at build time (distance via haversine over
trackpoints; ascent/descent via summed positive/negative elevation deltas with light smoothing
to avoid GPS noise inflation; duration via first/last trackpoint timestamps). A value explicitly
set in frontmatter **overrides** the derived one. Show derived vs overridden consistently; don't
make the user notice the difference.

`draft` status hikes render in `npm run dev` but are **excluded from production builds**.

---

## 3. Pages & routes

1. **`/` — Index / lifetime map (home).**
   - An **overview-first "where I've been" map**: each hike is a custom cairn **pin** with a
     place/date label, on a **pale** basemap so the pins are the visual subject; tracks render as
     quiet faint lines underneath. Opens at an overview zoom with breathing room (not a tight
     fit-to-bounds).
   - **Clustering:** nearby hikes collapse into a single numbered pin until you zoom in (clicking a
     cluster zooms to expand it). Pin labels use MapLibre collision detection — they show when
     there's room, otherwise just the pin.
   - Clicking a pin → popup card (title, date, distance) → links to the hike page.
   - The overview map is the page's **permanent centerpiece** — always rendered (directly under
     the title/stats), never removed or replaced. Vertical order: title → lifetime stats → search →
     map → logbook. Even with no hikes yet, the (empty) map still shows, with the "copy
     `_TEMPLATE`" hint beside/below it.
   - Below the map: a **logbook list** of all hikes (reverse-chronological); the summary stats band
     is above the map (see §5).
   - A **search box filters in real time** — it sits above the map and filters *which pins appear on
     the map* and which logbook cards show (by title/tags/location/date/summary). Clearing restores
     all pins. A no-match search leaves the map visible (with no/fewer pins) and shows a small "no
     matches" note by the logbook. (Implemented as a client-side filter so it works in dev too;
     Pagefind remains the project's build-time full-text index per §1.)
   - Performance: many tracks must render via a **single GeoJSON source + line layer** (GPU),
     not one DOM marker per point. See §7.

2. **`/hikes/[slug]` — per-hike page.**
   - Hero: cover photo or the map.
   - A MapLibre map showing **this hike's track** with **photo markers placed along it** (§6).
   - An elevation profile (small chart) synced to the track if feasible; keep it simple — a
     static SVG/canvas profile is fine for v1. Hover-to-locate-on-map is a nice-to-have, not
     required for v1.
   - Stats band (distance, ascent, descent, duration, date, location).
   - **Replay player** (added feature): a play/pause control animates a marker travelling the
     track over the GPX timeline (real per-point times where present, even spacing otherwise),
     with the elevation cursor moving in sync, a scrubber, speed control (1×/4×/16×), and an
     optional "follow" toggle that pans the map. As the marker passes a photo's location, that
     photo marker pops/glows briefly. Self-contained island; reuses the precomputed
     coordinates/timeline (no raw GPX shipped); reduced-motion-aware (no autoplay, pass/marker
     motion only on explicit play). See §7.
   - The Markdown diary entry.
   - A photo gallery / lightbox; clicking a photo can pan the map to its marker (nice-to-have).

3. **`/about` — static page.** Short bio + what the site is. Plain Markdown.

4. **(Future seam, do not build) `/tags/[tag]`** — leave the data shape ready but don't build
   tag-filter pages in v1 unless trivial.

**Social preview (Open Graph) cards (added feature):** every page carries OG/Twitter meta
(`og:image`, `twitter:card = summary_large_image`, etc.) pointing at a **per-page card image
generated at build time**, so shared links render a rich preview. Cards are 1200×630 PNGs emitted
by static endpoints (`/og/home.png`, `/og/<slug>.png`) — no runtime/SSR. Each card is hand-built as
SVG (paper background, Fraunces title, JetBrains Mono stats) and rasterised with **resvg**
(`@resvg/resvg-js`) using committed brand-font TTFs (`src/assets/fonts/`). The home card shows the
wordmark, tagline, lifetime stats and a dot-constellation of where I've been; each hike card shows
the title, date/location, key stats, and the **route-line motif** (the GPX trace as a signature,
shared with the index cards and hero — see §7). Per-hike cards follow the draft rule (only
published hikes emit one). Absolute URLs require `site` in `astro.config.mjs`.

---

## 4. The authoring / feedback loop (highest priority to get right)

This is the feature the owner cares most about. Make adding a hike feel instant.

- `npm run dev` starts Astro's dev server with hot reload.
- **Adding a hike = create a folder under `src/content/hikes/` with `index.md`, `track.gpx`,
  and a `photos/` dir.** On save, the dev server re-renders and the new hike appears on the
  index map and gets its own page. No other steps.
- GPX parsing, stat derivation, and EXIF/photo placement all happen at build time and must
  re-run on hot reload.
- Provide a **`npm run validate`** script that checks every hike folder for: required
  frontmatter present, GPX parses and has trackpoints, referenced cover/photos exist, and warns
  (not errors) when photos lack EXIF timestamps. Print a clear per-hike report. This is the
  owner's safety net while bulk-importing.
- Provide a **`hikes/_TEMPLATE/`** folder (a copyable starter with a commented `index.md`) so
  creating a new hike is copy-paste-edit.
- Ship with **one example hike** (`hikes/_example/`) using tiny placeholder GPX + 2 small
  placeholder images, so `npm install && npm run dev` shows a working site immediately, before
  the owner adds real data. Mark it `status: draft` so it never deploys.

---

## 5. Stats & the summary band

Per-hike stats (derived or overridden): distance_km, ascent_m, descent_m, duration, date,
location.

**Time-based stats (derived from the GPX, shown only when it has per-point timestamps):**
- **Start–End** — first/last trackpoint times, shown in the hike's **local timezone** (HH:MM).
- **Moving vs Elapsed** — elapsed = end − start; moving excludes "stopped" segments (those below
  **0.5 km/h** — `MOVING_SPEED_KMH`). Both are shown (the gap is meaningful). Durations as H:MM.
- **Pace** — average moving pace over the moving distance, M:SS/km.

If a GPX lacks per-point timestamps these degrade away (the band falls back to `duration`).

**Timezone resolution (the UTC-vs-local problem, solved once):** GPX times are UTC; displaying
them raw would be wrong. A single helper (`lib/timezone.ts`) resolves a hike's timezone — from the
track's **start coordinates** (`tz-lookup` → IANA zone, automatic and correct abroad), overridable
by a `timezone` frontmatter field, with a final default (`DEFAULT_TIMEZONE`, default `UTC`). The
same resolver is reused by **photo placement** to interpret EXIF local-without-zone timestamps
(DST handled per-instant via Intl). `npm run validate` reports the resolved zone and flags a gross
mismatch against the longitude (e.g. a Swedish hike resolving to a US offset).

Lifetime summary band on the index page, computed at build time across all published hikes:
total distance, total ascent, number of hikes, number of distinct days out, and the date range
(first hike → latest). Keep it to ~5 numbers. Render in the mono font. Round all numbers
sensibly (km to 1 decimal, metres to integer).

---

## 6. Photo-on-map placement (the differentiator)

Each photo should appear as a marker at the point on the track where it was taken. Algorithm,
at build time, per photo:

1. **If the photo has EXIF GPS that falls within (or near) the track area** → use those
   coordinates directly. **On-trail filter:** GPS that lies well outside the padded track bounds
   (e.g. a pre-hike photo taken at home, which still carries GPS) is **not** placed — it would drop
   a marker off the trail and leak home coordinates (privacy, §6). Such photos fall through to the
   timestamp step and are otherwise left unplaced (a manual pin overrides this).
2. **Else, if the photo has an EXIF timestamp AND the GPX has per-point timestamps** → place the
   photo at the trackpoint whose time is nearest the photo's capture time (the result is on the
   track by construction). This lets GPS-less photos land in the right place by time.
3. **Else** → photo is **unplaced**: still show it in the gallery, just no map marker. Never
   error out over a missing timestamp.

**EXIF recovery (HEIC):** some HEICs — notably certain Google Photos downloads — keep their full
EXIF (GPS *and* timestamp) in a TIFF block that the EXIF library can't locate via the HEIF
container, so a naive read reports "no metadata". Before giving up, the reader scans for the
embedded TIFF header and parses it as a standalone TIFF, recovering the real GPS/timestamp tags
(not a regex guess). This is what lets these photos place automatically rather than falling to
"unplaced". `npm run validate` lists, per hike, the photos that still can't be placed (and which
carry off-trail/home GPS) so they can be hand-pinned if wanted.

**Manual override:** an optional `photos/_photos.json` can specify, per filename, an explicit
`{ lat, lng }`, a caption, an explicit ordering, or `place: false` to suppress a marker.
Manual overrides win over both EXIF and timestamp inference. Example:

```json
{
  "IMG_0421.jpg": { "caption": "Sunrise over the plateau" },
  "IMG_0432.jpg": { "lat": 61.573, "lng": 12.700, "caption": "Camp" },
  "IMG_0440.jpg": { "place": false }
}
```

**Timezone caution:** EXIF timestamps are often local-without-zone and GPX is UTC. Modern phone
photos usually include an explicit `OffsetTimeOriginal` — when present, it is used directly. When
absent, a single configurable fallback offset (`PHOTO_UTC_OFFSET_HOURS` env, default 0) is applied;
a wrong value shifts every timestamp-placed photo along the track. `npm run validate` surfaces large
photo-time-vs-track-time deltas. (Timestamp matches with a gap beyond a sane threshold are left
unplaced rather than dropped on the wrong spot.)

**Privacy:** if `hidePrecisePins: true`, do not render the exact start pin / first trackpoint
(fuzz it or trim the track ends). Also: **strip GPS EXIF from the public derivative images** by
default so home/trailhead coordinates don't leak from pre-hike photos. Keep originals untouched.

**Marker UX:** small photo-thumbnail markers (or numbered dots that open a thumbnail). Clicking a
marker opens the photo (lightbox) and/or highlights it in the gallery. Cluster or thin markers
when many photos sit close together so the map doesn't choke.

---

## 7. Map implementation details

- Use **MapLibre GL JS**. The default basemap is a keyless outdoor/topographic style
  (OpenTopoMap — hillshading, contours, OSM trails); `MAP_STYLE_URL` still overrides it (single
  config point). Basemaps are defined as one config list in `lib/map.ts`.
- **Basemap switcher** (added feature): a small runtime control on every map toggles between the
  configured basemaps (topo / streets / satellite — all keyless). `setStyle` swaps the basemap;
  the track, start pins and photo markers are re-added on each style load. The choice is
  remembered for the session (sessionStorage).
- **Index map (overview):** load all hike tracks as **one GeoJSON FeatureCollection** into a single
  line source (rendered faint). Hike start points go into **one clustered GeoJSON source** rendered
  by native symbol/circle layers: a custom cairn-pin icon + collision-aware place/date label for
  individual hikes, numbered circles for clusters. Do **not** create per-point or per-hike DOM
  markers. The basemap defaults to a pale vector style (keyless OpenFreeMap Positron, which ships
  glyphs so map labels render); fit bounds with generous padding and a capped max-zoom.
- **Per-hike map:** single track as a GeoJSON line; photo markers as a GeoJSON source with a
  symbol layer (thumbnail icons) OR a modest number of HTML markers if thumbnails are easier that
  way — but cap it and cluster.
- Tracks and photo data are **precomputed at build time into compact GeoJSON/JSON** and imported
  by the island; the client never parses GPX.
- **Animations (keep tasteful, not heavy):** gentle fit-bounds ease on load; a subtle line-draw
  reveal of the track on the per-hike page is welcome; smooth fly-to when a photo/marker is
  clicked. Respect `prefers-reduced-motion`. No gratuitous motion.
- **Interactivity lives in an Astro island** (the map is the one genuinely interactive part).
  Everything else stays static HTML so pages load fast and ship minimal JS.

---

## 8. Images & performance

- Run all photos through Astro's image pipeline to generate **responsive derivatives**:
  - a small **thumbnail** (map markers, gallery grid),
  - a **medium** (in-page display),
  - a **large/full** (lightbox).
- Serve modern formats (WebP/AVIF) with fallbacks; lazy-load below-the-fold images.
- Generate low-quality placeholders (blur-up) for smooth perceived loading.
- Strip GPS EXIF from public derivatives (see §6 privacy).
- Originals stay in the repo's `photos/` dirs **for v1 local development only**. Note in the
  README that this is fine locally but that for a large lifetime archive the originals should
  move to object storage (R2) later — that's a documented seam (§10), not a v1 task.

---

## 9. Project structure (suggested)

```
/
  astro.config.mjs
  package.json
  README.md                 # setup, authoring guide, deploy guide
  .env.example              # MAP_STYLE_URL and any tile key, documented
  src/
    content/
      config.ts             # Zod schema for the hikes collection
      hikes/
        _TEMPLATE/          # copyable starter
        _example/           # ships working out of the box, status: draft
    components/
      Map.astro / Map island # MapLibre island(s)
      ElevationProfile.*
      StatsBand.*
      HikeCard.*
      Lightbox.*
    layouts/
    pages/
      index.astro
      hikes/[slug].astro
      about.astro
    lib/
      gpx.ts                # GPX -> GeoJSON + stat derivation
      photos.ts             # EXIF read, timestamp matching, override merge
      stats.ts              # lifetime aggregation
    styles/
  scripts/
    validate.mjs            # npm run validate
```

---

## 10. Documented future seams (DO NOT BUILD in v1 — just leave clean hooks)

Leave these easy to add later; do not implement now:

- **Object storage for photos (Cloudflare R2 / MinIO):** keep all photo URL generation behind one
  helper so the source can change from local files to a CDN base URL without touching templates.
- **Place-name / geo search (Nominatim):** Pagefind covers text search in v1. If geo search is
  added later it's a separate service; keep the search UI componentised so a second search mode
  can slot in.
- **Self-hosted vector tiles:** already covered by `MAP_STYLE_URL` being a single config value.
- **Tag pages, RSS, multi-day sub-segments:** data shapes should not preclude these, but don't
  build them.

---

## 11. Deployment (after local is "good enough")

- Build: `npm run build` → static `dist/` (+ run Pagefind as a postbuild step to index the site).
- Deploy `dist/` to **Cloudflare Pages** free tier. No serverless functions required.
- Document the Cloudflare Pages settings in the README (build command, output dir, env vars).
- Production build excludes `status: draft` hikes.

---

## 12. Acceptance criteria for v1 (definition of "good enough to consider deploying")

1. `npm install && npm run dev` shows a working site with the bundled example hike, no real data
   needed.
2. Dropping a real hike folder (real Garmin GPX + a handful of phone photos) in
   `src/content/hikes/`, with minimal frontmatter, produces:
   - the hike on the index lifetime map,
   - a per-hike page with the track drawn,
   - correct derived distance/ascent/descent/duration,
   - photos placed on the per-hike map by EXIF GPS or by timestamp matching,
   - a working gallery/lightbox,
   - no manual steps beyond creating the folder.
3. `npm run validate` reports per-hike health and flags missing timestamps / timezone skew.
4. Index map renders smoothly with multiple hikes via a single GeoJSON source (no per-point DOM
   markers).
5. Photos load fast (responsive derivatives, lazy-loaded, blur-up); animations are subtle and
   respect reduced-motion.
6. `npm run build` produces a static `dist/` that runs with no backend and is Cloudflare-Pages
   deployable.
7. README documents: how to add a hike, the frontmatter schema, the `_photos.json` overrides,
   the timezone setting, and how to deploy.

---

## 13. Explicit non-goals for v1

No accounts/auth. No CMS/admin UI. No database. No federation/social. No route planning. No live
GPS tracking. No Strava/Garmin API sync (manual GPX export only). No multi-user. No comments. No
server of any kind. No object storage yet (local files). No place-name/geo search yet (text
search only). Keep it simple.

---

## 14. First task for the implementer

1. Scaffold the Astro project + the hikes Content Collection with the Zod schema in §2.1.
2. Implement `lib/gpx.ts` (parse + stat derivation) and render a single hardcoded example hike
   end to end (per-hike page with track on a MapLibre map) **before** wiring the index map.
3. Then build the index lifetime map (single-GeoJSON-source pattern).
4. Then add `lib/photos.ts` (EXIF + timestamp placement + `_photos.json` overrides) and the
   gallery/lightbox.
5. Then the stats band, search (Pagefind), and `validate` script.
6. Then polish: animations, responsive images, reduced-motion, README.

The owner will provide a real GPX file and real photos from a recent hike to test against as
soon as step 2's example renders. Build so that swapping the example for real data is just
dropping in a folder.

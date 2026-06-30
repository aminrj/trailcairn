# CLAUDE.md — working instructions for this repo

## What this project is

**trailcairn** — a personal, lifetime hiking diary website. A public ledger of hikes, each with
a GPX track on a map, photos placed on that map, derived stats, and a written diary entry.

The full requirements live in **`SPEC.md`**. That file is the source of truth. Read it before
doing anything. If something here conflicts with SPEC.md, SPEC.md wins; flag the conflict to me.

(`trailcairn` is the working name and may change — it's only used in package name, titles, and
copy. Keep it in as few hardcoded places as possible so a rename is a quick find-and-replace.)

## Non-negotiable constraints (do not violate without asking)

1. **v1 is a pure static site. No backend.** No database, no Docker, no running services, no
   serverless functions. The build output is a static `dist/` folder. It must `git clone` and
   run with `npm install && npm run dev`.
2. **Stack is fixed** (see SPEC.md §1): Astro + MapLibre GL JS + Pagefind + Astro image
   pipeline. Do not substitute these. No Mapbox (lock-in). No map API key required for rendering.
3. **Flat files are the source of truth.** One folder per hike under `src/content/hikes/`
   (Markdown + GPX + photos). No CMS, no admin UI.
4. **Respect the non-goals** (SPEC.md §13): no auth, no accounts, no federation, no route
   planning, no live tracking, no Strava/Garmin API sync, no object storage yet, no geo/
   place-name search yet. If a feature isn't in SPEC.md, don't build it — propose it to me first.
5. **Don't over-engineer.** Prefer the simplest thing that satisfies the spec. Leave the
   documented future seams (SPEC.md §10) as clean hooks, not implementations.

## How we work together (workflow)

- **Branching:** Work on `dev` by default; `main` is production and auto-deploys (Cloudflare
  Pages). **Never commit, push, or merge to `main` yourself under any circumstances** — not
  even for "trivial" fixes, not even when asked to "push everything". Always push to `dev`,
  then explicitly stop and ask the user to review and merge. The user merges `dev` → `main`.
- **Build in vertical slices, in the order given in SPEC.md §14.** Do not attempt the whole app
  in one go. One slice at a time:
  1. Scaffold + content collection + Zod schema
  2. `lib/gpx.ts` + ONE example hike rendered end-to-end (per-hike page, track on a MapLibre map)
  3. Index lifetime map (single-GeoJSON-source pattern)
  4. `lib/photos.ts` (EXIF + timestamp placement + `_photos.json` overrides) + gallery/lightbox
  5. Stats band + Pagefind search + `validate` script
  6. Polish: animations, responsive images, reduced-motion, README
- **Stop at the end of each slice and tell me what to look at** in the browser. Don't barrel
  ahead into the next slice without a checkpoint.
- **After every change, before you tell me it's done:** run `npm run build` AND `npm run
  validate` (once they exist), and fix anything that breaks. Never report a slice complete with a
  failing build. Paste the relevant build/validate output in your summary.
- **Keep diffs small and reviewable.** I'll commit working slices to git. If you're about to make
  a large sweeping change, describe the plan first and wait.
- When I report a bug, I'll describe the **symptom** (what I see). Diagnose the cause yourself;
  don't just patch the surface. If your fix doesn't work after two tries, say so plainly and
  propose reverting to the last working commit rather than stacking more changes.

## Real data

- I will provide a real Garmin GPX file and real phone photos from a recent hike to test against,
  as soon as slice 2's example renders.
- Until then, use the bundled tiny placeholder example hike (`src/content/hikes/_example/`,
  `status: draft`) so the site works on a fresh clone with no real data.
- Real test data I give you goes in a **gitignored** location (e.g. `test-data/` or a real hike
  folder I designate). Never commit my personal photos or precise GPS tracks unless I explicitly
  say so. Assume hike data is private until told otherwise.

## Quality bar / gotchas to watch (from SPEC.md)

- **Maps:** render many tracks via a SINGLE GeoJSON source + line layer (GPU), never one DOM
  marker per point. Precompute GPX→GeoJSON at build time; never ship raw GPX to the client.
- **Stats:** derive distance/ascent/descent/duration from the GPX at build time; frontmatter
  values override. Smooth elevation lightly so GPS noise doesn't inflate ascent.
  **Duration is always moving time** (segments below 0.5 km/h excluded). For multi-day hikes
  the stats band shows "N days · N night(s) out" + moving time instead of a start–end clock
  that would misleadingly span overnight pauses. `validate` surfaces nights and days in the
  track summary line. Never use wall-clock elapsed time as the displayed duration.
  **Elevation uses hysteresis accumulation** (not a per-delta threshold): consecutive gains
  are accumulated and committed only once they exceed the noise floor. This correctly handles
  both coarse tracks (one point per 10s) and dense Garmin tracks (one point per ~2m) where
  per-step deltas are tiny but the real ascent is thousands of metres.
- **Photo placement:** EXIF GPS first; else match photo timestamp to nearest GPX trackpoint; else
  leave unplaced (never error). Honor `_photos.json` overrides. Watch the **timezone** issue
  (EXIF local vs GPX UTC) — a wrong offset shifts every photo; surface a warning in `validate`.
- **Privacy:** strip GPS EXIF from public image derivatives by default; honor `hidePrecisePins`.
- **Performance:** responsive image derivatives (thumb/medium/full), lazy-load, blur-up
  placeholders. Animations subtle and gated behind `prefers-reduced-motion`.
- **Config seams:** map style behind a single `MAP_STYLE_URL` env var; photo URLs behind one
  helper (so object storage can slot in later).

## Conventions

- Package manager: **npm**. Node: current LTS.
- Keep interactivity confined to Astro islands (essentially just the map). Everything else stays
  static HTML.
- TypeScript for `lib/` logic. Validate content with the Zod schema in `src/content/config.ts`.
- Plain, minimal CSS. Editorial/minimalist aesthetic. Headings in a serif display face
  (Fraunces), stats/metadata in mono (JetBrains Mono). Keep the font choice in one place.
- Update the README as features land (how to add a hike, frontmatter schema, `_photos.json`,
  timezone setting, deploy steps). Don't let it go stale.

## Definition of done for v1

The acceptance criteria in **SPEC.md §12** are the bar. In short: a fresh clone runs with the
example hike; dropping in a real hike folder (GPX + photos, minimal frontmatter) yields a hike on
the index map and a full per-hike page with derived stats and photos placed on the map, with no
manual steps beyond creating the folder; `npm run build` produces a deployable static `dist/`.

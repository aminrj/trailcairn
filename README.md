# trailcairn

A personal, lifetime hiking diary — a public ledger of hikes, each with a GPX track on a map,
photos placed along it, derived stats, and a written diary entry.

Static site, no backend. The source of truth is plain files: one folder per hike under
`src/content/hikes/`. See `SPEC.md` for the full design.

## Run it

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # static output in dist/
```

A fresh clone works out of the box: the bundled **example hike** (`src/content/hikes/_example/`)
renders in dev so you can see the site before adding real data. It is `status: draft`, so it is
excluded from production builds and never deploys.

## Add a hike

Copy `src/content/hikes/_TEMPLATE/` to a new folder — the folder name becomes the URL slug
(e.g. `2026-06-fulufjallet/`). Then:

1. Drop in your Garmin export as `track.gpx`.
2. Put photos in a `photos/` subfolder.
3. Edit the frontmatter in `index.md` (see the template's comments, and the schema in
   `src/content.config.ts`). Only `title`, `date`, `location`, `summary`, and `track` are
   required; stats are derived from the GPX.
4. Optionally add `photos/_photos.json` to caption or manually pin photos.

The dev server hot-reloads the new hike in.

## Status

Built in vertical slices (see `SPEC.md` §14). **Slice 1 done:** project scaffold, the hikes
content collection + Zod schema, and the `_TEMPLATE`/`_example` folders. The map, GPX stat
derivation, photo-on-map placement, search, and the `validate` script land in later slices.

## Configuration

`MAP_STYLE_URL` (see `.env.example`) is the single config point for the basemap, used from
slice 2 onward.

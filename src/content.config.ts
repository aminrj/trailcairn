import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// One folder per hike under src/content/hikes/ (SPEC §2). Each hike's prose +
// metadata live in its index.md. The track.gpx and photos/ sit beside it and
// are processed in later slices (gpx.ts, photos.ts) — not validated here.
//
// Glob pattern notes:
//  - '**/index.md' matches every hike folder's entry, including '_example'
//    (its leading underscore only affects routing, not this loader).
//  - '_TEMPLATE' is excluded: it's a copyable starter with placeholder
//    frontmatter that intentionally wouldn't satisfy the schema below.
const hikes = defineCollection({
  loader: glob({
    pattern: ['**/index.md', '!**/_TEMPLATE/**'],
    base: './src/content/hikes',
  }),
  // Schema mirrors SPEC §2.1. Stats are OPTIONAL: when absent they are derived
  // from the GPX at build time (slice 2); a value set here overrides the
  // derived one.
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(), // start date of the hike
    location: z.string(), // human-readable
    summary: z.string(), // 1–2 sentence teaser for cards/lists
    track: z.string(), // GPX filename, relative to the hike folder
    cover: z.string().optional(), // photo path rel. to folder; else auto-pick first photo
    tags: z.array(z.string()).default([]),
    status: z.enum(['draft', 'published']).default('published'),

    // --- derived-or-overridden stats (all optional) ---
    distance_km: z.number().optional(),
    ascent_m: z.number().optional(),
    descent_m: z.number().optional(),
    duration: z.string().optional(), // e.g. "6h 20m"

    // Timezone override (IANA id, e.g. "Europe/Stockholm"). Optional — normally
    // resolved automatically from the track's start coordinates (SPEC §5).
    timezone: z.string().optional(),

    // Privacy: when true, fuzz/omit the start-point pin (SPEC §6).
    hidePrecisePins: z.boolean().default(false),
  }),
});

export const collections = { hikes };

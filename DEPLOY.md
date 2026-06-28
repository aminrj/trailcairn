# trailcairn — Deploy & Authoring Guide

This is the guide to future-me. Two parts:

- **Part A — One-time setup** (do once): GitHub + Cloudflare Pages + the `hikes.aminrj.com`
  subdomain. ~20 minutes.
- **Part B — The forever loop** (every hike): download GPX + photos, make a folder, write the
  diary, push. The site rebuilds and deploys itself.

The mental model, in one line:
**Push to `main` → the live site at hikes.aminrj.com updates automatically. Work on any other
branch → it stays private with its own preview URL.**

---

## Part A — One-time setup

### A1. Put the repo on GitHub (if it isn't already)

```bash
# from the project folder
git status                      # confirm everything's committed
git branch -M main              # name the default branch "main"
# create an EMPTY repo on github.com first (no README), then:
git remote add origin git@github.com:<your-username>/trailcairn.git
git push -u origin main
```

Keep the repo **private** if you like — Cloudflare Pages works with private repos, and the
*built site* is public regardless. (Your real hike folders are gitignored, so they aren't on
GitHub anyway — see "A note on data" at the bottom.)

### A2. Create the Cloudflare Pages project

1. Log in to the Cloudflare dashboard → **Workers & Pages**.
2. **Create application → Pages → Connect to Git.**
3. Authorize GitHub (choose "Only select repositories" → pick `trailcairn`). Select it →
   **Begin setup**.
4. **Build settings** (the important screen):
   - **Framework preset:** Astro (if offered). If not, set manually below.
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Production branch:** `main`
   - **Environment variables:** add `NODE_VERSION` = `20` (or current LTS). Add any
     `MAP_*` / tile keys here too if the site uses a keyed provider — but the keyless map
     needs none.
5. **Save and Deploy.** The first build runs; in ~1–2 min you get a live `*.pages.dev` URL.
   Click it, confirm the site works.

> If Pagefind search needs a postbuild step, it should already be wired into `npm run build`
> (check `package.json`). If search is empty on the deployed site, that's the first thing to
> check.

### A3. Point hikes.aminrj.com at it

Because `aminrj.com` is already a Cloudflare zone, this is nearly automatic:

1. In the Pages project → **Custom domains → Set up a domain.**
2. Enter `hikes.aminrj.com` → **Continue.**
3. Cloudflare detects the zone and **creates the CNAME record for you** → confirm.
4. Wait a few minutes for SSL to provision (the dashboard shows status). Then
   **https://hikes.aminrj.com** is live with automatic HTTPS.

That's the whole setup. From here on, you never touch the Cloudflare dashboard again — pushing
to GitHub is the only action.

### A4. (Recommended) Set up the two-branch workflow

So you can keep building without every half-finished change going live:

```bash
git checkout -b dev             # your everyday working branch
git push -u origin dev
```

- Work, commit, and push on `dev` (or feature branches). Cloudflare auto-builds each push to a
  **preview URL** (shown in the GitHub commit checks and the Pages dashboard) — a private
  staging copy to review.
- When happy, merge `dev → main`. That push to `main` is what updates the public site.

```bash
# when a batch of work is ready to go live:
git checkout main
git merge dev
git push                        # → hikes.aminrj.com updates
git checkout dev                # go back to building
```

If you'd rather keep it dead simple and just push to `main` every time, that works too — you
lose the staging safety net but gain fewer steps. Future-you decides.

---

## Part B — The forever loop: adding a hike

Repeat this for every hike. It's the same five steps each time.

### B1. Download the data

- **GPX:** from Garmin Connect → open the activity → gear/export menu → **Export to GPX**.
  Save the file.
- **Photos:** from Google Photos (or your phone/NAS) → select the hike's photos → download.
  Don't worry about metadata; the build handles GPS, timestamps, or neither.

### B2. Make the hike folder

Folder name = the slug, format **`YYYY-MM-place`**, lowercase, ASCII, hyphens (no spaces, no
accents — the pretty name with accents goes in the title later).

```
src/content/hikes/
└── 2026-07-skuleskogen/        ← new folder, this naming pattern
    ├── index.md
    ├── track.gpx               ← rename your Garmin export to exactly this
    └── photos/
        ├── IMG_1234.jpg        ← drop photos in, keep original filenames
        └── ...
```

Fastest way: copy the template.

```bash
cp -r src/content/hikes/_TEMPLATE src/content/hikes/2026-07-skuleskogen
# then move your track.gpx and photos into it
```

### B3. Write the diary (`index.md`)

Open `index.md` and fill the frontmatter. Only the first five fields are required; stats fill
themselves in from the GPX.

```markdown
---
title: "Skuleskogen ridge"
date: 2026-07-12
location: "Skuleskogen, Sweden"
summary: "A coastal ridge walk in the High Coast, ending at the sea cave."
track: "track.gpx"
status: draft          # keep as draft until you're happy; flip to published to go live
---

Write the diary entry here in plain Markdown. As long or short as you like.
This is the story of the hike — what it was, how it felt, what you saw.
```

Optional extras when you want them:
- `cover: "photos/IMG_1234.jpg"` to choose the hero photo (else the first is used).
- `tags: ["coast", "day hike"]`.
- `hidePrecisePins: true` to fuzz the start point for privacy.
- A `photos/_photos.json` file to caption photos or hand-pin ones with no GPS:
  ```json
  { "IMG_1234.jpg": { "caption": "The sea cave" },
    "IMG_1240.jpg": { "lat": 63.10, "lng": 18.55, "caption": "Ridge top" } }
  ```

### B4. Preview locally

```bash
npm run dev          # open http://localhost:4321
```

Check the new hike: track on the map, stats, photos placed, diary reads well. For search,
`npm run build && npm run preview`. Fix anything, including switching `status: draft → published`
when the entry is ready to be public.

Run the safety check before publishing:

```bash
npm run validate     # flags missing fields, broken GPX, timezone skew on photos
```

### B5. Publish

Photos live in **Cloudflare R2**, not git (see `R2-PHOTOS.md`). So publishing is: build (makes the
WebP derivatives + the `photos.manifest.json` metadata bridge) → push the derivatives to R2 → commit
the **text + manifest** (never the photos) → merge.

```bash
# on dev branch:
npm run build                                       # writes public/_gen derivatives + photos.manifest.json
rclone copy -v public/_gen/photos/2026-07-skuleskogen \
            r2:trailcairn-photos/2026-07-skuleskogen --include "*.webp"   # pixels → R2

git add -f src/content/hikes/2026-07-skuleskogen/index.md \
           src/content/hikes/2026-07-skuleskogen/track.gpx \
           src/content/hikes/2026-07-skuleskogen/photos.manifest.json     # text + manifest ONLY
git commit -m "Add Skuleskogen ridge hike"
git push                                            # builds a preview

# when ready to go live:
git checkout main && git merge dev && git push      # → hikes.aminrj.com updates
git checkout dev
```

Within ~2 minutes the hike is live. Done. (Full R2 details, the slug↔key contract, and a worked
example are in `R2-PHOTOS.md`.)

> **Why `git add -f` the individual files?** The `.gitignore` ignores all real hike folders (and the
> manifest) by default, so a stray commit can never leak your GPS tracks or photos. You force-add
> *only* the text — `index.md`, `track.gpx`, `photos.manifest.json`. **Don't** `git add -f` the
> whole folder: that would pull the photos into git, which is exactly what R2 exists to avoid. The
> photos reach the web via `rclone`, not git.

---

## A note on data (read once, remember forever)

- Your hikes live as plain Markdown + GPX + JPEG/HEIC in folders. That IS the durable archive. Back
  up the whole project folder (NAS, second git remote, wherever) and you have everything,
  readable in any text editor in 2036.
- Because hike folders are gitignored-by-default, your private repo only contains the **text** you
  explicitly `git add -f` (Markdown, GPX, `photos.manifest.json`). The **photos** live in R2, not
  git. So your backup must cover BOTH: keep a full local copy of `src/content/hikes/` (the
  originals — your real archive) AND remember R2 is only the serving copy, not a backup
  (`R2-PHOTOS.md` Part E covers mirroring it back). gitignore protects privacy, not your data.
- The site is static. If trailcairn-the-code ever breaks, your *content* is untouched and
  portable to any other tool. Nothing about your history is locked to Cloudflare, Astro, or
  this codebase.

## If something breaks in 10 years

- **Build fails on Cloudflare:** check the build log in the Pages dashboard. Usually a Node
  version bump — update `NODE_VERSION`. Pin dependency versions in `package.json` to reduce
  this.
- **Site up but a hike looks wrong:** run `npm run validate` locally on that hike.
- **Forgot the workflow:** re-read Part B. It's always the same five steps.

## Footnote: if you specifically want tagged/versioned releases

The branch model above is recommended. But if you want immutable version stamps (e.g. you treat
the *code* as a product), you can tag releases and have a deploy reflect a tag. The simplest
durable version: keep `main` as production as above, and additionally tag milestones for your
own reference —

```bash
git tag -a v1.0 -m "First public version"
git push --tags
```

Cloudflare Pages deploys branches, not tags, so tags here are bookmarks for *you*, not deploy
triggers. For tag-triggered deploys you'd add a GitHub Action — more machinery, more to maintain,
and not worth it for a personal diary. Recommend skipping unless you have a clear reason.

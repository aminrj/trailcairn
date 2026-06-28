# trailcairn — Photo Storage (Cloudflare R2) Runbook

This is the guide to future-me on how photos work, why they live where they do, and how to
keep adding hikes years from now. If you're reading this after a long gap: start at
[The 30-second model](#the-30-second-model), then [Adding a hike's photos](#part-c--adding-a-hikes-photos-the-forever-loop).

---

## The 30-second model

- **Git holds words and pointers.** Markdown, GPX, and `_photos.json` live in the repo. They are
  small, text, diff-able, and last forever in git.
- **R2 holds the pixels.** The actual photo files live in a Cloudflare R2 bucket, served to the
  public over a custom domain. They are NOT in git.
- **The build joins them.** At build time the site generates `<img>` URLs pointing at the R2
  custom domain, using a single helper so the source is swappable.

Why split them: photos in git bloat the repo forever (history never shrinks), can't be truly
deleted, and eventually hit Cloudflare Pages build limits. R2 keeps the repo tiny and text-only,
makes deletes real, has **no egress fees** (serving images publicly is free), and is
S3-compatible so it's portable to any other provider or a self-hosted MinIO later — no lock-in.

**The contract that must never break:** the URL the build emits must exactly match the key the
file was uploaded to in R2. The build serves generated **WebP derivatives** (not the originals),
so the objects in R2 are files like `IMG_0421-medium.webp`. If the build emits
`https://photos.aminrj.com/2026-06-dals-ed/IMG_0421-medium.webp` then the file must live at the key
`2026-06-dals-ed/IMG_0421-medium.webp`. The thing you upload is the generated derivatives folder
`public/_gen/photos/<slug>/`; its subfolder name is the slug and the R2 prefix. Get this right and
everything works; get it wrong and images 404 silently. See
[Verifying it works](#part-d--verifying-it-works) for how to check.

---

## Part A — What was set up (one-time, already done)

Recorded here so you can recreate or audit it later.

### The bucket
- **Name:** `trailcairn-photos` (R2 → it appears in the Cloudflare dashboard).
- **Location:** Automatic.
- **Public access:** served via a **custom domain**, NOT the `r2.dev` URL. The `r2.dev` URL is
  rate-limited and for testing only; never use it in production.

### The serving custom domain
- **Domain:** `photos.aminrj.com` (a CNAME under the already-Cloudflare-managed `aminrj.com`
  zone; DNS + SSL were created automatically when the domain was connected to the bucket).
- This is the base URL the site's `<img>` tags point at. It is configured in the code in ONE
  place (see [Part B](#part-b--how-the-code-is-wired)).
- Objects served this way are cached at Cloudflare's edge — fast and effectively free.

### The upload API token
- A **scoped** R2 API token: **Object Read & Write**, restricted to the `trailcairn-photos`
  bucket only (NOT account-wide). Scoping it tight means a leaked token can't touch anything else.
- It produced an **Access Key ID**, a **Secret Access Key** (shown once — not viewable again),
  and an **S3 endpoint** of the form `https://<account-id>.r2.cloudflarestorage.com`.
- These credentials live ONLY in the local rclone config (`~/.config/rclone/rclone.conf`),
  never in the repo.

### The lifecycle safeguard
- An **"abort incomplete multipart uploads after 7 days"** lifecycle rule is set on the bucket.
  Without it, interrupted uploads leave orphaned parts you pay for forever. Set once, forget.

### If you ever need to recreate any of this
Dashboard → R2 → create bucket → Settings → Custom Domains (connect `photos.aminrj.com`) →
Manage R2 API Tokens (Object Read & Write, this bucket only) → Settings → Object lifecycle
rules (abort multipart after 7 days). Then redo [Part B-config](#local-tooling-rclone) below.

---

## Part B — How the code is wired

- The photo base URL lives in **one** config value: `PHOTO_BASE_URL` in `src/consts.ts`
  (env-overridable), set to `https://photos.aminrj.com`. Documented in `.env.example`.
- `genUrl()` in `src/lib/photos.ts` is the single source of truth for photo URLs:
  - **Production build:** returns `${PHOTO_BASE_URL}/<slug>/<base>-<size>.webp` (R2).
  - **Local dev (`npm run dev`):** returns `/_gen/photos/<slug>/<base>-<size>.webp`, served off
    disk, so you preview without R2 being reachable.
- **What's served is generated WebP derivatives**, not the originals. A build resizes each photo
  into `thumb` / `medium` / `full` WebP under `public/_gen/photos/<slug>/`. **Those** are what you
  upload to R2. The originals never leave your machine (and never go to git).
- **The manifest bridge (`photos.manifest.json`).** The deployed site is built by Cloudflare from
  the git repo — which is *text-only* (no photos). So Cloudflare can't read EXIF/placement. To
  bridge this, a **local** build writes a small `photos.manifest.json` next to each hike's
  `index.md` holding everything the deployed build needs it can't recompute: each photo's
  placement (lat/lng + which branch), dimensions, blur placeholder, caption, and source. It's
  text, and you commit it. The deployed build reads it and emits the R2 URLs. The manifest stores
  **no URLs** — they're rebuilt from the filename — so dev (local) and prod (R2) can't drift.
  `npm run validate` warns if the manifest is stale.

> Because every URL is generated in one helper and the bytes sit behind an S3-compatible API,
> switching providers later (different CDN, self-hosted MinIO) stays a config change — deliberate.

### Local tooling (rclone)
The uploader is **rclone** (reliable, idempotent, handles large files). Config lives at
`~/.config/rclone/rclone.conf`, remote named `r2`:

```ini
[r2]
type = s3
provider = Cloudflare
access_key_id = <ACCESS_KEY_ID>
secret_access_key = <SECRET_ACCESS_KEY>
endpoint = https://<ACCOUNT_ID>.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
```

Two non-negotiable details (these prevent brittleness):
1. **The `endpoint` must NOT include the bucket name.** If you append the bucket, rclone's file
   listing misbehaves and re-uploads everything every time instead of skipping existing files.
2. **`no_check_bucket = true`** is required because the token is object-scoped (not
   account-scoped); without it rclone errors trying to inspect the bucket.

Also: rclone **1.59+** (older versions throw 401s against R2).

---

## Part C — Adding a hike's photos (the forever loop)

For every new hike: build, push the pixels to R2, push the text to git. Four steps.

### 1. Put the original photos in the hike folder locally
```
src/content/hikes/2026-07-skuleskogen/photos/IMG_xxxx.jpg
```
Keep originals here — they're the local preview source, the metadata source, and what the build
resizes from. They do NOT go to git or R2 (the *derivatives* go to R2).
> Tip for clean placement: export photos straight from the phone or NAS originals, NOT a Google
> Photos web download. (Web downloads can hide EXIF in a spot some readers miss; the build now
> recovers it from the embedded block, but originals are still the safe bet.)

### 2. Build — generates the WebP derivatives AND the manifest
```bash
npm run build
```
This writes `public/_gen/photos/2026-07-skuleskogen/*.webp` (the files you upload) and
`src/content/hikes/2026-07-skuleskogen/photos.manifest.json` (the text you commit). Run
`npm run validate` too — it flags a stale manifest before you push.

### 3. Upload that hike's **derivatives** to R2
`copy` (adds/updates only, never deletes — safe), only the `.webp`, into a prefix that **exactly
equals the slug** (the `public/_gen/photos/` subfolder name the build just created):
```bash
rclone copy -v public/_gen/photos/2026-07-skuleskogen r2:trailcairn-photos/2026-07-skuleskogen --include "*.webp"
```
- `-v` shows what uploaded; re-running is idempotent (skips files already in R2).
- **The prefix MUST equal the build's `public/_gen/photos/<slug>` folder name.** Slugs are
  lowercase ASCII (see DEPLOY.md), so folder = slug = R2 prefix line up. If a hike folder has
  mixed case (e.g. `2026-06-Dals-Ed`), the generated slug is lowercased (`2026-06-dals-ed`) —
  upload from the `public/_gen/photos/` name, not the source folder name.
- One-shot for everything (all hikes at once, casing-proof):
  `rclone copy -v public/_gen/photos r2:trailcairn-photos --include "*.webp"`.

### 4. Publish the text + manifest (git), then go live
Commit only the text — index.md, the GPX, and the manifest. **Not** the photos.
```bash
# on dev:
git add -f src/content/hikes/2026-07-skuleskogen/index.md \
           src/content/hikes/2026-07-skuleskogen/track.gpx \
           src/content/hikes/2026-07-skuleskogen/photos.manifest.json
#   (-f because hike folders are gitignored; photos/ is deliberately NOT added — it lives in R2)
git commit -m "Add Skuleskogen hike"
git push                                            # builds a Cloudflare preview
# when happy:
git checkout main && git merge dev && git push      # → hikes.aminrj.com updates
git checkout dev
```

**Loop in one line:** `npm run build` → `rclone copy` the derivatives → `git add -f` the text +
manifest → preview → merge to main.

### Worked example (one real photo, end to end)
Hike folder `src/content/hikes/2026-06-Dals-Ed/`, photo `photos/IMG_0820.HEIC`:
- **Build emits** (prod) for its in-page image:
  `https://photos.aminrj.com/2026-06-dals-ed/IMG_0820-medium.webp`
  (slug `2026-06-dals-ed` + base `IMG_0820` + `-medium.webp`).
- **Manifest entry** (`.../2026-06-Dals-Ed/photos.manifest.json`) — no URL, just the metadata:
  ```json
  { "filename": "IMG_0820.HEIC", "width": 5712, "height": 4284, "blur": "data:image/webp;base64,…",
    "caption": null, "order": 9007199254740991, "placed": true,
    "lat": 59.0422, "lng": 11.7934, "source": "exif-gps" }
  ```
- **Local derivative** the build wrote: `public/_gen/photos/2026-06-dals-ed/IMG_0820-medium.webp`.
- **Upload command** that puts it at the matching key:
  ```bash
  rclone copy -v public/_gen/photos/2026-06-dals-ed r2:trailcairn-photos/2026-06-dals-ed --include "*.webp"
  ```
  → R2 key `2026-06-dals-ed/IMG_0820-medium.webp` → served at
  `https://photos.aminrj.com/2026-06-dals-ed/IMG_0820-medium.webp`. **Identical to the emitted URL.**

---

## Part D — Verifying it works

Do this the first time, and any time something looks wrong.

1. **The join is correct.** Pick one real photo. Confirm three things line up:
   - the URL the built page emits (view source / inspect an `<img>`) — a `…-medium.webp` etc.,
   - the R2 object key (`rclone lsf r2:trailcairn-photos/<slug>/`) — same `…-medium.webp`,
   - they should be identical paths. A 404'd image almost always means these don't match.
2. **The objects (derivatives) are actually in R2:**
   ```bash
   rclone lsf r2:trailcairn-photos/2026-07-skuleskogen/
   ```
   lists `*-thumb.webp`, `*-medium.webp`, `*-full.webp` for each photo.
3. **It serves publicly:** open a derivative directly, e.g.
   `https://photos.aminrj.com/2026-07-skuleskogen/IMG_xxxx-medium.webp`. If it loads, serving
   works. 403 → the custom domain / public access isn't set. 404 → the upload path doesn't match
   the URL (or you uploaded originals, not the `public/_gen` derivatives).
4. **On the live site / preview:** the hike's photos appear in the gallery and any placed ones show
   on the trail map. If the gallery is empty but the page builds, the manifest is missing or stale
   — `npm run build` then re-commit `photos.manifest.json`.

---

## Part E — Backups (read this once, it's the part people regret skipping)

R2 is durable, but it is **not your backup** — it's your serving copy. Likewise GitHub only has
the text (photos are gitignored). So:

- **Keep a full local copy of `src/content/hikes/` somewhere independent** (the NAS, an external
  drive, a second location). That folder — Markdown + GPX + the original photos — IS the lifetime
  archive. Everything else (the website, R2, the build) is a rendering of it.
- Optionally mirror the R2 bucket back to local periodically as a second safety net:
  ```bash
  rclone copy -v r2:trailcairn-photos ~/backups/trailcairn-photos
  ```
- The durability promise holds only if the source folder is backed up. gitignore protects
  privacy, not your data.

---

## Part F — Troubleshooting future-me

| Symptom | Likely cause | Fix |
|---|---|---|
| Images 404 on the live site | Upload key ≠ emitted URL: uploaded originals instead of `public/_gen` derivatives, slug/case mismatch, or forgot to `rclone copy` this hike | Compare emitted `<img>` URL vs `rclone lsf` output; re-upload `public/_gen/photos/<slug>` with `--include "*.webp"` |
| Gallery empty / no photos on a hike that builds fine | `photos.manifest.json` missing or stale (deployed build reads it, not the photos) | `npm run build` locally, then `git add -f …/photos.manifest.json` and re-push; `npm run validate` flags this |
| Images 403 / "access denied" | Custom domain or public access not configured | R2 → bucket → Settings → Custom Domains; ensure `photos.aminrj.com` is connected |
| rclone 401 errors | rclone too old, or token expired/revoked | Update rclone (≥1.59); if token revoked, mint a new scoped Object R/W token and update `rclone.conf` |
| rclone re-uploads everything each run | bucket name appended to `endpoint` in config | Remove bucket from `endpoint`; it must end at `...r2.cloudflarestorage.com` |
| rclone "bucket not found"-type error | object-scoped token without `no_check_bucket` | Add `no_check_bucket = true` to the `[r2]` remote |
| Photos don't auto-place on map | Source photos had GPS/timestamp stripped (e.g. Google web download) | Use originals; or hand-pin via `_photos.json` `{lat,lng}` |
| Paying for nothing / orphaned parts | Multipart lifecycle rule missing | Re-add "abort incomplete multipart uploads after 7 days" on the bucket |

---

## Why it's built this way (the one-paragraph rationale)

Photos in object storage + text in git is the pattern that survives a decade: the repo stays
small and fast forever, deletes are real, serving is free via R2's no-egress edge, and because
every photo URL is generated through one helper and stored under an S3-compatible API, nothing is
locked to Cloudflare — the whole archive is portable to any provider or self-hosted store with a
config change. The only discipline it asks of you is the slug = folder = R2 prefix contract and a
backup of the source folder. Keep those two and trailcairn's photos are good for the long haul.

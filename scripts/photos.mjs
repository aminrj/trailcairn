// Generate WebP derivatives + the committed photos.manifest.json for EVERY hike
// (draft or published), run via `npm run photos`.
//
// Why this exists: the manifest is the bridge that lets the photo-less Cloudflare
// build render photos from R2 (SPEC §8, R2-PHOTOS.md). It's normally written when
// a hike page renders — but `astro build` skips drafts, so a draft hike would
// never get one. This step is render-independent: it processes every hike folder
// directly, so the manifest + derivatives are always ready before you publish.
//
// It NEVER fails the process (per-hike try/catch, no non-zero exit) and is NOT
// wired into `npm run build`, so it can't affect the deployed Cloudflare build.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseGpx } from '../src/lib/gpx.ts';
import { processHikePhotos } from '../src/lib/photos.ts';
import { resolveHikeTimeZone } from '../src/lib/timezone.ts';

const HIKES_DIR = path.resolve('src/content/hikes');

function listHikeDirs() {
  if (!fs.existsSync(HIKES_DIR)) return [];
  return fs
    .readdirSync(HIKES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_TEMPLATE')
    .map((d) => d.name)
    .sort();
}

const c = { green: (s) => `\x1b[32m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

const folders = listHikeDirs();
console.log(c.bold(`\nGenerating derivatives + manifest for ${folders.length} hike(s)\n`));

let ok = 0;
for (const folder of folders) {
  const dir = path.join(HIKES_DIR, folder);
  // Slug must match Astro's content id (and the served URL / R2 prefix): lowercased.
  const slug = folder.toLowerCase();
  try {
    const indexPath = path.join(dir, 'index.md');
    if (!fs.existsSync(indexPath)) {
      console.log(`  ${folder}: ${c.dim('no index.md — skipped')}`);
      continue;
    }
    const { data } = matter(fs.readFileSync(indexPath, 'utf-8'));

    let gpx = null;
    const trackPath = path.join(dir, data.track || 'track.gpx');
    if (fs.existsSync(trackPath)) {
      try {
        gpx = parseGpx(fs.readFileSync(trackPath, 'utf-8'));
      } catch {
        /* placement just falls back to GPS-only without timestamp matching */
      }
    }
    const tz = gpx
      ? resolveHikeTimeZone({ lat: gpx.start[1], lng: gpx.start[0], frontmatterTz: data.timezone })
      : null;

    const { photos } = await processHikePhotos(
      { slug, dir, cover: data.cover ?? null, timezone: tz?.id },
      gpx,
    );
    const placed = photos.filter((p) => p.placed).length;
    const hasManifest = fs.existsSync(path.join(dir, 'photos.manifest.json'));
    if (photos.length === 0) {
      console.log(`  ${folder}: ${c.dim('no photos')}`);
    } else {
      console.log(
        `  ${c.green('✓')} ${folder}: ${photos.length} photos · ${placed} placed` +
          (hasManifest ? ` · ${c.dim('manifest written')}` : ''),
      );
    }
    ok++;
  } catch (e) {
    // Never fail the run — just report and move on.
    console.log(`  ${folder}: ${c.dim('skipped — ' + e.message)}`);
  }
}

console.log(
  `\n${ok}/${folders.length} hike(s) processed. ` +
    c.dim('Upload the derivatives to R2 (see R2-PHOTOS.md), then commit the manifest(s).\n'),
);

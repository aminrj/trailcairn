// Upload generated WebP derivatives to Cloudflare R2 — the one command that
// replaces the hand-typed `rclone copy` in DEPLOY.md / R2-PHOTOS.md.
//
// Why this exists: the ONLY step where a slug/case mismatch could ever creep in
// was typing the R2 destination prefix by hand. Hike FOLDERS are often mixed
// case (2026-07-Kulleberg), but the served URL + R2 key are the LOWERCASE slug
// (2026-07-kulleberg) — see scripts/photos.mjs and lib/photos.ts genUrl(). Get
// the case wrong on upload and every image 404s silently on the live site.
//
// This script never lets a human type the prefix: it takes each already-lowercase
// subfolder of public/_gen/photos/ (which the build wrote from the lowercased
// slug) as the single source of truth for the R2 key, uploads it, and VERIFIES
// the object count landed. So folder casing is now irrelevant — it can't break.
//
//   npm run publish            # upload every hike's derivatives, verify each
//   npm run publish kulleberg  # only hikes whose slug contains "kulleberg"
//   npm run publish -- --dry   # show what would upload, transfer nothing
//
// Safe by construction: `rclone copy` only adds/updates, never deletes; re-runs
// are idempotent. Requires rclone configured with an `r2:` remote (R2-PHOTOS.md).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const GEN_ROOT = path.resolve('public/_gen/photos');
const HIKES_DIR = path.resolve('src/content/hikes');
// The bucket destination, overridable for a different account/bucket/remote.
const DEST = (process.env.R2_PHOTOS_DEST ?? 'r2:trailcairn-photos').replace(/\/+$/, '');

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry') || args.includes('--dry-run');
const filters = args.filter((a) => !a.startsWith('-')).map((s) => s.toLowerCase());

function fail(msg) {
  console.error(c.red(`\n✗ ${msg}\n`));
  process.exit(1);
}

// --- preconditions ----------------------------------------------------------
try {
  execFileSync('rclone', ['version'], { stdio: 'ignore' });
} catch {
  fail('rclone not found on PATH. Install it and configure the `r2:` remote (see R2-PHOTOS.md).');
}
if (!fs.existsSync(GEN_ROOT)) {
  fail(`no ${path.relative(process.cwd(), GEN_ROOT)}/ — run \`npm run photos\` first to generate derivatives.`);
}

// Slugs come from the real hike folders, lowercased — exactly how the build
// derives them (scripts/photos.mjs). This is the source of truth for the R2
// key, so case can't drift. Deriving from the hikes (not from whatever sits in
// _gen/) also means orphaned derivative folders left over from a rename, and
// the local-only `_example`, never get pushed to R2.
let slugs = fs
  .readdirSync(HIKES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_')) // skip _example / _TEMPLATE
  .map((d) => d.name.toLowerCase())
  .sort();
if (filters.length) slugs = slugs.filter((s) => filters.some((f) => s.includes(f)));

if (slugs.length === 0) {
  console.log(c.yellow(filters.length ? `No _gen folders match: ${filters.join(', ')}` : 'No derivative folders to upload.'));
  process.exit(0);
}

function localWebpCount(slug) {
  const dir = path.join(GEN_ROOT, slug);
  if (!fs.existsSync(dir)) return 0; // derivatives not generated yet
  return fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).length;
}
function remoteWebpCount(slug) {
  try {
    const out = execFileSync('rclone', ['lsf', `${DEST}/${slug}`, '--include', '*.webp'], { encoding: 'utf-8' });
    return out.split('\n').filter((l) => l.trim().endsWith('.webp')).length;
  } catch {
    return 0; // prefix doesn't exist yet
  }
}

console.log(
  c.bold(`\n${dryRun ? '[dry run] ' : ''}Publishing ${slugs.length} hike(s) → ${DEST}\n`),
);

let uploaded = 0;
let failures = 0;
for (const slug of slugs) {
  const src = path.join(GEN_ROOT, slug);
  const local = localWebpCount(slug);
  if (local === 0) {
    console.log(`  ${c.dim('·')} ${slug}: ${c.dim('no derivatives in _gen — run `npm run photos` first')}`);
    continue;
  }
  if (dryRun) {
    const remote = remoteWebpCount(slug);
    console.log(`  ${c.dim('·')} ${slug}: ${local} local / ${remote} in R2 ${c.dim(local > remote ? `(${local - remote} to upload)` : '(in sync)')}`);
    continue;
  }
  try {
    // copy = add/update only (never deletes); idempotent on re-run.
    execFileSync('rclone', ['copy', src, `${DEST}/${slug}`, '--include', '*.webp'], { stdio: 'ignore' });
    const remote = remoteWebpCount(slug);
    if (remote >= local) {
      console.log(`  ${c.green('✓')} ${slug}: ${remote} object(s) in R2`);
      uploaded++;
    } else {
      console.log(`  ${c.red('✗')} ${slug}: uploaded but R2 shows ${remote}/${local} — re-run or check rclone`);
      failures++;
    }
  } catch (e) {
    console.log(`  ${c.red('✗')} ${slug}: upload failed — ${e.message.split('\n')[0]}`);
    failures++;
  }
}

// --- stray case-duplicate check ---------------------------------------------
// The exact bug this script prevents leaves debris: a mixed-case prefix in R2
// (e.g. 2026-07-Kulleberg/) alongside the correct lowercase one. Surface it so
// old mistakes get cleaned up. Read-only — never deletes anything.
if (!dryRun) {
  try {
    const dirs = execFileSync('rclone', ['lsf', DEST, '--dirs-only'], { encoding: 'utf-8' })
      .split('\n')
      .map((l) => l.replace(/\/$/, '').trim())
      .filter(Boolean);
    const stray = dirs.filter((d) => d !== d.toLowerCase() && dirs.includes(d.toLowerCase()));
    if (stray.length) {
      console.log(
        c.yellow(
          `\n⚠ Stray mixed-case prefixes in R2 (duplicate storage from an old hand-upload):\n` +
            stray.map((d) => `    ${d}/  →  delete with: rclone purge ${DEST}/${d}`).join('\n'),
        ),
      );
    }
  } catch {
    /* listing is best-effort */
  }
}

if (dryRun) {
  console.log(c.dim('\n(dry run — nothing uploaded)\n'));
  process.exit(0);
}
console.log(
  `\n${uploaded} uploaded, ${failures} failed. ` +
    (failures ? c.red('Some hikes did not sync.\n') : c.green('All derivatives are in R2.\n')),
);
process.exit(failures ? 1 : 0);

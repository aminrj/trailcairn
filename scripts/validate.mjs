// Per-hike health check (SPEC §4). Run with `npm run validate` (via tsx so it
// can import the TypeScript libs directly). Reports problems per hike and exits
// non-zero if any hard errors are found. Warnings never fail the run.
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseGpx, GpxError } from '../src/lib/gpx.ts';
import {
  inspectPhotoExif,
  matchPhotoToTrack,
  isPhotoFile,
  MAX_MATCH_GAP_MINUTES,
} from '../src/lib/photos.ts';
import {
  resolveHikeTimeZone,
  isValidTimeZone,
  zoneOffsetMinutes,
  roughOffsetMinutesFromLng,
} from '../src/lib/timezone.ts';

const HIKES_DIR = path.resolve('src/content/hikes');
const REQUIRED = ['title', 'date', 'location', 'summary', 'track'];

const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function listHikeDirs() {
  if (!fs.existsSync(HIKES_DIR)) return [];
  return fs
    .readdirSync(HIKES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_TEMPLATE')
    .map((d) => d.name)
    .sort();
}

async function validateHike(slug) {
  const dir = path.join(HIKES_DIR, slug);
  const errors = [];
  const warnings = [];
  const notes = [];

  // --- frontmatter ---
  const indexPath = path.join(dir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    return { slug, errors: ['missing index.md'], warnings, notes };
  }
  let data = {};
  try {
    data = matter(fs.readFileSync(indexPath, 'utf-8')).data;
  } catch (e) {
    errors.push(`index.md frontmatter failed to parse: ${e.message}`);
    return { slug, errors, warnings, notes };
  }
  for (const key of REQUIRED) {
    if (data[key] == null || data[key] === '') errors.push(`missing required field: ${key}`);
  }
  if (data.date != null && Number.isNaN(new Date(data.date).getTime())) {
    errors.push(`date is not a valid date: ${data.date}`);
  }
  if (data.status && !['draft', 'published'].includes(data.status)) {
    errors.push(`status must be draft|published (got: ${data.status})`);
  }

  // --- GPX ---
  let gpx = null;
  const trackName = data.track || 'track.gpx';
  const trackPath = path.join(dir, trackName);
  if (!fs.existsSync(trackPath)) {
    errors.push(`track file not found: ${trackName}`);
  } else {
    try {
      gpx = parseGpx(fs.readFileSync(trackPath, 'utf-8'));
      const hasTimes = gpx.times.some((t) => t != null);
      notes.push(
        `track: ${gpx.stats.points} pts · ${gpx.stats.distance_km} km · ${gpx.stats.ascent_m} m↑` +
          (hasTimes ? ` · ${gpx.stats.duration ?? '—'}` : ' · no timestamps'),
      );
      if (!hasTimes) warnings.push('GPX has no per-point timestamps (timestamp photo matching disabled)');

      // --- timezone sanity ---
      if (data.timezone && !isValidTimeZone(data.timezone)) {
        errors.push(`timezone is not a valid IANA zone: ${data.timezone}`);
      }
      const [lng, lat] = gpx.start;
      const tz = resolveHikeTimeZone({ lat, lng, frontmatterTz: data.timezone });
      if (isValidTimeZone(tz.id) && hasTimes) {
        const actual = zoneOffsetMinutes(gpx.stats.startEpochMs, tz.id);
        const expected = roughOffsetMinutesFromLng(lng);
        notes.push(`timezone: ${tz.id} (${tz.source}, UTC${actual >= 0 ? '+' : ''}${actual / 60})`);
        // Gross mismatch (e.g. a Swedish hike resolving to a US offset).
        if (Math.abs(actual - expected) > 180) {
          warnings.push(
            `timezone ${tz.id} (UTC${actual >= 0 ? '+' : ''}${actual / 60}) looks wrong for longitude ` +
              `${lng.toFixed(1)} (≈UTC${expected >= 0 ? '+' : ''}${expected / 60}) — set a \`timezone\` in frontmatter`,
          );
        }
      }
    } catch (e) {
      if (e instanceof GpxError) errors.push(`GPX: ${e.message}`);
      else errors.push(`GPX failed to parse: ${e.message}`);
    }
  }

  // --- cover ---
  if (data.cover && !fs.existsSync(path.join(dir, data.cover))) {
    errors.push(`cover not found: ${data.cover}`);
  }

  // --- photos ---
  const photosDir = path.join(dir, 'photos');
  const overridePath = path.join(photosDir, '_photos.json');
  let overrides = {};
  if (fs.existsSync(overridePath)) {
    try {
      overrides = JSON.parse(fs.readFileSync(overridePath, 'utf-8'));
    } catch (e) {
      errors.push(`_photos.json is not valid JSON: ${e.message}`);
    }
  }

  if (fs.existsSync(photosDir)) {
    const files = fs.readdirSync(photosDir).filter(isPhotoFile);
    // _photos.json keys that don't match a real file (typo guard)
    for (const key of Object.keys(overrides)) {
      if (key.startsWith('_')) continue;
      if (!files.includes(key)) warnings.push(`_photos.json references missing photo: ${key}`);
    }

    let withGps = 0;
    let withTime = 0;
    let pinned = 0;
    let unplaceable = 0;
    let fallbackOffset = 0;
    const gaps = [];

    for (const f of files) {
      const ov = overrides[f] ?? {};
      const exif = await inspectPhotoExif(path.join(photosDir, f));
      if (exif.hasGps) withGps++;
      if (exif.hasTime) withTime++;
      if (exif.offsetSource === 'fallback') fallbackOffset++;
      const manuallyPinned = ov.lat != null && ov.lng != null;
      if (manuallyPinned) pinned++;

      if (!exif.hasTime || !gpx) {
        // can't time-match; only unplaceable if also no GPS and not pinned/suppressed
        if (!exif.hasGps && !manuallyPinned && ov.place !== false) unplaceable++;
      } else {
        const m = matchPhotoToTrack(exif.epochMs, gpx);
        if (m) gaps.push(m.gapMin);
      }
    }

    notes.push(
      `photos: ${files.length} · ${withGps} GPS · ${withTime} timestamped · ${pinned} pinned`,
    );
    if (unplaceable > 0)
      warnings.push(`${unplaceable} photo(s) have no GPS/timestamp and no manual pin → unplaced`);

    // Timezone-skew heuristic: if timestamp-matched photos sit consistently far
    // from the track in time, the offset is probably wrong (SPEC §6).
    if (gaps.length > 0) {
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (median > MAX_MATCH_GAP_MINUTES) {
        warnings.push(
          `photo↔track time gap looks large (median ${Math.round(median)} min` +
            (fallbackOffset > 0 ? `, ${fallbackOffset} photo(s) using fallback offset` : '') +
            ') — check PHOTO_UTC_OFFSET_HOURS / timezone',
        );
      }
    }
  } else if (!data.cover) {
    notes.push('no photos/ folder');
  }

  return { slug, errors, warnings, notes };
}

// --- run ---
const dirs = listHikeDirs();
if (dirs.length === 0) {
  console.log(c.yellow('No hike folders found under src/content/hikes/.'));
  process.exit(0);
}

console.log(c.bold(`\nValidating ${dirs.length} hike(s)\n`));
let errorCount = 0;
let warnCount = 0;

for (const slug of dirs) {
  const { errors, warnings, notes } = await validateHike(slug);
  errorCount += errors.length;
  warnCount += warnings.length;
  const status = errors.length ? c.red('✗') : warnings.length ? c.yellow('⚠') : c.green('✓');
  console.log(`${status} ${c.bold(slug)}`);
  for (const n of notes) console.log(`    ${c.dim(n)}`);
  for (const w of warnings) console.log(`    ${c.yellow('⚠ ' + w)}`);
  for (const e of errors) console.log(`    ${c.red('✗ ' + e)}`);
  console.log();
}

const summary = `${dirs.length} hike(s), ${errorCount} error(s), ${warnCount} warning(s)`;
console.log(errorCount ? c.red(summary) : warnCount ? c.yellow(summary) : c.green(summary));
process.exit(errorCount ? 1 : 0);

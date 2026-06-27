import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import type { GpxData } from './gpx';
import { zoneOffsetMinutes } from './timezone';

// NOTE: this module deliberately has no `astro:content` dependency so the
// standalone validate script (plain Node via tsx) can reuse its EXIF logic.

// --- config -----------------------------------------------------------------

/**
 * Last-resort timezone offset (hours) for interpreting EXIF timestamps that
 * lack an explicit offset, when the hike's timezone is unknown (no zone, no
 * coords). The normal path is: embedded EXIF offset → the hike's resolved
 * timezone (shared lib/timezone.ts) → this env. A wrong value shifts every
 * timestamp-placed photo; validate surfaces large skews.
 */
const FALLBACK_UTC_OFFSET_HOURS = Number(process.env.PHOTO_UTC_OFFSET_HOURS ?? 0);

/** Largest photo↔track time gap (minutes) we still trust for placement. */
const MAX_MATCH_GAP_MIN = 90;

const SIZES = { thumb: 320, medium: 1000, full: 1800 } as const;
type SizeName = keyof typeof SIZES;
const SIZE_NAMES = Object.keys(SIZES) as SizeName[];
const QUALITY: Record<SizeName, number> = { thumb: 70, medium: 78, full: 80 };

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);
const HEIC_EXTS = new Set(['.heic', '.heif']);

// Derivatives are written under public/ so they're served in dev and copied to
// dist on build. All URL construction goes through genUrl() — the single seam
// for swapping in object storage later (SPEC §10).
const GEN_ROOT = path.resolve('public/_gen/photos');
function genUrl(slug: string, file: string): string {
  return `/_gen/photos/${slug}/${file}`;
}

// Per-hike image cache: lets us skip the (slow) HEIC decode + resize when the
// derivatives already exist and the source file is unchanged. Keyed by
// filename → { mtimeMs, width, height, blur }. Stored alongside the derivatives
// (gitignored). This is what keeps dev hot-reload fast on HEIC-heavy hikes.
interface ImageCacheEntry {
  mtimeMs: number;
  width: number;
  height: number;
  blur: string;
}
type ImageCache = Record<string, ImageCacheEntry>;

function cachePath(slug: string): string {
  return path.join(GEN_ROOT, slug, '_cache.json');
}
function readImageCache(slug: string): ImageCache {
  try {
    return JSON.parse(fs.readFileSync(cachePath(slug), 'utf-8')) as ImageCache;
  } catch {
    return {};
  }
}
function writeImageCache(slug: string, cache: ImageCache): void {
  try {
    fs.mkdirSync(path.join(GEN_ROOT, slug), { recursive: true });
    fs.writeFileSync(cachePath(slug), JSON.stringify(cache));
  } catch {
    /* cache is best-effort */
  }
}
function derivativesFresh(slug: string, base: string, srcMtimeMs: number): boolean {
  return SIZE_NAMES.every((s) => {
    const p = path.join(GEN_ROOT, slug, `${base}-${s}.webp`);
    try {
      return fs.statSync(p).mtimeMs >= srcMtimeMs;
    } catch {
      return false;
    }
  });
}
function derivativeUrls(slug: string, base: string): Record<SizeName, string> {
  return {
    thumb: genUrl(slug, `${base}-thumb.webp`),
    medium: genUrl(slug, `${base}-medium.webp`),
    full: genUrl(slug, `${base}-full.webp`),
  };
}

// --- types ------------------------------------------------------------------

export interface PhotoOverride {
  lat?: number;
  lng?: number;
  caption?: string;
  order?: number;
  place?: boolean;
}

export type PlacementSource = 'override' | 'exif-gps' | 'timestamp' | 'unplaced';

export interface ProcessedPhoto {
  filename: string;
  caption: string | null;
  order: number;
  placed: boolean;
  lat: number | null;
  lng: number | null;
  source: PlacementSource;
  width: number;
  height: number;
  blur: string; // tiny inline data-URI for blur-up
  derivatives: Record<SizeName, string>;
  /** Diagnostics for `npm run validate` (not shown in the UI). */
  diagnostics: {
    hadExifGps: boolean;
    hadExifTime: boolean;
    exifOffsetSource: 'exif' | 'fallback' | 'none';
    matchGapMinutes: number | null;
  };
}

export interface HikePhotos {
  photos: ProcessedPhoto[];
  /** Cover photo: frontmatter `cover` if set, else the first photo. */
  cover: ProcessedPhoto | null;
}

/** Minimal input so this module needn't know about astro:content entries. */
export interface HikePhotoInput {
  /** URL slug (also the derivative subfolder). */
  slug: string;
  /** Absolute path to the hike folder (containing photos/). */
  dir: string;
  /** Frontmatter `cover` value (path or filename), if any. */
  cover?: string | null;
  /** Hike's IANA timezone (shared resolver) — used to read EXIF local times. */
  timezone?: string | null;
}

export interface PhotoExif {
  hasGps: boolean;
  lat: number | null;
  lng: number | null;
  hasTime: boolean;
  epochMs: number | null;
  offsetSource: 'exif' | 'fallback' | 'none';
}

// --- helpers ----------------------------------------------------------------

export function isPhotoFile(name: string): boolean {
  return (
    !name.startsWith('.') &&
    !name.startsWith('_') &&
    PHOTO_EXTS.has(path.extname(name).toLowerCase())
  );
}

function readOverrides(photosDir: string): Record<string, PhotoOverride> {
  const file = path.join(photosDir, '_photos.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const out: Record<string, PhotoOverride> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith('_')) continue; // allow `_comment` keys
      if (v && typeof v === 'object') out[k] = v as PhotoOverride;
    }
    return out;
  } catch {
    return {}; // validate reports malformed JSON separately
  }
}

function listPhotoFiles(photosDir: string): string[] {
  if (!fs.existsSync(photosDir)) return [];
  return fs
    .readdirSync(photosDir)
    .filter((f) => !f.startsWith('.') && !f.startsWith('_'))
    .filter((f) => PHOTO_EXTS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Decode a source image to a sharp-readable buffer (converting HEIC first). */
async function decodeToBuffer(absPath: string): Promise<Buffer> {
  const ext = path.extname(absPath).toLowerCase();
  const raw = fs.readFileSync(absPath);
  if (HEIC_EXTS.has(ext)) {
    const out = await heicConvert({ buffer: raw, format: 'JPEG', quality: 0.92 });
    return Buffer.from(out);
  }
  return raw;
}

/**
 * Parse "YYYY:MM:DD HH:MM:SS" + optional "+HH:MM" offset into a UTC epoch (ms).
 * Offset priority: embedded EXIF offset → the hike's timezone (DST-correct at
 * the photo's date) → the env fallback.
 */
function exifToEpochMs(
  dt: string,
  offsetStr: string | undefined,
  zoneId?: string | null,
): { ms: number; offsetSource: 'exif' | 'fallback' } | null {
  const m = dt.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number) as unknown as number[];
  const wall = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  let offsetMin: number;
  let offsetSource: 'exif' | 'fallback';
  const om = offsetStr?.match(/^([+-])(\d{2}):(\d{2})$/);
  if (om) {
    offsetMin = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));
    offsetSource = 'exif';
  } else if (zoneId) {
    // `wall` is off the true instant by the offset, but that's fine for
    // determining the offset (DST doesn't flip within that error).
    offsetMin = zoneOffsetMinutes(wall, zoneId);
    offsetSource = 'fallback';
  } else {
    offsetMin = FALLBACK_UTC_OFFSET_HOURS * 60;
    offsetSource = 'fallback';
  }
  return { ms: wall - offsetMin * 60_000, offsetSource };
}

function nearestTrackpoint(
  tsMs: number,
  gpx: GpxData,
): { lat: number; lng: number; gapMin: number } | null {
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < gpx.times.length; i++) {
    const t = gpx.times[i];
    if (t == null) continue;
    const diff = Math.abs(t - tsMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const [lng, lat] = gpx.coordinates[bestIdx];
  return { lat, lng, gapMin: bestDiff / 60_000 };
}

async function ensureDerivative(
  input: Buffer,
  slug: string,
  base: string,
  size: SizeName,
  srcMtimeMs: number,
): Promise<string> {
  const file = `${base}-${size}.webp`;
  const outDir = path.join(GEN_ROOT, slug);
  const outPath = path.join(outDir, file);
  // Cache: skip if the derivative is newer than its source.
  if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= srcMtimeMs) {
    return genUrl(slug, file);
  }
  fs.mkdirSync(outDir, { recursive: true });
  // sharp drops all source metadata by default → GPS EXIF is stripped from the
  // public derivative (SPEC §6 privacy). Originals are untouched.
  await sharp(input)
    .rotate() // honour EXIF orientation before stripping metadata
    .resize({ width: SIZES[size], withoutEnlargement: true })
    .webp({ quality: QUALITY[size] })
    .toFile(outPath);
  return genUrl(slug, file);
}

/**
 * Read placement-relevant EXIF from a photo's original bytes (HEIC + JPEG).
 * Never throws — returns "nothing found" on any read error. Used by both the
 * build pipeline and the validate script.
 */
export async function inspectPhotoExif(absPath: string, zoneId?: string | null): Promise<PhotoExif> {
  let gps: { latitude?: number; longitude?: number } | undefined;
  let timeData: Record<string, unknown> | undefined;
  try {
    gps = await exifr.gps(fs.readFileSync(absPath));
  } catch {
    gps = undefined;
  }
  try {
    timeData = await exifr.parse(fs.readFileSync(absPath), {
      reviveValues: false,
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'CreateDate', 'OffsetTime'],
    });
  } catch {
    timeData = undefined;
  }
  const hasGps = gps?.latitude != null && gps?.longitude != null;
  const dtRaw = (timeData?.DateTimeOriginal ?? timeData?.CreateDate) as string | undefined;
  const offRaw = (timeData?.OffsetTimeOriginal ?? timeData?.OffsetTime) as string | undefined;
  const epoch = dtRaw ? exifToEpochMs(dtRaw, offRaw, zoneId) : null;
  return {
    hasGps,
    lat: hasGps ? gps!.latitude! : null,
    lng: hasGps ? gps!.longitude! : null,
    hasTime: !!epoch,
    epochMs: epoch ? epoch.ms : null,
    offsetSource: epoch ? epoch.offsetSource : 'none',
  };
}

/** Nearest-trackpoint match exposed for validate's timezone-skew check. */
export function matchPhotoToTrack(epochMs: number, gpx: GpxData) {
  return nearestTrackpoint(epochMs, gpx);
}

export const MAX_MATCH_GAP_MINUTES = MAX_MATCH_GAP_MIN;

interface PhotoImage {
  width: number;
  height: number;
  blur: string;
  derivatives: Record<SizeName, string>;
  coldDecode: boolean;
  cacheChanged: boolean;
}

/**
 * Ensure one photo's WebP derivatives + blur exist (cached by source mtime),
 * decoding the original (HEIC→JPEG when needed) only on a cold miss. Mutates
 * `cache`. Shared by the full per-hike pipeline and the cover-only path.
 */
async function ensurePhotoImage(
  slug: string,
  photosDir: string,
  filename: string,
  cache: ImageCache,
): Promise<PhotoImage> {
  const absPath = path.join(photosDir, filename);
  const srcMtimeMs = fs.statSync(absPath).mtimeMs;
  const base = path.parse(filename).name;
  let width: number;
  let height: number;
  let blur: string;
  let coldDecode = false;
  let cacheChanged = false;

  const cached = cache[filename];
  if (cached && cached.mtimeMs === srcMtimeMs && derivativesFresh(slug, base, srcMtimeMs)) {
    ({ width, height, blur } = cached);
  } else if (derivativesFresh(slug, base, srcMtimeMs)) {
    // Derivatives current but cache entry missing/stale → rebuild cheaply from
    // the existing WebP rather than re-decoding a HEIC original.
    const fullPath = path.join(GEN_ROOT, slug, `${base}-full.webp`);
    const meta = await sharp(fullPath).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    const blurBuf = await sharp(fullPath).resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
    blur = `data:image/webp;base64,${blurBuf.toString('base64')}`;
    cache[filename] = { mtimeMs: srcMtimeMs, width, height, blur };
    cacheChanged = true;
  } else {
    coldDecode = true;
    const decoded = await decodeToBuffer(absPath);
    const meta = await sharp(decoded).rotate().metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
    await Promise.all([
      ensureDerivative(decoded, slug, base, 'thumb', srcMtimeMs),
      ensureDerivative(decoded, slug, base, 'medium', srcMtimeMs),
      ensureDerivative(decoded, slug, base, 'full', srcMtimeMs),
    ]);
    const blurBuf = await sharp(decoded).rotate().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
    blur = `data:image/webp;base64,${blurBuf.toString('base64')}`;
    cache[filename] = { mtimeMs: srcMtimeMs, width, height, blur };
    cacheChanged = true;
  }
  return { width, height, blur, derivatives: derivativeUrls(slug, base), coldDecode, cacheChanged };
}

export interface HikeCover {
  thumb: string;
  medium: string;
  blur: string;
  width: number;
  height: number;
}

/**
 * Resolve and process ONLY a hike's cover photo (frontmatter `cover`, else the
 * first photo) for the index logbook thumbnails — so the index doesn't decode
 * every photo of every hike. Returns null when the hike has no photos.
 */
export async function getHikeCover(input: HikePhotoInput): Promise<HikeCover | null> {
  const photosDir = path.join(input.dir, 'photos');
  const files = listPhotoFiles(photosDir);
  if (files.length === 0) return null;
  let coverFile = files[0];
  if (input.cover) {
    const name = path.basename(input.cover);
    if (files.includes(name)) coverFile = name;
  }
  const cache = readImageCache(input.slug);
  try {
    const img = await ensurePhotoImage(input.slug, photosDir, coverFile, cache);
    if (img.cacheChanged) writeImageCache(input.slug, cache);
    return { thumb: img.derivatives.thumb, medium: img.derivatives.medium, blur: img.blur, width: img.width, height: img.height };
  } catch {
    return null;
  }
}

// --- main -------------------------------------------------------------------

/**
 * Process all photos for a hike: read EXIF (incl. HEIC), place each photo
 * (override → EXIF GPS → timestamp match → unplaced), generate responsive
 * WebP derivatives + a blur-up placeholder, and apply `_photos.json` overrides.
 * Never throws on a bad individual photo — it's skipped with diagnostics.
 */
export async function processHikePhotos(
  input: HikePhotoInput,
  gpx: GpxData | null,
): Promise<HikePhotos> {
  const { slug, dir, cover: coverField } = input;
  const photosDir = path.join(dir, 'photos');
  const overrides = readOverrides(photosDir);
  const files = listPhotoFiles(photosDir);

  const photos: ProcessedPhoto[] = [];
  const cache = readImageCache(slug);
  let cacheDirty = false;
  let coldDecodes = 0;

  for (const filename of files) {
    const absPath = path.join(photosDir, filename);
    const ov = overrides[filename] ?? {};
    try {
      // Generate/reuse derivatives + blur (decodes HEIC only on a cold miss).
      const img = await ensurePhotoImage(slug, photosDir, filename, cache);
      const { width, height, blur } = img;
      const { thumb, medium, full } = img.derivatives;
      if (img.coldDecode) coldDecodes++;
      if (img.cacheChanged) cacheDirty = true;

      // EXIF read from the ORIGINAL bytes (works for HEIC + JPEG). Cheap, so it
      // runs every time — placement can depend on _photos.json / GPX changes.
      // The hike's timezone resolves EXIF local-without-zone timestamps.
      const exif = await inspectPhotoExif(absPath, input.timezone);

      // Placement priority: override → EXIF GPS → timestamp → unplaced.
      let lat: number | null = null;
      let lng: number | null = null;
      let source: PlacementSource = 'unplaced';
      let matchGapMinutes: number | null = null;

      if (ov.place === false) {
        source = 'unplaced';
      } else if (ov.lat != null && ov.lng != null) {
        lat = ov.lat;
        lng = ov.lng;
        source = 'override';
      } else if (exif.hasGps) {
        lat = exif.lat;
        lng = exif.lng;
        source = 'exif-gps';
      } else if (exif.epochMs != null && gpx) {
        const match = nearestTrackpoint(exif.epochMs, gpx);
        if (match && match.gapMin <= MAX_MATCH_GAP_MIN) {
          lat = match.lat;
          lng = match.lng;
          source = 'timestamp';
          matchGapMinutes = Math.round(match.gapMin);
        } else if (match) {
          matchGapMinutes = Math.round(match.gapMin); // too far → leave unplaced, report gap
        }
      }

      photos.push({
        filename,
        caption: ov.caption ?? null,
        order: ov.order ?? Number.MAX_SAFE_INTEGER,
        placed: lat != null && lng != null,
        lat,
        lng,
        source,
        width,
        height,
        blur,
        derivatives: { thumb, medium, full },
        diagnostics: {
          hadExifGps: exif.hasGps,
          hadExifTime: exif.hasTime,
          exifOffsetSource: exif.offsetSource,
          matchGapMinutes,
        },
      });
    } catch {
      // Unreadable/corrupt image: skip it rather than fail the build.
      continue;
    }
  }

  if (cacheDirty) writeImageCache(slug, cache);
  if (coldDecodes > 0) {
    console.info(
      `[photos] ${slug}: generated derivatives for ${coldDecodes} photo(s) — one-time, cached afterwards.`,
    );
  }

  // Order: explicit `order` first, then filename order (stable).
  photos.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename, undefined, { numeric: true }));

  // Cover: frontmatter cover (matched by filename) else first photo.
  let cover: ProcessedPhoto | null = photos[0] ?? null;
  if (coverField) {
    const coverName = path.basename(coverField);
    cover = photos.find((p) => p.filename === coverName) ?? cover;
  }

  return { photos, cover };
}

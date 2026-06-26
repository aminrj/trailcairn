import fs from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import heicConvert from 'heic-convert';
import type { GpxData } from './gpx';
import { hikeDir, type HikeEntry } from './hikes';

// --- config -----------------------------------------------------------------

/**
 * Fallback timezone offset (hours, e.g. 2 for UTC+2) used to interpret EXIF
 * timestamps that lack an explicit offset, when matching photos to GPX time
 * (SPEC §6). Modern phone photos usually carry their own OffsetTimeOriginal,
 * which always wins over this. A wrong value shifts every timestamp-placed
 * photo — validate surfaces large skews.
 */
const FALLBACK_UTC_OFFSET_HOURS = Number(process.env.PHOTO_UTC_OFFSET_HOURS ?? 0);

/** Largest photo↔track time gap (minutes) we still trust for placement. */
const MAX_MATCH_GAP_MIN = 90;

const SIZES = { thumb: 320, medium: 1000, full: 1800 } as const;
type SizeName = keyof typeof SIZES;
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

// --- helpers ----------------------------------------------------------------

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

/** Parse "YYYY:MM:DD HH:MM:SS" + optional "+HH:MM" offset into a UTC epoch (ms). */
function exifToEpochMs(
  dt: string,
  offsetStr: string | undefined,
): { ms: number; offsetSource: 'exif' | 'fallback' } | null {
  const m = dt.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number) as unknown as number[];
  let offsetMin: number;
  let offsetSource: 'exif' | 'fallback';
  const om = offsetStr?.match(/^([+-])(\d{2}):(\d{2})$/);
  if (om) {
    offsetMin = (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3]));
    offsetSource = 'exif';
  } else {
    offsetMin = FALLBACK_UTC_OFFSET_HOURS * 60;
    offsetSource = 'fallback';
  }
  const wall = Date.UTC(Y, Mo - 1, D, H, Mi, S);
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

// --- main -------------------------------------------------------------------

/**
 * Process all photos for a hike: read EXIF (incl. HEIC), place each photo
 * (override → EXIF GPS → timestamp match → unplaced), generate responsive
 * WebP derivatives + a blur-up placeholder, and apply `_photos.json` overrides.
 * Never throws on a bad individual photo — it's skipped with diagnostics.
 */
export async function processHikePhotos(entry: HikeEntry, gpx: GpxData | null): Promise<HikePhotos> {
  const dir = hikeDir(entry);
  const photosDir = path.join(dir, 'photos');
  const overrides = readOverrides(photosDir);
  const files = listPhotoFiles(photosDir);
  const slug = entry.id;

  const photos: ProcessedPhoto[] = [];

  for (const filename of files) {
    const absPath = path.join(photosDir, filename);
    const ov = overrides[filename] ?? {};
    try {
      const srcMtimeMs = fs.statSync(absPath).mtimeMs;
      const decoded = await decodeToBuffer(absPath);
      const meta = await sharp(decoded).rotate().metadata();
      const base = path.parse(filename).name;

      const [thumb, medium, full] = await Promise.all([
        ensureDerivative(decoded, slug, base, 'thumb', srcMtimeMs),
        ensureDerivative(decoded, slug, base, 'medium', srcMtimeMs),
        ensureDerivative(decoded, slug, base, 'full', srcMtimeMs),
      ]);
      const blurBuf = await sharp(decoded).rotate().resize({ width: 16 }).webp({ quality: 40 }).toBuffer();
      const blur = `data:image/webp;base64,${blurBuf.toString('base64')}`;

      // EXIF read from the ORIGINAL bytes (works for HEIC + JPEG).
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

      const hadExifGps = gps?.latitude != null && gps?.longitude != null;
      const dtRaw = (timeData?.DateTimeOriginal ?? timeData?.CreateDate) as string | undefined;
      const offRaw = (timeData?.OffsetTimeOriginal ?? timeData?.OffsetTime) as string | undefined;
      const epoch = dtRaw ? exifToEpochMs(dtRaw, offRaw) : null;

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
      } else if (hadExifGps) {
        lat = gps!.latitude!;
        lng = gps!.longitude!;
        source = 'exif-gps';
      } else if (epoch && gpx) {
        const match = nearestTrackpoint(epoch.ms, gpx);
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
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        blur,
        derivatives: { thumb, medium, full },
        diagnostics: {
          hadExifGps,
          hadExifTime: !!epoch,
          exifOffsetSource: epoch ? epoch.offsetSource : 'none',
          matchGapMinutes,
        },
      });
    } catch {
      // Unreadable/corrupt image: skip it rather than fail the build.
      continue;
    }
  }

  // Order: explicit `order` first, then filename order (stable).
  photos.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename, undefined, { numeric: true }));

  // Cover: frontmatter cover (matched by filename) else first photo.
  let cover: ProcessedPhoto | null = photos[0] ?? null;
  if (entry.data.cover) {
    const coverName = path.basename(entry.data.cover);
    cover = photos.find((p) => p.filename === coverName) ?? cover;
  }

  return { photos, cover };
}

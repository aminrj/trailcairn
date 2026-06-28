// Single source of truth for the (working) site name and a few bits of copy.
// `trailcairn` is a working name and may change — keep it confined here plus
// package.json so a rename is a quick find-and-replace (CLAUDE.md / SPEC §0).
export const SITE_NAME = 'trailcairn';
export const SITE_TAGLINE = 'A lifetime hiking diary';
export const SITE_DESCRIPTION =
  'A personal, public ledger of hikes — each with a GPX track on a map, photos placed along it, derived stats, and a diary entry.';

// Base URL for photo derivatives in production (Cloudflare R2 custom domain).
// The single config point for photo storage (SPEC §8/§10): production builds
// serve `${PHOTO_BASE_URL}/<hike-slug>/<derivative-filename>`. Local dev serves
// from the on-disk `public/_gen/` instead (see src/lib/photos.ts). Override via
// the PHOTO_BASE_URL env var. Trailing slash is trimmed.
export const PHOTO_BASE_URL = (process.env.PHOTO_BASE_URL ?? 'https://photos.aminrj.com').replace(/\/+$/, '');

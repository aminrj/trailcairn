import tzlookup from 'tz-lookup';

// Single source of truth for the "GPX is UTC, photos/EXIF are local" timezone
// problem (SPEC §6/§2.1). A hike's timezone is resolved once — from the track's
// start coordinates (automatic, correct abroad), with a frontmatter override
// and a final default — and reused by both the per-hike time stats (display
// UTC→local) and photo placement (interpret EXIF local→UTC). DST is handled
// correctly because we resolve via the IANA zone with Intl, per-instant.

/** Ultimate fallback when coords don't resolve and no frontmatter zone is set. */
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE ?? 'UTC';

export interface ResolvedTimeZone {
  /** IANA zone id, e.g. "Europe/Stockholm". */
  id: string;
  /** How it was resolved (for validate / transparency). */
  source: 'frontmatter' | 'coords' | 'default';
}

export function resolveHikeTimeZone(opts: {
  lat?: number | null;
  lng?: number | null;
  frontmatterTz?: string | null;
}): ResolvedTimeZone {
  if (opts.frontmatterTz) return { id: opts.frontmatterTz, source: 'frontmatter' };
  if (opts.lat != null && opts.lng != null) {
    try {
      const id = tzlookup(opts.lat, opts.lng);
      if (id) return { id, source: 'coords' };
    } catch {
      /* out-of-range coords → fall through */
    }
  }
  return { id: DEFAULT_TIMEZONE, source: 'default' };
}

/** True if an IANA zone id is usable by Intl (validate guard). */
export function isValidTimeZone(id: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

/** Format a UTC instant as 24h local clock time "HH:MM" in the given zone. */
export function formatClock(epochMs: number, zoneId: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zoneId,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

/**
 * The zone's UTC offset (minutes) at a given instant — DST-correct. Used to
 * interpret EXIF local-without-zone timestamps as UTC for photo placement.
 */
export function zoneOffsetMinutes(epochMs: number, zoneId: string): number {
  const d = new Date(epochMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zoneId,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUTC - d.getTime()) / 60000);
}

/** Rough expected offset (minutes) from longitude — a sanity bound for validate. */
export function roughOffsetMinutesFromLng(lng: number): number {
  return Math.round(lng / 15) * 60;
}

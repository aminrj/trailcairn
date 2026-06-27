import fs from 'node:fs';
import path from 'node:path';
import type { Feature, LineString } from 'geojson';
import { getCollection, type CollectionEntry } from 'astro:content';
import { GpxError, parseGpx, type GpxData, type HikeStats } from './gpx';
import { aggregateLifetime, type LifetimeStats, type HikeStatLine } from './stats';

export type HikeEntry = CollectionEntry<'hikes'>;

/** Absolute path to the folder containing a hike's index.md (and track.gpx, photos/). */
export function hikeDir(entry: HikeEntry): string {
  if (!entry.filePath) throw new Error(`Hike "${entry.id}" has no source filePath.`);
  return path.dirname(path.resolve(entry.filePath));
}

export function trackPath(entry: HikeEntry): string {
  return path.join(hikeDir(entry), entry.data.track);
}

/** Parse this hike's GPX (build-time). Throws GpxError if the track is unusable. */
export function loadGpx(entry: HikeEntry): GpxData {
  return parseGpx(fs.readFileSync(trackPath(entry), 'utf-8'));
}

export interface ResolvedStats {
  distance_km: number | null;
  ascent_m: number | null;
  descent_m: number | null;
  duration: string | null;
}

/** Frontmatter values override derived ones (SPEC §2.1). */
export function resolveStats(entry: HikeEntry, derived: HikeStats): ResolvedStats {
  return {
    distance_km: entry.data.distance_km ?? derived.distance_km,
    ascent_m: entry.data.ascent_m ?? derived.ascent_m,
    descent_m: entry.data.descent_m ?? derived.descent_m,
    duration: entry.data.duration ?? derived.duration,
  };
}

/**
 * Hikes visible in the current build: drafts are included in dev only and
 * excluded from production (SPEC §2.1). Sorted reverse-chronological.
 */
export async function getVisibleHikes(): Promise<HikeEntry[]> {
  return (await getCollection('hikes'))
    .filter((h) => import.meta.env.DEV || h.data.status !== 'draft')
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export interface IndexMapHike {
  slug: string;
  title: string;
  date: string;
  distance_km: number | null;
  ascent_m: number | null;
  duration: string | null;
  cover: string | null;
  /** Track coordinates for the route-line motif on the index card (subsampled). */
  coords: [number, number][];
}

export interface IndexMapData {
  lines: Feature<LineString>[];
  starts: ([number, number] | null)[];
  hikes: IndexMapHike[];
  bounds: [[number, number], [number, number]] | null;
  lifetime: LifetimeStats;
}

/**
 * Build the single-source payload for the lifetime index map (SPEC §3/§7):
 * every visible hike's track line + start pin, index-aligned, with combined
 * bounds. Hikes whose GPX can't be parsed are skipped on the map (still listed
 * in the logbook); other errors propagate so the build fails loudly.
 */
export async function getIndexMapData(): Promise<IndexMapData> {
  const hikes = await getVisibleHikes();
  const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

  const lines: Feature<LineString>[] = [];
  const starts: ([number, number] | null)[] = [];
  const meta: IndexMapHike[] = [];
  const statLines: HikeStatLine[] = [];
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const hike of hikes) {
    let gpx: GpxData | null = null;
    try {
      gpx = loadGpx(hike);
    } catch (err) {
      if (!(err instanceof GpxError)) throw err; // unusable track → omit from map, still counted
    }

    // Lifetime totals count every visible hike (derived or overridden stats).
    statLines.push({
      distance_km: hike.data.distance_km ?? gpx?.stats.distance_km ?? null,
      ascent_m: hike.data.ascent_m ?? gpx?.stats.ascent_m ?? null,
      date: hike.data.date,
    });

    if (!gpx) continue; // no track → not on the map

    lines.push(gpx.line);
    starts.push(hike.data.hidePrecisePins ? null : gpx.start);
    meta.push({
      slug: hike.id,
      title: hike.data.title,
      date: dateFmt.format(hike.data.date),
      distance_km: hike.data.distance_km ?? gpx.stats.distance_km,
      ascent_m: hike.data.ascent_m ?? gpx.stats.ascent_m,
      duration: hike.data.duration ?? gpx.stats.duration,
      cover: hike.data.cover ?? null,
      coords: gpx.coordinates,
    });
    const [[bMinLon, bMinLat], [bMaxLon, bMaxLat]] = gpx.bounds;
    minLon = Math.min(minLon, bMinLon);
    minLat = Math.min(minLat, bMinLat);
    maxLon = Math.max(maxLon, bMaxLon);
    maxLat = Math.max(maxLat, bMaxLat);
  }

  const bounds: IndexMapData['bounds'] =
    lines.length > 0
      ? [
          [minLon, minLat],
          [maxLon, maxLat],
        ]
      : null;

  return { lines, starts, hikes: meta, bounds, lifetime: aggregateLifetime(statLines) };
}

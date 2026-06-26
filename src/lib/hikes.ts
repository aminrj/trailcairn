import fs from 'node:fs';
import path from 'node:path';
import { getCollection, type CollectionEntry } from 'astro:content';
import { parseGpx, type GpxData, type HikeStats } from './gpx';

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

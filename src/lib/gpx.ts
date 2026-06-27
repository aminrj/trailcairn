import { DOMParser } from '@xmldom/xmldom';
import { gpx as gpxToGeoJSON } from '@tmcw/togeojson';
import type { Feature, LineString, Position } from 'geojson';

export interface HikeStats {
  /** Total horizontal distance, km, 1 decimal. */
  distance_km: number;
  /** Total positive elevation gain, m, integer (lightly smoothed). */
  ascent_m: number;
  /** Total elevation loss, m, integer (lightly smoothed). */
  descent_m: number;
  /** Human duration, e.g. "6h 20m". null when the GPX has no timestamps. */
  duration: string | null;
  /** Duration in seconds (for aggregation). null when no timestamps. */
  durationSeconds: number | null;
  /** Number of trackpoints used. */
  points: number;
  /** ISO timestamps of first/last point, when present. */
  startTime: string | null;
  endTime: string | null;
}

export interface GpxData {
  /** Single merged LineString feature, [lon, lat] pairs — ready to drop into a GeoJSON source. */
  line: Feature<LineString>;
  /** [lon, lat] pairs for every trackpoint (for photo timestamp matching). */
  coordinates: [number, number][];
  /** Epoch ms per trackpoint, aligned to `coordinates`; null where no timestamp. */
  times: (number | null)[];
  /** [lon, lat] of the first trackpoint (the start pin). */
  start: [number, number];
  /** [[minLon, minLat], [maxLon, maxLat]] bounds. */
  bounds: [[number, number], [number, number]];
  /** Smoothed elevations aligned to the line coordinates (for the profile chart). */
  elevations: number[];
  /** Cumulative distance (km) at each point, aligned to coordinates (for the profile x-axis). */
  cumulativeKm: number[];
  stats: HikeStats;
}

const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(a: Position, b: Position): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const lat1r = toRad(lat1);
  const lat2r = toRad(lat2);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1r) * Math.cos(lat2r) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Light moving-average smoothing so GPS elevation noise doesn't inflate ascent
 * (SPEC §2.1 derivation rule). Window is small and odd.
 */
function smooth(values: number[], window = 5): number[] {
  if (values.length === 0) return values;
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < values.length) {
        sum += values[j];
        n++;
      }
    }
    return sum / n;
  });
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Flatten Line/MultiLineString geometries (multiple segments) into one path + parallel times. */
function flatten(feature: Feature): { coords: Position[]; times: (string | null)[] } {
  const coords: Position[] = [];
  const times: (string | null)[] = [];
  const geom = feature.geometry;
  // togeojson (v5+) stores per-point times in
  // properties.coordinateProperties.times (string[] for a LineString,
  // string[][] for a MultiLineString). Older exports used properties.coordTimes
  // — fall back to that for robustness.
  const props = feature.properties ?? {};
  const coordTimes = (props.coordinateProperties?.times ?? props.coordTimes ?? null) as
    | string[]
    | string[][]
    | null;

  if (geom.type === 'LineString') {
    geom.coordinates.forEach((c, i) => {
      coords.push(c);
      times.push((coordTimes as string[] | null)?.[i] ?? null);
    });
  } else if (geom.type === 'MultiLineString') {
    geom.coordinates.forEach((seg, si) => {
      seg.forEach((c, i) => {
        coords.push(c);
        const segTimes = (coordTimes as string[][] | null)?.[si];
        times.push(segTimes?.[i] ?? null);
      });
    });
  }
  return { coords, times };
}

/**
 * Normalised playback timeline in [0,1] per trackpoint, for the replay player.
 * Uses real per-point timestamps where present (so playback respects pauses);
 * falls back to even spacing when a track has no usable times. Always
 * monotonic non-decreasing. Aligned to `coordinates`.
 */
export function normalizedTimeline(data: GpxData): number[] {
  const { times, coordinates } = data;
  const n = coordinates.length;
  if (n <= 1) return n === 1 ? [0] : [];

  const firstT = times.find((t) => t != null) ?? null;
  const lastT = [...times].reverse().find((t) => t != null) ?? null;
  // No usable time span → even spacing by index.
  if (firstT == null || lastT == null || lastT <= firstT) {
    return coordinates.map((_, i) => i / (n - 1));
  }

  const span = lastT - firstT;
  const f: (number | null)[] = times.map((t) => (t != null ? (t - firstT) / span : null));
  if (f[0] == null) f[0] = 0;
  // Linearly interpolate any interior null fractions by index, keeping monotonic.
  let lastKnown = 0;
  for (let i = 1; i < n; i++) {
    if (f[i] != null) {
      const a = f[lastKnown]!;
      const b = f[i]!;
      for (let j = lastKnown + 1; j < i; j++) f[j] = a + ((b - a) * (j - lastKnown)) / (i - lastKnown);
      lastKnown = i;
    }
  }
  if (f[n - 1] == null) {
    const a = f[lastKnown]!;
    for (let j = lastKnown + 1; j < n; j++) f[j] = a + ((1 - a) * (j - lastKnown)) / (n - 1 - lastKnown);
  }
  return f.map((v) => Math.max(0, Math.min(1, v as number)));
}

export class GpxError extends Error {}

/**
 * Parse a GPX document string into render-ready GeoJSON plus derived stats.
 * Throws GpxError when there is no usable track (so validate/build can report it).
 */
export function parseGpx(xml: string): GpxData {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  // togeojson types expect a browser Document; xmldom's is compatible at runtime.
  const fc = gpxToGeoJSON(doc as unknown as Document);

  // Prefer the first track/route feature that has a line geometry.
  const lineFeature = fc.features.find(
    (f) => f.geometry?.type === 'LineString' || f.geometry?.type === 'MultiLineString',
  );
  if (!lineFeature) throw new GpxError('No track (LineString) found in GPX.');

  const { coords, times } = flatten(lineFeature);
  if (coords.length < 2) throw new GpxError('GPX track has fewer than 2 points.');

  // 2D coordinates for rendering/bounds.
  const coords2d: [number, number][] = coords.map(([lon, lat]) => [lon, lat]);

  // Bounds.
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of coords2d) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }

  // Distance + cumulative profile.
  let distanceM = 0;
  const cumulativeKm: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    distanceM += haversineMeters(coords[i - 1], coords[i]);
    cumulativeKm.push(distanceM / 1000);
  }

  // Elevation: smoothed, then thresholded accumulation to reject noise.
  const rawEle = coords.map((c) => (typeof c[2] === 'number' ? c[2] : 0));
  const hasElevation = coords.some((c) => typeof c[2] === 'number');
  const elevations = hasElevation ? smooth(rawEle) : rawEle;
  let ascent = 0;
  let descent = 0;
  const NOISE_THRESHOLD_M = 1; // ignore sub-metre wiggle after smoothing
  if (hasElevation) {
    for (let i = 1; i < elevations.length; i++) {
      const delta = elevations[i] - elevations[i - 1];
      if (delta > NOISE_THRESHOLD_M) ascent += delta;
      else if (delta < -NOISE_THRESHOLD_M) descent += -delta;
    }
  }

  // Duration from first/last timestamps.
  const firstTime = times.find((t) => t) ?? null;
  const lastTime = [...times].reverse().find((t) => t) ?? null;
  let durationSeconds: number | null = null;
  if (firstTime && lastTime) {
    const secs = (new Date(lastTime).getTime() - new Date(firstTime).getTime()) / 1000;
    if (Number.isFinite(secs) && secs > 0) durationSeconds = secs;
  }

  const line: Feature<LineString> = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: coords2d },
  };

  const timesMs = times.map((t) => (t ? new Date(t).getTime() : null));

  return {
    line,
    coordinates: coords2d,
    times: timesMs,
    start: coords2d[0],
    bounds: [
      [minLon, minLat],
      [maxLon, maxLat],
    ],
    elevations,
    cumulativeKm,
    stats: {
      distance_km: Math.round((distanceM / 1000) * 10) / 10,
      ascent_m: Math.round(ascent),
      descent_m: Math.round(descent),
      duration: durationSeconds != null ? formatDuration(durationSeconds) : null,
      durationSeconds,
      points: coords.length,
      startTime: firstTime,
      endTime: lastTime,
    },
  };
}

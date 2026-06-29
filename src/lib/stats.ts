// Lifetime summary aggregation (SPEC §5), computed at build time across the
// visible hikes. ~5 numbers for the index band.

export interface HikeStatLine {
  distance_km: number | null;
  ascent_m: number | null;
  date: Date;
}

export interface LifetimeStats {
  totalDistanceKm: number;
  totalAscentM: number;
  hikeCount: number;
  distinctDays: number;
  firstDate: Date | null;
  lastDate: Date | null;
}

/** Local-timezone time-of-day stats for the per-hike band (SPEC §5). */
export interface TimeStats {
  startClock: string; // local "HH:MM"
  endClock: string; // local "HH:MM"
  movingSeconds: number;
  /** Wall-clock elapsed seconds (end − start, includes overnight stops). */
  wallClockSeconds: number;
  paceSecPerKm: number | null;
  tzId: string; // resolved IANA zone (for the title/tooltip)
  /** Calendar days spanned (1 = day hike, 2 = one night out, …). */
  days: number;
  /** Number of overnight stops detected (gaps > 4 h between trackpoints). */
  nights: number;
}

export function aggregateLifetime(lines: HikeStatLine[]): LifetimeStats {
  let totalDistanceKm = 0;
  let totalAscentM = 0;
  const days = new Set<string>();
  let firstDate: Date | null = null;
  let lastDate: Date | null = null;

  for (const l of lines) {
    if (l.distance_km != null) totalDistanceKm += l.distance_km;
    if (l.ascent_m != null) totalAscentM += l.ascent_m;
    days.add(l.date.toISOString().slice(0, 10));
    if (!firstDate || l.date < firstDate) firstDate = l.date;
    if (!lastDate || l.date > lastDate) lastDate = l.date;
  }

  return {
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    totalAscentM: Math.round(totalAscentM),
    hikeCount: lines.length,
    distinctDays: days.size,
    firstDate,
    lastDate,
  };
}

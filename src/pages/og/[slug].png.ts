import type { APIRoute } from 'astro';
import { getVisibleHikes, loadGpx, resolveStats, type HikeEntry } from '../../lib/hikes';
import { renderHikeOg } from '../../lib/og';
import { GpxError } from '../../lib/gpx';

// Static per-hike OG cards: /og/<slug>.png, emitted at build time.
export async function getStaticPaths() {
  const hikes = await getVisibleHikes();
  return hikes.map((hike) => ({ params: { slug: hike.id }, props: { hike } }));
}

const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'long' });

export const GET: APIRoute = async ({ props }) => {
  const hike = (props as { hike: HikeEntry }).hike;

  let lines: [number, number][][] = [];
  let distance = hike.data.distance_km ?? null;
  let ascent = hike.data.ascent_m ?? null;
  let duration = hike.data.duration ?? null;
  try {
    const gpx = loadGpx(hike);
    lines = [gpx.coordinates];
    const s = resolveStats(hike, gpx.stats);
    distance = s.distance_km;
    ascent = s.ascent_m;
    duration = s.duration;
  } catch (err) {
    if (!(err instanceof GpxError)) throw err;
  }

  const parts = [
    distance != null ? `${distance} km` : null,
    ascent != null ? `${ascent} m↑` : null,
    duration ?? null,
  ].filter(Boolean) as string[];

  const location = hike.data.location.replace(/\s*—\s*TODO.*$/i, '').slice(0, 46);

  const png = renderHikeOg({
    title: hike.data.title,
    date: dateFmt.format(hike.data.date),
    location,
    statsLine: parts.join('  ·  '),
    lines,
  });

  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
};

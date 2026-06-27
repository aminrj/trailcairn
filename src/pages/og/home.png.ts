import type { APIRoute } from 'astro';
import { getIndexMapData } from '../../lib/hikes';
import { renderHomeOg } from '../../lib/og';
import { SITE_NAME, SITE_TAGLINE } from '../../consts';

// Static home OG card: /og/home.png, emitted at build time.
export const GET: APIRoute = async () => {
  const data = await getIndexMapData();
  const lines = data.lines.map((l) => l.geometry.coordinates as [number, number][]);
  const lt = data.lifetime;
  const parts = [
    `${lt.hikeCount} ${lt.hikeCount === 1 ? 'hike' : 'hikes'}`,
    `${lt.totalDistanceKm} km`,
    `${lt.totalAscentM} m↑`,
  ];

  const png = renderHomeOg({
    title: SITE_NAME,
    tagline: SITE_TAGLINE,
    statsLine: parts.join('  ·  '),
    lines,
  });

  return new Response(new Uint8Array(png), {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
};

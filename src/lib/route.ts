// Route-line "signature": project a GPX trace (or several) into a normalized
// SVG path that fits a small box, preserving shape. This is the site's visual
// identity motif — reused by the OG cards, the index hike cards and the hero.

export interface RouteMotif {
  /** One SVG path `d` string per input line, sharing one projection. */
  paths: string[];
  width: number;
  height: number;
}

/**
 * @param lines  one or more tracks, each an array of [lng, lat]
 * @param opts.width/height  target box (paths are fit inside, aspect preserved, centered)
 * @param opts.padding  inner padding so strokes don't clip
 * @param opts.maxPoints  cap points per line (subsampled) to keep the SVG small
 */
export function routeMotif(
  lines: [number, number][][],
  opts: { width?: number; height?: number; padding?: number; maxPoints?: number } = {},
): RouteMotif {
  const width = opts.width ?? 120;
  const height = opts.height ?? 80;
  const pad = opts.padding ?? 6;
  const maxPoints = opts.maxPoints ?? 400;

  const all = lines.flat();
  if (all.length < 2) return { paths: [], width, height };

  // Equirectangular projection with latitude correction so shapes aren't
  // horizontally stretched at high latitudes; y inverted so north is up.
  const meanLat = (all.reduce((s, [, la]) => s + la, 0) / all.length) * (Math.PI / 180);
  const cos = Math.cos(meanLat);
  const proj = ([lng, lat]: [number, number]): [number, number] => [lng * cos, -lat];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of all) {
    const [x, y] = proj(p);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const bw = maxX - minX || 1e-6;
  const bh = maxY - minY || 1e-6;
  const availW = width - pad * 2;
  const availH = height - pad * 2;
  const scale = Math.min(availW / bw, availH / bh);
  const offX = pad + (availW - bw * scale) / 2;
  const offY = pad + (availH - bh * scale) / 2;
  const tx = (x: number) => offX + (x - minX) * scale;
  const ty = (y: number) => offY + (y - minY) * scale;

  const paths = lines.map((line) => {
    if (line.length < 2) return '';
    const step = Math.max(1, Math.ceil(line.length / maxPoints));
    let d = '';
    for (let i = 0; i < line.length; i += step) {
      const [x, y] = proj(line[i]);
      d += `${i === 0 ? 'M' : 'L'}${tx(x).toFixed(1)},${ty(y).toFixed(1)}`;
    }
    // ensure the final point is included
    const [lx, ly] = proj(line[line.length - 1]);
    d += `L${tx(lx).toFixed(1)},${ty(ly).toFixed(1)}`;
    return d;
  });

  return { paths, width, height };
}

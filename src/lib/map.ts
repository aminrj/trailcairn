// Single config point for the basemap (SPEC §1/§7). Read at build time from
// MAP_STYLE_URL so a self-hosted vector style can be swapped in without code
// changes. Falls back to the free MapLibre demo style (no API key needed).
export const MAP_STYLE_URL =
  process.env.MAP_STYLE_URL ?? 'https://demotiles.maplibre.org/style.json';

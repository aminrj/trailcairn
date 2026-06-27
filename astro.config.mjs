// @ts-check
import { defineConfig } from 'astro/config';

// v1 is a pure static site (SPEC §0/§1): no adapter, no SSR.
// Map style URL is read from the MAP_STYLE_URL env var at the point of use
// (slice 2+), keeping the basemap a single config value (SPEC §1/§7).
export default defineConfig({
  // Production URL — used for absolute OG/canonical URLs. Change if the domain differs.
  site: 'https://hikes.aminrj.com',
  build: {
    format: 'directory',
  },
});

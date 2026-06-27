import type { StyleSpecification } from 'maplibre-gl';

// Basemap styles for MapLibre. Each is either a style-URL string or an inline
// MapLibre style object (for keyless raster providers). This is the single
// place to add/remove basemaps — components read from BASEMAPS and don't
// hardcode any provider (SPEC §1/§7).

const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function rasterStyle(opts: {
  tiles: string[];
  attribution: string;
  maxzoom?: number;
  tileSize?: number;
}): StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: opts.tiles,
        tileSize: opts.tileSize ?? 256,
        maxzoom: opts.maxzoom ?? 19,
        attribution: opts.attribution,
      },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

// Outdoor/topographic: hillshading, contours and OSM hiking trails. Keyless.
const TOPO_STYLE = rasterStyle({
  tiles: [
    'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
    'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
  ],
  attribution: `Map data: ${OSM}, SRTM | Map style: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
  maxzoom: 17,
});

// Satellite imagery. Keyless (Esri public service).
const SATELLITE_STYLE = rasterStyle({
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  attribution:
    'Imagery © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
  maxzoom: 19,
});

// Pale, clean vector style — used as the index/overview default so the hike
// pins are the visual subject. Keyless; ships glyphs (so map labels render).
const PALE_STYLE = 'https://tiles.openfreemap.org/styles/positron';

export interface Basemap {
  id: string;
  label: string;
  /** A style-URL string or an inline MapLibre style object. */
  style: string | StyleSpecification;
  /** Disabled basemaps (e.g. needing a key) are wired but hidden by default. */
  enabled?: boolean;
}

// MAP_STYLE_URL overrides the default (topo) basemap's style, keeping the
// single env config point from SPEC §1/§7 (e.g. swap in a self-hosted style).
const TOPO_OVERRIDE = process.env.MAP_STYLE_URL;

export const BASEMAPS: Basemap[] = [
  { id: 'topo', label: 'Topo', style: TOPO_OVERRIDE ?? TOPO_STYLE, enabled: true },
  { id: 'pale', label: 'Pale', style: PALE_STYLE, enabled: true },
  { id: 'satellite', label: 'Satellite', style: SATELLITE_STYLE, enabled: true },
];

export const ENABLED_BASEMAPS = BASEMAPS.filter((b) => b.enabled !== false);

/** Default basemap on per-hike maps (rich topo). */
export const DEFAULT_BASEMAP_ID = 'topo';
/** Default basemap on the index/overview map (pale, so pins pop). */
export const OVERVIEW_BASEMAP_ID = 'pale';
export const DEFAULT_BASEMAP_STYLE = ENABLED_BASEMAPS[0]?.style;

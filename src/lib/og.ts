import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { routeMotif } from './route';

// Build-time Open Graph card generation (SPEC §3). Each card is hand-built as
// SVG (full control + the route-line motif as the visual signature) and
// rendered to PNG by resvg with the brand fonts. Fully static — emitted by the
// /og/*.png endpoints at build, no runtime/SSR.

const FONT_DIR = path.resolve('src/assets/fonts');
const fontFiles = [
  'Fraunces-Regular.ttf',
  'Fraunces-SemiBold.ttf',
  'JetBrainsMono-Regular.ttf',
  'JetBrainsMono-Bold.ttf',
].map((f) => path.join(FONT_DIR, f));

const W = 1200;
const H = 630;
const PAPER = '#faf8f4';
const INK = '#1a1a17';
const INK_SOFT = '#5b5b54';
const ACCENT = '#3f6b4d';
const LINE = '#e4e0d8';

const SERIF = 'Fraunces';
const MONO = 'JetBrains Mono';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Naive word-wrap to at most `maxLines` lines of ~`maxChars`, ellipsising overflow. */
function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    // mark truncation if there was more text than fit
    const used = lines.join(' ').length;
    if (used < text.length - 1) lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,]?$/, '') + '…';
  }
  return lines;
}

function toPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    background: PAPER,
    font: { fontFiles, loadSystemFonts: false, defaultFontFamily: SERIF },
  });
  return resvg.render().asPng();
}

/** Wrap the motif paths in a translated group, with a start dot. */
function motifSvg(
  lines: [number, number][][],
  box: { x: number; y: number; w: number; h: number },
  opts: {
    stroke?: string;
    strokeWidth?: number;
    opacity?: number;
    startDot?: boolean; // dot at the first line's start (single track)
    allDots?: number; // radius of a dot at every line's start (constellation)
  } = {},
): string {
  const m = routeMotif(lines, { width: box.w, height: box.h, padding: 30, maxPoints: 300 });
  if (m.paths.length === 0) return '';
  const stroke = opts.stroke ?? ACCENT;
  const sw = opts.strokeWidth ?? 6;
  const paths = m.paths
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round" opacity="${opts.opacity ?? 1}"/>`,
    )
    .join('');
  const dotAt = (d: string, r: number) => {
    const mm = d.match(/^M([\d.]+),([\d.]+)/);
    return mm ? `<circle cx="${mm[1]}" cy="${mm[2]}" r="${r}" fill="${stroke}" stroke="${PAPER}" stroke-width="3"/>` : '';
  };
  let dots = '';
  if (opts.allDots) dots = m.paths.map((d) => dotAt(d, opts.allDots!)).join('');
  else if (opts.startDot) dots = dotAt(m.paths[0], sw + 3);
  return `<g transform="translate(${box.x},${box.y})">${paths}${dots}</g>`;
}

const frame = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${PAPER}"/>
  <rect x="0" y="${H - 10}" width="${W}" height="10" fill="${ACCENT}"/>
  <text x="80" y="92" font-family="${MONO}" font-size="26" letter-spacing="1" fill="${ACCENT}">trailcairn</text>
  ${inner}
</svg>`;

export interface HikeOg {
  title: string;
  date: string;
  location: string;
  statsLine: string; // "13 km · 192 m↑ · 3:36"
  lines: [number, number][][];
}

export function renderHikeOg(d: HikeOg): Buffer {
  const titleLines = wrap(d.title, 16, 2);
  const titleStartY = titleLines.length > 1 ? 230 : 270;
  const titleSvg = titleLines
    .map(
      (ln, i) =>
        `<text x="80" y="${titleStartY + i * 92}" font-family="${SERIF}" font-weight="600" font-size="84" fill="${INK}">${esc(ln)}</text>`,
    )
    .join('');
  const motif =
    motifSvg(d.lines, { x: 690, y: 150, w: 440, h: 360 }, { stroke: ACCENT, strokeWidth: 7, startDot: true }) ||
    '';
  return toPng(
    frame(`
      ${motif}
      ${titleSvg}
      <text x="80" y="430" font-family="${MONO}" font-weight="700" font-size="34" fill="${INK}">${esc(d.statsLine)}</text>
      <text x="80" y="486" font-family="${MONO}" font-size="27" fill="${INK_SOFT}">${esc(d.date)}</text>
      <text x="80" y="524" font-family="${MONO}" font-size="27" fill="${INK_SOFT}">${esc(d.location)}</text>
    `),
  );
}

export interface HomeOg {
  title: string;
  tagline: string;
  statsLine: string; // "4 hikes · 45.6 km · 734 m↑"
  lines: [number, number][][];
}

export function renderHomeOg(d: HomeOg): Buffer {
  // A "places I've wandered" constellation: faint traces + a dot per hike, so
  // it reads even when hikes are far apart (and fills in as more are added).
  const constellation =
    motifSvg(d.lines, { x: 560, y: 90, w: 580, h: 450 }, { stroke: ACCENT, strokeWidth: 4, opacity: 0.6, allDots: 9 }) ||
    '';
  return toPng(
    frame(`
      ${constellation}
      <text x="80" y="300" font-family="${SERIF}" font-weight="600" font-size="120" fill="${INK}">${esc(d.title)}</text>
      <text x="84" y="356" font-family="${MONO}" font-size="28" fill="${INK_SOFT}">${esc(d.tagline)}</text>
      <text x="84" y="470" font-family="${MONO}" font-weight="700" font-size="36" fill="${ACCENT}">${esc(d.statsLine)}</text>
    `),
  );
}

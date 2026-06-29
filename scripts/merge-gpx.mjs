#!/usr/bin/env node
// Merge multiple GPX files (one per day) into a single GPX with one <trk>
// containing one <trkseg> per input file, preserving all timestamps and
// elevation data. The site's gpx.ts parser handles MultiLineString natively
// so the merged file works without any other changes.
//
// Usage:
//   node scripts/merge-gpx.mjs day1.gpx day2.gpx day3.gpx --out track.gpx
//
// Or via npm (after adding to package.json scripts):
//   npm run merge-gpx -- day1.gpx day2.gpx --out track.gpx
//
// The --out file is written relative to cwd. Input files are also relative
// to cwd. Files are merged IN THE ORDER given — pass them chronologically.

import fs from 'node:fs';
import path from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: merge-gpx.mjs <file1.gpx> [file2.gpx ...] --out <output.gpx>');
  process.exit(1);
}

const outIdx = args.indexOf('--out');
if (outIdx === -1 || outIdx === args.length - 1) {
  console.error('Error: --out <filename> is required.');
  process.exit(1);
}

const outFile = args[outIdx + 1];
const inputFiles = args.filter((_, i) => i !== outIdx && i !== outIdx + 1);

if (inputFiles.length === 0) {
  console.error('Error: at least one input GPX file is required.');
  process.exit(1);
}

// Parse all input files and extract their <trkseg> elements.
const parser = new DOMParser();
const allSegments = [];
let firstName = null;
let firstTime = null;

for (const file of inputFiles) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }
  const xml = fs.readFileSync(abs, 'utf-8');
  const doc = parser.parseFromString(xml, 'text/xml');

  // Grab the track name from the first file.
  if (!firstName) {
    const nameEl = doc.getElementsByTagName('name')[0];
    firstName = nameEl?.textContent?.trim() ?? 'Merged Track';
  }

  // Grab the metadata time from the first file.
  if (!firstTime) {
    const metaTime = doc.getElementsByTagName('metadata')[0]
      ?.getElementsByTagName('time')[0]?.textContent?.trim();
    firstTime = metaTime ?? null;
  }

  // Extract all <trkseg> elements from all <trk> blocks.
  const segs = doc.getElementsByTagName('trkseg');
  let count = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const pts = seg.getElementsByTagName('trkpt').length;
    if (pts > 0) {
      allSegments.push({ xml: new XMLSerializer().serializeToString(seg), file, pts });
      count += pts;
    }
  }
  console.log(`  ${path.basename(file)}: ${segs.length} segment(s), ${count} trackpoints`);
}

if (allSegments.length === 0) {
  console.error('No trackpoints found in any input file.');
  process.exit(1);
}

// Build the merged GPX.
const now = firstTime ?? new Date().toISOString();
const merged = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="trailcairn-merge-gpx" version="1.1"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/11.xsd"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:ns2="http://www.garmin.com/xmlschemas/GpxExtensions/v3"
  xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
  <metadata>
    <time>${now}</time>
  </metadata>
  <trk>
    <name>${firstName}</name>
    <type>hiking</type>
${allSegments.map(s => '    ' + s.xml.replace(/\n/g, '\n    ')).join('\n')}
  </trk>
</gpx>
`;

const outAbs = path.resolve(outFile);
fs.writeFileSync(outAbs, merged, 'utf-8');

const totalPts = allSegments.reduce((n, s) => n + s.pts, 0);
console.log(`\nMerged ${inputFiles.length} file(s) · ${allSegments.length} segment(s) · ${totalPts} trackpoints`);
console.log(`Written to: ${outAbs}`);

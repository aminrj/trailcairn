---
# Copy this whole folder to src/content/hikes/<your-slug>/ and edit.
# The folder name becomes the URL slug, e.g. 2026-06-fulufjallet.
# This _TEMPLATE folder is intentionally NOT rendered by the site.

# --- required ---
title: "Hike title"                       # string
date: 2026-01-01                          # YYYY-MM-DD, the start date of the hike
location: "Range / area, Country"         # human-readable
summary: "One or two sentences for cards and lists."
track: "track.gpx"                        # GPX filename in this folder

# --- optional ---
# cover: "photos/IMG_0001.jpg"            # else the first photo is used
# tags: ["wild camp", "2-day"]
status: "published"                       # draft | published (default: published)

# Stats are DERIVED from the GPX at build time. Only set these to OVERRIDE a
# derived value (e.g. the GPX is missing elevation or the watch paused weirdly).
# distance_km: 18.4
# ascent_m: 720
# descent_m: 690
# duration: "6h 20m"

# hidePrecisePins: true                   # fuzz/omit the start-point pin for privacy
---

Write your diary entry here as plain Markdown. Free-form.

Drop the GPX export next to this file as `track.gpx`, and put photos in a
`photos/` subfolder. Photos are placed on the map automatically (by EXIF GPS,
then by matching the photo's timestamp to the track). To fix or annotate a
photo, edit `photos/_photos.json` (see the example in this folder).

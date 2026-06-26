---
title: "Example ridge loop"
date: 2026-06-14
location: "Nowhere in particular (synthetic example)"
summary: "A bundled placeholder hike so the site works on a fresh clone before you add real data."
track: "track.gpx"
cover: "photos/example-1.jpg"
tags: ["example", "placeholder"]
status: "draft"
---

This is the **bundled example hike**. It exists so that `npm install && npm run dev`
shows a working site immediately, before any of your real hikes are added.

Because its `status` is `draft`, it renders while you develop locally but is left
out of production builds — so it will never deploy.

To add your own first hike, copy `src/content/hikes/_TEMPLATE/` to a new folder
(the folder name becomes the URL slug), drop in your `track.gpx` and `photos/`,
edit the frontmatter, and save. The dev server hot-reloads it in.

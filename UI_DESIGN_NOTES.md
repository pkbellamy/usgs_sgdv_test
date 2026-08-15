# UI layout redesign — left sidebar / right main pane (2026-08-15)

**✅ RESOLVED (2026-08-15).** Implemented and verified live (real USGS fetch,
Time Series and Current Values modes, map square rendering with `invalidateSize()`,
and a simulated mobile-breakpoint single-column collapse, all with no console
errors).

## Current layout

Three horizontal control panels across the top (`.controls`, in `index.html`):
station selector, data parameters (parameter dropdown + date range + fetch button),
and display mode buttons. Below that, a full-width map (`#mapContainer`), then a
full-width charts grid (`#chartsGrid`) or current-values grid.

## Requested layout

- **Left-hand sidebar** (narrow column): consolidate all the controls currently
  spread across the three top panels — station input/list, parameter dropdown,
  date range inputs, fetch button, and display mode buttons — into one compact
  vertical menu.
- **Map**: move into the same left sidebar, shrunk to a small square, positioned in
  the **lower-left corner** of the screen (i.e., below the consolidated controls,
  still within the sidebar column).
- **Right-hand pane**: the large remaining area of the screen is dedicated to the
  data — the charts (time series) or current-values grid — giving it much more
  screen real estate than the current full-width-but-stacked-below layout.

## How it was implemented

- `index.html`: wrapped the three control panels (`.station-selector`,
  `.data-controls`, `.display-controls`) plus `#mapContainer` in a new `.sidebar`
  div; wrapped `#currentValuesGrid`/`#chartsGrid`/`#chartInstructions` in a new
  `.main-pane` div; both siblings inside a new `.app-layout` wrapper. The `h1` title
  stays as a full-width header above `.app-layout`. Removed `#map`'s inline
  `height: 400px` (moved to CSS). No `id` changes — `js/main.js` needed zero
  changes.
- `css/styles.css`: `.app-layout` is `display: flex`; `.sidebar` is a fixed
  `flex: 0 0 300px` column (`flex-direction: column`, `gap: 20px`); `.main-pane` is
  `flex: 1; min-width: 0`. `#map` uses `aspect-ratio: 1 / 1; width: 100%` so it
  renders as a true square that scales with the sidebar. `.map-legend` switched
  from a horizontal flex row to a vertical stack to fit the narrow column. Bumped
  `.container` `max-width` from 1400px to 1600px to give the main pane more room.
  Reduced `h2` font-size and card padding slightly so the three control panels fit
  comfortably at ~300px wide.
- Mobile breakpoint (`@media (max-width: 768px)`): replaced the old
  `.controls { grid-template-columns: 1fr }` override with
  `.app-layout { flex-direction: column }` (sidebar stacks above main pane, full
  width) and `#map { max-width: 400px; margin: 0 auto }` (keeps the map square
  reasonably sized instead of stretching to full viewport width).

**Verified:** real USGS fetch + chart rendering in the main pane, map rendering as
a clean square with the correct marker (confirmed via `map.invalidateSize()`
producing full tile coverage after a size change), Current Values mode rendering
correctly in the main pane, and a simulated mobile-width single-column collapse —
all with no console errors.

---

# Stats bar (Latest/Average/Minimum/Maximum) should reflect the current zoom window

**✅ RESOLVED (2026-08-15).** Implemented and verified live (synthetic zoom-window
tests, an empty-window placeholder test, and a real USGS fetch + zoom + Reset Zoom
cycle, all with no console errors).

## Current behavior (confirmed by reading the code)

The four stat values shown above each chart (`.stats-info` — Latest, Average,
Minimum, Maximum) are computed exactly once, in `createIndividualCharts`
(`js/main.js:931`), from `station.data` — the **entire** fetched dataset for that
station. They are never recalculated afterward.

`renderVisibleWindow` (`js/main.js:192`), which runs on every zoom/pan/reset and
already computes `visibleMin`/`visibleMax` over just the visible window
(`js/main.js:213-218`) to scale the Y-axis, does not touch the stats bar at all —
so the displayed Latest/Average/Minimum/Maximum silently go stale and stop matching
what's actually visible in the chart the moment the user zooms or pans.

## Requested behavior

Latest, Average, Minimum, and Maximum should be recalculated from whatever data is
currently visible in the chart's zoom window, updating live as the user zooms/pans
— consistent with the Y-axis, which already does this correctly.

## How it was implemented

- Added `setStatsDisplay(chart, stats, parameterConfig)` (`js/main.js`, just above
  `renderVisibleWindow`) which writes Latest/Average/Minimum/Maximum text into
  stable per-chart DOM references, or `'—'` placeholders when `stats` is `null`.
- `createIndividualCharts` now gives each `.stat-value` element a unique `id`
  (`stat-latest-${index}`, `stat-avg-${index}`, `stat-min-${index}`,
  `stat-max-${index}`) and, right before `charts.push(chart)`, stores references to
  all four on `chart._statEls` — same pattern already used for `chart._originalXRange`.
- `renderVisibleWindow`'s existing `visibleData` loop (which already computed
  `visibleMin`/`visibleMax` for the Y-axis) now also accumulates a running sum;
  after the loop, "Latest" is taken as the last element of `visibleData` (order is
  preserved by `.filter()`, so this is the most recent point within the current
  zoom window — not necessarily the most recent point overall).
- The existing `visibleData.length === 0` empty-window branch now also calls
  `setStatsDisplay(chart, null)` to show `'—'` instead of leaving stale numbers.

**Verified:** synthetic 10-point dataset showed correct full-window stats, correct
recalculated stats after zooming to a 3-point sub-window, and `'—'` placeholders
when zoomed to an empty window; a real USGS fetch + zoom + Reset Zoom cycle showed
the Average changing between the zoomed and full view and Latest/Min/Max staying
consistent — no console errors throughout.

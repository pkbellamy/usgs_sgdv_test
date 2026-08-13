# Zoom/pan/reset work — session notes (2026-08-13)

Working file: `js/main.js`, uncommitted (`git diff HEAD -- js/main.js`).
Base commit: `d99482d bug - testing Y-axis fix`.

This picks up an in-progress refactor of the Chart.js zoom/pan/Y-axis-rescale
logic (replaced destroy-and-recreate chart hacks with a single
`renderVisibleWindow` render path, added decimation, debounced view-change
handling, O(n) data merge). That refactor was code-reviewed and 6 bugs found
in it were fixed this session (see "Fixes already applied" below). Then the
fixed code was actually driven in a browser, which surfaced a **7th, more
serious bug** in Reset Zoom that is NOT yet fixed — see "Open bug" below.
That's the next thing to do.

## Fixes already applied (done, in working tree, not committed)

All in `js/main.js`, all verified by `node --check` (syntax) and partially by
live browser testing (zoom + pan tested live; reset tested live and is where
the open bug was found).

1. **Reset Zoom didn't fetch missing data.** `resetButton.onclick` and the
   `dblclick` handler (~line 1079, ~line 1089) now call
   `setTimeout(() => handleChartViewChange(chart), 0)` instead of
   `setTimeout(() => renderVisibleWindow(chart, station), 0)`, so a reset
   that lands outside currently-loaded data triggers a backfill like zoom/pan
   do. (This fix is still correct and should stay — it's orthogonal to the
   open bug below, which is about the x-range never actually changing on
   reset in the first place.)
2. **Global fetch mutex dropped concurrent backfills.** `isDataFetching`
   (single boolean) replaced with `fetchingStationIds` (a `Set` keyed by
   `stationData.stationId`), so restoring zoom on multiple charts after a
   parameter switch no longer causes later stations to silently skip their
   backfill fetch.
3. **`zoomRestoreByStation` leaked on error paths.** `onParameterChange` (~line
   358) now chains `.finally(() => { zoomRestoreByStation = {}; })` on
   `fetchDataAsync()` so a failed re-fetch can't leave stale zoom windows to
   be misapplied to a later, unrelated chart rebuild.
4. **Stale Y-axis/line when panning into an empty data window.**
   `renderVisibleWindow` (line 177) now clears `dataset.data` to `[]` and
   calls `chart.update('none')` when the visible window has zero loaded
   points, instead of returning early and leaving the previous window's line
   and axis on screen.
5. **Merge dedup precedence was flipped.** `mergeStationData` now keeps the
   *existing* point on a timestamp collision (matches pre-refactor
   behavior) instead of letting a later, narrower backfill fetch silently
   overwrite an already-displayed value.
6. **`decimateMinMax` double-pushed single/flat buckets.** Fixed to push once
   when `minPoint === maxPoint` (this also fixed flat-value buckets generally,
   not just size-1 buckets — confirmed empirically live: a 4199-point raw
   series decimated to 1194 rendered points instead of the naive ~1680,
   because many buckets during flat/baseflow periods have identical y across
   the whole bucket).

Two lower-priority efficiency findings from the review were **not** applied
(deliberately deferred, not urgent):
- `buildPointStyles` (line ~159) scans the `alerts` array separately in each
  of its 4 `.map()` passes — could be 1 pass instead of 4.
- `mergeStationData` (line ~244) does a full re-sort of the entire
  accumulated array on every fetch instead of merging into the
  already-sorted existing array.

## Open bug: Reset Zoom is non-functional after any pan/zoom (NOT FIXED)

### Repro (verified live via browser + direct chart API calls)

1. Loaded station `01646500`, 07/30/2026–08/13/2026, Discharge. Chart
   auto-ranged x to the full loaded extent: `2026-07-30T04:00:00.000Z` to
   `2026-08-13T17:50:00.000Z` (4199 raw points, `station.data` in
   `allStationData[0]`).
2. Zoomed in via real `wheel` events on the canvas → x-range correctly
   narrowed to `2026-08-02T20:59:59Z`–`2026-08-09T15:02:09Z`; Y-axis
   correctly rescaled to the visible window's padded min/max. Confirmed
   correct.
3. Panned via `chart.pan({x:-200}, undefined, 'default')` (plugin API,
   since synthetic mouse/pointer drag events don't reliably trigger
   chartjs-plugin-zoom's Hammer-based pan recognizer in this automation
   environment — see "Testing gotchas" below) → x-range shifted to
   `2026-08-04T00:00:28Z`–`2026-08-10T18:02:38Z`. Then called
   `handleChartViewChange(chart)` directly (this is what `onPanComplete`
   would have triggered) → Y-axis rescaled correctly again
   (`ymin:1552, ymax:3688`, exactly matching the padded raw min/max of the
   new visible window: raw 1730–3510). Pan pipeline confirmed correct.
4. Clicked the real "Reset Zoom" button in the UI. Console logged
   `🔄 Chart zoom reset for POTOMAC RIVER NEAR WASH...` (handler fired, no
   errors). **But the x-range did not change** — stayed at
   `2026-08-04T00:05:00Z`–`2026-08-10T18:00:00Z` (same panned window,
   just snapped to the nearest loaded data timestamps).
5. Confirmed directly: `chart.isZoomedOrPanned()` returns **`false`** and
   `chart.getZoomLevel()` returns **`1`** even though the chart is very
   obviously zoomed/panned away from the full data range. This means
   chartjs-plugin-zoom itself now believes the *current* panned window
   **is** the original, unzoomed baseline.
6. Confirmed `allStationData[0].data` still spans the true full original
   range (`2026-07-30T04:00:00Z`–`2026-08-13T17:50:00Z`, 4199 points) — the
   underlying data was never lost, only the plugin's notion of "original
   view to reset to" is corrupted.

### Root cause

The chart's x-axis has **no explicit `min`/`max`** in its `scales.x` config
(`js/main.js` ~line 1002–1024, see the comment left in place:
`// ENHANCED: No hard min/max - let chart auto-scale to data, limits only
apply to zoom plugin`). This was fine in the *pre-refactor* code, because
`dataset.data` was always the **full** `stationData.data` array — zoom/pan
only ever changed the scale's runtime `min`/`max` (via the zoom plugin),
never the dataset contents, so Chart.js's auto-ranging of x from "the data"
always meant "the full data," a stable, unchanging quantity.

The *new* `renderVisibleWindow` (line 177) reassigns
`chart.data.datasets[0].data = renderData` on every debounced zoom/pan tick,
where `renderData` is the **decimated, visible-window-filtered** subset (not
the full data). Combined with x having no explicit min/max, every
`chart.update('none')` call after a pan/zoom causes Chart.js to auto-fit the
x-axis to whatever's now in the (shrunken) dataset — and chartjs-plugin-zoom
recaptures/treats the resulting scale range as the new "original" baseline
on that update. So every debounced re-render silently redefines "original"
to be the current window, permanently baking in whatever zoom level you're
at. `chart.resetZoom()` then has nothing to reset to but the current view.

This is a bug in the visible-window-filtering design itself, not something
that was there pre-refactor, and it is **separate from and deeper than**
fix #1 above (which only made reset *fetch* missing data — that fix is still
correct/needed but doesn't address this).

### Planned fix (not yet implemented)

Stop relying on chartjs-plugin-zoom's `resetZoom()` / internal
"original-range" tracking — it can't be trusted once the dataset itself is
being mutated on every render. Instead:

1. **Capture the true original x-range ourselves** at chart-creation time in
   `createIndividualCharts` (around line 919, right after
   `initialRenderData` is computed, using the *full* `station.data` — not
   the decimated `initialRenderData`):
   ```js
   const fullRange = getDataTimeRange(station.data); // already exists, line ~236
   ```
   Store it somewhere retrievable per chart, e.g. a parallel array
   `chartOriginalRanges[index] = { min: fullRange.min.getTime(), max: fullRange.max.getTime() }`,
   or stash it directly on the chart instance after creation:
   `chart._originalXRange = { min: fullRange.min.getTime(), max: fullRange.max.getTime() };`
   (simplest — no new module-level array to keep in sync with `charts`/
   `allStationData`, and it naturally gets thrown away when the chart is
   destroyed/recreated).

2. **Replace `chart.resetZoom()` calls** in both `resetButton.onclick`
   (~line 1079) and the `dblclick` listener (~line 1089) with an explicit
   restore to that captured range via the plugin's own `zoomScale` API
   (already used elsewhere in this file for the parameter-switch zoom
   restore, ~line 1101, so it's a proven-working call in this codebase):
   ```js
   chart.zoomScale('x', chart._originalXRange, 'none');
   ```
   instead of `chart.resetZoom()`. Keep the existing
   `setTimeout(() => handleChartViewChange(chart), 0)` follow-up from fix #1
   unchanged (still needed so a reset that lands outside currently-loaded
   data triggers a backfill, and so the visible window re-renders against
   the restored range).

3. Double check `getDataTimeRange` (line ~236) is called with `station.data`
   (the full array) at the correct point in `createIndividualCharts` — it
   must be captured **before** any zoom/pan has had a chance to mutate
   `station.data` via a backfill merge that shifts the array, though since
   backfills only *add* points (never remove), a snapshot taken right after
   the initial data load is safe even if the array object mutates later
   (`_originalXRange` is a plain `{min, max}` copy, not a reference).

4. **Re-verify live** after implementing: repeat steps 1–4 of the repro
   above and confirm `chart.scales.x.min/max` return to the exact original
   full-range values after clicking Reset Zoom, and that
   `chart.isZoomedOrPanned()` / `chart.getZoomLevel()` are informational only
   now (their brokenness doesn't matter once reset no longer depends on
   them).

5. Consider whether `zoomRestoreByStation` (the parameter-switch zoom
   restore feature, ~line 358–372, ~1101) has a related but distinct
   problem: it saves `{min: chart.scales.x.min, max: chart.scales.x.max}`
   from the *live* scale, which is fine for its purpose (restoring the
   user's last view across a parameter switch) — this is NOT the same bug,
   no change needed there. Just noted so it isn't confused with the reset
   fix above during implementation.

## Testing gotchas learned this session (for whoever resumes)

- App is static HTML/JS, no build step. Serve with e.g.
  `python3 -m http.server 8791` from the repo root and open
  `http://localhost:8791/index.html`.
- USGS station used for testing: `01646500` (Potomac River near
  Washington, DC — Little Falls Pump Station), reliably has real recent
  data with visible spikes, good for eyeballing zoom.
- Keep the fetch date range modest (~2 weeks). A ~100-day range triggered
  an HTTP 413 from the `corsproxy.io` fallback proxy (payload too large) —
  not a bug in this app, just a proxy limit worth remembering when picking
  test date ranges.
- Chrome browser automation's synthetic `scroll` action scrolls the **page**,
  not the chart canvas — it does not reliably reach chartjs-plugin-zoom's
  wheel handler. Real chart-canvas zoom testing needs a genuine
  `WheelEvent` dispatched directly on the canvas element via
  `javascript_tool` (`canvas.dispatchEvent(new WheelEvent('wheel', {clientX,
  clientY, deltaY, bubbles:true, cancelable:true}))`), which reliably
  reaches the plugin. Wheel-zoom was verified working this way.
- Synthetic mouse/pointer drag (both the `computer` tool's
  `left_click_drag` and manually dispatched `PointerEvent`/`MouseEvent`
  sequences via `javascript_tool`) did **not** trigger chartjs-plugin-zoom's
  Hammer.js-based pan recognizer in this environment — likely needs a real
  OS-level event stream with many intermediate move events that these
  synthetic paths don't reproduce closely enough. Worked around by calling
  `chart.pan({x: -N}, undefined, 'default')` (the plugin's own public pan
  API) directly, then manually invoking `handleChartViewChange(chart)` (the
  same function `onPanComplete` would call) to exercise the actual app
  logic. This is a testing-environment limitation, not evidence of an app
  bug in real mouse-drag panning — treat pan as "logic verified, real-mouse
  UI path unverified" if it matters later.
- All chart-internal state is reachable from `javascript_tool` via the
  page's top-level `let charts = []` / `let allStationData = []` /
  `let fetchingStationIds` — these are accessible as bare identifiers (not
  `window.charts`) because classic `<script>` top-level `let` bindings share
  one global lexical environment across script tags/eval in the same page,
  which is what CDP's `Runtime.evaluate` executes into. Useful for future
  debugging without needing to instrument the app.

## Next step when resuming

Implement the "Planned fix" section above, then re-run the full
zoom → pan → reset live-browser repro to confirm Reset Zoom actually
restores the true full original range. After that, this file's contents can
be folded into the commit message (or deleted) once the fix is committed.

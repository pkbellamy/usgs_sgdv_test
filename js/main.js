// Global variables
let selectedStations = [];
let charts = [];
let map;
let stationMarkers = [];
let displayMode = 'timeseries'; // 'timeseries' or 'current'
let allStationData = []; // Store all fetched data for parameter switching
let stationDataRanges = {}; // Store known data ranges for each station
let fetchingStationIds = new Set(); // stationIds with an in-flight backfill fetch (per-station, so concurrent charts don't block each other)
let zoomRestoreByStation = {}; // stationId -> {min, max} to reapply after a parameter-switch rebuild
const VIEW_CHANGE_DEBOUNCE_MS = 200;
const MAX_RENDERED_POINTS = 2000; // cap on points handed to Chart.js per render pass
const colors = ['#667eea', '#764ba2', '#28a745', '#20c997'];

// Parameter configurations for better labeling and formatting
const parameterConfigs = {
    '00060': { name: 'Discharge', unit: 'ft³/s', format: (val) => val.toFixed(1) },
    '00065': { name: 'Gage Height', unit: 'ft', format: (val) => val.toFixed(2) },
    '00010': { name: 'Temperature', unit: '°C', format: (val) => val.toFixed(1) },
    '63680': { name: 'Turbidity', unit: 'NTU', format: (val) => val.toFixed(1) }
};

// Global functions that need to be accessible from HTML onclick attributes
window.setDisplayMode = function(mode) {
    displayMode = mode;
    
    // Update button states
    document.getElementById('timeSeriesBtn').classList.toggle('active', mode === 'timeseries');
    document.getElementById('currentBtn').classList.toggle('active', mode === 'current');
    
    // Update date controls visibility
    const dateControls = document.getElementById('dateControls');
    const fetchBtn = document.getElementById('fetchBtn');
    
    if (mode === 'current') {
        dateControls.classList.add('hidden');
        fetchBtn.textContent = 'Fetch Current Values';
    } else {
        dateControls.classList.remove('hidden');
        fetchBtn.textContent = 'Fetch & Visualize Data';
    }
    
    // Update existing display if data is already loaded
    if (selectedStations.length > 0) {
        const chartsGrid = document.getElementById('chartsGrid');
        const currentValuesGrid = document.getElementById('currentValuesGrid');
        
        if (mode === 'current') {
            chartsGrid.style.display = 'none';
            currentValuesGrid.style.display = 'grid';
        } else {
            chartsGrid.style.display = 'grid';
            currentValuesGrid.style.display = 'none';
        }
    }
};

window.addStation = function() {
    console.log('🔧 addStation function called');
    const input = document.getElementById('stationInput');
    const stationId = input.value.trim();
    
    console.log('📝 Station ID entered:', stationId);
    
    if (!stationId) {
        alert('Please enter a station ID');
        return;
    }
    
    if (selectedStations.length >= 4) {
        alert('Maximum 4 stations allowed');
        return;
    }
    
    if (selectedStations.includes(stationId)) {
        alert('Station already selected');
        return;
    }
    
    // Basic validation for USGS station ID format
    if (!/^[0-9]{8,15}$/.test(stationId)) {
        alert('Please enter a valid USGS station ID (8-15 digits)');
        return;
    }
    
    selectedStations.push(stationId);
    input.value = '';
    console.log('✅ Station added. Current stations:', selectedStations);
    updateStationDisplay();
    updateFetchButton();
    
    // Clear existing data when stations change
    allStationData = [];
};

window.removeStation = function(stationId) {
    console.log('🗑️ Removing station:', stationId);
    selectedStations = selectedStations.filter(id => id !== stationId);
    updateStationDisplay();
    updateFetchButton();
    
    // Remove marker from map if it exists
    const markerToRemove = stationMarkers.find(marker => marker.stationId === stationId);
    if (markerToRemove && map) {
        map.removeLayer(markerToRemove.marker);
        stationMarkers = stationMarkers.filter(marker => marker.stationId !== stationId);
    }
    
    // Clear existing data when stations change
    allStationData = [];
};

window.fetchData = function() {
    console.log('🚀 fetchData function called');
    if (selectedStations.length === 0) {
        console.log('❌ No stations selected');
        return;
    }
    
    fetchDataAsync();
};

// Bucket-decimate a time-sorted array down to at most maxPoints, keeping the min-y and
// max-y point from each bucket. This preserves true extremes (so alert spikes and Y-axis
// bounds stay accurate) while capping how many points Chart.js has to draw — rendering
// thousands of raw points on every zoom/pan is what caused multi-hundred-ms redraws once a
// station's accumulated history got large.
function decimateMinMax(data, maxPoints) {
    if (data.length <= maxPoints) return data;

    const bucketCount = Math.max(1, Math.floor(maxPoints / 2));
    const bucketSize = Math.ceil(data.length / bucketCount);
    const result = [];

    for (let i = 0; i < data.length; i += bucketSize) {
        const end = Math.min(i + bucketSize, data.length);
        let minPoint = data[i];
        let maxPoint = data[i];

        for (let j = i + 1; j < end; j++) {
            const point = data[j];
            if (point.y < minPoint.y) minPoint = point;
            if (point.y > maxPoint.y) maxPoint = point;
        }

        if (minPoint === maxPoint) {
            result.push(minPoint);
        } else if (minPoint.x.getTime() <= maxPoint.x.getTime()) {
            result.push(minPoint, maxPoint);
        } else {
            result.push(maxPoint, minPoint);
        }
    }

    return result;
}

// Build the four alert-aware point-style arrays Chart.js expects, one entry per point in
// `data`. `data` must be the exact array assigned to the dataset (i.e. already decimated)
// so the styles stay index-aligned with what's actually rendered.
function buildPointStyles(data, alerts, color) {
    const isAlertPoint = (point) => alerts.some(alert =>
        Math.abs(alert.time.getTime() - point.x.getTime()) < 300000
    );

    return {
        pointRadius: data.map(point => isAlertPoint(point) ? 15 : 2),
        pointBackgroundColor: data.map(point => isAlertPoint(point) ? '#ff4757' : color),
        pointBorderColor: data.map(point => isAlertPoint(point) ? '#ffffff' : color),
        pointBorderWidth: data.map(point => isAlertPoint(point) ? 4 : 1)
    };
}

// Render the currently visible x-window: filter full-resolution station data to the chart's
// visible range, rescale Y to fit it, decimate it for drawing, and push it into the chart.
// This is the single path used after any zoom, pan, reset, data fetch, or parameter switch.
function renderVisibleWindow(chart, stationData) {
    const xScale = chart.scales.x;
    const visibleStartTime = xScale.min;
    const visibleEndTime = xScale.max;

    const visibleData = stationData.data.filter(point => {
        const pointTime = point.x.getTime();
        return pointTime >= visibleStartTime && pointTime <= visibleEndTime;
    });

    if (visibleData.length === 0) {
        // Nothing loaded for the visible window (data gap, or a backfill fetch that hasn't
        // landed yet) — clear the dataset instead of leaving the previous window's line/points
        // on screen under axes that no longer describe them.
        const dataset = chart.data.datasets[0];
        dataset.data = [];
        Object.assign(dataset, buildPointStyles([], stationData.alerts, stationData.color));
        chart.update('none');
        return;
    }

    let visibleMin = Infinity;
    let visibleMax = -Infinity;
    for (const point of visibleData) {
        if (point.y < visibleMin) visibleMin = point.y;
        if (point.y > visibleMax) visibleMax = point.y;
    }
    const range = visibleMax - visibleMin;
    const padding = Math.max(range * 0.1, 0.1);

    chart.options.scales.y.min = Math.max(0, visibleMin - padding);
    chart.options.scales.y.max = visibleMax + padding;

    const renderData = decimateMinMax(visibleData, MAX_RENDERED_POINTS);
    const dataset = chart.data.datasets[0];
    dataset.data = renderData;
    Object.assign(dataset, buildPointStyles(renderData, stationData.alerts, stationData.color));

    chart.update('none');
}

// Single handler for zoom/pan: fetch more data if the view approaches the edge of what's
// loaded, then re-render the now-visible window. Debounced per-chart so rapid wheel/drag
// events collapse into one pass instead of racing.
async function handleChartViewChange(chart) {
    const stationIndex = charts.indexOf(chart);
    if (stationIndex < 0 || stationIndex >= allStationData.length) return;

    const stationData = allStationData[stationIndex];

    if (displayMode === 'timeseries') {
        await fetchAdditionalDataIfNeeded(chart, stationData);
    }

    renderVisibleWindow(chart, stationData);
}

function onChartViewChanged(chart) {
    clearTimeout(chart._viewChangeTimer);
    chart._viewChangeTimer = setTimeout(() => handleChartViewChange(chart), VIEW_CHANGE_DEBOUNCE_MS);
}

// Find the min/max timestamp in a data array without spreading it into Math.min/max
// (spread blows the call stack once a station's merged history gets large)
function getDataTimeRange(data) {
    let min = Infinity;
    let max = -Infinity;
    for (const point of data) {
        const t = point.x.getTime();
        if (t < min) min = t;
        if (t > max) max = t;
    }
    return { min: new Date(min), max: new Date(max) };
}

// Merge new points into existing data, de-duping by timestamp, in O(n) instead of the
// previous O(n^2) findIndex-per-point scan (which got progressively slower as a station's
// history grew from repeated pans). On a timestamp collision, existing data wins — matches
// the old reduce/findIndex behavior and avoids a value the user already saw (and any alert
// tied to it) silently changing underneath them from a later, narrower backfill fetch.
function mergeStationData(existingData, newData) {
    const byTime = new Map(existingData.map(point => [point.x.getTime(), point]));
    for (const point of newData) {
        if (!byTime.has(point.x.getTime())) {
            byTime.set(point.x.getTime(), point);
        }
    }
    return Array.from(byTime.values()).sort((a, b) => a.x.getTime() - b.x.getTime());
}

// ENHANCED: Dynamic data fetching based on chart zoom/pan
async function fetchAdditionalDataIfNeeded(chart, stationData) {
    if (fetchingStationIds.has(stationData.stationId) || displayMode !== 'timeseries') {
        return false;
    }

    const currentViewStart = new Date(chart.scales.x.min);
    const currentViewEnd = new Date(chart.scales.x.max);
    const { min: currentDataStart, max: currentDataEnd } = getDataTimeRange(stationData.data);

    // Add buffer to prevent excessive refetching
    const bufferHours = 6;
    const startBuffer = new Date(currentDataStart.getTime() - (bufferHours * 60 * 60 * 1000));
    const endBuffer = new Date(currentDataEnd.getTime() + (bufferHours * 60 * 60 * 1000));

    // Collect BOTH directions independently — panning/zooming out can need older data
    // AND newer data in the same view change, and they must not overwrite each other
    const ranges = [];

    if (currentViewStart < startBuffer) {
        const minDate = new Date('1889-01-01'); // USGS data availability limit
        const stationMinDate = stationDataRanges[stationData.stationId]?.earliest || minDate;

        if (currentViewStart >= stationMinDate) {
            ranges.push({
                start: new Date(Math.max(currentViewStart.getTime() - (7 * 24 * 60 * 60 * 1000), stationMinDate.getTime())),
                end: currentDataStart
            });
        }
    }

    if (currentViewEnd > endBuffer) {
        const maxDate = new Date(); // Current date/time limit

        if (currentViewEnd <= maxDate) {
            ranges.push({
                start: currentDataEnd,
                end: new Date(Math.min(currentViewEnd.getTime() + (7 * 24 * 60 * 60 * 1000), maxDate.getTime()))
            });
        }
    }

    if (ranges.length === 0) {
        return false;
    }

    fetchingStationIds.add(stationData.stationId);
    let addedAny = false;
    try {
        const parameter = document.getElementById('parameterSelect').value;

        for (const range of ranges) {
            console.log(`🔄 Fetching additional data for ${stationData.stationId}: ${range.start.toISOString().split('T')[0]} to ${range.end.toISOString().split('T')[0]}`);

            const baseUrl = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${stationData.stationId}&parameterCd=${parameter}&startDT=${range.start.toISOString().split('T')[0]}&endDT=${range.end.toISOString().split('T')[0]}`;

            const data = await fetchWithMultipleProxies(baseUrl);

            if (data.value && data.value.timeSeries && data.value.timeSeries.length > 0) {
                const timeSeries = data.value.timeSeries[0];
                const values = timeSeries.values[0].value;

                const newChartData = values
                    .filter(v => v.value !== null && v.value !== undefined && !isNaN(parseFloat(v.value)))
                    .map(v => ({
                        x: new Date(v.dateTime),
                        y: parseFloat(v.value)
                    }));

                if (newChartData.length > 0) {
                    stationData.data = mergeStationData(stationData.data, newChartData);
                    addedAny = true;
                    console.log(`✅ Added ${newChartData.length} new data points for ${stationData.stationId}`);
                }
            }
        }

        if (addedAny) {
            // Rendering (dataset assignment, point styles, decimation, Y-axis, chart.update)
            // is handled by the caller via renderVisibleWindow, not here — keeps the fetch
            // layer only responsible for updating stationData, not drawing.
            stationData.alerts = detectRapidIncrease(stationData.data);
        }
    } catch (error) {
        console.error(`❌ Failed to fetch additional data for ${stationData.stationId}:`, error);
    } finally {
        fetchingStationIds.delete(stationData.stationId);
    }

    return addedAny;
}

window.onParameterChange = function() {
    const parameter = document.getElementById('parameterSelect').value;
    console.log('📊 Parameter changed to:', parameter);

    // If we have existing data and are in time series mode, re-fetch for new parameter
    if (allStationData.length > 0 && displayMode === 'timeseries') {
        console.log('🔄 Re-fetching data for new parameter...');

        // Snapshot each chart's visible x-window, keyed by station, so it can be restored
        // after createIndividualCharts rebuilds everything from scratch below
        charts.forEach((chart, i) => {
            const stationId = allStationData[i]?.stationId;
            if (stationId) {
                zoomRestoreByStation[stationId] = { min: chart.scales.x.min, max: chart.scales.x.max };
            }
        });

        // createIndividualCharts consumes and clears zoomRestoreByStation on success, but if
        // fetchDataAsync fails/throws before reaching createIndividualCharts, nothing would
        // otherwise clear it — leaving stale zoom windows to be misapplied to a later, unrelated
        // rebuild (e.g. after adding/removing a station). Clear it here once the fetch settles,
        // regardless of outcome, as a backstop.
        fetchDataAsync().finally(() => {
            zoomRestoreByStation = {};
        });
    }
};

function updateStationDisplay() {
    const container = document.getElementById('selectedStations');
    
    if (selectedStations.length === 0) {
        container.innerHTML = '<p style="color: #6c757d; font-style: italic;">No stations selected. Add up to 4 stations.</p>';
        return;
    }
    
    container.innerHTML = selectedStations.map((station, index) => 
        `<span class="station-tag" style="background: linear-gradient(45deg, ${colors[index]}, ${colors[(index + 1) % colors.length]}); cursor: pointer;" onclick="removeStation('${station}')" title="Click to remove">
            Station ${station} ×
        </span>`
    ).join('');
}

function updateFetchButton() {
    const fetchBtn = document.getElementById('fetchBtn');
    if (fetchBtn) {
        fetchBtn.disabled = selectedStations.length === 0;
    }
}

// Initialize map
function initializeMap() {
    if (!document.getElementById('map')) {
        console.error('❌ Map element not found');
        return;
    }
    
    if (typeof L === 'undefined') {
        console.error('❌ Leaflet library not loaded');
        return;
    }
    
    try {
        map = L.map('map').setView([39.8283, -98.5795], 4); // Center on USA
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(map);
        
        console.log('✅ Map created successfully');
    } catch (error) {
        console.error('❌ Error creating map:', error);
    }
}

// Fit map to show all stations
function fitMapToStations() {
    if (!map || stationMarkers.length === 0) {
        console.log('❌ Cannot fit map: no map or no markers');
        return;
    }
    
    console.log(`🗺️ Fitting map to ${stationMarkers.length} stations...`);
    
    if (stationMarkers.length === 1) {
        const marker = stationMarkers[0];
        map.setView([marker.latitude, marker.longitude], 10);
        console.log(`📍 Single station: zoomed to ${marker.latitude}, ${marker.longitude}`);
    } else {
        const group = new L.featureGroup(stationMarkers.map(sm => sm.marker));
        map.fitBounds(group.getBounds().pad(0.1));
        console.log(`📍 Multiple stations: fitted bounds`);
    }
    
    setTimeout(() => {
        if (map) {
            map.invalidateSize();
        }
    }, 200);
}

// Add station marker to map
async function addStationToMap(stationId, siteName, latitude, longitude, color, hasAlerts = false) {
    if (!map) return;
    
    const icon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div style="
            background: ${hasAlerts ? '#ff4757' : color}; 
            width: 20px; 
            height: 20px; 
            border-radius: 50%; 
            border: 3px solid white; 
            box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            ${hasAlerts ? 'animation: pulse 2s infinite;' : ''}
        "></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
    });
    
    const marker = L.marker([latitude, longitude], { icon }).addTo(map);
    marker.bindPopup(`
        <div style="text-align: center;">
            <strong>${siteName}</strong><br>
            Station ID: ${stationId}<br>
            ${hasAlerts ? '<span style="color: #ff4757; font-weight: bold;">⚠️ ALERT: Rapid increase detected!</span>' : ''}
        </div>
    `);
    
    stationMarkers.push({ 
        stationId, 
        marker, 
        latitude, 
        longitude 
    });
}

// Detect rapid increases (100%+ within 1 hour window)
function detectRapidIncrease(data) {
    const alerts = [];
    
    console.log(`🔍 Analyzing ${data.length} data points for rapid increases within 1-hour windows...`);
    
    if (data.length < 2) {
        console.log('❌ Not enough data points for analysis');
        return alerts;
    }
    
    const sortedData = [...data].sort((a, b) => a.x.getTime() - b.x.getTime());
    let significantIncreases = 0;
    
    for (let i = 0; i < sortedData.length - 1; i++) {
        const basePoint = sortedData[i];
        const baseTime = basePoint.x.getTime();
        const oneHourLater = baseTime + (60 * 60 * 1000);
        
        if (basePoint.y <= 0) continue;
        
        let maxValueInHour = basePoint.y;
        let maxPoint = basePoint;
        
        for (let j = i + 1; j < sortedData.length; j++) {
            const currentPoint = sortedData[j];
            const currentTime = currentPoint.x.getTime();
            
            if (currentTime > oneHourLater) break;
            
            if (currentPoint.y > maxValueInHour) {
                maxValueInHour = currentPoint.y;
                maxPoint = currentPoint;
            }
        }
        
        const percentIncrease = ((maxValueInHour - basePoint.y) / basePoint.y) * 100;
        const timeDiff = maxPoint.x.getTime() - basePoint.x.getTime();
        const minutesDiff = timeDiff / (1000 * 60);
        
        if (percentIncrease >= 30) {
            significantIncreases++;
            console.log(`📈 1-hour window increase: ${basePoint.y.toFixed(2)} → ${maxValueInHour.toFixed(2)} (+${percentIncrease.toFixed(1)}% in ${minutesDiff.toFixed(0)} min) from ${moment(basePoint.x).format('MMM DD HH:mm')} to ${moment(maxPoint.x).format('MMM DD HH:mm')}`);
        }
        
        if (percentIncrease >= 100) {
            const alert = {
                time: maxPoint.x,
                startTime: basePoint.x,
                value: maxValueInHour,
                startValue: basePoint.y,
                increase: percentIncrease.toFixed(1),
                minutesDiff: minutesDiff.toFixed(0),
                dataIndex: i
            };
            
            alerts.push(alert);
            console.log(`🚨 ALERT DETECTED: ${alert.startValue.toFixed(2)} → ${alert.value.toFixed(2)} (+${alert.increase}% in ${alert.minutesDiff} minutes)`);
        }
    }
    
    console.log(`📊 1-hour window analysis: ${significantIncreases} increases ≥30%, ${alerts.length} alerts ≥100%`);
    return alerts;
}

// Calculate trend based on recent data points
function calculateTrend(data) {
    if (data.length < 3) return { direction: 'stable', text: 'Insufficient data' };
    
    const recentPoints = data.slice(-Math.min(10, data.length));
    const firstValue = recentPoints[0].y;
    const lastValue = recentPoints[recentPoints.length - 1].y;
    
    const percentChange = ((lastValue - firstValue) / firstValue) * 100;
    
    if (percentChange > 5) {
        return { direction: 'up', text: `Rising (+${percentChange.toFixed(1)}%)` };
    } else if (percentChange < -5) {
        return { direction: 'down', text: `Falling (${percentChange.toFixed(1)}%)` };
    } else {
        return { direction: 'stable', text: 'Stable' };
    }
}

async function fetchDataAsync() {
    const parameter = document.getElementById('parameterSelect').value;
    const fetchBtn = document.getElementById('fetchBtn');
    const chartsGrid = document.getElementById('chartsGrid');
    const currentValuesGrid = document.getElementById('currentValuesGrid');
    
    fetchBtn.disabled = true;
    
    if (displayMode === 'current') {
        fetchBtn.textContent = 'Fetching Current Values...';
        currentValuesGrid.style.display = 'grid';
        currentValuesGrid.innerHTML = '<div class="loading">Loading current stream gage readings</div>';
    } else {
        const startDate = document.getElementById('startDate').value;
        const endDate = document.getElementById('endDate').value;
        
        if (!startDate || !endDate) {
            alert('Please select both start and end dates');
            fetchBtn.disabled = false;
            return;
        }
        
        fetchBtn.textContent = 'Fetching Data...';
        chartsGrid.style.display = 'block';
        chartsGrid.innerHTML = '<div class="loading">Loading stream gage data and station locations</div>';
    }
    
    try {
        const stationData = [];
        const paramConfig = parameterConfigs[parameter] || { name: 'Unknown Parameter', unit: '', format: (val) => val.toFixed(2) };
        const parameterName = `${paramConfig.name} (${paramConfig.unit})`;
        
        for (let i = 0; i < selectedStations.length; i++) {
            const stationId = selectedStations[i];
            
            try {
                let baseUrl;
                if (displayMode === 'current') {
                    const now = new Date();
                    const yesterday = new Date(now.getTime() - (24 * 60 * 60 * 1000));
                    baseUrl = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${stationId}&parameterCd=${parameter}&startDT=${yesterday.toISOString().split('T')[0]}&endDT=${now.toISOString().split('T')[0]}`;
                } else {
                    const startDate = document.getElementById('startDate').value;
                    const endDate = document.getElementById('endDate').value;
                    baseUrl = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${stationId}&parameterCd=${parameter}&startDT=${startDate}&endDT=${endDate}`;
                }
                
                const data = await fetchWithMultipleProxies(baseUrl);
                
                if (data.value && data.value.timeSeries && data.value.timeSeries.length > 0) {
                    const timeSeries = data.value.timeSeries[0];
                    const siteName = timeSeries.sourceInfo.siteName;
                    const latitude = parseFloat(timeSeries.sourceInfo.geoLocation.geogLocation.latitude);
                    const longitude = parseFloat(timeSeries.sourceInfo.geoLocation.geogLocation.longitude);
                    const values = timeSeries.values[0].value;
                    
                    const chartData = values
                        .filter(v => v.value !== null && v.value !== undefined && !isNaN(parseFloat(v.value)))
                        .map(v => ({
                            x: new Date(v.dateTime),
                            y: parseFloat(v.value)
                        }));
                    
                    if (chartData.length > 0) {
                        console.log(`🔍 Processing station ${stationId} (${siteName})`);
                        
                        let alerts = [];
                        if (displayMode === 'timeseries') {
                            alerts = detectRapidIncrease(chartData);
                        }
                        
                        const trend = calculateTrend(chartData);
                        console.log(`✅ Station ${stationId} processed: ${alerts.length} alerts found`);
                        
                        stationData.push({
                            stationId: stationId,
                            siteName: siteName,
                            latitude: latitude,
                            longitude: longitude,
                            data: chartData,
                            color: colors[i],
                            parameterName: parameterName,
                            parameterConfig: paramConfig,
                            alerts: alerts,
                            trend: trend
                        });
                        
                        await addStationToMap(stationId, siteName, latitude, longitude, colors[i], alerts.length > 0);
                    } else {
                        console.warn(`⚠️ No valid data points for station ${stationId}`);
                    }
                }
            } catch (error) {
                console.error(`Error fetching data for station ${stationId}:`, error);
            }
        }
        
        if (stationData.length === 0) {
            throw new Error('No data available for the selected stations and time period.');
        }
        
        // Store the fetched data globally for parameter switching
        allStationData = stationData;
        
        document.getElementById('mapContainer').style.display = 'block';
        
        setTimeout(() => {
            if (map) {
                console.log('🗺️ Resizing map and fitting to stations...');
                map.invalidateSize();
                fitMapToStations();
            }
        }, 100);
        
        if (displayMode === 'current') {
            createCurrentValuesDisplay(stationData);
        } else {
            createIndividualCharts(stationData);
            // Show chart instructions when charts are displayed
            const instructionsElement = document.getElementById('chartInstructions');
            if (instructionsElement) {
                instructionsElement.style.display = 'block';
            }
        }
        
    } catch (error) {
        let errorMessage = error.message;
        if (error.message.includes('Failed to fetch') || error.message.includes('CORS') || error.message.includes('proxy')) {
            errorMessage = `
                <div class="cors-info">
                    <strong>Proxy Service Error</strong>
                    All CORS proxy services failed. Please try again in a few minutes.
                </div>
            `;
        }
        
        if (displayMode === 'current') {
            currentValuesGrid.innerHTML = `<div class="error">Error: ${errorMessage}</div>`;
        } else {
            chartsGrid.innerHTML = `<div class="error">Error: ${errorMessage}</div>`;
        }
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = displayMode === 'current' ? 'Fetch Current Values' : 'Fetch & Visualize Data';
    }
}

function createCurrentValuesDisplay(stationData) {
    const currentValuesGrid = document.getElementById('currentValuesGrid');
    currentValuesGrid.innerHTML = '';
    
    stationData.forEach((station, index) => {
        const latestReading = station.data[station.data.length - 1];
        const readingTime = latestReading.x;
        const currentValue = latestReading.y;
        
        const hasAlerts = station.alerts.length > 0;
        const statusClass = hasAlerts ? 'status-alert' : 'status-normal';
        const statusText = hasAlerts ? '⚠️ ALERT' : '✅ Normal';
        
        let trendArrow = '→';
        let trendClass = 'trend-stable';
        if (station.trend.direction === 'up') {
            trendArrow = '↗';
            trendClass = 'trend-up';
        } else if (station.trend.direction === 'down') {
            trendArrow = '↘';
            trendClass = 'trend-down';
        }
        
        const formattedValue = station.parameterConfig.format(currentValue);
        const unit = station.parameterConfig.unit;
        
        const cardDiv = document.createElement('div');
        cardDiv.className = 'current-value-card';
        cardDiv.innerHTML = `
            <div class="station-header">
                <div class="station-name">${station.siteName}</div>
                <div class="station-id">Station ID: ${station.stationId}</div>
            </div>
            
            <div class="status-indicator ${statusClass}">
                ${statusText}
            </div>
            
            <div class="current-reading">
                <div class="current-value">${formattedValue}</div>
                <div class="current-unit">${unit}</div>
            </div>
            
            <div class="reading-time">
                Last updated: ${moment(readingTime).format('MMM DD, YYYY HH:mm')}
                <br>
                <small>(${moment(readingTime).fromNow()})</small>
            </div>
            
            <div class="trend-indicator">
                <span class="trend-arrow ${trendClass}">${trendArrow}</span>
                <span class="trend-text">${station.trend.text}</span>
            </div>
        `;
        
        currentValuesGrid.appendChild(cardDiv);
    });
}

async function fetchWithMultipleProxies(baseUrl) {
    const proxies = [
        {
            name: 'ThingProxy',
            url: `https://thingproxy.freeboard.io/fetch/${baseUrl}`,
            parseResponse: (data) => data
        },
        {
            name: 'CorsProxy.io',
            url: `https://corsproxy.io/?${encodeURIComponent(baseUrl)}`,
            parseResponse: (data) => data
        }
    ];
    
    let lastError;
    let attemptCount = 0;
    
    console.log(`🔍 Attempting to fetch USGS data using ${proxies.length} reliable proxy services...`);
    
    for (const proxy of proxies) {
        try {
            attemptCount++;
            console.log(`🔄 Attempt ${attemptCount}: Trying ${proxy.name}...`);
            
            const response = await fetch(proxy.url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            const parsedData = proxy.parseResponse(data);
            
            if (parsedData && (parsedData.value || parsedData.name)) {
                console.log(`✅ SUCCESS! Data fetched using: ${proxy.name}`);
                
                const fetchBtn = document.getElementById('fetchBtn');
                const originalText = displayMode === 'current' ? 'Fetch Current Values' : 'Fetch & Visualize Data';
                fetchBtn.textContent = `✅ Using ${proxy.name}`;
                setTimeout(() => {
                    fetchBtn.textContent = originalText;
                }, 2000);
                
                return parsedData;
            } else {
                throw new Error('Invalid response format');
            }
            
        } catch (error) {
            console.warn(`❌ ${proxy.name} failed: ${error.message}`);
            lastError = error;
            continue;
        }
    }
    
    console.error(`🚫 Both reliable proxy services failed!`);
    throw new Error(`All proxy services failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

function createIndividualCharts(stationData) {
    const chartsGrid = document.getElementById('chartsGrid');
    
    charts.forEach(chart => chart.destroy());
    charts = [];
    
    chartsGrid.innerHTML = '';
    
    stationData.forEach((station, index) => {
        const values = station.data.map(d => d.y);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const latest = values[values.length - 1];
        
        const paramConfig = station.parameterConfig;
        
        let alertsHtml = '';
        if (station.alerts.length > 0) {
            alertsHtml = `
                <div class="alerts-section">
                    <div class="alert-header">⚠️ RAPID INCREASE ALERTS (${station.alerts.length})</div>
                    ${station.alerts.slice(0, 3).map(alert => `
                        <div class="alert-item">
                            <strong>${moment(alert.startTime).format('MMM DD, HH:mm')} → ${moment(alert.time).format('HH:mm')}</strong>: 
                            ${paramConfig.format(alert.startValue)} → ${paramConfig.format(alert.value)} 
                            (+${alert.increase}% in ${alert.minutesDiff} min)
                        </div>
                    `).join('')}
                    ${station.alerts.length > 3 ? `<div class="alert-more">... and ${station.alerts.length - 3} more alerts</div>` : ''}
                </div>
            `;
        }
        
        const chartDiv = document.createElement('div');
        chartDiv.className = 'individual-chart';
        chartDiv.innerHTML = `
            <div class="chart-header">
                <div class="chart-title">${station.siteName}</div>
                <div class="chart-subtitle">Station ID: ${station.stationId} | ${station.parameterName}</div>
                ${alertsHtml}
                <div class="stats-info">
                    <div class="stat-item">
                        <div class="stat-value">${paramConfig.format(latest)}</div>
                        <div class="stat-label">Latest</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${paramConfig.format(avg)}</div>
                        <div class="stat-label">Average</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${paramConfig.format(min)}</div>
                        <div class="stat-label">Minimum</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${paramConfig.format(max)}</div>
                        <div class="stat-label">Maximum</div>
                    </div>
                </div>
            </div>
            <canvas id="chart-${index}" style="height: 300px;"></canvas>
        `;
        
        chartsGrid.appendChild(chartDiv);
        
        const ctx = document.getElementById(`chart-${index}`).getContext('2d');

        console.log(`📈 Creating chart for ${station.siteName} with dynamic Y-axis scaling`);

        const initialRenderData = decimateMinMax(station.data, MAX_RENDERED_POINTS);
        const initialPointStyles = buildPointStyles(initialRenderData, station.alerts, station.color);

        const chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: station.parameterName,
                    data: initialRenderData,
                    borderColor: station.color,
                    backgroundColor: station.color + '20',
                    fill: true,
                    tension: 0.3,
                    pointRadius: initialPointStyles.pointRadius,
                    pointBackgroundColor: initialPointStyles.pointBackgroundColor,
                    pointBorderColor: initialPointStyles.pointBorderColor,
                    pointBorderWidth: initialPointStyles.pointBorderWidth,
                    pointHoverRadius: 10,
                    borderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        mode: 'nearest',
                        intersect: false,
                        callbacks: {
                            title: function(context) {
                                return moment(context[0].parsed.x).format('MMM DD, YYYY HH:mm');
                            },
                            label: function(context) {
                                // Use the hovered point's own parsed value rather than indexing
                                // into station.data — the rendered dataset is decimated, so
                                // context.dataIndex does not line up with station.data's indices
                                const alerts = station.alerts.filter(alert =>
                                    Math.abs(alert.time.getTime() - context.parsed.x) < 60000
                                );

                                let label = `${station.parameterName}: ${paramConfig.format(context.parsed.y)}`;
                                if (alerts.length > 0) {
                                    label += ` ⚠️ ALERT: +${alerts[0].increase}% increase in ${alerts[0].minutesDiff}min`;
                                }
                                return label;
                            }
                        }
                    },
                    // Zoom and pan plugins
                    zoom: {
                        zoom: {
                            wheel: {
                                enabled: true,
                                speed: 0.05 // Reduced sensitivity
                            },
                            pinch: {
                                enabled: true
                            },
                            mode: 'x',
                            onZoomComplete: function({chart}) {
                                onChartViewChanged(chart);
                            }
                        },
                        pan: {
                            enabled: true,
                            mode: 'x',
                            threshold: 20, // Reduced sensitivity
                            onPanComplete: function({chart}) {
                                onChartViewChanged(chart);
                            }
                        },
                        // Set limits based on USGS data availability
                        limits: {
                            x: {
                                min: new Date('1889-01-01').getTime(), // USGS data availability start
                                max: new Date().getTime() // Current date/time
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            displayFormats: {
                                day: 'MMM DD',
                                hour: 'MMM DD HH:mm'
                            },
                            tooltipFormat: 'MMM DD, YYYY HH:mm'
                        },
                        title: {
                            display: true,
                            text: 'Date/Time (1889 - Present | Dynamic data loading)',
                            font: { weight: 'bold', size: 11 }
                        },
                        grid: {
                            color: 'rgba(0,0,0,0.05)'
                        },
                        ticks: {
                            maxTicksLimit: 8
                        }
                        // ENHANCED: No hard min/max - let chart auto-scale to data, limits only apply to zoom plugin
                    },
                    y: {
                        title: {
                            display: true,
                            text: station.parameterName,
                            font: { weight: 'bold', size: 12 }
                        },
                        grid: {
                            color: 'rgba(0,0,0,0.05)'
                        },
                        ticks: {
                            callback: function(value) {
                                return paramConfig.format(value);
                            }
                        }
                        // ENHANCED: No fixed min/max - let Y-axis auto-scale and update dynamically
                    }
                },
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                hover: {
                    animationDuration: 200
                },
                animation: {
                    duration: 1500,
                    easing: 'easeInOutQuart'
                }
            }
        });
        
        // Add zoom reset button
        const resetButton = document.createElement('button');
        resetButton.textContent = '🔍 Reset Zoom';
        resetButton.style.cssText = `
            position: absolute;
            top: 15px;
            right: 15px;
            padding: 8px 12px;
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 600;
            box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
            z-index: 1000;
        `;
        // resetZoom() has no completion callback (unlike onZoomComplete/onPanComplete), so
        // chart.scales.x isn't guaranteed to reflect the reset range on the very next line —
        // defer a tick so handleChartViewChange reads the settled post-reset scale. Routing
        // through handleChartViewChange (not renderVisibleWindow directly) also backfills any
        // data the reset range needs but isn't loaded yet, same as zoom/pan do.
        resetButton.onclick = function() {
            chart.resetZoom();
            setTimeout(() => handleChartViewChange(chart), 0);
            console.log('🔄 Chart zoom reset for', station.siteName);
        };

        chartDiv.style.position = 'relative';
        chartDiv.appendChild(resetButton);

        // Add double-click zoom reset
        ctx.canvas.addEventListener('dblclick', function() {
            chart.resetZoom();
            setTimeout(() => handleChartViewChange(chart), 0);
            console.log('🔄 Chart zoom reset via double-click for', station.siteName);
        });

        charts.push(chart);

        // If this station had a zoom window saved before a parameter switch, restore it and
        // let handleChartViewChange backfill whatever the new parameter is missing there.
        // Deferred a tick for the same reason as the reset handlers above — chart.scales.x
        // isn't guaranteed to reflect zoomScale's change on the very next line.
        const savedRange = zoomRestoreByStation[station.stationId];
        if (savedRange) {
            chart.zoomScale('x', savedRange, 'none');
            setTimeout(() => handleChartViewChange(chart), 0);
        }
    });

    zoomRestoreByStation = {};
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('📱 Application starting up...');
    
    // ENHANCED: Initialize date inputs to last 7 days (was 30 days)
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - (7 * 24 * 60 * 60 * 1000));
    
    const endDateElement = document.getElementById('endDate');
    const startDateElement = document.getElementById('startDate');
    
    if (endDateElement && startDateElement) {
        endDateElement.value = today.toISOString().split('T')[0];
        startDateElement.value = sevenDaysAgo.toISOString().split('T')[0];
        console.log('✅ Date inputs initialized to last 7 days');
    }
    
    // ENHANCED: Set up parameter change listener for interactive charting
    const parameterSelect = document.getElementById('parameterSelect');
    if (parameterSelect) {
        parameterSelect.addEventListener('change', window.onParameterChange);
        console.log('✅ Parameter change listener set up');
    }
    
    // Set up Enter key listener for station input
    const stationInput = document.getElementById('stationInput');
    if (stationInput) {
        stationInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                console.log('⌨️ Enter key pressed in station input');
                window.addStation();
            }
        });
        console.log('✅ Enter key listener set up');
    }
    
    // Test that the add button works
    const addBtn = document.getElementById('addBtn');
    if (addBtn) {
        console.log('✅ Add button found in DOM');
        console.log('🔧 Add button onclick:', addBtn.getAttribute('onclick'));
    } else {
        console.error('❌ Add button not found!');
    }
    
    // Initialize map when page loads
    setTimeout(() => {
        if (typeof L !== 'undefined') {
            initializeMap();
            console.log('✅ Map initialized successfully');
        } else {
            console.error('❌ Leaflet library not loaded - map will not work');
            const mapContainer = document.getElementById('mapContainer');
            if (mapContainer) {
                mapContainer.style.display = 'none';
            }
        }
    }, 100);
    
    console.log('✅ DOMContentLoaded setup complete');
});
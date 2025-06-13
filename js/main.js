// Global variables
let selectedStations = [];
let charts = [];
let map;
let stationMarkers = [];
let displayMode = 'timeseries'; // 'timeseries' or 'current'
let allStationData = []; // Store all fetched data for parameter switching
let stationDataRanges = {}

// ENHANCED: Force Y-axis recalculation as a backup method
function forceYAxisRecalculation(chart, stationData) {
    const xScale = chart.scales.x;
    const visibleStartTime = xScale.min;
    const visibleEndTime = xScale.max;
    
    // Filter data to only what's currently visible
    const visibleData = stationData.data.filter(point => {
        const pointTime = point.x.getTime();
        return pointTime >= visibleStartTime && pointTime <= visibleEndTime;
    });
    
    if (visibleData.length > 0) {
        const visibleValues = visibleData.map(d => d.y);
        const visibleMin = Math.min(...visibleValues);
        const visibleMax = Math.max(...visibleValues);
        const range = visibleMax - visibleMin;
        const padding = Math.max(range * 0.1, 0.1);
        
        const newYMin = Math.max(0, visibleMin - padding);
        const newYMax = visibleMax + padding;
        
        console.log(`🔧 FORCE Y-axis recalculation: ${newYMin.toFixed(2)} - ${newYMax.toFixed(2)}`);
        
        // Try the most aggressive approach - destroy and recreate the Y scale
        try {
            // Remove the current scale configuration
            delete chart.config.options.scales.y.min;
            delete chart.config.options.scales.y.max;
            
            // Set new limits
            chart.config.options.scales.y.min = newYMin;
            chart.config.options.scales.y.max = newYMax;
            
            // Force complete chart update
            chart.update('resize');
            
            console.log(`🔧 FORCE update complete: ${chart.scales.y.min.toFixed(2)} - ${chart.scales.y.max.toFixed(2)}`);
        } catch (error) {
            console.error('🔧 Force Y-axis update failed:', error);
        }
    }
}; // Store known data ranges for each station
let isDataFetching = false; // Prevent multiple simultaneous fetches
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

// ENHANCED: Recreate chart with new Y-axis range (nuclear option)
function updateYAxisForVisibleData(chart, stationData) {
    const xScale = chart.scales.x;
    const visibleStartTime = xScale.min;
    const visibleEndTime = xScale.max;
    
    // Filter data to only what's currently visible
    const visibleData = stationData.data.filter(point => {
        const pointTime = point.x.getTime();
        return pointTime >= visibleStartTime && pointTime <= visibleEndTime;
    });
    
    if (visibleData.length > 0) {
        const visibleValues = visibleData.map(d => d.y);
        const visibleMin = Math.min(...visibleValues);
        const visibleMax = Math.max(...visibleValues);
        const range = visibleMax - visibleMin;
        const padding = Math.max(range * 0.1, 0.1);
        
        const newYMin = Math.max(0, visibleMin - padding);
        const newYMax = visibleMax + padding;
        
        // Get current Y-axis range
        const currentYMin = chart.scales.y.min;
        const currentYMax = chart.scales.y.max;
        
        // Check if we need a significant change
        const minDiff = Math.abs(newYMin - currentYMin);
        const maxDiff = Math.abs(newYMax - currentYMax);
        const currentRange = currentYMax - currentYMin;
        const threshold = currentRange * 0.1; // 10% threshold for recreation
        
        if (minDiff > threshold || maxDiff > threshold) {
            console.log(`🔥 RECREATING CHART with new Y-axis: ${newYMin.toFixed(2)} - ${newYMax.toFixed(2)}`);
            console.log(`🔥 Previous Y-axis: ${currentYMin.toFixed(2)} - ${currentYMax.toFixed(2)}`);
            console.log(`🔥 Visible data: ${visibleMin.toFixed(2)} - ${visibleMax.toFixed(2)} (${visibleData.length} points)`);
            
            // Store current zoom state
            const currentXMin = xScale.min;
            const currentXMax = xScale.max;
            
            // Find the chart index
            const chartIndex = charts.indexOf(chart);
            if (chartIndex >= 0) {
                // Destroy the old chart
                chart.destroy();
                
                // Recreate the chart with new Y-axis range
                const canvas = document.getElementById(`chart-${chartIndex}`);
                const ctx = canvas.getContext('2d');
                
                const newChart = createSingleChart(ctx, stationData, chartIndex, newYMin, newYMax);
                
                // Restore zoom state
                setTimeout(() => {
                    newChart.zoomScale('x', {min: currentXMin, max: currentXMax}, 'none');
                }, 100);
                
                // Replace in charts array
                charts[chartIndex] = newChart;
                
                console.log(`✅ Chart recreated with Y-axis: ${newChart.scales.y.min.toFixed(2)} - ${newChart.scales.y.max.toFixed(2)}`);
            }
        }
    }
}

// ENHANCED: Create a single chart (extracted from createIndividualCharts)
function createSingleChart(ctx, station, index, yMin = null, yMax = null) {
    const values = station.data.map(d => d.y);
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    const range = dataMax - dataMin;
    const padding = range * 0.1;
    
    // Use provided Y-axis range or calculate from data
    const finalYMin = yMin !== null ? yMin : Math.max(0, dataMin - padding);
    const finalYMax = yMax !== null ? yMax : dataMax + padding;
    
    const paramConfig = station.parameterConfig;
    
    console.log(`📈 Creating chart for ${station.siteName} with Y-axis: ${finalYMin.toFixed(2)} - ${finalYMax.toFixed(2)}`);
    
    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: station.parameterName,
                data: station.data,
                borderColor: station.color,
                backgroundColor: station.color + '20',
                fill: true,
                tension: 0.3,
                pointRadius: station.data.map((point, idx) => {
                    const isAlert = station.alerts.some(alert => {
                        const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                        return timeDiff < 300000;
                    });
                    return isAlert ? 15 : 2;
                }),
                pointBackgroundColor: station.data.map((point, idx) => {
                    const isAlert = station.alerts.some(alert => {
                        const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                        return timeDiff < 300000;
                    });
                    return isAlert ? '#ff4757' : station.color;
                }),
                pointBorderColor: station.data.map((point, idx) => {
                    const isAlert = station.alerts.some(alert => {
                        const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                        return timeDiff < 300000;
                    });
                    return isAlert ? '#ffffff' : station.color;
                }),
                pointBorderWidth: station.data.map((point, idx) => {
                    const isAlert = station.alerts.some(alert => {
                        const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                        return timeDiff < 300000;
                    });
                    return isAlert ? 4 : 1;
                }),
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
                            const point = station.data[context.dataIndex];
                            const alerts = station.alerts.filter(alert => 
                                Math.abs(alert.time.getTime() - point.x.getTime()) < 60000
                            );
                            
                            let label = `${station.parameterName}: ${paramConfig.format(context.parsed.y)}`;
                            if (alerts.length > 0) {
                                label += ` ⚠️ ALERT: +${alerts[0].increase}% increase in ${alerts[0].minutesDiff}min`;
                            }
                            return label;
                        }
                    }
                },
                zoom: {
                    zoom: {
                        wheel: {
                            enabled: true,
                            speed: 0.05
                        },
                        pinch: {
                            enabled: true
                        },
                        mode: 'x',
                        onZoomComplete: function({chart}) {
                            console.log('🔍 Chart zoomed:', new Date(chart.scales.x.min), 'to', new Date(chart.scales.x.max));
                            
                            const stationIndex = charts.indexOf(chart);
                            if (stationIndex >= 0 && stationIndex < allStationData.length) {
                                setTimeout(() => {
                                    fetchAdditionalDataIfNeeded(chart, allStationData[stationIndex]);
                                }, 500);
                                
                                setTimeout(() => {
                                    updateYAxisForVisibleData(chart, allStationData[stationIndex]);
                                }, 100);
                            }
                        }
                    },
                    pan: {
                        enabled: true,
                        mode: 'x',
                        threshold: 20,
                        onPanComplete: function({chart}) {
                            console.log('👋 Chart panned:', new Date(chart.scales.x.min), 'to', new Date(chart.scales.x.max));
                            
                            const stationIndex = charts.indexOf(chart);
                            if (stationIndex >= 0 && stationIndex < allStationData.length) {
                                setTimeout(() => {
                                    fetchAdditionalDataIfNeeded(chart, allStationData[stationIndex]);
                                }, 500);
                                
                                setTimeout(() => {
                                    updateYAxisForVisibleData(chart, allStationData[stationIndex]);
                                }, 100);
                            }
                        }
                    },
                    limits: {
                        x: {
                            min: new Date('1889-01-01').getTime(),
                            max: new Date().getTime()
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
                },
                y: {
                    min: finalYMin,
                    max: finalYMax,
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
    
    return chart;
}
// ENHANCED: Dynamic data fetching based on chart zoom/pan
async function fetchAdditionalDataIfNeeded(chart, stationData) {
    if (isDataFetching || displayMode !== 'timeseries') {
        return false;
    }
    
    const currentViewStart = new Date(chart.scales.x.min);
    const currentViewEnd = new Date(chart.scales.x.max);
    const currentDataStart = new Date(Math.min(...stationData.data.map(d => d.x.getTime())));
    const currentDataEnd = new Date(Math.max(...stationData.data.map(d => d.x.getTime())));
    
    // Add buffer to prevent excessive refetching
    const bufferHours = 6;
    const startBuffer = new Date(currentDataStart.getTime() - (bufferHours * 60 * 60 * 1000));
    const endBuffer = new Date(currentDataEnd.getTime() + (bufferHours * 60 * 60 * 1000));
    
    let needsNewData = false;
    let newStartDate = null;
    let newEndDate = null;
    
    // Check if we need data before current range
    if (currentViewStart < startBuffer) {
        const minDate = new Date('1889-01-01'); // USGS data availability limit
        const stationMinDate = stationDataRanges[stationData.stationId]?.earliest || minDate;
        
        if (currentViewStart >= stationMinDate) {
            newStartDate = new Date(Math.max(currentViewStart.getTime() - (7 * 24 * 60 * 60 * 1000), stationMinDate.getTime()));
            newEndDate = currentDataStart;
            needsNewData = true;
        }
    }
    
    // Check if we need data after current range
    if (currentViewEnd > endBuffer) {
        const maxDate = new Date(); // Current date/time limit
        
        if (currentViewEnd <= maxDate) {
            newStartDate = currentDataEnd;
            newEndDate = new Date(Math.min(currentViewEnd.getTime() + (7 * 24 * 60 * 60 * 1000), maxDate.getTime()));
            needsNewData = true;
        }
    }
    
    if (needsNewData && newStartDate && newEndDate) {
        console.log(`🔄 Fetching additional data for ${stationData.stationId}: ${newStartDate.toISOString().split('T')[0]} to ${newEndDate.toISOString().split('T')[0]}`);
        
        isDataFetching = true;
        try {
            const parameter = document.getElementById('parameterSelect').value;
            const baseUrl = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${stationData.stationId}&parameterCd=${parameter}&startDT=${newStartDate.toISOString().split('T')[0]}&endDT=${newEndDate.toISOString().split('T')[0]}`;
            
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
                    // Merge new data with existing data and remove duplicates
                    const allData = [...stationData.data, ...newChartData];
                    const uniqueData = allData.reduce((acc, current) => {
                        const existingIndex = acc.findIndex(item => item.x.getTime() === current.x.getTime());
                        if (existingIndex === -1) {
                            acc.push(current);
                        }
                        return acc;
                    }, []);
                    
                    // Sort by timestamp
                    uniqueData.sort((a, b) => a.x.getTime() - b.x.getTime());
                    
                    // Update station data
                    stationData.data = uniqueData;
                    
                    // Update chart data
                    chart.data.datasets[0].data = uniqueData;
                    
                    // ENHANCED: Recalculate Y-axis range for new data
                    const allValues = uniqueData.map(d => d.y);
                    const newMin = Math.min(...allValues);
                    const newMax = Math.max(...allValues);
                    const range = newMax - newMin;
                    const padding = range * 0.1;
                    
                    chart.options.scales.y.min = Math.max(0, newMin - padding);
                    chart.options.scales.y.max = newMax + padding;
                    
                    // Recalculate alerts for new data
                    stationData.alerts = detectRapidIncrease(uniqueData);
                    
                    // Update point styling for alerts
                    updateChartPointStyling(chart, stationData);
                    
                    // Update the chart
                    chart.update('none'); // No animation for smoother experience
                    
                    console.log(`✅ Added ${newChartData.length} new data points for ${stationData.stationId}`);
                    return true;
                }
            }
        } catch (error) {
            console.error(`❌ Failed to fetch additional data for ${stationData.stationId}:`, error);
        } finally {
            isDataFetching = false;
        }
    }
    
    return false;
}

// ENHANCED: Update chart point styling after adding new data
function updateChartPointStyling(chart, stationData) {
    const dataset = chart.data.datasets[0];
    
    dataset.pointRadius = stationData.data.map((point, index) => {
        const isAlert = stationData.alerts.some(alert => {
            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
            return timeDiff < 300000;
        });
        return isAlert ? 15 : 2;
    });
    
    dataset.pointBackgroundColor = stationData.data.map((point, index) => {
        const isAlert = stationData.alerts.some(alert => {
            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
            return timeDiff < 300000;
        });
        return isAlert ? '#ff4757' : stationData.color;
    });
    
    dataset.pointBorderColor = stationData.data.map((point, index) => {
        const isAlert = stationData.alerts.some(alert => {
            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
            return timeDiff < 300000;
        });
        return isAlert ? '#ffffff' : stationData.color;
    });
    
    dataset.pointBorderWidth = stationData.data.map((point, index) => {
        const isAlert = stationData.alerts.some(alert => {
            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
            return timeDiff < 300000;
        });
        return isAlert ? 4 : 1;
    });
}
window.onParameterChange = function() {
    const parameter = document.getElementById('parameterSelect').value;
    console.log('📊 Parameter changed to:', parameter);
    
    // If we have existing data and are in time series mode, re-fetch for new parameter
    if (allStationData.length > 0 && displayMode === 'timeseries') {
        console.log('🔄 Re-fetching data for new parameter...');
        fetchDataAsync();
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
        
        // ENHANCED: Don't calculate fixed Y-axis range - let it be dynamic
        console.log(`📈 Creating chart for ${station.siteName} with dynamic Y-axis scaling`);
        
        const chart = new Chart(ctx, {
            type: 'line',
            data: {
                datasets: [{
                    label: station.parameterName,
                    data: station.data,
                    borderColor: station.color,
                    backgroundColor: station.color + '20',
                    fill: true,
                    tension: 0.3,
                    pointRadius: station.data.map((point, index) => {
                        const isAlert = station.alerts.some(alert => {
                            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                            return timeDiff < 300000;
                        });
                        return isAlert ? 15 : 2;
                    }),
                    pointBackgroundColor: station.data.map((point, index) => {
                        const isAlert = station.alerts.some(alert => {
                            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                            return timeDiff < 300000;
                        });
                        return isAlert ? '#ff4757' : station.color;
                    }),
                    pointBorderColor: station.data.map((point, index) => {
                        const isAlert = station.alerts.some(alert => {
                            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                            return timeDiff < 300000;
                        });
                        return isAlert ? '#ffffff' : station.color;
                    }),
                    pointBorderWidth: station.data.map((point, index) => {
                        const isAlert = station.alerts.some(alert => {
                            const timeDiff = Math.abs(alert.time.getTime() - point.x.getTime());
                            return timeDiff < 300000;
                        });
                        return isAlert ? 4 : 1;
                    }),
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
                                const point = station.data[context.dataIndex];
                                const alerts = station.alerts.filter(alert => 
                                    Math.abs(alert.time.getTime() - point.x.getTime()) < 60000
                                );
                                
                                let label = `${station.parameterName}: ${paramConfig.format(context.parsed.y)}`;
                                if (alerts.length > 0) {
                                    label += ` ⚠️ ALERT: +${alerts[0].increase}% increase in ${alerts[0].minutesDiff}min`;
                                }
                                return label;
                            }
                        }
                    },
                    // ENHANCED: Enable zoom and pan plugins
                    zoom: {
                        zoom: {
                            wheel: {
                                enabled: true,
                                speed: 0.05 // ENHANCED: Reduced sensitivity (was 0.1)
                            },
                            pinch: {
                                enabled: true
                            },
                            mode: 'x',
                            onZoomComplete: function({chart}) {
                                console.log('🔍 Chart zoomed:', new Date(chart.scales.x.min), 'to', new Date(chart.scales.x.max));
                                
                                // ENHANCED: Fetch additional data if needed
                                const stationIndex = charts.indexOf(chart);
                                if (stationIndex >= 0 && stationIndex < allStationData.length) {
                                    setTimeout(() => {
                                        fetchAdditionalDataIfNeeded(chart, allStationData[stationIndex]);
                                    }, 500); // Small delay to prevent excessive calls
                                    
                                    // ENHANCED: Update Y-axis for currently visible data
                                    setTimeout(() => {
                                        updateYAxisForVisibleData(chart, allStationData[stationIndex]);
                                    }, 100); // Quick update for Y-axis
                                    
                                    // ENHANCED: Force Y-axis recalculation after a longer delay
                                    setTimeout(() => {
                                        forceYAxisRecalculation(chart, allStationData[stationIndex]);
                                    }, 1000); // Secondary attempt after data settling
                                    
                                    // ENHANCED: Force Y-axis recalculation after a longer delay
                                    setTimeout(() => {
                                        forceYAxisRecalculation(chart, allStationData[stationIndex]);
                                    }, 1000); // Secondary attempt after data settling
                                }
                            }
                        },
                        pan: {
                            enabled: true,
                            mode: 'x',
                            threshold: 20, // ENHANCED: Increased threshold for less sensitive panning
                            onPanComplete: function({chart}) {
                                console.log('👋 Chart panned:', new Date(chart.scales.x.min), 'to', new Date(chart.scales.x.max));
                                
                                // ENHANCED: Fetch additional data if needed
                                const stationIndex = charts.indexOf(chart);
                                if (stationIndex >= 0 && stationIndex < allStationData.length) {
                                    setTimeout(() => {
                                        fetchAdditionalDataIfNeeded(chart, allStationData[stationIndex]);
                                    }, 500); // Small delay to prevent excessive calls
                                    
                                    // ENHANCED: Update Y-axis for currently visible data
                                    setTimeout(() => {
                                        updateYAxisForVisibleData(chart, allStationData[stationIndex]);
                                    }, 100); // Quick update for Y-axis
                                }
                            }
                        },
                        // ENHANCED: Set limits based on data availability
                        limits: {
                            x: {
                                min: new Date('1889-01-01').getTime(), // USGS data availability start
                                max: new Date().getTime() // Current date/time
                            }
                        }
                        // ENHANCED: Removed limits to allow panning/zooming beyond initial date range
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
        resetButton.onclick = function() {
            chart.resetZoom();
            console.log('🔄 Chart zoom reset for', station.siteName);
        };
        
        chartDiv.style.position = 'relative';
        chartDiv.appendChild(resetButton);
        
        // Add double-click zoom reset
        ctx.canvas.addEventListener('dblclick', function() {
            chart.resetZoom();
            console.log('🔄 Chart zoom reset via double-click for', station.siteName);
        });
        
        charts.push(chart);
    });
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
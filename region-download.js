/* OpenStreetMap region exports, compatible with Single photo's loadOsm.
 * Geometry conversion: vendored osmtogeojson 3.0.0-beta.5 (MIT). */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  function queryFor(bounds) {
    const [west, south, east, north] = bounds;
    if (!bounds.every(Number.isFinite) || west < -180 || east > 180 ||
        south < -85 || north > 85 || west >= east || south >= north) {
      throw new Error('Choose a region within the map, away from the date line and poles.');
    }
    const height = (north - south) * 111.2;
    const width = (east - west) * 111.2 * Math.cos((south + north) * Math.PI / 360);
    if (height > 20 || width > 20) throw new Error('Zoom in: choose a region less than 20 km across in each direction.');
    return `[out:json][timeout:30][maxsize:33554432];nwr(${south},${west},${north},${east});out geom;`;
  }
  function toGeoJSON(data, bounds) {
    if (data.remark) throw new Error('The map service could not complete this region. Try a smaller area or retry later.');
    if (!Array.isArray(data.elements)) throw new Error('The map service returned an invalid response.');
    // Keep tags flat so existing matching can read entrance, door, building,
    // highway, amenity, indoor, level, etc. directly from properties.
    const converted = window.osmtogeojson(data, {flatProperties: true,
      uninterestingTags: tags => !tags || Object.keys(tags).length === 0});
    const features = converted.features;
    for (const feature of features) {
      const [type, id] = feature.id.split('/');
      feature.properties.osm_id = Number(id);
      feature.properties.osm_type = type;
    }
    return {type: 'FeatureCollection', features,
      source: 'OpenStreetMap contributors', license: 'ODbL-1.0',
      attribution: 'https://www.openstreetmap.org/copyright',
      // Complete ways can extend outside this selection; this is not a GeoJSON bbox.
      selection_bbox: bounds.slice(), exported_at: new Date().toISOString()};
  }
  let map, preview, selection, result, controller, onUse;
  function status(message, error = false) {
    $('regionStatus').textContent = message;
    $('regionStatus').classList.toggle('status-error', error);
  }
  function boundsNow() {
    const b = map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
  function updateBounds() {
    $('regionBounds').textContent = `Visible bounds (west, south, east, north): ${boundsNow().map(n => n.toFixed(5)).join(', ')}. The outlined region marks the loaded data.`;
  }
  function init() {
    map = window.L.map('regionMap', {maxZoom: 22, worldCopyJump: true}).setView([51.5074, -0.1278], 15);
    window.MGMaps.addBasemaps(map, 'regionMap');
    new ResizeObserver(() => map.invalidateSize()).observe($('regionMap'));
    map.on('moveend', updateBounds);
    updateBounds();
    $('regionGo').addEventListener('submit', event => {
      event.preventDefault();
      map.setView([Number($('regionLat').value), Number($('regionLon').value)], 15);
    });
    $('regionCancel').addEventListener('click', () => controller?.abort());
    $('regionLoad').addEventListener('click', async () => {
      let query, bounds = boundsNow();
      try { query = queryFor(bounds); } catch (error) { status(error.message, true); return; }
      controller = new AbortController();
      const request = controller;
      const timeout = setTimeout(() => request.abort(), 45000);
      $('regionLoad').disabled = true;
      $('regionCancel').hidden = false;
      $('regionDownload').disabled = $('regionUse').disabled = true;
      if (preview) { map.removeLayer(preview); preview = null; }
      if (selection) { map.removeLayer(selection); selection = null; }
      result = null;
      status('Loading all mapped features for the selected region…');
      try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST', body: new URLSearchParams({data: query}), signal: request.signal
        });
        if (!response.ok) throw new Error(`Map service returned HTTP ${response.status}. Retry shortly or choose a smaller area.`);
        const geojson = toGeoJSON(await response.json(), bounds);
        if (!geojson.features.length) { status('No mapped features found here. Choose another region.'); return; }
        preview = window.L.geoJSON(geojson, {
          style: {color: '#f59e0b', weight: 2, fillOpacity: 0.12},
          pointToLayer: (_feature, latlng) => window.L.circleMarker(latlng,
            {radius: 4, color: '#38bdf8', weight: 1, fillOpacity: 0.8}),
          onEachFeature: (feature, layer) => {
            const text = document.createElement('div');
            text.style.whiteSpace = 'pre-wrap';
            text.textContent = `${feature.id}\n` + Object.entries(feature.properties)
              .map(([key, value]) => `${key}=${value}`).join('\n');
            layer.bindPopup(text);
          }
        }).addTo(map);
        selection = window.L.rectangle([[bounds[1], bounds[0]], [bounds[3], bounds[2]]],
          {color: '#38bdf8', weight: 2, fill: false, dashArray: '6 4', interactive: false}).addTo(map);
        result = geojson;
        $('regionDownload').disabled = $('regionUse').disabled = false;
        const incomplete = geojson.features.filter(f => f.properties.tainted).length;
        status(`${geojson.features.length} mapped features loaded for the outlined region. Download the GeoJSON or use it in Single photo.` +
          (incomplete ? ` ${incomplete} features have incomplete geometry, marked tainted in the file.` : ''));
      } catch (error) {
        status(error.name === 'AbortError' ? 'Loading cancelled or timed out. You can retry.' :
          `Could not load mapped features: ${error.message}`, true);
      } finally {
        clearTimeout(timeout);
        controller = null;
        $('regionLoad').disabled = false;
        $('regionCancel').hidden = true;
      }
    });
    $('regionDownload').addEventListener('click', () => {
      if (!result) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], {type: 'application/geo+json'}));
      const a = document.createElement('a');
      a.href = url;
      a.download = `osm-features-${result.selection_bbox.map(n => n.toFixed(4)).join('_')}.geojson`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      status(`Downloaded ${result.features.length} mapped features as GeoJSON.`);
    });
    $('regionUse').addEventListener('click', () => { if (result) onUse(result); });
  }
  window.MGRegion = {queryFor, toGeoJSON, open(use) {
    onUse = use;
    if (!map) init();
    map.invalidateSize();
  }};
})();

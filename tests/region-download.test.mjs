// Export conversion and the load / preview / download / Single photo handoff.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {Blob} from 'node:buffer';

const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    disabled: true, hidden: false, textContent: '', handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    classList: {toggle() {}}, click() { this.clicked = true; }
  });
  return elements.get(id);
};
let bounds = [-0.13, 51.50, -0.12, 51.51], response, request, download, used;
const map = {setView() { return this; }, invalidateSize() {}, on() {}, removeLayer() {},
  getBounds() { return {getWest: () => bounds[0], getSouth: () => bounds[1],
    getEast: () => bounds[2], getNorth: () => bounds[3]}; }};
const layer = {addTo() { return this; }};
const context = vm.createContext({window: {MGMaps: {addBasemaps() {}}, L: {
  map: () => map, geoJSON: () => layer, rectangle: () => layer}},
  document: {getElementById: element, createElement: () => (download = element('anchor'))},
  ResizeObserver: class {observe() {}}, URLSearchParams, AbortController, Blob,
  URL: {createObjectURL: () => 'blob:test', revokeObjectURL() {}},
  setTimeout: () => 1, clearTimeout() {},
  fetch: async (url, options) => { request = {url, options}; return response; }});
vm.runInContext(readFileSync(new URL('../vendor/osmtogeojson.js', import.meta.url), 'utf8'), context);
vm.runInContext(readFileSync(new URL('../region-download.js', import.meta.url), 'utf8'), context);
const {queryFor, toGeoJSON, open} = context.window.MGRegion;
assert.match(queryFor(bounds), /nwr\(51.5,-0.13,51.51,-0.12\);out geom;/);
assert.throws(() => queryFor([-1, 50, 1, 52]), /Zoom in/);
assert.throws(() => queryFor([179, 50, 181, 51]), /date line/);
assert.throws(() => queryFor([NaN, 50, 1, 51]), /region/);
const data = {elements: [
  {type: 'way', id: 123, nodes: [1, 2], tags: {highway: 'footway', name: 'Test path', surface: 'paved'},
    geometry: [{lat: 51.501, lon: -0.129}, {lat: 51.502, lon: -0.128}]},
  {type: 'node', id: 125, tags: {highway: 'crossing'}, lat: 51.5, lon: -0.12},
  {type: 'node', id: 126, tags: {entrance: 'main', door: 'hinged', indoor: 'door', level: '0'}, lat: 51.501, lon: -0.128},
  {type: 'node', id: 127, tags: {amenity: 'bench', name: '<img src=x onerror=alert(1)>'}, lat: 51.501, lon: -0.127},
  {type: 'way', id: 128, nodes: [10, 11, 12, 13, 10], tags: {building: 'yes', name: 'Test building'},
    geometry: [{lat: 51.501, lon: -0.129}, {lat: 51.501, lon: -0.128}, {lat: 51.502, lon: -0.128}, {lat: 51.502, lon: -0.129}, {lat: 51.501, lon: -0.129}]},
  {type: 'relation', id: 129, tags: {type: 'multipolygon', building: 'school', name: 'Courtyard building'}, members: [
    {type: 'way', ref: 130, role: 'outer', geometry: [{lat: 51.503, lon: -0.129}, {lat: 51.503, lon: -0.125}, {lat: 51.507, lon: -0.125}, {lat: 51.507, lon: -0.129}, {lat: 51.503, lon: -0.129}]},
    {type: 'way', ref: 131, role: 'inner', geometry: [{lat: 51.504, lon: -0.128}, {lat: 51.504, lon: -0.126}, {lat: 51.506, lon: -0.126}, {lat: 51.506, lon: -0.128}, {lat: 51.504, lon: -0.128}]}
  ]}
]};
const converted = toGeoJSON(data, bounds);
const byId = id => converted.features.find(f => f.id === id);
assert.equal(converted.features.length, 6);
assert.equal(byId('way/123').properties.highway, 'footway');
assert.equal(byId('way/123').properties.name, 'Test path');
assert.equal(JSON.stringify(byId('way/123').geometry.coordinates[0]), '[-0.129,51.501]');
assert.equal(byId('node/126').geometry.type, 'Point');
assert.equal(byId('node/126').properties.door, 'hinged');
assert.equal(byId('node/126').properties.level, '0');
assert.equal(byId('way/128').geometry.type, 'Polygon');
assert.equal(byId('relation/129').geometry.type, 'Polygon');
assert.equal(byId('relation/129').geometry.coordinates.length, 2, 'courtyard hole must survive');
const multiBuilding = JSON.parse(JSON.stringify(data.elements.find(e => e.id === 129)));
multiBuilding.members.push({type: 'way', ref: 132, role: 'outer', geometry: [
  {lat: 51.508, lon: -0.129}, {lat: 51.508, lon: -0.128}, {lat: 51.509, lon: -0.128},
  {lat: 51.509, lon: -0.129}, {lat: 51.508, lon: -0.129}
]});
const multi = toGeoJSON({elements: [multiBuilding]}, bounds).features[0];
assert.equal(multi.geometry.type, 'MultiPolygon');
assert.equal(multi.geometry.coordinates.length, 2, 'separate building parts must survive');
const route = toGeoJSON({elements: [{type: 'relation', id: 200,
  tags: {type: 'route', route: 'hiking', name: 'Walking route'}, members: [
    {type: 'way', ref: 201, role: '', geometry: [{lat: 51.501, lon: -0.129}, {lat: 51.502, lon: -0.128}]}
  ]}]}, bounds).features.find(f => f.id === 'relation/200');
assert.equal(route.properties.route, 'hiking');
assert.ok(['LineString', 'MultiLineString'].includes(route.geometry.type));
assert.throws(() => toGeoJSON({elements: [], remark: 'timeout'}, bounds), /could not complete/);
assert.throws(() => toGeoJSON({}, bounds), /invalid response/);

// Feed the exported file into the real Single photo loader.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('  function loadOsm(obj) {');
const end = app.indexOf('\n  if (osmFile)', start);
vm.runInContext('let osmData;\n' + app.slice(start, end), context);
context.geojson = converted;
vm.runInContext('loadOsm(geojson)', context);
assert.equal(vm.runInContext('osmData.lines.find(l => l.tags.highway).tags.highway', context), 'footway');
assert.equal(vm.runInContext('osmData.lines.length', context), 4);
assert.equal(vm.runInContext('osmData.points.find(p => p.tags.door).tags.entrance', context), 'main');
assert.equal(vm.runInContext('osmData.lines.find(l => l.tags.name === "Test building").tags.building', context), 'yes');

open(geojson => { used = geojson; });
response = {ok: true, json: async () => data};
await element('regionLoad').handlers.click();
assert.equal(request.options.method, 'POST');
assert.match(request.options.body.get('data'), /nwr\(/);
assert.equal(element('regionDownload').disabled, false);
element('regionDownload').handlers.click();
assert.match(download.download, /^osm-features-.*\.geojson$/);
assert.equal(download.clicked, true);
element('regionUse').handlers.click();
assert.equal(used.features.find(f => f.id === 'way/123').properties.highway, 'footway');
response = {ok: false, status: 429};
await element('regionLoad').handlers.click();
assert.match(element('regionStatus').textContent, /HTTP 429/);
assert.equal(element('regionDownload').disabled, true);
assert.equal(element('regionLoad').disabled, false);
response = {ok: true, json: async () => ({elements: []})};
await element('regionLoad').handlers.click();
assert.match(element('regionStatus').textContent, /No mapped features/);
assert.equal(element('regionUse').disabled, true);
context.fetch = async (_url, {signal}) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {name: 'AbortError'})));
});
const cancelled = element('regionLoad').handlers.click();
element('regionCancel').handlers.click();
await cancelled;
assert.match(element('regionStatus').textContent, /cancelled or timed out/);
assert.equal(element('regionCancel').hidden, true);
assert.equal(element('regionLoad').disabled, false);
assert.equal(element('regionDownload').disabled, true);
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /data-workflow="region-download"/);
assert.match(html, /src="region-download.js"/);
assert.match(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), /"\.\/region-download.js"/);
console.log('Region export, download and Single photo compatibility checks passed.');

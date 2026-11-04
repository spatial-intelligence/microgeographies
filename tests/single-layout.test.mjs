// Layout contract for the single-photo console (index.html + styles.css).
//
// Single mode is a fixed console: five workflow cards in a top strip and
// a view stage below (photo + depth left, map right) with no page scroll.
// Narrow screens unfold back into the stacked scrolling page. A manual
// location override is per-photo: picking a new photo clears it so a
// drag-correction from a previous image cannot hijack the new EXIF.
// Runs on plain node with no dependencies:
//
//   node tests/single-layout.test.mjs
import assert from 'assert';
import {readFileSync} from 'fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

const ids = [];
for (const m of html.matchAll(/ id="([^"]+)"/g)) ids.push(m[1]);

// Ancestry: scan tags, tracking only container elements that this page
// always closes explicitly (div/aside/section/main). Other tags with ids
// record the container stack at their position.
const CONTAINERS = {div: 1, aside: 1, section: 1, main: 1};
const VOID = {meta: 1, link: 1, input: 1, img: 1, br: 1, hr: 1, source: 1};
const stack = [];
const ancestors = new Map(); // id-or-class key -> ancestor descriptor list
function record(key) { ancestors.set(key, stack.slice()); }
for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)(\s[^>]*)?>/g)) {
  const close = m[1] === '/';
  const tag = m[2].toLowerCase();
  const attrs = m[3] || '';
  if (VOID[tag]) continue;
  if (close) {
    if (CONTAINERS[tag]) stack.pop();
    continue;
  }
  const id = (attrs.match(/ id="([^"]+)"/) || [])[1];
  const cls = (attrs.match(/ class="([^"]+)"/) || [])[1] || '';
  if (id) record('#' + id);
  for (const c of ['console-left', 'console-right']) {
    if ((' ' + cls + ' ').indexOf(' ' + c + ' ') !== -1) record('.' + c);
  }
  if (CONTAINERS[tag]) stack.push({tag: tag, id: id || '', cls: cls});
}
function anc(key) {
  const a = ancestors.get(key);
  assert.ok(a, 'no element found for ' + key);
  return a;
}
function hasClass(a, c) { return a.some((x) => (' ' + x.cls + ' ').indexOf(' ' + c + ' ') !== -1); }
function hasId(a, id) { return a.some((x) => x.id === id); }

// Stage grouping: photo + depth left, map right, all inside #secStage.
assert.ok(hasId(anc('#photoCanvas'), 'secStage'), '#photoCanvas must sit in #secStage');
assert.ok(hasClass(anc('#photoCanvas'), 'console-left'), '#photoCanvas must sit in .console-left');
assert.ok(hasId(anc('#depthCanvas'), 'secStage'), '#depthCanvas must sit in #secStage');
assert.ok(hasClass(anc('#depthCanvas'), 'console-left'), '#depthCanvas must sit in .console-left');
assert.ok(hasId(anc('#map'), 'secStage'), '#map must sit in #secStage');
assert.ok(hasClass(anc('#map'), 'console-right'), '#map must sit in .console-right');
assert.ok(hasId(anc('.console-left'), 'secStage'), '.console-left must sit in #secStage');
assert.ok(hasId(anc('.console-right'), 'secStage'), '.console-right must sit in #secStage');
// Workflow cards stay top-level sections in main, never inside the stage.
for (const id of ['secPhoto', 'secObjects', 'secDetector', 'secResults', 'secMatch']) {
  assert.ok(!hasId(anc('#' + id), 'secStage'), '#' + id + ' must not sit in #secStage');
  assert.equal(anc('#' + id).slice(-1)[0].tag, 'main', '#' + id + ' must sit in main');
}
assert.ok(ids.indexOf('secLoc') === -1, 'secLoc was merged into the location dialog');
// Setup/location dialogs, EXPORT menu, map-match, measure, hover tip exist.
assert.ok(html.indexOf('<dialog id="cfgDlg"') !== -1, 'missing #cfgDlg setup dialog');
assert.ok(html.indexOf('<dialog id="locDlg"') !== -1, 'missing #locDlg location dialog');
for (const id of ['exportMenu', 'exportGeoBtn', 'exportPngBtn', 'osmFile', 'matchTol',
                  'snapPath', 'matchOut', 'matchList', 'measureBtn', 'hoverTip',
                  'detectorSummary', 'locState']) {
  assert.ok(ids.indexOf(id) !== -1, 'missing #' + id + ' in index.html');
}
assert.ok(ids.indexOf('pngBtn') === -1, 'pngBtn was merged into the EXPORT menu');

// Console CSS: fixed viewport grid, strip over a 3x stage, two-col stage.
function baseRule(selector) {
  const i = css.indexOf(selector + ' {');
  assert.ok(i !== -1, 'missing base CSS rule ' + selector);
  return css.slice(i, css.indexOf('}', i));
}
const console = baseRule('body[data-mode="single"]');
assert.ok(console.indexOf('height: 100vh') !== -1, 'console must fill the viewport, got: ' + console);
assert.ok(console.indexOf('overflow: hidden') !== -1, 'console must not page-scroll, got: ' + console);
const consoleMain = baseRule('body[data-mode="single"] main');
assert.ok(consoleMain.indexOf('display: grid') !== -1, 'console main must be display: grid');
assert.ok(consoleMain.indexOf('minmax(0, 3fr)') !== -1, 'stage row must outweigh the strip, got: ' + consoleMain);
const stage = baseRule('body[data-mode="single"] #secStage');
assert.ok(stage.indexOf('grid-template-columns: 1fr 1fr') !== -1, 'stage must split left/right, got: ' + stage);
assert.ok(baseRule('.console-left').indexOf('display: grid') !== -1, '.console-left must be display: grid');
// Narrow screens unfold into the scrolling page.
const narrow = css.indexOf('@media (max-width: 950px)');
assert.ok(narrow !== -1, 'missing narrow-screen console media query');
const narrowCss = css.slice(narrow, narrow + 3000);
assert.ok(narrowCss.indexOf('.console-left') !== -1, 'narrow query must restyle .console-left');
assert.ok(narrowCss.indexOf('display: block') !== -1, 'narrow query must un-grid the console');

// app.js wiring: mode dataset, stage section, map re-measure.
assert.ok(app.indexOf('document.body.dataset.mode = mode') !== -1, 'setMode must publish body dataset.mode');
assert.ok(app.indexOf('"secStage"') !== -1, 'single mode must include the secStage section');
assert.ok(app.indexOf('invalidateSize') !== -1, 'single mode must re-measure the Leaflet map');
// Stale-override fix: a new photo clears the previous manual location.
assert.ok(app.indexOf('manualLat.value = ""') !== -1, 'picking a photo must clear the manual override');
assert.ok(app.indexOf('manualClearedNote') !== -1, 'the clear must be announced in the EXIF verdict');
// v0.22: prompt geometry, map-match engine, snap-to-path, measure, hover.
for (const fn of ['parsePrompts', 'geomsField', 'loadOsm', 'matchOsm', 'snapToPath',
                  'updateOsm', 'setMeasuring', 'showTip', 'effPin', 'effEnds']) {
  assert.ok(app.indexOf('function ' + fn + '(') !== -1, 'app.js must define ' + fn + '()');
}
const basemaps = readFileSync(new URL('../map-basemaps.js', import.meta.url), 'utf8');
assert.ok(basemaps.includes('World_Imagery'), 'maps must offer Esri aerial imagery');
for (const name of ['Light gray', 'Dark gray']) assert.ok(basemaps.includes(name), `maps must offer ${name}`);
assert.ok(basemaps.includes('maxNativeZoom'), 'maps must upscale tiles past native zoom');
// EXPORT menu + match list styling contracts.
assert.ok(baseRule('.export-menu').indexOf('position: absolute') !== -1, '.export-menu must float');
const matchList = baseRule('#matchList');
assert.ok(matchList.indexOf('max-height') !== -1, '#matchList must cap its height, got: ' + matchList);
assert.ok(matchList.indexOf('overflow') !== -1, '#matchList must scroll, got: ' + matchList);
assert.ok(baseRule('.mg-dlg').indexOf('max-height') !== -1, '.mg-dlg must cap its height');

// v0.23: photo+video workflow is its own section + mode, additive only.
assert.ok(!hasId(anc('#secVideo'), 'secStage'), '#secVideo must not sit in #secStage');
assert.equal(anc('#secVideo').slice(-1)[0].tag, 'main', '#secVideo must sit in main');
for (const id of ['videoZip', 'videoConcepts', 'videoDetector', 'videoToken',
                  'videoSnap', 'videoBtn', 'videoOut', 'videoView', 'videoPopup',
                  'videoFeatures', 'videoExportBtn', 'videoMap']) {
  assert.ok(ids.indexOf(id) !== -1, 'missing #' + id + ' in index.html');
}
assert.ok(app.indexOf('"set-video"') !== -1, 'mode switcher must offer set-video');
assert.ok(app.indexOf('/api/video-cloud') !== -1, 'video run must post to /api/video-cloud');
assert.ok(app.indexOf('renderVideoResult') !== -1, 'video result renderer must exist');

export const singleLayoutChecksPassed = true;

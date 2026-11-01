// Layout contract for the 3D stage (index.html + styles.css).
//
// The Display / minimap / telemetry panels and the icon toolbar live in a
// static side console OUTSIDE the 3D viewport: nothing floats over the
// canvas except the empty-state note and the (legacy, hidden) popup.
// Runs on plain node with no dependencies:
//
//   node tests/sfm-layout.test.mjs
import assert from 'assert';
import {readFileSync} from 'fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

// Every id is unique (the DOM was regrouped; duplicates would rewire $()).
const ids = [];
for (const m of html.matchAll(/ id="([^"]+)"/g)) ids.push(m[1]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
assert.deepEqual(dupes, [], 'duplicate ids in index.html: ' + dupes.join(', '));

// Every $("id") lookup in app.js resolves to an element in index.html.
const refs = new Set();
for (const m of app.matchAll(/\$\("([^"]+)"\)/g)) refs.add(m[1]);
assert.ok(refs.size > 0, 'no $("...") lookups found in app.js');
for (const id of refs) {
  assert.ok(ids.indexOf(id) !== -1, 'app.js references missing #' + id);
}

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
  for (const c of ['sfm-stage', 'sfm-side', 'hud-left', 'hud-right']) {
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

// Viewport + side console inside the stage; panels inside the console.
assert.ok(hasClass(anc('#sfmViewWrap'), 'sfm-stage'), '#sfmViewWrap must sit in .sfm-stage');
assert.ok(hasClass(anc('.sfm-side'), 'sfm-stage'), '.sfm-side must sit in .sfm-stage');
assert.ok(hasClass(anc('.hud-left'), 'sfm-side'), 'Display panel must sit in .sfm-side');
assert.ok(hasClass(anc('.hud-right'), 'sfm-side'), 'minimap panel must sit in .sfm-side');
// Toolbar is a sibling bar above the stage, not an overlay inside it.
assert.ok(hasId(anc('#sfmToolbar'), 'sfmWrap'), '#sfmToolbar must sit in #sfmWrap');
assert.ok(!hasClass(anc('#sfmToolbar'), 'sfm-stage'), '#sfmToolbar must not sit in .sfm-stage');
// Empty-state note + popup anchor to the viewport itself.
assert.equal(anc('#sfmEmpty').slice(-1)[0].id, 'sfmViewWrap', '#sfmEmpty must be inside #sfmViewWrap');
assert.equal(anc('#sfmPopup').slice(-1)[0].id, 'sfmViewWrap', '#sfmPopup must be inside #sfmViewWrap');
assert.ok(hasId(anc('#sfmExportDlg'), 'sfmWrap'), '#sfmExportDlg must sit in #sfmWrap');

// Panels and toolbar are in normal flow, not absolutely positioned overlays.
function baseRule(selector) {
  const i = css.indexOf(selector + ' {');
  assert.ok(i !== -1, 'missing base CSS rule ' + selector);
  return css.slice(i, css.indexOf('}', i));
}
for (const selector of ['.hud-panel', '.sfm-toolbar']) {
  const rule = baseRule(selector);
  assert.ok(rule.indexOf('position: static') !== -1, selector + ' must be position: static, got: ' + rule);
  assert.ok(rule.indexOf('absolute') === -1, selector + ' must not be absolutely positioned');
}
// Stage is a two-column grid on desktop, stacked under the narrow breakpoint.
assert.ok(baseRule('.sfm-stage').indexOf('display: grid') !== -1, '.sfm-stage must be display: grid');
// SAM label list is capped + scrollable so it never pushes the 3D view down.
const samList = baseRule('#sfmSamList');
assert.ok(samList.indexOf('max-height') !== -1, '#sfmSamList must cap its height, got: ' + samList);
assert.ok(samList.indexOf('overflow') !== -1, '#sfmSamList must scroll, got: ' + samList);
// Theatre mode: expanding widens the stage in normal flow, never a
// fullscreen fixed takeover, and never locks vertical page scroll.
const expanded = baseRule('.sfm-wrap.expanded');
assert.ok(expanded.indexOf('fixed') === -1, '.sfm-wrap.expanded must not be fixed, got: ' + expanded);
assert.ok(expanded.indexOf('100vw') !== -1, '.sfm-wrap.expanded must break toward viewport width, got: ' + expanded);
const bodyLock = baseRule('.viewer-expanded');
assert.ok(bodyLock.indexOf('overflow: hidden') === -1, '.viewer-expanded must not lock page scroll, got: ' + bodyLock);
const narrow = css.indexOf('@media (max-width: 700px)');
assert.ok(narrow !== -1, 'missing narrow-screen media query');
assert.ok(
  css.slice(narrow, narrow + 1200).indexOf('.sfm-stage') !== -1,
  'narrow-screen query must restyle .sfm-stage'
);

export const layoutChecksPassed = true;

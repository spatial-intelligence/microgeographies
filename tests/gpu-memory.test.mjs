import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('  $("clearGpuBtn").addEventListener');
const end = app.indexOf('  if (locClose)', start);
assert.ok(start > 0 && end > start);
let click, request, response;
const button = {addEventListener(_event, handler) { click = handler; }};
const status = {textContent: '', classList: {remove() {}, add() {}}};
const context = vm.createContext({$: id => id === 'clearGpuBtn' ? button : status,
  fetch: async (url, options) => { request = {url, options}; return response; }});
vm.runInContext(app.slice(start, end), context);
response = {ok: true, json: async () => ({ok: true, cuda_available: true,
  released_bytes: 1024 * 1048576, reserved_bytes: 0})};
await click();
assert.equal(request.url, '/api/gpu/clear');
assert.equal(request.options.method, 'POST');
assert.match(status.textContent, /Released 1024 MB/);
assert.equal(button.disabled, false);
response = {ok: false, status: 409, json: async () => ({detail: 'A processing job is still active.'})};
await click();
assert.match(status.textContent, /still active/);
assert.equal(button.disabled, false);
response = {ok: false, status: 404, json: async () => ({})};
await click();
assert.match(status.textContent, /Restart the backend/);
context.fetch = async () => { throw new Error('Network unavailable'); };
await click();
assert.match(status.textContent, /Network unavailable/);
assert.equal(button.disabled, false);
console.log('Settings GPU cleanup button checks passed.');

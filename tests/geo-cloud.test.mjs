import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {geographicPoint} from '../geo-cloud.js';

const code=readFileSync(new URL('../sfm3d.js',import.meta.url),'utf8')
  .replace(/^import[^\n]+\r?\n/gm,'')
  .replace(/^export\s*\{[^\n]+\r?\n/gm,'')
  .replace(/export function/g,'function');
const {buildGeoJson}=new vm.Script(`(()=>{${code}; return {buildGeoJson};})()`)
  .runInNewContext({geographicPoint});
const positions=new Float32Array([10,20,30]);
const colors=new Float32Array([1,.5,0]);
const reference={origin:{lat:51.5,lon:-.125,altitude_m:100},
  matrix:[[1,0,0],[0,1,0],[0,0,1]],translation:[0,0,0]};
const located=JSON.parse(buildGeoJson(positions,colors,['door'],[2],[0],reference));
assert.equal(located.frame,'WGS84');
assert.ok(Math.abs(located.features[0].geometry.coordinates[0]+.1248555)<.000001);
assert.ok(Math.abs(located.features[0].geometry.coordinates[1]-51.5001799)<.000001);
assert.equal(located.features[0].geometry.coordinates[2],130);
const local=JSON.parse(buildGeoJson(positions,colors,['door'],[2],[0]));
assert.equal(local.features[0].geometry,null,'Local metres must never masquerade as longitude/latitude');
assert.deepEqual(local.features[0].properties.local_xyz,[10,20,30]);

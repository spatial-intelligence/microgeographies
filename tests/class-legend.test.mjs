import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Color} from '../vendor/three.module.js';
import {classLegendEntries} from '../viewer-class-legend.js';
test('legend counts labelled originals and uses the actual class colour space',()=>{
  const red=new Color('#e6194b'),blue=new Color('#4363d8');
  const colors=new Float32Array([...red.toArray(),...blue.toArray(),...red.toArray(),0,0,0]);
  const entries=classLegendEntries(['Printer','Bin','Printer',null],colors);
  assert.deepEqual(entries.map(({label,count})=>({label,count})),[{label:'Bin',count:1},{label:'Printer',count:2}]);
  assert.equal(entries[0].color,blue.getStyle());assert.equal(entries[1].color,red.getStyle());
  assert.deepEqual(classLegendEntries([],new Float32Array()),[]);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitMapControls,relevantFrames,localPointFromMap} from '../video-survey.js';
import {clampDepthRange} from '../viewer-camera-controls.js';
import {geographicPoint} from '../geo-cloud.js';
test('manual fit recovers scale, rotation, coordinates and elevation',()=>{
  const radius=6371000,lat=51,lon=-.1,a=1.8,b=.7;
  const controls=[[0,0,0],[10,0,0],[0,0,10],[10,0,10]].map(local=>({local,
    lat:lat+(b*local[0]+a*local[2])/radius*180/Math.PI,
    lon:lon+(a*local[0]-b*local[2])/(radius*Math.cos(lat*Math.PI/180))*180/Math.PI}));
  const ref=fitMapControls(controls,null,100);
  assert.ok(ref.rms_m<.001);
  assert.ok(Math.abs(ref.scale_m_per_unit-Math.hypot(a,b))<.0001);
  controls.forEach(c=>{const p=geographicPoint(new Float64Array(c.local),0,ref);assert.ok(Math.abs(p[0]-c.lon)<1e-8);assert.ok(Math.abs(p[1]-c.lat)<1e-8);assert.equal(p[2],100);});
  const local=localPointFromMap(lon+.0001,lat+.0002,[1,-2,3],ref),world=geographicPoint(new Float64Array(local),0,ref);
  assert.ok(Math.abs(world[0]-lon-.0001)<1e-10);assert.ok(Math.abs(world[1]-lat-.0002)<1e-10);
  assert.ok(Math.abs(world[2]-geographicPoint(new Float64Array([1,-2,3]),0,ref)[2])<1e-8,'Editing longitude/latitude preserves tag height');
  assert.throws(()=>fitMapControls(controls.slice(0,2)),/three/);
  assert.throws(()=>fitMapControls([0,1,2].map(x=>({local:[x,0,0],lat:51,lon:x}))),/non-collinear/);
});
test('depth sliders retain a one-unit gap when either bound crosses the other',()=>{
  for(const changed of ['min','max'])for(const min of [-10,0,5,20,30])for(const max of [-5,0,5,20,40]){
    const [lo,hi]=clampDepthRange(min,max,20,changed);assert.ok(lo>=0&&hi<=20&&hi-lo>=1);
  }
  assert.deepEqual(clampDepthRange(8,5,20,'min'),[8,9]);
  assert.deepEqual(clampDepthRange(8,5,20,'max'),[4,5]);
});
test('frames exclude behind-camera and occluded points; regions widen search',()=>{
  const camera={image:'f',qvec:[1,0,0,0],tvec:[0,0,0],params:[80,80,50,40],width:100,height:80};
  const frames=[{image:'f',url:'test',depth:new Array(1024).fill(4)}];
  assert.equal(relevantFrames([0,0,4],[camera],frames).length,1);
  assert.equal(relevantFrames([0,0,-4],[camera],frames).length,0);
  assert.equal(relevantFrames([0,0,8],[camera],frames).length,0);
  assert.equal(relevantFrames([3,0,4],[camera],frames).length,0);
  assert.equal(relevantFrames([3,0,4],[camera],frames,1).length,1);
});

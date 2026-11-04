import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PointIndex,densifyPoints,buildTin,buildPhotoCutout,buildPhotoMosaic} from '../cloud-geometry.js';

test('nearest neighbour search matches brute force on flat, duplicate and 3D data',()=>{
  const positions=Float32Array.from(Array.from({length:240},(_,i)=>[Math.sin(i*12.3),i%3===0?0:Math.cos(i*4.7),i%17/9]).flat());
  const index=new PointIndex(positions);
  for(let i=0;i<240;i+=7){const p=Array.from(positions.subarray(i*3,i*3+3));
    const expected=Array.from({length:240},(_,j)=>({index:j,d:Math.hypot(...p.map((v,k)=>v-positions[j*3+k]))})).filter(v=>v.index!==i&&v.d>1e-8).sort((a,b)=>a.d-b.d||a.index-b.index)[0];
    const actual=index.nearest(p,i,1e-8);assert.equal(actual.index,expected.index);assert.ok(Math.abs(actual.distance-expected.d)<1e-10);
  }
});

test('densification creates unique interpolants with the nearest endpoint colour',()=>{
  const raw=new Float32Array([0,0,0,2,0,0]),before=raw.slice();
  assert.equal(densifyPoints(raw,0).count,0);
  const dense=densifyPoints(raw,1);assert.equal(dense.count,2);
  const maximum=densifyPoints(raw,10);assert.equal(maximum.count,20);
  assert.deepEqual(maximum.positions,densifyPoints(raw,10).positions,'Seeded random previews survive reloads without reshuffling');
  for(let i=0;i<dense.count;i++)assert.ok([...maximum.positions].filter((_,j)=>j%3===0).includes(dense.positions[i*3]),'Higher density retains existing seeded samples');
  assert.equal(new Set([...dense.positions].filter((_,i)=>i%3===0)).size,2);
  for(let i=0;i<dense.count;i++){
    const x=dense.positions[i*3];assert.ok(x>0&&x<2);
    assert.equal(dense.colorSources[i],x<=1?0:1);
  }
  assert.deepEqual(raw,before,'Original reconstruction is never overwritten');
  assert.ok(densifyPoints(raw,.5).count<dense.count);
  const xs=[...maximum.positions].filter((_,i)=>i%3===0).sort((a,b)=>a-b),gaps=xs.slice(1).map((v,i)=>v-xs[i]);
  assert.ok(Math.max(...gaps)-Math.min(...gaps)>.01,'Random samples must not use regular interpolation intervals');
  assert.ok(densifyPoints(raw,1,null,4).count<=4);
});

test('TIN preserves horizontal and vertical surfaces and exposes finer density',()=>{
  for(const vertical of [false,true]){
    const raw=Float32Array.from(Array.from({length:25},(_,i)=>vertical?[1,i%5,Math.floor(i/5)]:[i%5,0,Math.floor(i/5)]).flat());
    const tin=buildTin(raw,1);assert.equal(tin.count,32);
    let area=0;for(let j=0;j<tin.indices.length;j+=3){const [a,b,c]=[0,1,2].map(k=>Array.from(tin.positions.subarray(tin.indices[j+k]*3,tin.indices[j+k]*3+3))),u=b.map((v,k)=>v-a[k]),v=c.map((x,k)=>x-a[k]);area+=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])/2;}
    assert.ok(Math.abs(area-16)<1e-7,'Local Delaunay patches must not double-cover the plane');
    for(const id of tin.colorSources)assert.ok(id<raw.length/3);
  }
  const grid=Float32Array.from(Array.from({length:900},(_,i)=>[i%30,0,Math.floor(i/30)]).flat());
  assert.ok(buildTin(grid,.5).count>buildTin(grid,2).count,'Smaller Point Size creates a finer mesh');
  assert.equal(buildTin(new Float32Array([0,0,0,1,0,0,2,0,0])).count,0,'Collinear points do not fabricate a surface');
});
test('random density fills local surface interiors and copies the nearest original colour',()=>{
  const raw=Float32Array.from(Array.from({length:9},(_,i)=>[i%3,0,Math.floor(i/3)]).flat()),dense=densifyPoints(raw,5);
  let interior=0;
  for(let i=0;i<dense.count;i++){
    const p=Array.from(dense.positions.subarray(i*3,i*3+3));assert.equal(p[1],0,'Random points must stay on the local plane');
    if(p[0]%1!==0&&p[2]%1!==0)interior++;
    let best=0,distance=Infinity;for(let j=0;j<9;j++){const d=p.reduce((s,v,k)=>s+(v-raw[j*3+k])**2,0);if(d<distance){distance=d;best=j;}}
    assert.equal(dense.colorSources[i],best);
  }
  assert.ok(interior>dense.count/2,'Samples must scatter inside neighbouring triangles, not remain regularly aligned on edges');
});

test('TIN leaves unsupported gaps between distant clusters open',()=>{
  const raw=Float32Array.from([0,100].flatMap(offset=>Array.from({length:25},(_,i)=>[offset+i%5,0,Math.floor(i/5)]).flat()));
  const tin=buildTin(raw,1);
  assert.ok(tin.count>0);
  for(let j=0;j<tin.indices.length;j+=3){const xs=[0,1,2].map(k=>tin.positions[tin.indices[j+k]*3]);assert.ok(Math.max(...xs)-Math.min(...xs)<10);}
});
test('fine TIN keeps more than the old 60,000-vertex limit',()=>{
  const raw=Float32Array.from(Array.from({length:70000},(_,i)=>[i%350,0,Math.floor(i/350)]).flat());
  const tin=buildTin(raw,.5);assert.ok(tin.colorSources.length>60000);assert.ok(tin.count>100000);
});

test('photo cutouts use camera intrinsics, recovered orientation and depth',()=>{
  const camera={image:'a',qvec:[1,0,0,0],tvec:[-1,-2,-3],width:2,height:2,model:'PINHOLE',params:[2,2,1,1]};
  const frame={image:'a',url:'data:image/test',depth:[4,4,4,4]};
  const cutout=buildPhotoCutout(new Float32Array(),camera,frame);
  assert.deepEqual([...cutout.positions.slice(0,3)],[-1,0,7]);assert.equal(cutout.indices.length,6);assert.equal(cutout.planar,false);
  const rotated=buildPhotoCutout(new Float32Array(),{...camera,tvec:[0,0,0],qvec:[Math.SQRT1_2,0,Math.SQRT1_2,0]},frame);
  const center=[0,1,2].map(k=>[0,1,2,3].reduce((sum,i)=>sum+rotated.positions[i*3+k],0)/4);
  assert.ok(Math.abs(center[0]+4)<1e-6&&Math.abs(center[2])<1e-6);
  assert.equal(buildPhotoCutout(new Float32Array(),camera,{...frame,depth:[1,1,10,10]}),null,'Depth edges must produce cutouts, not stretched triangles');
  const mosaic=buildPhotoMosaic(new Float32Array(),[camera,{...camera,image:'b'}],[frame,{...frame,image:'b'}],1);
  assert.equal(mosaic.count,1);assert.equal(mosaic.total,2);
});

test('directional gap filling respects colour boundaries, depth layers and the ?1000 cap',()=>{
  const raw=[],colors=[];
  for(let z=0;z<6;z++)for(let x=0;x<6;x++){raw.push(x,0,z);colors.push(...(x<3?[1,0,0]:[0,0,1]));}
  const positions=new Float32Array(raw),rgb=new Float32Array(colors);
  const dense=densifyPoints(positions,1000,null,2000000,rgb);
  assert.ok(dense.count>0);assert.ok(dense.count<=36000);
  assert.deepEqual(dense.positions,densifyPoints(positions,2000,null,2000000,rgb).positions);
  for(let i=0;i<dense.count;i++){
    const x=dense.positions[i*3];assert.ok(x<=2||x>=3,'Never bridge the red/blue boundary');
    assert.equal(dense.positions[i*3+1],0);
    const nearest=new PointIndex(positions).nearest(Array.from(dense.positions.subarray(i*3,i*3+3)),-1,-1).index;
    assert.equal(dense.colorSources[i],nearest);
  }
  const layers=new Float32Array([...raw,...raw.map((v,i)=>i%3===1?v+8:v)]),filled=densifyPoints(layers,1000);
  for(let i=1;i<filled.positions.length;i+=3)assert.ok(filled.positions[i]===0||filled.positions[i]===8,'Do not fill between disconnected depth layers');
  assert.ok(densifyPoints(positions,1000,null,17,rgb).count<=17);
});

test('k-nearest neighbourhood matches brute force',()=>{
  const p=Float32Array.from(Array.from({length:120},(_,i)=>[Math.sin(i),Math.cos(i*2),i/20]).flat()),index=new PointIndex(p),query=[.2,.3,2];
  const expected=Array.from({length:120},(_,i)=>({index:i,d:query.reduce((s,v,k)=>s+(v-p[i*3+k])**2,0)})).sort((a,b)=>a.d-b.d||a.index-b.index).slice(0,48).map(v=>v.index);
  assert.deepEqual(index.nearestK(query).map(v=>v.index),expected);
});

test('density uses a multiplier, reaches x1000 and reports the preview cap',()=>{
  const raw=new Float32Array([0,0,0,2,0,0]);
  assert.equal(densifyPoints(raw,1).count,2,'x1 adds one point per source');
  assert.equal(densifyPoints(raw,1000).count,2000,'x1000 adds 1000 points per source');
  const capped=densifyPoints(raw,1000,null,100);
  assert.equal(capped.count,100);assert.equal(capped.requestedCount,2000);assert.equal(capped.targetCount,100);
});

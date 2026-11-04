import assert from 'node:assert/strict';
import {groupReviewObjects,sampleReviewFrames,classReviewFrames,reviewFeatures,referenceKey,reviewPixelPoint,matchingReviewRecords} from '../survey-review.js';
function test(name, run) { run(); console.log('PASS ' + name); }

const reference={available:true,origin:{lat:51.5,lon:-.1,altitude_m:0},
  matrix:[[10,0,0],[0,0,10],[0,-10,0]],translation:[0,0,0],scale_m_per_unit:10};

test('same class 100 metres apart stays separate after scaling',()=>{
  const positions=new Float64Array([0,0,2,.1,0,2,10,0,2,10.1,0,2]);
  const pointLabels=Object.fromEntries([0,1,2,3].map(i=>[i,{label:i%2?'DOOR':'door'}]));
  const groups=groupReviewObjects({positions,pointLabels,classes:['DOOR'],reference,radius:5});
  assert.equal(groups.length,2);assert.deepEqual(groups.map(g=>g.count),[2,2]);
  assert.ok(Math.abs(groups[1].local[0]-groups[0].local[0]-10)<.001);
  const wide=groupReviewObjects({positions,pointLabels,classes:['door'],reference,radius:100});
  assert.equal(wide.length,2,'100-metre boundary still excludes the point at 101 metres');
});

test('neighbour chains do not join far-away items; classes and floors stay separate',()=>{
  const positions=new Float64Array([0,0,1,.4,0,1,.8,0,1]);
  const pointLabels={0:{label:'door'},1:{label:'door'},2:{label:'door'}};
  const groups=groupReviewObjects({positions,pointLabels,classes:['door'],reference,radius:5});
  assert.equal(groups.length,2);
  const tagged=groupReviewObjects({positions,pointLabels:{},classes:['door','steps'],reference,radius:5,tags:[
    {name:'Door',local:[0,0,1],indoor:true,floor:0},
    {name:'Door',local:[0,0,1],indoor:true,floor:1},
    {name:'Steps',local:[0,0,1],indoor:true,floor:0},
    {name:'Door',local:[0,0,1],aggregation:'label centroid'}
  ]});
  assert.equal(tagged.length,3);assert.ok(tagged.every(g=>g.manual));
  assert.throws(()=>groupReviewObjects({positions,classes:['door'],reference:{available:false},radius:5}),/3D view/);
});

test('sample selection is capped and class detections must cover the target',()=>{
  const frames=[0,1,2,3,4].map(i=>({image:`f${i}`,url:'data:image/jpeg;base64,test',time_s:i,u:.5,v:.5,score:i/10,
    detections:[{label:'door',box:[.4,.4,.6,.6]}]}));
  assert.equal(sampleReviewFrames(frames,2).length,2);
  assert.equal(sampleReviewFrames([...frames,frames[0]],3).length,3);
  assert.equal(classReviewFrames(frames,'DOOR').length,5);
  assert.equal(classReviewFrames(frames,'window').length,0);
  assert.equal(classReviewFrames([{...frames[0],u:.9}],'door').length,0);
  assert.equal(classReviewFrames(frames,'window',true).length,5);
  assert.match(classReviewFrames([{...frames[0],detections:undefined}],'door')[0].class_evidence,/older project/);
});

test('GeoJSON keeps separate locations, answers, evidence and question metadata',()=>{
  const records=[0,10].map(x=>({local:[x,0,2],label:'door',answer:{wheelchair:x===0,wheelchairreason:'Steps',visualimp:null,visualimpreason:'Unknown'},
    question:'Accessible?',template:{wheelchair:null},samples:[{image:'f1',u:.5,v:.5}],radius:5,
    reference_key:referenceKey(reference),reviewed_at:'2026-11-04T14:00:00Z'}));
  const features=reviewFeatures(records,reference);
  assert.equal(features.length,2);assert.equal(features[0].geometry.type,'Point');
  assert.notEqual(features[0].geometry.coordinates[0],features[1].geometry.coordinates[0]);
  assert.equal(features[0].geometry.coordinates.length,2);
  assert.equal(features[0].properties.wheelchair,true);assert.equal(features[1].properties.wheelchair,false);
  assert.equal(features[0].properties.spark_registration_changed,false);
  assert.equal(reviewFeatures(records,{...reference,translation:[1,0,0]})[0].properties.spark_registration_changed,true);
  const unlocated=reviewFeatures(records,{available:false});assert.equal(unlocated.length,2);assert.equal(unlocated[0].geometry,null);assert.deepEqual(unlocated[0].properties.local_xyz,[0,0,2]);
});

test('unregistered points group at a 500 CSS-pixel threshold and identify matches exact instances',()=>{
  const projection={width:2000,height:1000,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
  const positions=new Float64Array([-.8,0,0,-.6,0,0,.4,0,0]);
  const pointLabels={0:{label:'door'},1:{label:'door'},2:{label:'door'}};
  const groups=groupReviewObjects({positions,pointLabels,classes:['door'],reference:null,radius:500,projection});
  assert.equal(groups.length,2);assert.deepEqual(groups[0].point_indices,[0,1]);
  assert.deepEqual(reviewPixelPoint([0,0,0],projection),[1000,500,0]);assert.equal(reviewPixelPoint([2,0,0],projection),null);
  const records=groups.map(group=>({...group,radius:500,grouping_units:'pixels',grouping_projection:projection,answer:{door:'example'}}));
  assert.equal(matchingReviewRecords(records,2,[.4,0,0],'door',null).length,1);
  assert.equal(matchingReviewRecords(records,2,[.4,0,0],'door',null)[0].id,groups[1].id);
  const output=reviewFeatures(records,null);assert.equal(output[0].geometry,null);assert.equal(output[0].properties.spark_group_radius_pixels,500);
  assert.equal(reviewFeatures(records,reference)[0].geometry.type,'Point','later registration supplies coordinates without another paid call');
});

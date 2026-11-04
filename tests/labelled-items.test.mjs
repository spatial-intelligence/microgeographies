import assert from 'node:assert/strict';
import {buildLabelledItems} from '../labelled-items.js';
import {groupReviewObjects,matchingReviewRecords,reviewFeatures} from '../survey-review.js';
const projection={width:1000,height:1000,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
const positions=new Float64Array([0,0,0,.1,0,0,.8,0,0,.9,0,0]);
const labels=Object.fromEntries([0,1,2,3].map(i=>[i,{label:'door'}]));
const groups=groupReviewObjects({positions,pointLabels:labels,classes:['door'],radius:500,projection});
assert.equal(groups.length,1,'distance alone would combine both doors');
const registry=buildLabelledItems({positions,pointLabels:labels,newGroups:groups,getFrames:local=>[
  {image:'two-doors',u:local[0],v:.5,detections:[{label:'door',box:[0,0,.3,1]},{label:'door',box:[.7,0,1,1]}]}
]});
assert.equal(registry.items.length,2,'separate SAM boxes must get separate IDs');
const [a,b]=registry.items;assert.notEqual(a.item_id,b.item_id);
assert.deepEqual(a.point_indices,[0,1]);assert.deepEqual(b.point_indices,[2,3]);
assert.equal(labels[0].item_id,labels[1].item_id);assert.notEqual(labels[0].item_id,labels[2].item_id);
const restored=buildLabelledItems({positions,pointLabels:JSON.parse(JSON.stringify(labels))});
assert.deepEqual(restored.items.map(i=>i.item_id),registry.items.map(i=>i.item_id));
const records=[{...a,manual:true,point_indices:[0,1,2,3],answer:{door:'A'},radius:10000},
  {...b,manual:true,answer:{door:'B'},radius:10000}];
assert.deepEqual(matchingReviewRecords(records,2,[.8,0,0],'door',null,b.item_id).map(r=>r.answer),[{door:'B'}]);
assert.equal(matchingReviewRecords(records,10,[.8,0,0],'door',null).length,0,'nearby same-class points must never inherit answers');
assert.equal(reviewFeatures(records,null)[0].properties.item_id,a.item_id);
const tags=[{name:'Door',local:[0,0,0],point_index:0},{name:'Door',local:[.01,0,0],point_index:1}];
const manual=buildLabelledItems({positions,pointLabels:{},tags});
assert.equal(manual.items.length,2);assert.notEqual(tags[0].item_id,tags[1].item_id);
const originalId=tags[0].item_id;tags[0].name='Entrance';
assert.equal(buildLabelledItems({positions,pointLabels:{},tags}).items[0].item_id,originalId);
console.log('PASS distinct SAM/user item IDs, stable reloads and no cross-item answer matching');

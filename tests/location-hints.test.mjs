import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const elements=new Map(),element=id=>{
  if(!elements.has(id))elements.set(id,{children:[],attributes:{},setAttribute(key,value){this.attributes[key]=value;},addEventListener(){},show(){this.open=true;},close(){this.open=false;},replaceChildren(...items){this.children=items;},append(...items){this.children.push(...items);},textContent:'',hidden:true});
  return elements.get(id);
};
let requestCount=0,changes=[],resolveResponse;
const movements=[],map={on(){},setView:(position,zoom)=>movements.push({position,zoom}),fitBounds:bounds=>movements.push({bounds})};
const layer={addTo(){return this;},clearLayers(){}};
const marker={addTo(){return this;},bindTooltip(){return this;},on(){return this;}};
const context=vm.createContext({window:{L:{layerGroup:()=>layer,circleMarker:()=>marker}},
  document:{getElementById:element,createElement:()=>element('dynamic-'+Math.random())},AbortController,
  fetch:async()=>{requestCount++;return new Promise(resolve=>resolveResponse=resolve);}});
vm.runInContext(readFileSync(new URL('../location-hints.js',import.meta.url),'utf8'),context);
let previewCount=0;const videoFile={name:'survey.mp4',size:1234};
const data={georeference:{available:false}},hints=context.window.MGLocationHints.create({getMap:()=>map,getData:()=>data,onChange:value=>changes.push(value),getVideoFile:()=>videoFile,getToken:()=> 'test-key',
  extractFrames:async(file,start)=>{previewCount++;assert.equal(file,videoFile);assert.equal(start,1);return [{url:'frame2',time_s:2},{url:'frame3',time_s:3}];}});
const pending=hints.locate('data:image/jpeg;base64,test','test-key');
assert.equal(requestCount,1);
assert.match(element('videoLocationHintStatus').textContent,/Reconstruction continues/);
// Candidate selection is still pending while this separate request runs.
assert.equal(hints.snapshot(),null);
const candidates=[{name:'Town A',lat:51.5,lon:-.1,confidence:'low',reason:'Sign'},
  {name:'Town B',lat:52,lon:-.2,confidence:'medium',reason:'Landmark'}];
resolveResponse({ok:true,json:async()=>({candidates,usage:{total_tokens:100}})});await pending;
assert.equal(element('videoLocationHintChoices').children.length,2);
assert.ok(movements.some(m=>m.bounds));
assert.equal(hints.snapshot().selected_index,null,'multiple guesses require a user choice');
assert.match(element('videoLocationHintStatus').textContent,/could not pinpoint/);
assert.equal(hints.snapshot().frame_time_s,1);
assert.equal(element('videoLocationHints').open,true);
element('videoLocationHintDismiss').onclick();assert.equal(element('videoLocationHints').open,false);
assert.equal(hints.snapshot().candidates.length,2,'closing must retain the results');
element('videoLocationHintOpen').onclick();assert.equal(element('videoLocationHints').open,true);assert.equal(requestCount,1);
element('videoLocationHintChoices').children[1].children[0].onclick();
assert.equal(hints.snapshot().selected_index,1);
assert.equal(movements.at(-1).position[0],52);
assert.equal(data.georeference.available,false,'choosing a starting point never registers the cloud');
await hints.locate('another image','test-key');assert.equal(requestCount,1,'one request maximum per run');
await element('videoLocationHintNext').onclick();assert.equal(previewCount,1);assert.equal(requestCount,1,'previews must not send paid requests');
assert.equal(element('videoLocationHintFrames').children.length,2);
element('videoLocationHintFrames').children[1].onclick();assert.equal(element('videoLocationHintImage').src,'frame3');
const retry=element('videoLocationHintSend').onclick();assert.equal(requestCount,2,'one explicit retry sends only one request');
resolveResponse({ok:true,json:async()=>({candidates:[candidates[0]]})});await retry;
assert.equal(hints.snapshot().frame_time_s,3);assert.equal(hints.snapshot().frame_preview,'frame3');
hints.reset();assert.equal(hints.snapshot(),null);
await hints.locate('image','');assert.equal(requestCount,2,'missing credentials never calls Meta');
assert.ok(changes.length>=2);
console.log('PASS parallel lookup, close/reopen, preview without paid calls, selected-frame retry and no automatic registration');

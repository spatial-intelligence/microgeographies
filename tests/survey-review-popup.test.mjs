// Exercise the real popup controller with a small DOM double and mocked API.
import assert from 'node:assert/strict';
import {createSurveyReview} from '../survey-review.js';

class Element {
  constructor(tag='div'){this.tagName=tag;this.nodes=new Map();this.children=[];this.handlers={};this.value='';this.checked=false;this.style={};}
  set innerHTML(html){for(const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
    const node=new Element(match[1]);node.id=match[3];node.value=match[2].match(/\bvalue="([^"]*)"/)?.[1]||'';
    node.disabled=/\bdisabled\b/.test(match[2]);this.nodes.set(node.id,node);
  }}
  setAttribute(){}
  append(...nodes){nodes.forEach(node=>node.parent=this);this.children.push(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
  replaceChildren(...nodes){this.children=nodes;}
  querySelector(selector){return this.nodes.get(selector.slice(1));}
  addEventListener(name,callback){this.handlers[name]=callback;}
  showModal(){this.open=true;}
  close(){this.open=false;}
}
const body=new Element(),toolbar=new Element(),token=new Element('input');token.value='test-key';
const doc={body,createElement:tag=>new Element(tag),getElementById:id=>id==='tokenInput'?token:null};
const previousDocument=globalThis.document,previousFetch=globalThis.fetch;
globalThis.document=doc;
let calls=[],changes=0;
const reference={available:true,origin:{lat:51.5,lon:-.1,altitude_m:0},matrix:[[10,0,0],[0,0,10],[0,-10,0]],translation:[0,0,0]};
const cloud={positions:new Float64Array([0,0,3,10,0,3])};
const ctx={cloud,data:{georeference:reference,point_labels:{0:{label:'door'},1:{label:'door'}}}};
const answer={wheelchair:true,wheelchairreason:'Steps',visualimp:null,visualimpreason:'Not visible'};
try {
  const review=createSurveyReview({host:{querySelector:()=>toolbar},getContext:()=>ctx,getTags:()=>[],
    getFrames:()=>[{image:'f1',time_s:1,url:'data:image/jpeg;base64,test',u:.5,v:.5,score:0}],onChange:()=>changes++});
  const dialog=body.children[0],el=id=>dialog.querySelector('#surveyReview'+id);
  globalThis.fetch=async (url,options)=>{
    const payload=JSON.parse(options.body);calls.push({url,payload});
    const lines=payload.groups.flatMap((group,i)=>[
      {type:'start',attempt:i+1,label:group.label}, {type:'result',id:group.id,answer,usage:{total_tokens:120}}
    ]).map(value=>JSON.stringify(value)+'\n').join('');
    let done=false;return {ok:true,body:{getReader:()=>({read:async()=>done?{done:true}:(done=true,{value:new TextEncoder().encode(lines),done:false})})}};
  };
  el('Max').value='1';el('Prepare').onclick();
  assert.equal(calls.length,0,'preview must never send images');
  assert.match(el('Status').textContent,/2 spatial group\(s\); 1 request\(s\)/);
  assert.equal(el('Preview').children.length,1);
  await el('Run').onclick();
  assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/survey-review');
  assert.equal(calls[0].payload.groups.length,1);assert.equal(calls[0].payload.max_requests,1);
  assert.equal(review.features().length,1);assert.equal(review.features()[0].properties.wheelchair,true);
  const saved=review.snapshot();
  assert.equal(saved.records.length,1);
  assert.ok(!JSON.stringify(saved).includes('test-key'));
  assert.ok(!JSON.stringify(saved).includes('data:image'));
  el('Prepare').onclick();assert.match(el('Status').textContent,/1 already answered/);
  await el('Run').onclick();assert.equal(review.features().length,2,'second door gets its own answer');
  el('Prepare').onclick();assert.equal(el('Run').disabled,true,'completed items are skipped');
  review.restore(saved);assert.equal(review.features().length,1);
  el('Repeat').checked=true;el('Prepare').onclick();
  const before=calls.length;
  ctx.data.georeference={...reference,translation:[1,0,0]};
  await el('Run').onclick();assert.equal(calls.length,before,'stale registration cannot send');
  assert.match(el('Status').textContent,/registration changed/);
  ctx.data.georeference=reference;el('Prepare').onclick();
  globalThis.fetch=async (_url,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(Object.assign(new Error('Stopped'),{name:'AbortError'})));
  });
  const running=el('Run').onclick();el('Stop').onclick();await running;
  assert.match(el('Status').textContent,/Stopped/);
  assert.equal(review.snapshot().records.length,1,'completed answers survive cancellation');
  assert.ok(changes>0);
  ctx.data.georeference={available:false};ctx.cloud={positions:new Float64Array([-.8,0,0,-.6,0,0,.4,0,0])};
  ctx.data.point_labels={0:{label:'door'},1:{label:'door'},2:{label:'steps'}};
  ctx.projection={width:2000,height:1000,matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]};
  review.restore({records:[],requests:[{classes:'door',question:'Any access issues?',template:JSON.stringify({wheelchair:null})},
    {classes:'steps',question:'How many steps?',template:JSON.stringify({stepcount:0})}]});
  el('Max').value='5';el('Prepare').onclick();
  assert.match(el('Status').textContent,/Grouping: 500 pixels/);
  assert.equal(el('PixelRow').hidden,false);assert.equal(el('MetricRow').hidden,true);
  globalThis.fetch=async (_url,{body})=>{const payload=JSON.parse(body);calls.push({payload});
    assert.equal(payload.groups.length,2);assert.equal(payload.groups[0].question,'Any access issues?');assert.equal(payload.groups[1].question,'How many steps?');
    const lines=payload.groups.map(group=>JSON.stringify({type:'result',id:group.id,answer:group.label==='door'?{wheelchair:true}:{stepcount:3}})+'\n').join('');
    let done=false;return {ok:true,body:{getReader:()=>({read:async()=>done?{done:true}:(done=true,{value:new TextEncoder().encode(lines),done:false})})}};
  };
  await el('Run').onclick();assert.equal(review.features().length,2);assert.ok(review.features().every(f=>f.geometry===null));
  assert.equal(review.features()[1].properties.stepcount,3);assert.equal(el('Download').disabled,false);
  assert.equal(review.snapshot().requests.length,2);
  assert.equal(review.identify(0,[-.8,0,0],'door')[0].answer.wheelchair,true);
  ctx.data.georeference=reference;assert.ok(review.features().every(f=>f.geometry?.type==='Point'));
  ctx.data.point_labels={};review.refreshClasses();assert.equal(toolbar.children[0].disabled,true);
  ctx.data.point_labels={0:{label:'door'}};review.refreshClasses();assert.equal(toolbar.children[0].disabled,false);
  assert.equal(toolbar.children[0].textContent,'Process Classes');
  ctx.cloud={positions:new Float64Array([0,0,3,10,0,3])};ctx.data.point_labels={0:{label:'door'},1:{label:'door'}};
  review.restore({records:[],requests:[{classes:'door',question:'Describe this door',template:'{"description":""}'}]});
  el('Prepare').onclick();
  globalThis.fetch=async(_url,{body})=>{const payload=JSON.parse(body);assert.equal(payload.groups.length,2);assert.notEqual(payload.groups[0].item_id,payload.groups[1].item_id);
    const lines=payload.groups.map(g=>JSON.stringify({type:'result',id:g.id,item_id:g.item_id,answer:{description:g.item_id}})+'\n').join('');let done=false;
    return {ok:true,body:{getReader:()=>({read:async()=>done?{done:true}:(done=true,{value:new TextEncoder().encode(lines),done:false})})}};
  };
  await el('Run').onclick();
  assert.equal(review.identify(0,[0,0,3],'door').length,1);assert.equal(review.identify(1,[10,0,3],'door').length,1);
  assert.notEqual(review.identify(0,[0,0,3],'door')[0].answer.description,review.identify(1,[10,0,3],'door')[0].answer.description);
  const withIds=review.snapshot(),id=review.itemForPoint(0).item_id;review.restore(withIds);assert.equal(review.itemForPoint(0).item_id,id);
  review.restore({records:[{id:'legacy-class-answer',label:'door',manual:true,point_indices:[0,1],local:[5,0,3],samples:[],answer:{description:'Old shared answer'},question:'Describe this door',template:{description:''}}]});
  assert.equal(review.identify(0,[0,0,3],'door').length,0);assert.equal(review.identify(1,[10,0,3],'door').length,0,'ambiguous legacy answers must not attach to either item');
  console.log('PASS separate same-class item requests and Identify answers, including saved IDs');
  console.log('PASS unregistered processing, multi-row questions, local exports, Identify metadata and tagged-class gate');
  console.log('PASS popup preview, hard request cap, saved answers, repeat skipping and registration checks');
} finally {
  globalThis.document=previousDocument;globalThis.fetch=previousFetch;
}

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const elements=new Map();
const element=id=>{
  if(!elements.has(id))elements.set(id,{hidden:true,disabled:true,children:[],textContent:'',
    replaceChildren(...children){this.children=children;},append(...children){this.children.push(...children);},
    showModal(){this.open=true;},close(){this.open=false;}});
  return elements.get(id);
};
let token='',calls=[],resolveResponse,selected=null;
const context=vm.createContext({window:{},document:{getElementById:element,createElement:()=>element(Symbol())},AbortController,
  fetch:(url,options)=>{calls.push({url,options});return new Promise(resolve=>resolveResponse=resolve);}});
vm.runInContext(readFileSync(new URL('../location-hints.js',import.meta.url),'utf8'),context);
const hints=context.window.MGLocationHints.createPhoto({getImage:()=> 'photo-data',getToken:()=>token,onSelect:c=>selected=c});
const button=element('photoEstimateLocation'),status=element('photoLocationHintStatus'),choices=element('photoLocationHintChoices');
hints.reset();assert.equal(button.hidden,true);
hints.setAvailable(true);assert.equal(button.hidden,false);assert.equal(button.disabled,false);
await button.onclick();assert.equal(calls.length,0);assert.match(status.textContent,/Meta API key/);
token='test-key';const pending=button.onclick();assert.equal(calls.length,1);assert.equal(button.disabled,true);
assert.equal(JSON.parse(calls[0].options.body).image,'photo-data');assert.equal(calls[0].url,'/api/location-hint');
const candidate={name:'Town',lat:51.5,lon:-.1,confidence:'medium',reason:'Street sign'};
resolveResponse({ok:true,json:async()=>({candidates:[candidate]})});await pending;
assert.equal(selected,null,'location must be explicitly selected');assert.equal(choices.children.length,1);
choices.children[0].children[0].onclick();assert.equal(selected.name,'Town');
assert.equal(element('photoLocationHints').open,false);
const stale=button.onclick();hints.reset();assert.equal(calls[1].options.signal.aborted,true);
resolveResponse({ok:true,json:async()=>({candidates:[candidate]})});await stale;
assert.equal(choices.children.length,0,'previous photo results cannot populate a new photo');assert.equal(button.hidden,true);
hints.setAvailable(true);const empty=button.onclick();resolveResponse({ok:true,json:async()=>({candidates:[]})});await empty;
assert.match(status.textContent,/No location could be identified/);
const failure=button.onclick();resolveResponse({ok:false,status:502,json:async()=>({detail:'Lookup unavailable'})});await failure;
assert.equal(status.textContent,'Lookup unavailable');assert.equal(button.disabled,false);
console.log('PASS photo lookup, missing credentials, explicit selection, photo reset, empty results and error recovery');

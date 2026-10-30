import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as Three from '../vendor/three.module.js';

// Real Three.js and copied OrbitControls/navigation; only DOM/WebGL are stubbed.
class Element {
  constructor(){this.children=[];this.style={};this.attributes={};this.listeners=new Map();this.clientWidth=800;this.clientHeight=500;this.offsetParent={};this.className='';this.hidden=false;this.classList={add(){},remove(){}};}
  append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  setAttribute(name,value){this.attributes[name]=value;}
  getRootNode(){return root;}
  getBoundingClientRect(){return {left:0,top:0,width:this.clientWidth,height:this.clientHeight};}
  setPointerCapture(){} releasePointerCapture(){} focus(){}
}
const root=new Element();
let renderedCamera,renderedScene,canvas,nextFrame;
const context=vm.createContext({...Three,THREE:{...Three,WebGLRenderer:class{
  constructor(){this.domElement=canvas=new Element();}
  setPixelRatio(){} setSize(w,h){this.domElement.clientWidth=w;this.domElement.clientHeight=h;}
  render(scene,camera){renderedScene=scene;renderedCamera=camera;}
  dispose(){}
}},window:{devicePixelRatio:1},document:{createElement(){return new Element();}},
ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame(fn){nextFrame=fn;return 1;},cancelAnimationFrame(){nextFrame=null;}});
function load(path,names){
  let code=readFileSync(new URL(path,import.meta.url),'utf8');
  code=code.replace(/^import[\s\S]*?from\s*["'][^"']+["'];\r?\n/gm,'').replace(/\bexport\s+(?=function|class|const)/g,'').replace(/export\s*\{[^}]*\};?/g,'');
  return new vm.Script(`(()=>{${code}\nreturn {${names.join(',')}};})()`).runInContext(context);
}
Object.assign(context,load('../vendor/OrbitControls.js',['OrbitControls']));
Object.assign(context,load('../view-navigation.js',['createViewNavigation']));
Object.assign(context,load('../view-roll.js',['createViewRoll']));
Object.assign(context,load('../point-identify.js',['attachPointIdentify']));
Object.assign(context,load('../viewer-annotations.js',['createIdentifyTooltip']));
const {createViewer}=load('../slam-viewer.js',['createViewer']);
const host=new Element(),viewer=createViewer(host);
const positions=new Float32Array([-3,-2,0,3,2,4,0,0,2]);
const rgb=new Float32Array(positions.length).fill(.7);
viewer.setCloud(positions,rgb,rgb,['a','b','c']);
const tick=()=>nextFrame();
const center=new Three.Vector3(0,0,2),span=Math.sqrt(36+16+16);
assert.equal(renderedCamera.fov,55);
assert.deepEqual(renderedCamera.up.toArray(),[0,-1,0]);
assert.ok(renderedCamera.position.distanceTo(center.clone().add(new Three.Vector3(span*.45,-span*.35,-span*.65)))<1e-7);
assert.equal(host.children.filter(x=>x.className.startsWith('view-navigation-edge')).length,2);
assert.equal(host.children.filter(x=>x.className.startsWith('view-roll-edge')).length,2);
const event=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,shiftKey:false,preventDefault(){},stopPropagation(){}});
const zoom=host.children.find(x=>x.className==='view-navigation-edge zoom');
let distance=renderedCamera.position.distanceTo(center);
zoom.onpointerdown(event(100,10));zoom.onpointermove(event(200,10));zoom.onpointerup(event(200,10));tick();
assert.ok(renderedCamera.position.distanceTo(center)<distance);
viewer.fitBounds();tick();
const start=renderedCamera.position.clone();
zoom.onpointerdown(event(100,10));zoom.onpointermove(event(300,10));zoom.onpointercancel(event(300,10));tick();
assert.ok(renderedCamera.position.distanceTo(start)<1e-7);
const roll=host.children.find(x=>x.className==='view-roll-edge right');
const before=renderedCamera.quaternion.clone();
roll.onpointerdown(event(799,100));roll.onpointermove(event(799,200));roll.onpointerup(event(799,200));tick();
assert.ok(renderedCamera.quaternion.angleTo(before)>.1);
assert.deepEqual(renderedCamera.up.toArray(),[0,-1,0]);
viewer.resetRoll();tick();assert.ok(renderedCamera.quaternion.angleTo(before)<1e-6);
viewer.topView();tick();assert.ok(Math.abs(renderedCamera.position.y+span)<1e-6);
viewer.setColorMode('class');viewer.setPointSize(2);
assert.equal(renderedScene.children[0].material.size,4);
assert.equal(renderedScene.children[0].material.sizeAttenuation,false);
viewer.setCloud(positions,rgb,rgb);tick();
assert.equal(host.children.filter(x=>x.className.startsWith('view-navigation-edge')).length,2,'No duplicate controls on new cloud');
viewer.dispose();assert.equal(host.children.length,0);assert.equal(nextFrame,null);
export const navigationChecksPassed=true;

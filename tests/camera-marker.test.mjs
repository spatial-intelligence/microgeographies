import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {createMainCameraMarker,translateCameraPose,aimCameraPose} from '../viewer-camera-marker.js';
import {formatIdentifyText} from '../point-identify.js';

const pose={position:[0,0,0],target:[1,0,0],up:[0,1,0],roll:.3};
const translated=translateCameraPose(pose,[2,3,4]);assert.deepEqual(translated.position,[2,3,4]);assert.deepEqual(translated.target,[3,3,4]);assert.equal(translated.roll,.3);
const aimed=aimCameraPose(pose,[0,2,0]);assert.deepEqual(aimed.position,pose.position);assert.deepEqual(aimed.target,[0,1,0]);assert.equal(aimed.roll,.3);
class Element{
  constructor(){this.handlers={};this.style={setProperty(key,value){this[key]=value;}};this.hidden=false;this.captured=false;}
  setAttribute(){}
  addEventListener(type,fn){this.handlers[type]=fn;}
  removeEventListener(type){delete this.handlers[type];}
  setPointerCapture(){this.captured=true;}hasPointerCapture(){return this.captured;}releasePointerCapture(){this.captured=false;}
  remove(){this.removed=true;}
}
const previousDocument=globalThis.document;globalThis.document={createElement:()=>new Element()};
try{
  const nodes=[],camera=new THREE.PerspectiveCamera(60,1,.1,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const controls={enabled:true},canvas={getBoundingClientRect:()=>({left:0,top:0,width:500,height:500})};
  let current=structuredClone(pose),updates=0;
  const marker=createMainCameraMarker({host:{append:node=>nodes.push(node)},canvas,camera,controls,getPose:()=>current,onChange:value=>{current=value;updates++;}});
  marker.update();const position=nodes.find(node=>node.className==='viewer-main-camera-position'),aim=nodes.find(node=>node.className==='viewer-main-camera-aim');
  assert.equal(position.hidden,false);assert.equal(position.style.left,'250px');
  const event=(x,y)=>({button:0,pointerId:1,clientX:x,clientY:y,preventDefault(){},stopPropagation(){}});
  position.handlers.pointerdown(event(250,250));assert.equal(controls.enabled,false);
  position.handlers.pointermove(event(300,250));position.handlers.pointerup(event(300,250));assert.equal(controls.enabled,true);
  assert.ok(current.position[0]>0);assert.ok(Math.abs(current.target[0]-current.position[0]-1)<1e-8);assert.ok(updates>0);
  marker.update();const start={x:parseFloat(aim.style.left),y:parseFloat(aim.style.top)},before=[...current.position];
  aim.handlers.pointerdown(event(start.x,start.y));aim.handlers.pointermove(event(start.x,start.y-60));aim.handlers.pointerup(event(start.x,start.y-60));
  assert.deepEqual(current.position,before);assert.ok(current.target[1]>0,'direction handle updates main camera heading');
  marker.dispose();assert.ok(nodes.every(node=>node.removed));assert.equal(controls.enabled,true);
}finally{globalThis.document=previousDocument;}
const text=formatIdentifyText('door',-1,[{title:'Spark: door',question:'Any access issues?',answer:{wheelchair:true,wheelchairreason:'Steps visible'}}]);
assert.match(text,/Class: door/);assert.match(text,/wheelchairreason/);assert.match(text,/Steps visible/);assert.match(text,/Any access issues/);
console.log('PASS live camera marker projection, drag position, aim, cleanup and Identify metadata formatting');

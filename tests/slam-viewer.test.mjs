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
setTimeout,clearTimeout,
ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame(fn){nextFrame=fn;return 1;},cancelAnimationFrame(){nextFrame=null;}});
function load(path,names){
  let code=readFileSync(new URL(path,import.meta.url),'utf8');
  code=code.replace(/^import[\s\S]*?from\s*["'][^"']+["'];\r?\n/gm,'').replace(/\bexport\s+(?=function|class|const)/g,'').replace(/export\s*\{[^}]*\};?/g,'');
  return new vm.Script(`(()=>{${code}\nreturn {${names.join(',')}};})()`).runInContext(context);
}
Object.assign(context,load('../vendor/OrbitControls.js',['OrbitControls']));
Object.assign(context,load('../view-navigation.js',['createViewNavigation']));
Object.assign(context,load('../view-roll.js',['createViewRoll']));
Object.assign(context,load('../point-identify.js',['attachPointIdentify','formatIdentifyText']));
Object.assign(context,load('../viewer-camera-marker.js',['createMainCameraMarker','translateCameraPose','aimCameraPose']));
Object.assign(context,load('../viewer-class-legend.js',['classLegendEntries','createClassLegend']));
Object.assign(context,load('../cloud-representations.js',['createCloudRepresentations']));
Object.assign(context,load('../viewer-camera-controls.js',['createViewerCameraControls']));
Object.assign(context,load('../viewer-annotations.js',['createIdentifyTooltip','createMeasurementOverlay','createControlPointOverlay']));
const {createViewer,createCameraOverlay,cloudHeightValues}=load('../slam-viewer.js',['createViewer','createCameraOverlay','cloudHeightValues']);
const host=new Element(),viewer=createViewer(host);
const positions=new Float32Array([-3,-2,0,3,2,4,0,0,2]);
const rgb=new Float32Array(positions.length).fill(.7);
assert.deepEqual(Array.from(cloudHeightValues(positions)),[4,0,2]);
assert.deepEqual(Array.from(cloudHeightValues(positions,[0,0,2])),[0,8,4],'Fitted vertical carries metric scale');
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
const basis=new Three.Quaternion().setFromAxisAngle(new Three.Vector3(0,0,1),Math.PI/2);
viewer.setCloud(positions,rgb,rgb,[],[],[{qvec:[basis.w,basis.x,basis.y,basis.z],tvec:[0,0,0]}]);tick();
const inverse=basis.clone().invert();
assert.ok(renderedCamera.up.distanceTo(new Three.Vector3(0,-1,0).applyQuaternion(inverse))<1e-7);
assert.ok(renderedCamera.position.distanceTo(center.clone().add(new Three.Vector3(span*.45,-span*.35,-span*.65).applyQuaternion(inverse)))<1e-7);
viewer.fitBounds();tick();
assert.ok(renderedCamera.up.distanceTo(new Three.Vector3(0,-1,0).applyQuaternion(inverse))<1e-7);
const overlayCameras=[
  {qvec:[1,0,0,0],tvec:[0,0,0],model:'PINHOLE',params:[4,4,2,1],width:5,height:3},
  {qvec:[1,0,0,0],tvec:[-1,0,0],model:'PINHOLE',params:[4,4,2,1],width:5,height:3}
];
const overlay=createCameraOverlay(overlayCameras,.5);
assert.equal(overlay.name,'camera-overlays');
assert.equal(overlay.children.length,1);
assert.ok(overlay.children[0].isLineSegments,'Cameras must be wireframes, never opaque boxes');
const pathPositions=overlay.children[0].geometry.attributes.position;
assert.equal(pathPositions.count,34,'Eight frustum edges per camera plus one trajectory segment');
assert.deepEqual([pathPositions.getX(32),pathPositions.getY(32),pathPositions.getZ(32)],[0,0,0]);
assert.deepEqual([pathPositions.getX(33),pathPositions.getY(33),pathPositions.getZ(33)],[1,0,0]);
viewer.setCloud(positions,rgb,rgb,[],[],overlayCameras);tick();
viewer.setCamerasVisible(false);
assert.equal(renderedScene.getObjectByName('camera-overlays').visible,false);
viewer.setCamerasVisible(true);
assert.equal(renderedScene.getObjectByName('camera-overlays').visible,true);
// Navigation keys move only the focused viewer, with F now lowering the camera.
const press = key => { for(const fn of canvas.listeners.get('keydown') || []) fn({key,preventDefault(){}}); };
const release = key => { for(const fn of canvas.listeners.get('keyup') || []) fn({key}); };
const advance = time => nextFrame(time);
let time = 100;
for(const key of ['w','s','a','d','r','f']) {
  const before = renderedCamera.position.clone();
  press(key); advance(time+=40); release(key);
  assert.ok(before.distanceTo(renderedCamera.position)>0, `${key} must move the camera`);
}
for(const key of ['q','e','z','c']) {
  const before = renderedCamera.quaternion.clone();
  press(key); advance(time+=40); release(key);
  assert.ok(before.angleTo(renderedCamera.quaternion)>0, `${key} must rotate the camera`);
}
viewer.setBrightness(1.5);
assert.equal(renderedScene.children[0].material.color.r,1.5);
const saved=viewer.getPose();
press('w');advance(time+=40);release('w');
const flight=viewer.flyTo(saved,100);
for(let i=0;i<5;i++)advance(time+=40);
assert.equal(await flight,true);
assert.ok(renderedCamera.position.distanceTo(new Three.Vector3(...saved.position))<1e-7);
const cancelled=viewer.flyTo(saved,1000);viewer.cancelFlight();
assert.equal(await cancelled,false);
viewer.setColorMode('height');
const heightColors=renderedScene.children[0].geometry.attributes.color.array.slice();
press('w');advance(time+=40);release('w');
assert.deepEqual(renderedScene.children[0].geometry.attributes.color.array,heightColors,'Height colours must not change as the camera moves');
viewer.setCloud(positions,rgb,rgb,[],[],[{qvec:[basis.w,basis.x,basis.y,basis.z],tvec:[0,0,0]}]);tick();
for(const [name,direction] of Object.entries({top:[0,-1,0],bottom:[0,1,0],left:[-1,0,0],right:[1,0,0],front:[0,0,-1],back:[0,0,1]})) {
  viewer.setPreset(name);tick();
  const expected=new Three.Vector3(...direction).applyQuaternion(inverse);
  const pose=viewer.getPose(),actual=new Three.Vector3(...pose.position).sub(new Three.Vector3(...pose.target)).normalize();
  assert.ok(actual.distanceTo(expected)<1e-6,`${name} preset follows the reconstruction camera axes`);
  const forward=renderedCamera.getWorldDirection(new Three.Vector3());
  assert.ok(forward.distanceTo(expected.negate())<1e-6,`${name} looks at the cloud`);
}
viewer.setPreset('perspective');tick();
assert.ok(renderedCamera.position.distanceTo(center.clone().add(new Three.Vector3(span*.45,-span*.35,-span*.65).applyQuaternion(inverse)))<1e-7);
const primaryFrame=nextFrame,primaryCanvas=canvas;
const firstPose=viewer.getPose(),secondHost=new Element(),secondViewer=createViewer(secondHost);
secondViewer.setCloud(positions,rgb,rgb);secondViewer.setPreset('right');
assert.deepEqual(viewer.getPose(),firstPose,'Changing the second camera leaves the first pose unchanged');
secondViewer.dispose();
nextFrame=primaryFrame;canvas=primaryCanvas;
viewer.setCameraSettings({fov:90,depthMin:4,depthMax:16,depthScale:2,navigationMode:'walk'});
tick();assert.equal(renderedCamera.fov,90);assert.equal(renderedCamera.near,2);assert.equal(renderedCamera.far,8);
const beforeLook=viewer.getPose();
for(const fn of canvas.listeners.get('pointerdown')||[])fn(event(300,200));
for(const fn of canvas.listeners.get('pointermove')||[])fn(event(360,220));
for(const fn of canvas.listeners.get('pointerup')||[])fn(event(360,220));
tick();assert.ok(Math.hypot(...viewer.getPose().position.map((v,i)=>v-beforeLook.position[i]))<1e-8,'WALK mouse look keeps camera position fixed');
assert.notDeepEqual(viewer.getPose().target,beforeLook.target,'WALK mouse look changes viewing direction');
// Clamp all navigation/presets to the cloud's true vertical, not camera roll/up.
viewer.setGroundReference({available:true,matrix:[[1,0,0],[0,1,0],[0,0,2]]});
viewer.setCameraSettings({groundBarrier:true});
const below={position:[0,0,-20],target:[0,0,-10],up:[0,-1,0],roll:0};
let landing=viewer.flyTo(below,1);advance(time+=40);await landing;
assert.ok(viewer.getPose().position[2]>=0,'Flight respects world ground elevation');
const walkDirection=new Three.Vector3(...viewer.getPose().target).sub(new Three.Vector3(...viewer.getPose().position));
assert.ok(Math.abs(walkDirection.z-10)<1e-6,'Ground correction preserves WALK look direction');
assert.equal(viewer.getCameraSettings().groundBarrier,true);
viewer.setCameraSettings({navigationMode:'orbit'});viewer.setPreset('front');advance(time+=40);
assert.ok(viewer.getPose().position[2]>=0,'Preset/orbit cannot go below registered ground');
viewer.setCameraSettings({groundLevel:5});landing=viewer.flyTo(below,1);advance(time+=40);await landing;
assert.ok(viewer.getPose().position[2]>=5,'Editable ground level raises the barrier');
viewer.setCameraSettings({groundLevel:null});
viewer.setCameraSettings({groundBarrier:false});landing=viewer.flyTo(below,1);advance(time+=40);await landing;
assert.ok(viewer.getPose().position[2]<0,'Barrier can be turned off');
const floorCloud=Float32Array.from([[0,1000,0],...Array.from({length:100},(_,i)=>[i%10,0,Math.floor(i/10)])].flat());
viewer.setCloud(floorCloud,new Float32Array(floorCloud.length).fill(.5),new Float32Array(floorCloud.length).fill(.5));
viewer.setCameraSettings({groundBarrier:true,groundLevel:null,navigationMode:'walk'});
landing=viewer.flyTo({position:[0,50,0],target:[0,50,5],up:[0,-1,0],roll:0},1);advance(time+=40);await landing;
assert.ok(viewer.getPose().position[1]<=0,'Auto floor ignores a solitary point below the visible floor');
press('f');for(let i=0;i<12;i++)advance(time+=40);release('f');
assert.ok(viewer.getPose().position[1]<=0,'Holding down in WALK stays above the floor');
viewer.dispose();assert.equal(host.children.length,0);assert.equal(nextFrame,null);
export const navigationChecksPassed=true;

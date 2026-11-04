import * as THREE from './vendor/three.module.js';

export function translateCameraPose(pose,delta){return {...pose,position:pose.position.map((v,k)=>v+delta[k]),target:pose.target.map((v,k)=>v+delta[k]),up:[...pose.up]};}
export function aimCameraPose(pose,point){
  const direction=point.map((v,k)=>v-pose.position[k]),length=Math.hypot(...direction);
  if(length<1e-9)return pose;
  const distance=Math.max(1e-6,Math.hypot(...pose.target.map((v,k)=>v-pose.position[k])));
  return {...pose,position:[...pose.position],up:[...pose.up],target:pose.position.map((v,k)=>v+direction[k]/length*distance)};
}

// Screen overlays share the cloud's exact world coordinates and camera projection.
// Dragging uses a plane parallel to this view, so top view naturally moves in plan.
export function createMainCameraMarker({host,canvas,camera,controls,getPose,onChange}){
  const nodes=[],listeners=[];
  const create=(tag,className)=>{const node=document.createElement(tag);node.className=className;host.append(node);nodes.push(node);return node;};
  const line=create('span','viewer-main-camera-line'),upLine=create('span','viewer-main-camera-up');
  const position=create('button','viewer-main-camera-position'),aim=create('button','viewer-main-camera-aim');
  position.type=aim.type='button';position.textContent='M';aim.textContent='›';position.title='Main camera: drag to move; orange indicates direction, cyan indicates up/roll';aim.title='Main camera direction: drag to aim';
  position.setAttribute('aria-label','Move main camera');aim.setAttribute('aria-label','Aim main camera');
  let drag=null,endWorld=null,visible=false;
  const listen=(node,type,handler)=>{node.addEventListener(type,handler);listeners.push([node,type,handler]);};
  const rect=()=>canvas.getBoundingClientRect();
  function intersection(event,plane){
    const r=rect();if(!r.width||!r.height)return null;
    const ray=new THREE.Raycaster();camera.updateMatrixWorld();
    ray.setFromCamera(new THREE.Vector2((event.clientX-r.left)/r.width*2-1,1-(event.clientY-r.top)/r.height*2),camera);
    return ray.ray.intersectPlane(plane,new THREE.Vector3());
  }
  function finish(event){
    if(!drag)return;controls.enabled=drag.wasEnabled;
    const saved=drag;drag=null;
    if(saved.node.hasPointerCapture?.(saved.pointerId))saved.node.releasePointerCapture(saved.pointerId);
    event?.stopPropagation?.();
  }
  for(const [node,kind] of [[position,'position'],[aim,'aim']]){
    listen(node,'pointerdown',event=>{
      if(event.button!==0||!visible)return;const pose=getPose();if(!pose)return;
      event.preventDefault();event.stopPropagation();
      const origin=kind==='position'?new THREE.Vector3().fromArray(pose.position):endWorld.clone();
      const plane=new THREE.Plane().setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()),origin),start=intersection(event,plane);
      if(!start)return;
      drag={kind,node,pose:structuredClone(pose),origin,plane,start,wasEnabled:controls.enabled,pointerId:event.pointerId};
      controls.enabled=false;node.setPointerCapture(event.pointerId);
    });
    listen(node,'pointermove',event=>{
      if(!drag||drag.node!==node||event.pointerId!==drag.pointerId)return;
      event.preventDefault();event.stopPropagation();const point=intersection(event,drag.plane);if(!point)return;
      const delta=point.sub(drag.start);
      onChange(drag.kind==='position'?translateCameraPose(drag.pose,delta.toArray()):aimCameraPose(drag.pose,drag.origin.clone().add(delta).toArray()));
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(node,type,finish);
    listen(node,'click',event=>{event.preventDefault();event.stopPropagation();});
  }
  const project=(point,r)=>{const v=point.clone().project(camera);return {x:(v.x+1)*r.width/2,y:(1-v.y)*r.height/2,z:v.z};};
  function drawLine(node,a,b){node.style.left=a.x+'px';node.style.top=a.y+'px';node.style.width=Math.hypot(b.x-a.x,b.y-a.y)+'px';node.style.transform=`rotate(${Math.atan2(b.y-a.y,b.x-a.x)}rad)`;}
  return {
    update(){
      const pose=getPose(),r=rect();visible=false;
      if(pose&&r.width&&r.height){
        camera.updateMatrixWorld();const p=new THREE.Vector3().fromArray(pose.position),depth=p.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3()));
        const raw=project(p,r),a={x:Math.max(10,Math.min(r.width-10,raw.x)),y:Math.max(10,Math.min(r.height-10,raw.y))};
        visible=depth>0&&raw.z>=-1&&raw.z<=1;
        if(visible){
          const unit=2*depth*Math.tan(camera.fov*Math.PI/360)/r.height;
          const forward=new THREE.Vector3().fromArray(pose.target).sub(p).normalize();
          endWorld=p.clone().addScaledVector(forward,unit*48);const tip=project(endWorld,r);let b={x:a.x+tip.x-raw.x,y:a.y+tip.y-raw.y};
          const aligned=Math.hypot(b.x-a.x,b.y-a.y)<16;if(aligned)b={x:a.x+36,y:a.y};
          b.x=Math.max(8,Math.min(r.width-8,b.x));b.y=Math.max(8,Math.min(r.height-8,b.y));
          if(Math.hypot(b.x-a.x,b.y-a.y)<12)b={x:a.x>r.width/2?a.x-28:a.x+28,y:a.y};
          position.style.left=a.x+'px';position.style.top=a.y+'px';aim.style.left=b.x+'px';aim.style.top=b.y+'px';
          aim.style.setProperty('--camera-heading',Math.atan2(b.y-a.y,b.x-a.x)+'rad');
          line.style.borderTopStyle=aligned?'dashed':'solid';drawLine(line,a,b);
          const right=forward.clone().cross(new THREE.Vector3().fromArray(pose.up)).normalize();
          const cameraUp=right.cross(forward).normalize().applyAxisAngle(forward,-(pose.roll||0));
          const up=project(p.clone().addScaledVector(cameraUp,unit*18),r);drawLine(upLine,a,{x:a.x+up.x-raw.x,y:a.y+up.y-raw.y});
          position.style.borderStyle=raw.x!==a.x||raw.y!==a.y?'dashed':'solid';
          position.title=raw.x!==a.x||raw.y!==a.y?'Main camera is outside this view (edge marker). Drag to move it.':'Main camera: drag to move; orange indicates direction, cyan indicates up/roll';
        }
      }
      nodes.forEach(node=>{node.hidden=!visible;});
    },
    dispose(){finish();listeners.forEach(([node,type,handler])=>node.removeEventListener(type,handler));nodes.forEach(node=>node.remove());}
  };
}

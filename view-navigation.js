// Screen-edge navigation also works with a single finger, without changing tools.
export function createViewNavigation({host,camera,controls,onNavigate=()=>{},updateCamera=()=>controls.update()}){
  let drag=null;const edges=[];
  function render(){camera.updateMatrixWorld()}
  function apply(kind,dx,start,fine=false){
    const amount=dx*(fine?.25:1);
    if(kind==='zoom'){
      const distance=start.position.distanceTo(start.target),minimum=Math.max(controls.minDistance||0,camera.near*2,1e-6),maximum=Math.max(minimum,Math.min(controls.maxDistance??Infinity,camera.far*.8));
      const next=Math.max(minimum,Math.min(maximum,distance*Math.exp(-amount/Math.max(host.clientWidth,100)*3)));
      camera.position.copy(start.position).sub(start.target).multiplyScalar(next/Math.max(distance,1e-12)).add(start.target);
    }else{
      // Match right-drag panning: dragging right moves the scene to the right.
      const worldPerPixel=2*start.position.distanceTo(start.target)*Math.tan(camera.fov*Math.PI/360)/Math.max(host.clientHeight,1);
      const offset=start.right.clone().multiplyScalar(-amount*worldPerPixel);
      camera.position.copy(start.position).add(offset);controls.target.copy(start.target).add(offset);
    }
    render();
  }
  function snapshot(){render();return {position:camera.position.clone(),target:controls.target.clone(),right:camera.position.clone().setFromMatrixColumn(camera.matrixWorld,0)}}
  function finish(e,cancel=false){if(!drag)return;e.preventDefault();e.stopPropagation();const previous=drag;drag=null;
    if(cancel){camera.position.copy(previous.position);controls.target.copy(previous.target);render()}
    controls.enabled=previous.enabled;previous.edge.classList.remove('dragging');
  }
  for(const [kind,text,title] of [['zoom','−  ZOOM  +','Drag right to zoom in, left to zoom out'],['pan','↔  PAN','Drag left or right to slide the view']]){
    const edge=document.createElement('div');edge.className=`view-navigation-edge ${kind}`;edge.tabIndex=0;edge.setAttribute('role','button');edge.setAttribute('aria-label',`${title}. Arrow keys also work. Shift for fine adjustment; Escape cancels a drag.`);edge.textContent=text;edge.title=title+' · Shift for fine adjustment';
    edge.onpointerdown=e=>{if(e.button!==0||drag)return;e.preventDefault();e.stopPropagation();onNavigate();updateCamera();drag={...snapshot(),x:e.clientX,enabled:controls.enabled,kind,edge,pointerId:e.pointerId};controls.enabled=false;edge.setPointerCapture(e.pointerId);edge.focus({preventScroll:true});edge.classList.add('dragging')};
    edge.onpointermove=e=>{if(!drag||drag.edge!==edge||drag.pointerId!==e.pointerId)return;e.preventDefault();e.stopPropagation();apply(kind,e.clientX-drag.x,drag,e.shiftKey)};
    edge.onpointerup=e=>{if(drag?.edge===edge&&drag.pointerId===e.pointerId)finish(e)};
    edge.onpointercancel=e=>{if(drag?.edge===edge&&drag.pointerId===e.pointerId)finish(e,true)};
    edge.onlostpointercapture=e=>{if(drag?.edge===edge&&drag.pointerId===e.pointerId)finish(e,true)};
    edge.onkeydown=e=>{if(e.key==='Escape'){finish(e,true);return}if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(e.key)||drag)return;e.preventDefault();e.stopPropagation();onNavigate();updateCamera();apply(kind,['ArrowRight','ArrowUp','+'].includes(e.key)?24:-24,snapshot(),e.shiftKey)};
    // A double tap on an edge is navigation, never the tools menu.
    edge.ondblclick=e=>{e.preventDefault();e.stopPropagation()};host.append(edge);edges.push(edge);
  }
  return {dispose(){if(drag){controls.enabled=drag.enabled;drag=null}for(const edge of edges)edge.remove()}};
}

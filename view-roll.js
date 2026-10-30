// View-only roll is applied after OrbitControls, preserving its original world-up basis.
export function createViewRoll({host,camera,controls,onNavigate=()=>{}}){
  let angle=0,applied=0,drag=null;
  const badge=document.createElement('div');badge.className='view-roll-readout';badge.hidden=true;host.append(badge);
  const edges=[];
  const wrap=value=>Math.atan2(Math.sin(value),Math.cos(value));
  function display(){const degrees=angle*180/Math.PI;badge.textContent=`View roll ${degrees.toFixed(1)}°`;badge.hidden=!drag&&Math.abs(degrees)<.05;
    for(const edge of edges)edge.setAttribute('aria-valuenow',degrees.toFixed(1))}
  function update(){
    if(!controls.enabled&&angle===applied)return;
    if(applied)camera.rotateZ(-applied);
    if(controls.enabled)controls.update();
    if(angle)camera.rotateZ(angle);
    applied=angle;camera.updateMatrixWorld();
  }
  function set(value){angle=wrap(value);update();display()}
  function finish(e){if(!drag)return;e.preventDefault();e.stopPropagation();const previous=drag;if(e.type==='pointercancel')set(previous.angle);drag=null;controls.enabled=previous.enabled;display()}
  for(const [side,name] of [[-1,'left'],[1,'right']]){
    const edge=document.createElement('div');edge.className=`view-roll-edge ${name}`;edge.tabIndex=0;edge.setAttribute('role','slider');edge.setAttribute('aria-label',`${name} edge: drag up/down to roll view; double-click or Home to reset`);edge.setAttribute('aria-valuemin','-180');edge.setAttribute('aria-valuemax','180');edge.setAttribute('aria-valuenow','0');edge.title='Drag up/down to roll view · Shift for fine adjustment · Double-click to reset';edge.textContent='ROLL';
    edge.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();onNavigate();update();drag={y:e.clientY,angle,enabled:controls.enabled,side,height:Math.max(host.clientHeight,100)};controls.enabled=false;edge.setPointerCapture(e.pointerId);edge.focus({preventScroll:true});display()};
    edge.onpointermove=e=>{if(!drag)return;e.preventDefault();e.stopPropagation();set(drag.angle+drag.side*(e.clientY-drag.y)/drag.height*Math.PI*(e.shiftKey ? .25 : 1))};
    edge.onpointerup=finish;edge.onpointercancel=finish;
    edge.ondblclick=e=>{e.preventDefault();e.stopPropagation();onNavigate();set(0)};
    edge.onkeydown=e=>{if(e.key==='Home'||e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();onNavigate();set(e.key==='Home'?0:angle+side*(e.key==='ArrowDown'?1:-1)*Math.PI/180*(e.shiftKey ? .25 : 1))}else if(e.key==='Escape'&&drag)finish({...e,type:'pointercancel',preventDefault:()=>e.preventDefault(),stopPropagation:()=>e.stopPropagation()})};
    host.append(edge);edges.push(edge);
  }
  display();
  return {update,set,reset(){onNavigate();set(0)},get angle(){return angle},dispose(){if(drag){controls.enabled=drag.enabled;drag=null}for(const edge of edges)edge.remove();badge.remove()}};
}

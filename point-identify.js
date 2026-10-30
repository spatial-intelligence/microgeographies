export function attachPointIdentify({host,canvas,getTool,pick,identify,tooltip,onError=()=>{}}){
  let down=null,request=0,disposed=false;
  function clear(){request++;down=null;tooltip.clear()}
  function start(e){if(e.button!==0)return;clear();if(getTool()==='identify')down={x:e.clientX,y:e.clientY,pointer:e.pointerId}}
  async function end(e){
    const start=down;down=null;
    if(e.button!==0||!start||start.pointer!==e.pointerId||getTool()!=='identify'||Math.hypot(e.clientX-start.x,e.clientY-start.y)>4)return;
    const index=pick(e);if(index===null||index===undefined){clear();return}
    const token=++request,r=host.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    try{const result=await identify(index);if(!disposed&&token===request&&getTool()==='identify')tooltip.show(x,y,result.label,result.object_id??-1)}
    catch(e){if(!disposed&&token===request){tooltip.clear();onError(e.message)}}
  }
  const listeners=[['pointerdown',start],['pointerup',end],['pointercancel',clear]];
  for(const [event,fn] of listeners)canvas.addEventListener(event,fn);
  return {clear,dispose(){disposed=true;clear();for(const [event,fn] of listeners)canvas.removeEventListener(event,fn);tooltip.dispose()}};
}

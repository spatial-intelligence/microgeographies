let topLayer=1200;

export function createToolWindow({id,title,content,width=390,left=24,top=100,className='',onClose=null}) {
  const panel=document.createElement('section');panel.id=id;panel.className=`tool-window ${className}`;
  panel.hidden=true;panel.setAttribute('role','dialog');panel.setAttribute('aria-label',title);panel.setAttribute('aria-modal','false');
  panel.style.width=`${width}px`;panel.style.left=`${left}px`;panel.style.top=`${top}px`;
  const header=document.createElement('header');header.className='tool-window-header';
  const heading=document.createElement('strong');heading.textContent=title;
  const close=document.createElement('button');close.type='button';close.textContent='Close';close.setAttribute('aria-label',`Close ${title}`);
  const body=document.createElement('div');body.className='tool-window-body';body.append(content);
  header.append(heading,close);panel.append(header,body);document.body.append(panel);
  const raise=()=>panel.style.zIndex=++topLayer;
  function constrain(){const r=panel.getBoundingClientRect();panel.style.left=`${Math.max(0,Math.min(parseFloat(panel.style.left)||0,innerWidth-Math.min(r.width,innerWidth)))}px`;const y=Math.max(0,Math.min(parseFloat(panel.style.top)||0,innerHeight-100));panel.style.top=`${y}px`;panel.style.maxHeight=`${innerHeight-y-8}px`;}
  let drag=null;
  header.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('button'))return;const r=panel.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,left:r.left,top:r.top};header.setPointerCapture(e.pointerId);raise();e.preventDefault();});
  header.addEventListener('pointermove',e=>{if(!drag)return;panel.style.left=`${drag.left+e.clientX-drag.x}px`;panel.style.top=`${drag.top+e.clientY-drag.y}px`;constrain();});
  const end=()=>drag=null;header.addEventListener('pointerup',end);header.addEventListener('pointercancel',end);
  panel.addEventListener('pointerdown',raise);close.onclick=()=>{if(onClose)onClose();else panel.hidden=true;};
  window.addEventListener('resize',constrain);
  return {element:panel,show(){panel.hidden=false;constrain();raise();},hide(){panel.hidden=true;},
    getLayout(){return {left:panel.style.left,top:panel.style.top,width:panel.style.width,height:panel.style.height};},
    setLayout(layout){for(const k of ['left','top','width','height'])if(/^\d+(\.\d+)?px$/.test(layout?.[k]||''))panel.style[k]=layout[k];constrain();},
    dispose(){window.removeEventListener('resize',constrain);panel.remove();}};
}

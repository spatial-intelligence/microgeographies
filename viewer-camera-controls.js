export function clampDepthRange(min,max,limit,changed='min'){
  limit=Math.max(2,Number(limit)||2);min=Math.max(0,Math.min(limit-1,Number(min)||0));max=Math.max(1,Math.min(limit,Number(max)||1));
  if(max-min<1){if(changed==='max')min=Math.max(0,max-1);else max=Math.min(limit,min+1);}
  return [min,max];
}

export function createViewerCameraControls({host,toolbar,state,span,apply}){
  const panel=document.createElement('details');panel.className='viewer-camera-panel';
  panel.innerHTML=`<summary title="Camera and depth settings" aria-label="Camera and depth settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m4 7 3-3h10l3 3v13H4z"/><circle cx="12" cy="12" r="4"/></svg><span class="viewer-tool-label">Camera &amp; depth</span></summary><div class="viewer-camera-body"><label>Navigation<select data-camera-mode><option value="orbit">ORBIT object</option><option value="walk">WALK around</option></select></label><label title="Keep the camera above the ground level, using registered elevation when available"><input data-ground-barrier type="checkbox"> Ground barrier</label><div data-ground-options><label>Ground level <span data-ground-unit></span><input data-ground-level type="number" step="any" min="0"></label><button type="button" data-ground-auto>Auto floor</button><p>Height above the cloud minimum. Auto floor ignores the lowest 2% to reduce stray-point effects. Raise this level if the camera still passes below the visible floor.</p></div><label>Field of view <output data-fov-label></output><input data-fov type="range" min="25" max="110" step="1" value="55"></label><div class="depth-filter"><label>Minimum depth <output data-min-label></output><input data-depth-min type="range" min="0" step="1" value="0"></label><div class="depth-filter-line"></div><label><input data-depth-max type="range" min="1" step="1"><span>Maximum depth <output data-max-label></output></span></label></div><fieldset class="representation-controls"><legend>Cloud representation</legend><label>View<select data-render-mode><option value="points">Point cloud</option><option value="mosaic">Photo mosaic / cutouts</option><option value="tin">TIN triangle mesh</option><option value="gaussians">Gaussian splatting</option></select></label><label>Synthetic densification <output data-densify-label>?0</output><input data-densify type="range" min="0" max="1000" value="0" step="0.1"></label><label data-tin-options><input data-tin-wireframe type="checkbox"> TIN wireframe</label><div data-mosaic-options><label>Photo opacity<input data-mosaic-opacity type="range" min="0.1" max="1" value="0.85" step="0.05"></label><label>Photo budget (1-250)<input data-mosaic-budget type="number" min="1" max="250" value="64"></label></div><p data-geometry-status role="status"></p><p>?1 adds one point per original; ?1000 requests 1000 per original. Added points fill supported local gaps, avoiding strong colour and depth boundaries; the preview is capped at 2 million added points. Picking and exports use original samples. In TIN mode, smaller Point Size creates a denser mesh. Mosaic uses recovered photo poses and available depth.</p></fieldset><p>ORBIT: drag to pan, Ctrl + drag to spin. WALK: drag to look, WASD to move, R/F up/down. Depth is distance in front of this camera; bounds stay at least 1 apart.</p></div>`;
  if(!panel.querySelector)return {refresh(){},dispose(){}};
  if(toolbar)toolbar.prepend(panel);else host.append(panel);const $=s=>panel.querySelector(s);
  panel.addEventListener('toggle',()=>{if(panel.open)panel.querySelector('.viewer-camera-body').style.maxHeight=Math.max(80,Math.min(host.clientHeight-95,host.getBoundingClientRect().bottom-95,innerHeight*.58))+'px';});
  function refresh(){const scale=state.depthScale||1,limit=Math.max(2,Math.ceil(span*3*scale));
    state.depthLimit=limit;
    if(!Number.isFinite(state.depthMax))state.depthMax=limit;
    [state.depthMin,state.depthMax]=clampDepthRange(state.depthMin,state.depthMax,limit);
    $('[data-render-mode]').value=state.renderMode;
    $('[data-render-mode] [value="mosaic"]').disabled=!state.hasPhotos;$('[data-render-mode] [value="gaussians"]').disabled=!state.hasGaussians;
    $('[data-densify]').value=state.densify;$('[data-densify]').disabled=state.renderMode!=='points';$('[data-densify-label]').textContent='?'+state.densify;
    $('[data-tin-options]').hidden=state.renderMode!=='tin';$('[data-tin-wireframe]').checked=!!state.tinWireframe;
    $('[data-mosaic-options]').hidden=state.renderMode!=='mosaic';$('[data-mosaic-opacity]').value=state.mosaicOpacity;$('[data-mosaic-budget]').value=state.mosaicBudget;
     $('[data-ground-barrier]').checked=!!state.groundBarrier;
    $('[data-ground-options]').hidden=!state.groundBarrier;
    $('[data-ground-level]').value=Number(((state.groundLevel??state.groundAuto??0)*scale).toFixed(4));
    $('[data-ground-unit]').textContent=state.metric?'(m above cloud minimum)':'(units above cloud minimum)';
    $('[data-camera-mode]').value=state.navigationMode;$('[data-fov]').value=state.fov;$('[data-fov-label]').textContent=state.fov+'°';
    for(const key of ['min','max']){$(`[data-depth-${key}]`).max=limit;$(`[data-depth-${key}]`).value=state[key==='min'?'depthMin':'depthMax'];$(`[data-${key}-label]`).textContent=state[key==='min'?'depthMin':'depthMax'].toFixed(0)+(state.metric?' m':' units');}
  }
  $('[data-camera-mode]').onchange=e=>{state.navigationMode=e.target.value;apply();};
  $('[data-ground-barrier]').onchange=e=>{state.groundBarrier=e.target.checked;refresh();apply();};
  $('[data-ground-level]').onchange=e=>{state.groundLevel=Math.max(0,Number(e.target.value)||0)/(state.depthScale||1);refresh();apply();};
  $('[data-ground-auto]').onclick=()=>{state.groundLevel=null;refresh();apply();};
  $('[data-fov]').oninput=e=>{state.fov=Number(e.target.value);refresh();apply();};
  for(const bound of ['min','max'])$(`[data-depth-${bound}]`).oninput=e=>{[state.depthMin,state.depthMax]=clampDepthRange(bound==='min'?e.target.value:state.depthMin,bound==='max'?e.target.value:state.depthMax,state.depthLimit,bound);refresh();apply();};
  $('[data-render-mode]').onchange=e=>{state.renderMode=e.target.value;refresh();apply();};
  $('[data-densify]').oninput=e=>{state.densify=Number(e.target.value);refresh();apply();};
  $('[data-tin-wireframe]').onchange=e=>{state.tinWireframe=e.target.checked;apply();};
  $('[data-mosaic-opacity]').oninput=e=>{state.mosaicOpacity=Number(e.target.value);apply();};
  $('[data-mosaic-budget]').onchange=e=>{state.mosaicBudget=Math.max(1,Math.min(250,Number(e.target.value)||64));refresh();apply();};
  refresh();return {refresh,setGeometryInfo(info){
    const pieces=[info.original.toLocaleString()+' original points'];
    if(state.renderMode==='points')pieces.push(info.synthetic.toLocaleString()+' synthetic points (?'+(info.synthetic/Math.max(1,info.original)).toFixed(1)+' added)');
    if(state.renderMode==='tin')pieces.push(info.triangles.toLocaleString()+' triangles / '+info.meshVertices.toLocaleString()+' mesh vertices');
    if(state.renderMode==='mosaic')pieces.push(info.photos+' / '+info.photoTotal+' source photos'+(info.planarPhotos?' ('+info.planarPhotos+' median-depth photo planes)':''));
    if(state.renderMode==='points'&&info.requested>info.synthetic&&!info.busy)pieces.push(info.requested>info.target?'2 million point preview limit; actual density shown':'Some gaps rejected by surface/boundary checks');
    if(info.busy)pieces.push('Building preview...');if(info.error)pieces.push(info.error);
    if(!info.busy&&state.renderMode==='tin'&&!info.triangles)pieces.push('No supported surface: try a smaller Point Size.');
    if(!info.busy&&state.renderMode==='mosaic'&&!info.photos)pieces.push('No supported source photo geometry.');
    $('[data-geometry-status]').textContent=pieces.join(' / ');
  },dispose(){panel.remove();}};
}

import {createToolWindow} from './floating-windows.js';
import {geographicPoint} from './geo-cloud.js';
import {createSurveyReview} from './survey-review.js';
import {newItemId} from './labelled-items.js';

export function cameraRotation(camera) {
  const [w,x,y,z]=camera?.qvec || [1,0,0,0];
  return [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
    [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
    [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]];
}
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const RADIUS=6371000;

export function localPointFromMap(lon,lat,local,reference){
  const {matrix,translation,origin}=reference,scaleSquared=matrix[0].reduce((s,v)=>s+v*v,0);
  const enu=[(lon-origin.lon)*Math.PI/180*RADIUS*Math.cos(origin.lat*Math.PI/180),(lat-origin.lat)*Math.PI/180*RADIUS,dot(matrix[2],local)+translation[2]];
  return [0,1,2].map(k=>matrix.reduce((sum,row,j)=>sum+row[k]*(enu[j]-translation[j]),0)/scaleSquared);
}

// Map positions constrain horizontal registration. First-camera Y supplies
// vertical: the operator must have started with a level camera.
export function fitMapControls(controls, camera, altitude=null) {
  if(controls.length<3) throw Error('Add at least three cloud/map pairs.');
  const rotation=cameraRotation(camera), lat=controls.reduce((s,c)=>s+c.lat,0)/controls.length;
  const lon=controls.reduce((s,c)=>s+c.lon,0)/controls.length;
  const xy=controls.map(c=>[dot(rotation[0],c.local),dot(rotation[2],c.local)]);
  const en=controls.map(c=>[(c.lon-lon)*Math.PI/180*RADIUS*Math.cos(lat*Math.PI/180),(c.lat-lat)*Math.PI/180*RADIUS]);
  const mean=p=>[0,1].map(k=>p.reduce((s,v)=>s+v[k],0)/p.length);
  const cx=mean(xy),cy=mean(en);let xx=0,zz=0,xz=0,aa=0,bb=0;
  xy.forEach((p,i)=>{const x=p[0]-cx[0],z=p[1]-cx[1],e=en[i][0]-cy[0],n=en[i][1]-cy[1];xx+=x*x;zz+=z*z;xz+=x*z;aa+=x*e+z*n;bb+=x*n-z*e;});
  if(xx*zz-xz*xz<1e-5*(xx+zz)**2) throw Error('Cloud control points must be spread across a non-collinear area.');
  const a=aa/(xx+zz),b=bb/(xx+zz),scale=Math.hypot(a,b);
  if(!Number.isFinite(scale)||scale<1e-6) throw Error('Map positions must be distinct and spread across the site.');
  const matrix=[rotation[0].map((v,k)=>a*v-b*rotation[2][k]),rotation[0].map((v,k)=>b*v+a*rotation[2][k]),rotation[1].map(v=>-scale*v)];
  const translation=[cy[0]-a*cx[0]+b*cx[1],cy[1]-b*cx[0]-a*cx[1],scale*dot(rotation[1],controls[0].local)];
  const residuals=controls.map((c,i)=>Math.hypot(dot(matrix[0],c.local)+translation[0]-en[i][0],dot(matrix[1],c.local)+translation[1]-en[i][1]));
  return {available:true,origin:{lat,lon,altitude_m:altitude ?? 0},matrix,translation,scale_m_per_unit:scale,
    rms_m:Math.sqrt(residuals.reduce((s,v)=>s+v*v,0)/controls.length),residuals,
    altitude_known:altitude!==null,method:'Manual horizontal similarity; first camera assumed level',controls};
}

export function relevantFrames(local, cameras, frames, radius=0) {
  return cameras.flatMap(c=>{
    const r=cameraRotation(c),p=r.map((row,k)=>dot(row,local)+(c.tvec?.[k]||0));
    if(p[2]<=0) return [];
    const [fx,fy,cx,cy]=c.params,u=fx*p[0]/p[2]+cx,v=fy*p[1]/p[2]+cy;
    const margin=Math.max(fx,fy)*radius/p[2];
    if(u< -margin||u>=c.width+margin||v< -margin||v>=c.height+margin)return [];
    const frame=frames.find(f=>f.image===c.image);if(!frame)return [];
    if(frame.depth && !radius){const d=frame.depth[Math.min(31,Math.max(0,Math.floor(v/c.height*32)))*32+Math.min(31,Math.max(0,Math.floor(u/c.width*32)))];
      if(d>0&&p[2]>d+Math.max(.15,d*.08))return [];}
    return [{...frame,u:u/c.width,v:v/c.height,score:Math.hypot((u-cx)/fx,(v-cy)/fy)}];
  }).sort((a,b)=>a.score-b.score);
}

export function createVideoSurvey({host,getContext,onReference,onTags}) {
  host.innerHTML=`<div class="survey-tools" role="group" aria-label="Survey tools">
      <button data-tool="control">Georeference</button>
      <button id="surveyExport" disabled>Export survey</button>
    </div><p id="surveyStatus" role="status">Build or load a project to begin.</p>
    <section id="surveyRegisterPanel"><p class="hint">Click a cloud point, then its map position. Add at least three pairs spread across the site. Start with a level camera. Heights are relative to control 1 unless its surveyed elevation is entered.</p>
      <label>Control 1 elevation (metres, optional)<input id="surveyAltitude" type="number" step="any"></label>
      <label class="row"><input id="surveyLiveRefine" type="checkbox" checked> Re-register automatically when dragging map controls</label>
      <p class="hint">Drag a numbered map marker to refine the cloud alignment. Move 3D / Move map correct either half of a pair. Escape cancels an edit.</p>
      <button id="surveyCancelEdit" hidden>Cancel point edit</button><ol id="surveyControls"></ol>
      <button id="surveyRegister">Register cloud on map</button><button id="surveyUndo">Undo pair</button>
    </section>
    <section id="surveyMeasurePanel"><p>Click two cloud points in either view. The segment and distance appear in both views.</p><button id="surveyClearMeasure">Clear measurement</button></section>
    <section id="surveyTagPanel"><p>Click a cloud point to create a tag, or choose Edit on an existing tag. Map tags can also be dragged or clicked to edit.</p>
      <form id="surveyTagForm" hidden><label>Name / type<input id="surveyTagName" required maxlength="160" placeholder="Printer, bin, office"></label>
      <div class="coordinate-fields" id="surveyTagCoords"><label>Latitude<input id="surveyTagLat" type="number" min="-85" max="85" step="any" required></label><label>Longitude<input id="surveyTagLon" type="number" min="-180" max="180" step="any" required></label></div>
      <label>Location<select id="surveyIndoor"><option value="outdoor">Outdoor</option><option value="indoor">Indoor</option></select></label>
      <label id="surveyFloorRow" hidden>Floor level<input id="surveyFloor" type="number" step="1" value="0"></label>
      <button type="submit">Save POINT</button></form><ul id="surveyTags"></ul>
    </section>
    <aside id="surveyPhotos" hidden><label>Region radius (metres; 0 = point)<input id="surveyRadius" type="number" min="0" max="100" step="0.1" value="0"></label>
      <p class="hint">Click a cloud point to see sampled source frames. Visibility is estimated from projection and depth. Browse with , / . or &lt; / &gt;.</p>
      <div class="survey-photo-wrap"><img id="surveyPhoto" alt="Source video frame"><i id="surveyCrosshair"></i></div>
      <button id="surveyPrev">Previous</button><button id="surveyNext">Next</button><p id="surveyPhotoInfo"></p></aside>`;
  const $=id=>document.getElementById(id);let controls=[],tags=[],pending=null,selected=null,measurement=[],photos=[],photoIndex=0,tool='orbit',map=null,mapHandler=null,controlLayer=null,editing=null,editingTag=null;
  const windows={};
  for(const [key,id,title] of [['control','surveyRegisterPanel','Georeference'],['measure','surveyMeasurePanel','Measure'],['tag','surveyTagPanel','Tags'],['photos','surveyPhotos','Source photos']]){
    windows[key]=createToolWindow({id:'surveyWindow-'+key,title,content:$(id),width:key==='photos'?420:410,
      left:Math.max(12,innerWidth-(key==='photos'?440:430)),top:key==='photos'?110:Math.max(90,innerHeight*.52),className:'survey-window'});
  }
  const status=text=>{$('surveyStatus').textContent=text;};
  const review=createSurveyReview({host,getContext,getTags:()=>tags,
    getFrames:local=>{const ctx=getContext();return relevantFrames(local,ctx.data.cameras||[],ctx.data.source_frames||[]);},
    onChange:()=>publishTags()});
  function eachViewer(action){const ctx=getContext();(ctx.viewers || [ctx.viewer]).filter(Boolean).forEach(action);}
  function overlay(){
    const points=[...controls.map((c,i)=>({index:c.index,number:i+1,controlId:!editing&&['control','orbit'].includes(tool)?i:undefined,pending:editing?.index===i})),
      ...tags.map(t=>({index:t.point_index,local:t.local,number:t.name})),
      ...(pending?[{index:pending.index,number:controls.length+1,pending:true}]:[])];
    eachViewer(viewer=>viewer.setControlPoints(points));
  }
  function cancelEdit(){editing=null;pending=null;$('surveyCancelEdit').hidden=true;overlay();}
  function startEdit(index,side){
    if(!controls[index])return;
    setTool('control');editing={index,side};$('surveyCancelEdit').hidden=false;
    renderControls();status(`Move control ${index+1}: click its corrected ${side==='cloud'?'point in either 3D view':'map location'}. Escape cancels.`);
  }
  function changed(message){invalidate();renderControls();status(message+' Register again to update world coordinates.');}
  function removeControl(index){
    cancelEdit();controls.splice(index,1);
    if(index===0)$('surveyAltitude').value='';
    changed('Control point deleted.');
  }
  function setTool(value){tool=value;cancelEdit();eachViewer(viewer=>viewer.setTool(value));host.querySelectorAll('[data-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tool===value)));$('surveyPhotos').hidden=value!=='photos';$('surveyTagForm').hidden=true;Object.values(windows).forEach(w=>w.hide());windows[value]?.show();renderControls();status(value==='identify'?'Click a point in either 3D view to see its class.':value==='control'?'Click a point in the cloud, then its map position.':`Click a cloud point to ${value==='tag'?'create a tag':value==='measure'?'measure a distance':value==='photos'?'find source frames':'navigate'}.`);}
  host.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
  function renderControls(){
    if(map && window.L){
      controlLayer?.remove();controlLayer=window.L.layerGroup().addTo(map);
      controls.forEach((c,i)=>{
        const icon=window.L.divIcon({className:'survey-map-control'+(editing?.index===i?' selected':''),html:String(i+1),iconSize:[26,26],iconAnchor:[13,13]});
        const marker=window.L.marker([c.lat,c.lon],{icon,draggable:true,bubblingMouseEvents:false,title:`Control point ${i+1}: drag to correct its map position`}).addTo(controlLayer);
        marker.on('click',()=>startEdit(i,'map'));
        marker.on('dragend',()=>{const p=marker.getLatLng();cancelEdit();controls[i]={...controls[i],lat:p.lat,lon:p.lng};changed(`Map position for control ${i+1} moved.`);if($('surveyLiveRefine').checked&&controls.length>=3)register();});
      });
    }
    $('surveyControls').replaceChildren(...controls.map((c,i)=>{
      const li=document.createElement('li');li.dataset.controlIndex=i;li.setAttribute('aria-label',`Control point ${i+1}`);
      li.classList.toggle('editing',editing?.index===i);
      const label=document.createElement('span'),residual=getContext().data?.georeference?.residuals?.[i];
      label.textContent=`${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`+(residual!=null?` - residual ${residual.toFixed(2)} m`:'');
      li.append(label);
      for(const [text,action] of [['Move 3D',()=>startEdit(i,'cloud')],['Move map',()=>startEdit(i,'map')],['Delete',()=>removeControl(i)]]){
        const button=document.createElement('button');button.type='button';button.textContent=text;button.onclick=action;li.append(button);
      }
      return li;
    }));overlay();
  }
  function invalidate(){
    review.invalidate();
    if(getContext().data?.georeference?.method?.startsWith('Manual')){onReference({available:false,reason:'Control points changed; register again.'});onTags([]);}
    measurement=[];eachViewer(viewer=>viewer.setMeasurement([]));$('surveyExport').disabled=true;
  }
  $('surveyCancelEdit').onclick=()=>{cancelEdit();renderControls();status('Point edit cancelled.');};
  $('surveyUndo').onclick=()=>{if(pending){cancelEdit();renderControls();status('Pending control point cancelled.');return;}if(controls.length)removeControl(controls.length-1);};
  function register(){try{const ctx=getContext();if(!ctx.cloud)throw Error('Build a cloud first.');const value=$('surveyAltitude').value,ref=fitMapControls(controls,ctx.data.cameras?.[0],value===''?null:Number(value));onReference(ref);review.invalidate();renderControls();publishTags();status(`Registered ${controls.length} pairs · horizontal RMS ${ref.rms_m.toFixed(2)} m · scale ${ref.scale_m_per_unit.toFixed(4)} m/unit. ${ref.altitude_known?'Surveyed elevation used.':'Heights are relative to control point 1.'}`);}catch(e){status(e.message);}}
  $('surveyRegister').onclick=register;
  $('surveyAltitude').oninput=()=>{invalidate();status('Elevation changed. Register again to update coordinates.');};
  $('surveyClearMeasure').onclick=()=>{measurement=[];eachViewer(viewer=>viewer.setMeasurement([]));status('Measurement cleared.');};
  $('surveyIndoor').onchange=()=>{$('surveyFloorRow').hidden=$('surveyIndoor').value!=='indoor';$('surveyFloor').required=$('surveyIndoor').value==='indoor';};
  function features(){const ref=getContext().data?.georeference;return [...tags.map(t=>{const coordinates=ref?.available?geographicPoint(new Float64Array(t.local),0,ref):null;if(coordinates&&!ref.altitude_known)coordinates.pop();return {type:'Feature',geometry:coordinates?{type:'Point',coordinates}:null,properties:{...t,local_xyz:t.local,altitude_reference:!ref?.available?'unregistered':ref.altitude_known?'surveyed':'relative to control point 1',relative_height_m:ref?.available?geographicPoint(new Float64Array(t.local),0,ref)[2]-(ref.origin.altitude_m||0):null}};}),...review.features()];}
  function publishTags(){
    review.refreshClasses();
    overlay();onTags(features());$('surveyExport').disabled=!getContext().cloud;
    $('surveyTags').replaceChildren(...tags.map((t,i)=>{const li=document.createElement('li');li.textContent=`${t.name} · ID ${t.item_id||'unassigned'} - ${t.indoor?'Indoor / floor '+t.floor:'Outdoor'} `;
      const edit=document.createElement('button');edit.textContent='Edit';edit.onclick=()=>editTag(i);
      const remove=document.createElement('button');remove.textContent='Delete';remove.onclick=()=>{tags.splice(i,1);review.invalidate();publishTags();};li.append(edit,remove);return li;}));
  }
  function detectedTags(){const ctx=getContext();return review.items().filter(item=>!item.manual).map(item=>({name:item.label,item_id:item.item_id,local:[...item.local],point_index:item.point_index,indoor:false,floor:null,detected:true,
    source:ctx.data?.detector==='api'?'SAM 3.1 API':'Detected cloud label',aggregation:'labelled item'}));}
  function openTagForm(tag,index=null){
    editingTag=index;selected={index:tag.point_index,local:[...tag.local]};
    const ref=getContext().data?.georeference,coords=ref?.available?geographicPoint(new Float64Array(tag.local),0,ref):null;
    $('surveyTagCoords').hidden=!coords;
    for(const id of ['surveyTagLat','surveyTagLon']){$(id).disabled=!coords;$(id).required=!!coords;}
    $('surveyTagName').value=tag.name||'';$('surveyTagLat').value=coords?.[1]??'';$('surveyTagLon').value=coords?.[0]??'';
    $('surveyIndoor').value=tag.indoor?'indoor':'outdoor';$('surveyFloor').value=tag.floor??0;$('surveyIndoor').onchange();
    $('surveyTagForm').hidden=false;windows.tag.show();$('surveyTagName').focus({preventScroll:true});
  }
  function editTag(index){if(!tags[index])return;setTool('tag');openTagForm(tags[index],index);}
  function moveTag(index,lat,lon){const ref=getContext().data?.georeference;if(!ref?.available||!tags[index])return;tags[index].local=localPointFromMap(lon,lat,tags[index].local,ref);review.invalidate();publishTags();status('Tag position updated.');}
  $('surveyTagForm').onsubmit=e=>{
    e.preventDefault();const ref=getContext().data?.georeference;
    if(!selected){status('Choose a cloud point before saving a tag.');return;}
    const name=$('surveyTagName').value.trim();if(!name)return;
    const indoor=$('surveyIndoor').value==='indoor',tag={name,item_id:editingTag===null?newItemId():(tags[editingTag].item_id||newItemId()),indoor,floor:indoor?Number($('surveyFloor').value):null,
      local:ref?.available?localPointFromMap(Number($('surveyTagLon').value),Number($('surveyTagLat').value),selected.local,ref):[...selected.local],point_index:selected.index,source:'DA3 video cloud'};
    if(editingTag===null)tags.push(tag);else tags[editingTag]=tag;
    editingTag=null;review.invalidate();publishTags();$('surveyTagForm').hidden=true;status(ref?.available?'World-coordinate POINT saved.':'Local POINT saved. Georeferencing later will supply map coordinates.');
  };
  $('surveyExport').onclick=()=>{const blob=new Blob([JSON.stringify({type:'FeatureCollection',features:features(),georeference:getContext().data.georeference},null,2)],{type:'application/geo+json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='microgeo-video-survey.geojson';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  function showPhoto(){const f=photos[photoIndex];$('surveyPhoto').hidden=!f;$('surveyCrosshair').hidden=!f;$('surveyPrev').disabled=$('surveyNext').disabled=photos.length<2;$('surveyPhotoInfo').textContent=f?`${photoIndex+1} / ${photos.length} · ${f.image}${f.time_s!=null?' · '+f.time_s.toFixed(2)+' s':''}`:'No sampled frames view this selection. Try a larger region.';if(f){$('surveyPhoto').src=f.url;$('surveyCrosshair').style.left=`${Math.max(0,Math.min(1,f.u))*100}%`;$('surveyCrosshair').style.top=`${Math.max(0,Math.min(1,f.v))*100}%`;}}
  function browse(delta){if(photos.length){photoIndex=(photoIndex+delta+photos.length)%photos.length;showPhoto();}}
  $('surveyPrev').onclick=()=>browse(-1);$('surveyNext').onclick=()=>browse(1);
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&(editing||pending)&&!host.hidden&&!host.closest('[hidden]')){cancelEdit();renderControls();status('Point edit cancelled.');return;}if(host.hidden||host.closest('[hidden]')||tool!=='photos'||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable)return;if([',','<','.','>'].includes(e.key)){e.preventDefault();browse([',','<'].includes(e.key)?-1:1);}});
  function findPhotos(){windows.photos.show();if(!selected)return;const ctx=getContext(),scale=ctx.data.georeference?.scale_m_per_unit||1;photos=relevantFrames(selected.local,ctx.data.cameras||[],ctx.data.source_frames||[],Math.max(0,Number($('surveyRadius').value)||0)/scale);photoIndex=0;showPhoto();}
  $('surveyRadius').oninput=findPhotos;
  function pick(index){const ctx=getContext(),local=Array.from(ctx.cloud.positions.subarray(index*3,index*3+3));selected={index,local};if(tool==='control'){if(editing){if(editing.side!=='cloud'){status('Click the map to move this control, or cancel the edit.');return;}const i=editing.index;controls[i]={...controls[i],index,local};cancelEdit();changed(`3D position for control ${i+1} moved.`);return;}pending=selected;overlay();status(`Control ${controls.length+1} selected. Click its matching map location.`);}else if(tool==='measure'){if(measurement.length===2)measurement=[];measurement.push(index);eachViewer(viewer=>viewer.setMeasurement(measurement,ctx.data.georeference?.scale_m_per_unit||1));if(measurement.length===2){const p=ctx.cloud.positions,d=Math.hypot(...local.map((v,k)=>v-p[measurement[0]*3+k])),scale=ctx.data.georeference?.scale_m_per_unit;status(`Distance: ${(d*(scale||1)).toFixed(3)} ${scale||ctx.data.metric?'m':'local units'}${scale?' (registered scale)':''}`);}else status('Click the second endpoint.');}else if(tool==='tag'){openTagForm({point_index:index,local,name:'',indoor:false,floor:0});}else if(tool==='photos')findPhotos();}
  return {
    editTag,moveTag,setTool,
    snapshot(){return structuredClone({controls,tags,measurement,review:review.snapshot(),altitude:$('surveyAltitude').value,liveRefine:$('surveyLiveRefine').checked,windows:Object.fromEntries(Object.entries(windows).map(([k,v])=>[k,v.getLayout()]))});},
    restore(saved){
      controls=structuredClone(saved?.controls||[]);tags=structuredClone(saved?.tags||[]);measurement=saved?.measurement||[];
      review.restore(saved?.review);
      if(tags.some(tag=>tag.aggregation==='label centroid')){tags=tags.filter(tag=>tag.aggregation!=='label centroid');tags.push(...detectedTags());}
      $('surveyAltitude').value=saved?.altitude??'';$('surveyLiveRefine').checked=saved?.liveRefine!==false;
      for(const [k,layout] of Object.entries(saved?.windows||{}))windows[k]?.setLayout(layout);
      setTool('orbit');renderControls();publishTags();eachViewer(v=>v.setMeasurement(measurement,getContext().data?.georeference?.scale_m_per_unit||1));status('Project restored.');
    },
    reset(){
      controls=[];tags=[];pending=selected=null;measurement=[];photos=[];
      review.restore(null);
      tags=detectedTags();
      setTool('orbit');renderControls();publishTags();showPhoto();
    },
    attach(){
      const ctx=getContext();
      eachViewer(viewer=>{viewer.onPointPick(pick);viewer.onControlPointPick(index=>startEdit(index,'cloud'));viewer.setTool(tool);
        viewer.setIdentifyMetadata?.((index,local,label)=>{
          if(host.hidden)return {};
          const tag=tags.find(tag=>tag.aggregation!=='label centroid'&&tag.point_index===index);
          const item=review.itemForPoint(index);
          return {label:item?.label||tag?.name||label,object_id:item?.item_id??-1,metadata:[...(tag&&!tag.detected?[{title:'User tag',answer:{name:tag.name,item_id:tag.item_id,indoor:tag.indoor,floor:tag.floor}}]:[]),...review.identify(index,local,item?.label||tag?.name||label)]};
        });});
      if(map!==ctx.map){
        if(map&&mapHandler)map.off('click',mapHandler);map=ctx.map;
        mapHandler=e=>{
          if(tool!=='control')return;
          if(editing){
            if(editing.side!=='map'){status('Click either cloud view to move this control, or cancel the edit.');return;}
            const i=editing.index;controls[i]={...controls[i],lat:e.latlng.lat,lon:e.latlng.lng};cancelEdit();changed(`Map position for control ${i+1} moved.`);return;
          }
          if(!pending)return;
          controls.push({...pending,lat:e.latlng.lat,lon:e.latlng.lng});pending=null;
          changed(`${controls.length} pair(s). Select another cloud point or register.`);
        };
        map?.on('click',mapHandler);
      }
      overlay();
    },
  };
}

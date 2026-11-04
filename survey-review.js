import {geographicPoint} from './geo-cloud.js';
import {buildLabelledItems} from './labelled-items.js';

export const REVIEW_MODEL = 'muse-spark-1.3-contributor';
const DEFAULT_QUESTION = 'Does this entrance have visible accessibility issues for wheelchair users (consider door type and steps) or visually impaired users? Keep reasons short. wheelchair and visualimp mean an issue is visible: true = visible issue, false = no visible issue, null = cannot determine from these images. Do not infer measurements or unseen conditions.';
const DEFAULT_TEMPLATE = {wheelchair:null, wheelchairreason:'', visualimp:null, visualimpreason:''};
const normalize = value => String(value || '').trim().toLowerCase();
const distance = (a,b) => Math.hypot(...a.map((v,k)=>v-b[k]));
export function referenceKey(reference) { return JSON.stringify([reference?.available,reference?.matrix,reference?.translation,reference?.origin]); }
export function reviewPixelPoint(local,projection){
  if(!projection?.matrix||!(projection.width>0)||!(projection.height>0))return null;
  const e=projection.matrix,[x,y,z]=local,w=e[3]*x+e[7]*y+e[11]*z+e[15];if(!(w>0))return null;
  const nx=(e[0]*x+e[4]*y+e[8]*z+e[12])/w,ny=(e[1]*x+e[5]*y+e[9]*z+e[13])/w,nz=(e[2]*x+e[6]*y+e[10]*z+e[14])/w;
  if(Math.abs(nx)>1||Math.abs(ny)>1||Math.abs(nz)>1)return null;
  return [(nx+1)*projection.width/2,(1-ny)*projection.height/2,0];
}

// Fixed anchors prevent a chain of neighbouring samples joining distant doors.
// Distances use the registered transform in metres, including vertical distance.
export function groupReviewObjects({positions,pointLabels={},tags=[],classes,reference,radius,projection}) {
  const registered=!!reference?.available&&!!reference.matrix;
  if(!registered&&!projection)throw Error('Show the point cloud in the 3D view before grouping in pixels.');
  if(!Number.isFinite(radius)||radius<=0||radius>(registered?100:10000))throw Error(`Grouping distance must be greater than 0 and at most ${registered?'100 metres':'10000 pixels'}.`);
  const wanted=new Set(classes.map(normalize).filter(Boolean));
  if(!wanted.size)throw Error('Enter at least one class, separated by commas.');
  const groups=[],cells=new Map();
  const world=local=>registered?reference.matrix.map((row,k)=>row.reduce((sum,v,j)=>sum+v*local[j],reference.translation?.[k]||0)):reviewPixelPoint(local,projection);
  function add(label,local,index,indoor=false,floor=null,manual=false,manualIndex=null){
    const key=normalize(label);if(!wanted.has(key)||!local.every(Number.isFinite))return;
    const point=world(local);if(!point)return;
    const cell=point.map(v=>Math.floor(v/radius)),floorKey=indoor?`indoor:${floor??'unknown'}`:'outdoor';
    const cellKey=c=>JSON.stringify([key,floorKey,...c]);let found=null,best=Infinity;
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++){
      for(const group of cells.get(cellKey([cell[0]+x,cell[1]+y,cell[2]+z]))||[]){
        const d=distance(point,group.anchor);if(d<=radius&&d<best){found=group;best=d;}
      }
    }
    if(!found){found={id:`${key}:${index}`,label:key,anchor:point,local:[...local],sum:[0,0,0],count:0,
      point_index:index,indoor,floor,members:[]};groups.push(found);const c=cellKey(cell);if(!cells.has(c))cells.set(c,[]);cells.get(c).push(found);}
    found.manual=found.manual||manual;found.count++;local.forEach((v,k)=>found.sum[k]+=v);found.members.push({local:[...local],index,manualIndex});
  }
  for(const [key,item] of Object.entries(pointLabels)){
    const i=Number(key);if(!Number.isInteger(i)||i<0||i*3+2>=positions.length)continue;
    add(item.label,Array.from(positions.subarray(i*3,i*3+3)),i);
  }
  // Detected label-centroid tags are summaries, not additional instances.
  tags.forEach((tag,i)=>{if(tag.aggregation!=='label centroid'&&Array.isArray(tag.local))add(tag.name,tag.local,`tag-${i}`,!!tag.indoor,tag.floor,true,tag.point_index);});
  return groups.map(group=>{
    const center=group.sum.map(v=>v/group.count);
    const representative=group.members.reduce((best,item)=>distance(item.local,center)<distance(best.local,center)?item:best);
    return {id:group.id,label:group.label,local:center,target:representative.local,point_index:representative.index,
      count:group.count,indoor:group.indoor,floor:group.floor,manual:!!group.manual};
    }).map((group,i)=>({...group,point_indices:[...new Set(groups[i].members.flatMap(item=>[item.index,item.manualIndex]).filter(Number.isInteger))]}));
}

export function matchingReviewRecords(records,index,local,label,reference,itemId=null){
  if(itemId)return records.filter(record=>record.item_id===itemId);
  const exact=records.filter(record=>record.point_indices?.includes(index));
  const owners=new Set(exact.map(record=>record.item_id||record.id));
  return owners.size===1?exact:[];
}

export function sampleReviewFrames(candidates,limit=2) {
  const unique=[...new Map(candidates.filter(f=>f.url&&Number.isFinite(f.u)&&Number.isFinite(f.v))
    .map(f=>[f.image,f])).values()].sort((a,b)=>a.score-b.score||String(a.image).localeCompare(String(b.image)));
  if(!unique.length)return [];
  const selected=[unique.shift()];
  while(selected.length<limit&&unique.length){
    // Prefer distinct moments among reasonably centred views.
    const ranked=unique.map((f,i)=>({i,score:Math.min(...selected.map(s=>Math.abs((f.time_s??i)-(s.time_s??0))))/(1+f.score)}));
    ranked.sort((a,b)=>b.score-a.score);selected.push(unique.splice(ranked[0].i,1)[0]);
  }
  return selected;
}

export function classReviewFrames(candidates,label,manual=false) {
  return candidates.filter(frame=>manual||!Array.isArray(frame.detections)||frame.detections.some(d=>
    normalize(d.label)===normalize(label)&&Array.isArray(d.box)&&d.box.length===4&&
    frame.u>=d.box[0]-.03&&frame.u<=d.box[2]+.03&&frame.v>=d.box[1]-.03&&frame.v<=d.box[3]+.03))
    .map(frame=>({...frame,class_evidence:manual?'manual tag':Array.isArray(frame.detections)?'frame detection':'projected cloud class (older project)'}));
}

export function reviewFeatures(records,reference) {
  const registered=!!reference?.available;
  return records.filter(record=>record.answer&&record.local).map((record,i)=>{
    const coordinates=registered?geographicPoint(new Float64Array(record.local),0,reference):null;
    if(registered&&!reference.altitude_known)coordinates.pop();
    return {type:'Feature',id:`spark-review-${i+1}`,geometry:coordinates?{type:'Point',coordinates}:null,properties:{
      ...record.answer,name:record.label,label:record.label,feature_type:'image_question',
      item_id:record.item_id||null,
      indoor:record.indoor,floor:record.floor,source:REVIEW_MODEL,
      spark_answer:record.answer,spark_question:record.question,spark_template:record.template,
      local_xyz:record.local,coordinate_frame:registered?'WGS84':'local-sfm (unregistered)',
      spark_samples:record.samples,spark_group_radius_m:record.grouping_units==='pixels'?null:record.radius,
      spark_group_radius_pixels:record.grouping_units==='pixels'?record.radius:null,spark_reviewed_at:record.reviewed_at,
      spark_reviewed_without_georeference:record.grouping_units==='pixels',
      spark_usage:record.usage||null,spark_registration_changed:registered&&record.grouping_units!=='pixels'&&record.reference_key!==referenceKey(reference),
      altitude_reference:!registered?'unregistered':reference.altitude_known?'surveyed':'relative to control point 1'
    }};
  });
}

export function createSurveyReview({host,getContext,getTags,getFrames,onChange}) {
  const openButton=document.createElement('button');openButton.type='button';openButton.id='surveyReviewOpen';openButton.textContent='Process Classes';openButton.disabled=true;
  host.querySelector('.survey-tools').append(openButton);
  const dialog=document.createElement('dialog');dialog.id='surveyReviewDialog';dialog.className='mg-dlg survey-review-dialog';
  dialog.setAttribute('aria-labelledby','surveyReviewTitle');
  dialog.innerHTML=`<div class="dlg-head"><h2 id="surveyReviewTitle">Process Classes</h2><button type="button" id="surveyReviewClose">Close</button></div>
    <p class="hint">Uses Muse Spark 1.3 Contributor and the Meta API key in Settings. Selected sample images and your question are sent to Meta; Contributor content may be used to train models. <a href="https://dev.meta.ai/docs/models" target="_blank" rel="noopener">About Contributor mode</a>.</p>
    <div class="survey-review-table-wrap"><table class="survey-review-table"><thead><tr><th scope="col">Class</th><th scope="col">Request</th><th scope="col">Template</th></tr></thead>
    <tbody id="surveyReviewRows"><tr><td><textarea id="surveyReviewClasses" rows="6" maxlength="500" aria-label="Class(es) for request 1"></textarea></td>
    <td><textarea id="surveyReviewQuestion" rows="8" maxlength="6000" aria-label="Request 1"></textarea></td>
    <td><textarea id="surveyReviewTemplate" rows="8" maxlength="6000" aria-label="JSON template for request 1"></textarea></td></tr></tbody></table></div>
    <button type="button" id="surveyReviewAdd">Add class / request row</button>
    <p class="hint">Use valid JSON. null means a true/false/unknown field; text values define text fields. The default flags mean a visible accessibility issue, not confirmed compliance.</p>
    <div class="region-actions"><label id="surveyReviewMetricRow">Same-item distance (metres)<input id="surveyReviewRadius" type="number" min="0.1" max="100" step="0.1" value="5"></label>
    <label id="surveyReviewPixelRow">Same-item distance (view pixels)<input id="surveyReviewPixelRadius" type="number" min="1" max="10000" step="1" value="500"></label>
    <label>Images per item<input id="surveyReviewSamples" type="number" min="1" max="3" step="1" value="2"></label>
    <label>Max requests this run<input id="surveyReviewMax" type="number" min="1" max="20" step="1" value="5"></label></div>
    <label class="row"><input id="surveyReviewRepeat" type="checkbox"> Include items already answered for these settings</label>
    <p class="hint">Each row may name one class or several comma-separated classes, with its own request and JSON template. Send all rows as one batch; the maximum request count applies across the whole table.</p>
    <p class="hint">Each labelled item has a persistent ID and gets its own answer. Distances separate new detections when IDs are first assigned; separate SAM boxes and separate user tags keep separate IDs. Existing IDs stay fixed when the view or registration changes. Unregistered answers export local XYZ with null map geometry.</p>
    <div class="region-actions"><button type="button" id="surveyReviewPrepare">Preview samples &amp; request count</button><button type="button" id="surveyReviewRun" disabled>Send to Meta</button><button type="button" id="surveyReviewStop" hidden>Stop further requests</button><button type="button" id="surveyReviewDownload" disabled>Download answers GeoJSON</button></div>
    <p id="surveyReviewStatus" role="status" aria-live="polite">Build or load a cloud, add class/request rows and preview before sending. Georeferencing is optional.</p>
    <div id="surveyReviewPreview"></div><div id="surveyReviewResults"></div>`;
  document.body.append(dialog);
  const $=id=>dialog.querySelector('#'+id);
  let records=[],plan=null,controller=null,epoch=0,registry={items:[],owners:new Map()},itemCache=null;
  $('surveyReviewClasses').value='door';$('surveyReviewQuestion').value=DEFAULT_QUESTION;$('surveyReviewTemplate').value=JSON.stringify(DEFAULT_TEMPLATE,null,2);
  const fields=['Radius','PixelRadius','Samples','Max','Repeat'];
  let rows=[{classes:$('surveyReviewClasses'),question:$('surveyReviewQuestion'),template:$('surveyReviewTemplate')}];
  function addRow(values={}){
    if(rows.length>=20){message('Use at most 20 request rows.');return;}
    const element=document.createElement('tr'),row={element};
    for(const [key,label] of [['classes','Class(es)'],['question','Request'],['template','JSON template']]){
      const cell=document.createElement('td'),input=document.createElement('textarea');input.rows=key==='classes'?6:8;input.maxLength=key==='classes'?500:6000;
      input.setAttribute('aria-label',`${label} for request ${rows.length+1}`);input.value=values[key]||'';input.addEventListener('input',invalidate);row[key]=input;cell.append(input);element.append(cell);
      if(key==='classes'){const remove=document.createElement('button');remove.type='button';remove.textContent='Remove row';row.remove=remove;
        remove.onclick=()=>{element.remove();rows=rows.filter(item=>item!==row);invalidate();};cell.append(remove);}
    }
    rows.push(row);$('surveyReviewRows').append(element);invalidate();
  }
  $('surveyReviewAdd').onclick=()=>addRow();
  for(const input of [rows[0].classes,rows[0].question,rows[0].template])input.addEventListener('input',invalidate);
  const rawRows=()=>rows.map(row=>Object.fromEntries(['classes','question','template'].map(key=>[key,row[key].value])));
  function setDisabled(disabled){fields.forEach(name=>$("surveyReview"+name).disabled=disabled);rows.forEach(row=>{for(const key of ['classes','question','template','remove'])if(row[key])row[key].disabled=disabled;});$('surveyReviewAdd').disabled=disabled;}
  function updateUnits(){const registered=!!getContext().data?.georeference?.available;$('surveyReviewMetricRow').hidden=!registered;$('surveyReviewPixelRow').hidden=registered;}
  const message=text=>{$('surveyReviewStatus').textContent=text;};
  function ensureItems(){
    const ctx=getContext();if(!ctx.cloud)return registry;
    const pointLabels=ctx.data?.point_labels||{},tags=getTags(),registered=!!ctx.data?.georeference?.available;
    const projection=ctx.viewer?.getReviewProjection?.()||ctx.projection;
    const manualKey=JSON.stringify(tags.filter(tag=>!tag.detected&&tag.aggregation!=='label centroid').map(tag=>[tag.item_id,tag.name,tag.point_index,tag.local,tag.indoor,tag.floor]));
    const missing=Object.fromEntries(Object.entries(pointLabels).filter(([,value])=>!value.item_id));
    const viewKey=Object.keys(missing).length?JSON.stringify(projection):'';
    if(itemCache?.cloud===ctx.cloud&&itemCache.labels===pointLabels&&itemCache.manualKey===manualKey&&itemCache.viewKey===viewKey)return registry;
    const classes=[...new Set(Object.values(missing).map(value=>normalize(value.label)).filter(Boolean))];
    const radius=Number($(registered?'surveyReviewRadius':'surveyReviewPixelRadius').value)||(registered?5:500);
    const groups=classes.length&&(registered||projection)?groupReviewObjects({positions:ctx.cloud.positions,pointLabels:missing,classes,reference:ctx.data?.georeference,radius,projection}):[];
    const multipleBoxes=ctx.data?.source_frames?.some(frame=>{const counts=new Map();return (frame.detections||[]).some(d=>{const label=normalize(d.label);counts.set(label,(counts.get(label)||0)+1);return counts.get(label)>1;});});
    registry=buildLabelledItems({positions:ctx.cloud.positions,pointLabels,tags,newGroups:groups,getFrames:multipleBoxes?getFrames:null});
    itemCache={cloud:ctx.cloud,labels:pointLabels,manualKey,viewKey};
    for(const record of records)if(!record.item_id){const ids=new Set((record.point_indices||[]).map(index=>registry.owners.get(index)).filter(Boolean));
      if(ids.size===1)record.item_id=[...ids][0];else record.legacy_unlinked=true;}
    return registry;
  }
  function refreshClasses(){const ctx=getContext();ensureItems();const tagged=getTags().some(tag=>normalize(tag.name))||Object.values(ctx.data?.point_labels||{}).some(item=>normalize(item.label));openButton.disabled=!tagged;openButton.title=tagged?'Process tagged classes with image questions':'Tag a class yourself or enable SAM labelling first';}
  function settings(){
    const registered=!!getContext().data?.georeference?.available;
    const radius=Number($(registered?'surveyReviewRadius':'surveyReviewPixelRadius').value),samples=Number($('surveyReviewSamples').value),max=Number($('surveyReviewMax').value);
    if(!Number.isInteger(samples)||samples<1||samples>3||!Number.isInteger(max)||max<1||max>20)throw Error('Choose 1–3 images per item and 1–20 requests.');
    const requests=rawRows().flatMap((row,index)=>{
      if(!row.classes.trim()&&!row.question.trim()&&!row.template.trim())return [];
      const classes=row.classes.split(/[,\n]+/).map(normalize).filter(Boolean),question=row.question.trim();
      if(!classes.length||!question)throw Error(`Row ${index+1}: enter a class and a request.`);
      let template;try{template=JSON.parse(row.template);}catch{throw Error(`Row ${index+1}: the template must be valid JSON with quoted keys.`);}
      if(!template||Array.isArray(template)||typeof template!=='object'||!Object.keys(template).length)throw Error(`Row ${index+1}: the template must be a non-empty object.`);
      return [{classes,question,template,index}];
    });
    if(!requests.length)throw Error('Add at least one class/request row.');
    return {requests,radius,samples,max,grouping_units:registered?'metres':'pixels'};
  }
  function invalidate(){plan=null;$('surveyReviewRun').disabled=true;}
  fields.forEach(name=>$("surveyReview"+name).addEventListener('input',invalidate));
  function render(){
    refreshClasses();
    $('surveyReviewResults').replaceChildren(...records.map(record=>{
      const box=document.createElement('details'),title=document.createElement('summary'),pre=document.createElement('pre');
      title.textContent=`${record.label} · ${record.item_id||'legacy answer: no single item ID'} · ${record.samples.length} image(s) · ${record.reviewed_at}`;
      pre.textContent=JSON.stringify(record.answer,null,2);box.append(title,pre);return box;
    }));
    $('surveyReviewDownload').disabled=!records.length;
    onChange();
  }
  function prepare(){
    try{
      updateUnits();const ctx=getContext(),s=settings(),reference=ctx.data?.georeference;
      if(!ctx.cloud)throw Error('Build or load a survey cloud first.');
      const projection=s.grouping_units==='pixels'?ctx.viewer?.getReviewProjection?.()||ctx.projection:null;
      const labelled=ensureItems().items;
      let skipped=0,answered=0,totalGroups=0;const candidates=[],seen=new Set();
      for(const request of s.requests){
        const groups=labelled.filter(item=>request.classes.includes(normalize(item.label)));
        totalGroups+=groups.length;
        const prepared=groups.map(group=>({...group,samples:sampleReviewFrames(classReviewFrames(getFrames(group.target),group.label,group.manual),s.samples)}));
        for(const group of prepared){
        if(!group.samples.length){skipped++;continue;}
        const key=JSON.stringify([group.item_id,request.question,request.template]);
        if(!$('surveyReviewRepeat').checked&&records.some(r=>r.item_id===group.item_id&&r.question===request.question&&JSON.stringify(r.template)===JSON.stringify(request.template))){answered++;continue;}
        if(seen.has(key))continue;seen.add(key);
        candidates.push({...group,id:`${request.index}:${group.id}`,key,question:request.question,template:request.template});
        }
      }
      const items=candidates.slice(0,s.max);
      plan={...s,items,reference_key:referenceKey(reference),cloud:ctx.cloud,projection};
      const previews=items.map(group=>{
        const box=document.createElement('section'),title=document.createElement('p');
        const coords=reference?.available?geographicPoint(new Float64Array(group.local),0,reference):null;
        title.textContent=`${group.label} · ID ${group.item_id} · ${coords?coords[1].toFixed(6)+', '+coords[0].toFixed(6):'local XYZ '+group.local.map(v=>v.toFixed(3)).join(', ')} · ${group.count} tagged samples · ${group.question}`;
        box.append(title);
        group.samples.forEach(frame=>{const figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');
          image.src=frame.url;image.alt=`${group.label} in ${frame.image}`;caption.textContent=`${frame.image} · ${frame.class_evidence} · target ${(frame.u*100).toFixed(0)}%, ${(frame.v*100).toFixed(0)}% from top left`;figure.append(image,caption);box.append(figure);});
        return box;
      });
      $('surveyReviewPreview').replaceChildren(...previews);
      $('surveyReviewRun').disabled=!items.length;
      $('surveyReviewRun').textContent=`Send ${items.length} request(s) to Meta`;
      message(`${totalGroups} spatial group(s); ${items.length} request(s), ${items.reduce((n,g)=>n+g.samples.length,0)} image(s) planned across ${s.requests.length} row(s). Grouping: ${s.radius} ${s.grouping_units}. ${Math.max(0,candidates.length-items.length)} over the request limit; ${answered} already answered; ${skipped} without a visible source image. No requests sent yet.`);
    }catch(error){invalidate();message(error.message);}
  }
  $('surveyReviewPrepare').onclick=prepare;
  async function run(){
    if(!plan||controller)return;
    const ctx=getContext(),token=document.getElementById('tokenInput')?.value.trim();
    if(!token){message('Add your Meta API key in Settings first.');return;}
    if(ctx.cloud!==plan.cloud||referenceKey(ctx.data?.georeference)!==plan.reference_key){invalidate();message('The survey registration changed. Preview the groups again.');return;}
    const current=plan,runEpoch=epoch;controller=new AbortController();
    $('surveyReviewRun').disabled=true;$('surveyReviewPrepare').disabled=true;$('surveyReviewStop').hidden=false;
    setDisabled(true);
    let completed=0,failed=0;const errors=[];
    try{
      const response=await fetch('/api/survey-review',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
        body:JSON.stringify({token,max_requests:current.max,
          groups:current.items.map(group=>({id:group.id,item_id:group.item_id,label:group.label,question:group.question,template:group.template,images:group.samples.map(f=>({url:f.url,u:f.u,v:f.v}))}))})});
      if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(typeof error.detail==='string'?error.detail:`Review request failed (HTTP ${response.status}).`);}
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      function accept(line){
        if(!line.trim())return;const data=JSON.parse(line);
        if(data.type==='start'){message(`Request ${data.attempt} of ${current.items.length}: ${data.label}…`);return;}
        if(data.type!=='result')return;
        if(data.error){failed++;errors.push(data.error);message(`A request failed: ${data.error}. ${completed} answer(s) saved.`);return;}
        if(epoch!==runEpoch)return;
        const group=current.items.find(g=>g.id===data.id);if(!group)return;
        if(data.item_id&&data.item_id!==group.item_id){failed++;errors.push('An answer had a mismatched item ID and was not attached.');return;}
        const record={...group,samples:group.samples.map(({image,time_s,u,v,class_evidence})=>({image,time_s,u,v,class_evidence})),
          radius:current.radius,grouping_units:current.grouping_units,grouping_projection:current.projection,answer:data.answer,usage:data.usage,
          reference_key:current.reference_key,reviewed_at:new Date().toISOString()};
        records=records.filter(r=>!(r.item_id===record.item_id&&r.question===record.question&&JSON.stringify(r.template)===JSON.stringify(record.template)));records.push(record);completed++;render();
      }
      while(true){const {value,done}=await reader.read();pending+=decoder.decode(value||new Uint8Array(),{stream:!done});
        const lines=pending.split('\n');pending=lines.pop();lines.forEach(accept);if(done){if(pending.trim())accept(pending);break;}}
      if(epoch===runEpoch)message(`Finished: ${completed} answer(s) saved, ${failed} failed. Responses are included in Export survey and saved projects. No automatic retries.`+(errors.length?' '+errors.slice(0,2).join(' '):''));
    }catch(error){if(epoch===runEpoch)message(error.name==='AbortError'?`Stopped. ${completed} answer(s) saved. An already-sent request may still complete and be charged.`:error.message);}
    finally{controller=null;$('surveyReviewStop').hidden=true;$('surveyReviewPrepare').disabled=false;setDisabled(false);invalidate();}
  }
  $('surveyReviewRun').onclick=run;$('surveyReviewStop').onclick=()=>controller?.abort();
  openButton.onclick=()=>{updateUnits();if(!dialog.open)dialog.showModal();render();};$('surveyReviewClose').onclick=()=>dialog.close();
  $('surveyReviewDownload').onclick=()=>{
    const collection={type:'FeatureCollection',features:reviewFeatures(records,getContext().data?.georeference)},url=URL.createObjectURL(new Blob([JSON.stringify(collection,null,2)],{type:'application/geo+json'})),a=document.createElement('a');
    a.href=url;a.download='microgeo-survey-answers.geojson';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return {
    refreshClasses,
    items:()=>ensureItems().items,
    itemForPoint:index=>{const current=ensureItems();return current.items.find(item=>item.item_id===current.owners.get(index));},
    identify:(index,local,label)=>{const current=ensureItems(),id=current.owners.get(index);return id?matchingReviewRecords(records,index,local,label,getContext().data?.georeference,id)
      .map(record=>({title:`Spark: ${record.label} · ID ${id}`,question:record.question,answer:record.answer,reviewed_at:record.reviewed_at})):[];},
    features:()=>reviewFeatures(records,getContext().data?.georeference),
    snapshot:()=>structuredClone({records,items:ensureItems().items,requests:rawRows(),settings:Object.fromEntries(fields.map(name=>[name,name==='Repeat'?false:$("surveyReview"+name).value]))}),
    restore(saved){epoch++;controller?.abort();records=structuredClone(saved?.records||[]);itemCache=null;registry={items:[],owners:new Map()};
      for(const item of saved?.items||[])for(const index of item.point_indices||[]){const label=getContext().data?.point_labels?.[index];if(label&&!label.item_id)label.item_id=item.item_id;}
      if(saved){const requests=saved.requests||[{classes:saved.settings?.Classes||'door',question:saved.settings?.Question||DEFAULT_QUESTION,template:saved.settings?.Template||JSON.stringify(DEFAULT_TEMPLATE,null,2)}];
        rows.slice(1).forEach(row=>row.element.remove());rows=rows.slice(0,1);for(const key of ['classes','question','template'])rows[0][key].value=requests[0]?.[key]||'';requests.slice(1).forEach(addRow);}
      for(const [name,value] of Object.entries(saved?.settings||{})){if(fields.includes(name)&&name!=='Repeat')$("surveyReview"+name).value=value;}invalidate();$('surveyReviewPreview').replaceChildren();render();},
    invalidate(){controller?.abort();invalidate();updateUnits();$('surveyReviewDownload').disabled=!records.length;},
  };
}

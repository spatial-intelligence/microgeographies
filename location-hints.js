/* Location results are retained when the non-modal popup is closed. */
(() => {
  'use strict';
  async function extractVideoFrames(file,afterSeconds,signal){
    const data=new FormData();data.append('video',file);data.append('after_seconds',String(afterSeconds));
    const response=await fetch('/api/location-frames',{method:'POST',body:data,signal});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(typeof result.detail==='string'?result.detail:`Frame previews failed (HTTP ${response.status}).`);
    return result.frames||[];
  }
  function createPhoto({getImage,getToken,onSelect}){
    const $=id=>document.getElementById(id),button=$('photoEstimateLocation'),panel=$('photoLocationHints'),status=$('photoLocationHintStatus'),choices=$('photoLocationHintChoices');
    let controller=null,generation=0;
    const show=()=>{if(!panel.open)panel.showModal();};
    function reset(){generation++;controller?.abort();controller=null;button.hidden=true;button.disabled=true;choices.replaceChildren();status.textContent='';if(panel.open)panel.close();}
    button.onclick=async()=>{
      show();const token=getToken().trim();
      if(!token){status.textContent='Add a Meta API key in Settings, then click Estimate location again.';return;}
      const image=getImage();if(!image){status.textContent='Wait for the photo to finish loading.';return;}
      if(controller)return;
      const request=new AbortController(),version=generation;controller=request;button.disabled=true;choices.replaceChildren();status.textContent='Estimating the photo location with Spark...';
      try{
        const response=await fetch('/api/location-hint',{method:'POST',headers:{'Content-Type':'application/json'},signal:request.signal,body:JSON.stringify({image,token})});
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:`Location lookup failed (HTTP ${response.status}).`);
        if(version!==generation)return;
        const candidates=(data.candidates||[]).filter(c=>Number.isFinite(c.lat)&&Math.abs(c.lat)<=85&&Number.isFinite(c.lon)&&Math.abs(c.lon)<=180);
        choices.replaceChildren(...candidates.map(candidate=>{
          const item=document.createElement('li'),use=document.createElement('button'),detail=document.createElement('p');
          use.type='button';use.textContent=`Use ${candidate.name}`;
          detail.textContent=`${candidate.lat.toFixed(5)}, ${candidate.lon.toFixed(5)} | ${candidate.confidence} confidence. ${candidate.reason}`;
          use.onclick=()=>{onSelect(candidate);panel.close();};item.append(use,detail);return item;
        }));
        status.textContent=candidates.length?'Choose a suggested location after checking its landmarks. You can correct it by dragging the camera marker on the map.':'No location could be identified from this photo. Enter its location using Location & heading.';
      }catch(error){if(version===generation)status.textContent=error.name==='AbortError'?'Location lookup stopped.':error.message;}
      finally{if(controller===request){controller=null;button.disabled=false;}}
    };
    $('photoLocationHintClose').onclick=()=>panel.close();
    return {reset,setAvailable(available){button.hidden=!available;button.disabled=!available||!!controller;}};
  }
  window.MGLocationHints={extractVideoFrames,createPhoto,create({getMap,getData,onChange,isSurvey=()=>true,getVideoFile=()=>null,getToken=()=>'',extractFrames=extractVideoFrames}){
    const $=id=>document.getElementById(id),panel=$('videoLocationHints'),status=$('videoLocationHintStatus'),list=$('videoLocationHintChoices');
    let result=null,layer=null,controller=null,previewController=null,generation=0,attempted=false,autoCentered=false,observedMap=null,dismissed=false,currentFrame=null;
    const notice=text=>{status.textContent=text;$('videoLocationHintsBar').hidden=!isSurvey();$('videoLocationHintSummary').textContent=text.length>120?text.slice(0,117)+'...':text;};
    function showPopup(){if(!isSurvey())return;dismissed=false;panel.hidden=false;if(!panel.open){if(panel.show)panel.show();else panel.open=true;}}
    function closePopup(){dismissed=true;if(panel.close)panel.close();else panel.open=false;panel.hidden=true;}
    function showFrame(frame){
      currentFrame=frame;$('videoLocationHintImage').hidden=!frame;
      if(frame){$('videoLocationHintImage').src=frame.url;$('videoLocationHintFrameInfo').textContent=`Selected frame: ${Number.isFinite(frame.time_s)?frame.time_s.toFixed(2)+' seconds':'timestamp unavailable'}. Sending it uses one Spark request.`;}
      else $('videoLocationHintFrameInfo').textContent='Choose the original video to preview another frame.';
      $('videoLocationHintSend').disabled=!frame||!!controller;
    }
    function snapshot(){return result?JSON.parse(JSON.stringify(result)):null;}
    function select(index){
      const candidate=result?.candidates?.[index],map=getMap();if(!candidate||!map)return;
      map.setView([candidate.lat,candidate.lon],candidate.confidence==='high'?16:13);result.selected_index=index;onChange(snapshot());
      notice(`Map moved to ${candidate.name}. Close this popup when finished. Add cloud/map control pairs to register the cloud; this is only a suggested starting point.`);
    }
    function refresh(){
      $('videoLocationHintsBar').hidden=!isSurvey();
      const currentMap=getMap();if(currentMap&&observedMap!==currentMap){observedMap=currentMap;currentMap.on('dragstart',()=>{autoCentered=true;});}
      layer?.clearLayers();if(!result)return;
      const candidates=result.candidates||[],map=getMap();
      list.replaceChildren(...candidates.map((candidate,index)=>{
        const item=document.createElement('li'),button=document.createElement('button'),description=document.createElement('span');
        button.type='button';button.textContent=`${index+1}. ${candidate.name} - zoom here`;button.onclick=()=>select(index);
        description.textContent=` ${candidate.lat.toFixed(5)}, ${candidate.lon.toFixed(5)} | ${candidate.confidence} confidence. ${candidate.reason}`;
        item.append(button,description);return item;
      }));
      if(map&&window.L){
        if(!layer)layer=window.L.layerGroup().addTo(map);
        candidates.forEach((candidate,index)=>{const text=document.createElement('span');text.textContent=`${index+1}. ${candidate.name}: ${candidate.reason} (${candidate.confidence} confidence; unverified)`;
          window.L.circleMarker([candidate.lat,candidate.lon],{radius:9,color:'#d99730',fillOpacity:.7,weight:2}).addTo(layer).bindTooltip(text).on('click',()=>{select(index);showPopup();});});
        if(!autoCentered&&!getData()?.georeference?.available){
          if(result.selected_index!=null&&candidates[result.selected_index]){const selected=candidates[result.selected_index];map.setView([selected.lat,selected.lon],selected.confidence==='high'?16:13);}
          else if(candidates.length===1)map.setView([candidates[0].lat,candidates[0].lon],13);
          else if(candidates.length>1)map.fitBounds(candidates.map(c=>[c.lat,c.lon]),{padding:[28,28],maxZoom:12});
          autoCentered=!!candidates.length;
        }
      }
      const sampleLabel=Number.isFinite(result.frame_time_s)?`frame at ${result.frame_time_s.toFixed(2)} s`:'sampled frame';
      notice(candidates.length&&(result.needs_choice||candidates.length>1||candidates[0].confidence!=='high')?`Spark could not pinpoint the exact location. ${candidates.length} possible place(s) from the ${sampleLabel} are shown on the map; pick a marker or zoom here. If these are poor suggestions, preview the next ten seconds and send a better frame.`:
        candidates.length?`One likely location from the ${sampleLabel} is shown on the map. Check its landmarks before georeferencing.`:`Spark found no evidence-supported candidates in the ${sampleLabel}. Preview another frame or navigate the map manually.`);
    }
    function reset(saved=null){
      generation++;controller?.abort();previewController?.abort();controller=previewController=null;
      result=saved?JSON.parse(JSON.stringify(saved)):null;attempted=!!saved;dismissed=!!saved;autoCentered=false;layer?.clearLayers();list.replaceChildren();$('videoLocationHintFrames').replaceChildren();
      if(panel.open){if(panel.close)panel.close();else panel.open=false;}panel.hidden=true;
      showFrame(result?.frame_preview?{url:result.frame_preview,time_s:result.frame_time_s}:null);
      $('videoLocationHintNext').disabled=false;refresh();
    }
    async function locate(image,token,time_s=1,manual=false){
      if(controller||(!manual&&attempted))return;attempted=true;showFrame({url:image,time_s});
      if(!token){notice('Add a Meta API key in Settings to get location suggestions. Reconstruction continues without a lookup.');if(!dismissed)showPopup();return;}
      const thisGeneration=generation,requestController=new AbortController();controller=requestController;$('videoLocationHintSend').disabled=true;
      const sourceFile=$('videoLocationHintFile').files?.[0]||getVideoFile();
      if(manual)showPopup();
      notice(`Asking Spark about the frame at ${Number.isFinite(time_s)?time_s.toFixed(2)+' s':'about 1 s'} in the background. Reconstruction continues...`);
      try{
        const response=await fetch('/api/location-hint',{method:'POST',headers:{'Content-Type':'application/json'},signal:requestController.signal,body:JSON.stringify({image,token})});
        const data=await response.json().catch(()=>({}));if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:`Location lookup failed (HTTP ${response.status}).`);
        if(thisGeneration!==generation)return;
        result={...data,frame_time_s:time_s,frame_preview:image,source_video:sourceFile?{name:sourceFile.name,size:sourceFile.size}:result?.source_video,suggested_at:new Date().toISOString(),selected_index:null};
        if(manual)autoCentered=false;refresh();onChange(snapshot());if(!dismissed)showPopup();
      }catch(error){if(thisGeneration===generation){notice(error.name==='AbortError'?'Location lookup stopped. Reconstruction continues.':`${error.message} Reconstruction continues; no automatic retry. Any previous suggestions are retained. Choose another frame to try again.`);if(!dismissed)showPopup();}}
      finally{if(controller===requestController){controller=null;$('videoLocationHintSend').disabled=!currentFrame;}}
    }
    async function nextFrames(){
      const explicit=$('videoLocationHintFile').files?.[0],file=explicit||getVideoFile();
      if(!file){notice('Choose the original survey video above to preview the next ten seconds.');return;}
      if(!explicit&&result?.source_video&&(file.name!==result.source_video.name||file.size!==result.source_video.size)){notice('Choose the original survey video above; the current file belongs to a different survey.');return;}
      if(previewController)return;const control=new AbortController(),thisGeneration=generation;previewController=control;$('videoLocationHintNext').disabled=true;
      const start=currentFrame?.time_s??result?.frame_time_s??1;notice(`Preparing previews after ${start.toFixed(2)} seconds. No Spark requests are sent for previews.`);
      try{
        const frames=await extractFrames(file,start,control.signal);if(thisGeneration!==generation)return;
        const options=frames.map(frame=>{const button=document.createElement('button'),image=document.createElement('img'),caption=document.createElement('span');button.type='button';button.className='location-frame-option';
          image.src=frame.url;image.alt=`Video frame at ${frame.time_s.toFixed(2)} seconds`;caption.textContent=frame.time_s.toFixed(2)+' s';button.append(image,caption);button.setAttribute('aria-pressed','false');
          button.onclick=()=>{showFrame(frame);options.forEach(node=>node.setAttribute('aria-pressed',String(node===button)));};return button;});
        $('videoLocationHintFrames').replaceChildren(...options);notice(options.length?`Choose a frame, then click Send selected frame to Spark. ${options.length} preview(s); no additional Spark request has been sent.`:'No more frames are available after this point.');
      }catch(error){if(thisGeneration===generation&&error.name!=='AbortError')notice(error.message);}
      finally{if(previewController===control){previewController=null;$('videoLocationHintNext').disabled=false;}}
    }
    $('videoLocationHintOpen').onclick=()=>{refresh();showPopup();};$('videoLocationHintDismiss').onclick=closePopup;
    panel.addEventListener?.('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closePopup();}});
    $('videoLocationHintNext').onclick=nextFrames;
    $('videoLocationHintSend').onclick=()=>currentFrame?locate(currentFrame.url,getToken(),currentFrame.time_s,true):undefined;
    return {locate,reset,restore:reset,refresh,snapshot,notice};
  }};
})();

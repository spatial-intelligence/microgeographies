(() => {
  'use strict';
  const form=document.getElementById('resizeZipForm'),status=document.getElementById('resizeZipStatus');
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const file=document.getElementById('resizeZipFile').files[0];if(!file)return;
    const button=document.getElementById('resizeZipRun');button.disabled=true;
    status.classList.remove('status-error');status.textContent='Resizing images and preparing your ZIP…';
    try{
      const data=new FormData(form),response=await fetch('/api/resize-images',{method:'POST',body:data});
      if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(typeof error.detail==='string'?error.detail:`Resizing failed (HTTP ${response.status}).`);}
      const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download=file.name.replace(/\.zip$/i,'')+'_resize.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);
      status.textContent=`Downloaded ${a.download}: ${response.headers.get('X-Images-Resized')||0} resized, ${response.headers.get('X-Images-Unchanged')||0} already small, ${response.headers.get('X-Files-Skipped')||0} unsupported/extra files skipped. Image filenames, folders and EXIF/GPS metadata retained where present.`;
    }catch(error){status.classList.add('status-error');status.textContent=error.message;}
    finally{button.disabled=false;}
  });
})();

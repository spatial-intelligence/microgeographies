import {createToolWindow} from './floating-windows.js';
let editor=null;
export function editMapTag({name,lat,lon,indoor=false,floor=0,onSave}){
  if(!editor){
    const form=document.createElement('form');
    form.innerHTML=`<label>Name<input name="name" required maxlength="160"></label><label>Latitude<input name="lat" type="number" min="-85" max="85" step="any" required></label><label>Longitude<input name="lon" type="number" min="-180" max="180" step="any" required></label><label>Location<select name="indoor"><option value="outdoor">Outdoor</option><option value="indoor">Indoor</option></select></label><label data-floor>Floor<input name="floor" type="number" step="1" value="0"></label><button type="submit">Save tag</button>`;
    const popup=createToolWindow({id:'mapTagEditor',title:'Edit map tag',content:form,left:Math.max(12,innerWidth-430),top:100});
    editor={form,popup};
  }
  const {form,popup}=editor,field=name=>form.elements.namedItem(name);
  Object.entries({name,lat,lon,indoor:indoor?'indoor':'outdoor',floor:floor??0}).forEach(([k,v])=>field(k).value=v);
  function sync(){form.querySelector('[data-floor]').hidden=field('indoor').value!=='indoor';field('floor').required=field('indoor').value==='indoor';}
  field('indoor').onchange=sync;sync();
  form.onsubmit=e=>{e.preventDefault();if(!field('name').value.trim())return;const inside=field('indoor').value==='indoor';onSave({name:field('name').value.trim(),lat:Number(field('lat').value),lon:Number(field('lon').value),indoor:inside,floor:inside?Number(field('floor').value):null});popup.hide();};
  popup.show();
}

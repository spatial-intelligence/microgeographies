import * as THREE from './vendor/three.module.js';

export function classLegendEntries(labels,colors){
  const classes=new Map();
  for(let i=0;i<labels.length;i++){
    const label=labels[i];if(!label)continue;
    if(!classes.has(label)){
      const color=new THREE.Color();if(colors?.length>=i*3+3)color.fromArray(colors,i*3);else color.set('#8a8a8a');
      classes.set(label,{label,count:0,color:color.getStyle()});
    }
    classes.get(label).count++;
  }
  return [...classes.values()].sort((a,b)=>a.label.localeCompare(b.label));
}

export function createClassLegend({host,labels,colors,state}){
  if(host.id==='videoSecondView')return {refresh(){},dispose(){}};
  const legend=document.createElement('details');legend.className='viewer-class-legend';
  if(!legend.querySelector)return {refresh(){},dispose(){}};
  const entries=classLegendEntries(labels,colors),summary=document.createElement('summary'),list=document.createElement('ul'),note=document.createElement('p');
  summary.textContent=`Classes (${entries.length})`;legend.append(summary,list,note);
  // Capture the user's choice before the queued toggle event, so an
  // asynchronous preview/colour refresh cannot close a just-opened legend.
  summary.onclick=()=>state.classLegendOpen=!legend.open;
  for(const entry of entries){const row=document.createElement('li'),swatch=document.createElement('i'),name=document.createElement('span'),count=document.createElement('small');
    swatch.style.backgroundColor=entry.color;swatch.className='class-swatch';swatch.setAttribute('aria-hidden','true');name.textContent=entry.label;count.textContent=entry.count.toLocaleString();row.append(swatch,name,count);list.append(row);}
  legend.ontoggle=()=>state.classLegendOpen=legend.open;
  function refresh(){legend.open=!!state.classLegendOpen;note.textContent=!entries.length?'No labelled classes in this cloud.':state.renderMode==='mosaic'?'Photo mosaic shows source RGB.':state.colorMode==='class'?'Class colours / original point counts.':'Class palette / select Class colours to apply.';}
  host.append(legend);refresh();return {refresh,dispose(){legend.ontoggle=null;summary.onclick=null;legend.remove();}};
}

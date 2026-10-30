import * as THREE from 'three';

export function measurementStations(start,end,interval=5){
  const distance=Math.hypot(...end.map((v,i)=>v-start[i]));
  const stations=[{position:start,label:'START',endpoint:true}];
  for(let metres=interval;metres<distance-1e-8;metres+=interval)stations.push({position:start.map((v,i)=>v+(end[i]-v)*metres/distance),label:`${metres} m`,endpoint:false});
  stations.push({position:end,label:`END · ${distance.toFixed(3)} m`,endpoint:true});return stations;
}

export function createIdentifyTooltip(host){
  const tip=document.createElement('div');tip.className='identify-tooltip';tip.setAttribute('role','tooltip');tip.hidden=true;host.append(tip);
  return {show(x,y,label,objectId){tip.textContent=`Class: ${label||'Unclassified'}${objectId>=0?` · Object #${objectId}`:''}`;tip.hidden=false;
    tip.style.left=Math.max(4,Math.min(x+14,host.clientWidth-tip.offsetWidth-4))+'px';tip.style.top=Math.max(4,Math.min(y+14,host.clientHeight-tip.offsetHeight-4))+'px'},clear(){tip.hidden=true},dispose(){tip.remove()}};
}

export function createMeasurementOverlay({host,scene,positions}){
  const layer=document.createElement('div');layer.className='measurement-overlay';host.append(layer);
  let markers=[],line=null;
  function clear(){for(const marker of markers)marker.node.remove();markers=[];if(line){scene.remove(line);line.geometry.dispose();line.material.dispose();line=null}}
  function set(indices,measure=true){
    clear();if(!indices.length)return;
    const coords=indices.map(i=>Array.from(positions.subarray(i*3,i*3+3)));
    const stations=coords.length===2&&measure?measurementStations(...coords):coords.map((position,i)=>({position,label:measure?'START':String(i+1),endpoint:true}));
    for(const station of stations){const node=document.createElement('div');node.className='measurement-marker '+(station.endpoint?'endpoint':'interval');
      const dot=document.createElement('i'),label=document.createElement('span');label.textContent=station.label;node.append(dot,label);layer.append(node);markers.push({node,point:new THREE.Vector3(...station.position)})}
    if(coords.length===2&&measure){line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(coords.map(p=>new THREE.Vector3(...p))),new THREE.LineBasicMaterial({color:'#a5e7ee',depthTest:false,transparent:true,opacity:.9}));line.renderOrder=10;scene.add(line)}
  }
  const projected=new THREE.Vector3();
  function update(camera){for(const {node,point} of markers){projected.copy(point).project(camera);node.hidden=projected.z< -1||projected.z>1||Math.abs(projected.x)>1||Math.abs(projected.y)>1;node.style.left=(projected.x+1)*host.clientWidth/2+'px';node.style.top=(1-projected.y)*host.clientHeight/2+'px'}}
  return {set,update,dispose(){clear();layer.remove()}};
}


export function createControlPointOverlay({host,positions}){
  const layer=document.createElement('div');layer.className='gcp-source-overlay';host.append(layer);let markers=[];
  function clear(){for(const marker of markers)marker.node.remove();markers=[]}
  function set(points){
    clear();for(const entry of points){
      if(!Number.isInteger(entry.index)||entry.index<0||entry.index*3+2>=positions.length)continue;
      const node=document.createElement('div');node.className='gcp-source-marker'+(entry.pending?' pending':'');
      node.setAttribute('aria-label',`Control point ${entry.number}${entry.pending?', awaiting map position':''}`);
      const dot=document.createElement('i'),label=document.createElement('span');label.textContent=`(${entry.number})`;node.append(dot,label);layer.append(node);
      markers.push({node,point:new THREE.Vector3(...positions.subarray(entry.index*3,entry.index*3+3))});
    }
  }
  const projected=new THREE.Vector3();
  function update(camera){for(const {node,point} of markers){projected.copy(point).project(camera);node.hidden=projected.z< -1||projected.z>1||Math.abs(projected.x)>1||Math.abs(projected.y)>1;node.style.left=(projected.x+1)*host.clientWidth/2+'px';node.style.top=(1-projected.y)*host.clientHeight/2+'px'}}
  return {set,update,dispose(){clear();layer.remove()}};
}

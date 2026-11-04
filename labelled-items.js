// IDs belong to labelled instances, never to a class or a question row.
let sequence=0;
export function newItemId(){return 'item-'+(globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`);}
const distance=(a,b)=>a.reduce((sum,v,k)=>sum+(v-b[k])**2,0);
const name=value=>String(value||'').trim().toLowerCase();
function itemFromPoints(id,label,indices,positions,extra={}){
  const local=[0,0,0];indices.forEach(i=>local.forEach((v,k)=>local[k]+=positions[i*3+k]));local.forEach((v,k)=>local[k]/=indices.length);
  let closest=indices[0];for(const i of indices)if(distance(Array.from(positions.subarray(i*3,i*3+3)),local)<distance(Array.from(positions.subarray(closest*3,closest*3+3)),local))closest=i;
  return {id,item_id:id,label,local,target:Array.from(positions.subarray(closest*3,closest*3+3)),point_index:closest,point_indices:indices,count:indices.length,manual:false,indoor:false,floor:null,...extra};
}

// Co-visible, separate SAM boxes are distinct instances even inside one distance
// bucket. Sample only a bounded number of points; no extra inference is used.
function splitDetections(group,positions,getFrames){
  if(!getFrames||group.point_indices.length<2)return [group];
  const frames=new Map(),indices=group.point_indices,step=Math.max(1,Math.ceil(indices.length/200));
  for(let n=0;n<indices.length;n+=step){const i=indices[n],local=Array.from(positions.subarray(i*3,i*3+3));
    for(const frame of getFrames(local)){
      const detections=(frame.detections||[]).map((d,index)=>({...d,index})).filter(d=>name(d.label)===name(group.label)&&d.box?.length===4);
      if(detections.length<2)continue;
      if(!frames.has(frame.image))frames.set(frame.image,new Map());
      for(const detection of detections){const [x1,y1,x2,y2]=detection.box;if(frame.u<x1||frame.u>x2||frame.v<y1||frame.v>y2)continue;
        const boxes=frames.get(frame.image);if(!boxes.has(detection.index))boxes.set(detection.index,{box:detection.box,indices:[]});boxes.get(detection.index).indices.push(i);
      }
    }
  }
  let seeds=[];
  for(const [image,boxes] of frames){const selected=[];
    for(const [index,box] of [...boxes].sort((a,b)=>b[1].indices.length-a[1].indices.length)){
      const overlap=selected.some(other=>{const a=box.box,b=other.box;const intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));return intersection/Math.max(1e-12,Math.min((a[2]-a[0])*(a[3]-a[1]),(b[2]-b[0])*(b[3]-b[1])))>.5;});
      if(!overlap)selected.push({...box,image,index,local:itemFromPoints('',group.label,box.indices,positions).local});
    }
    if(selected.length>seeds.length)seeds=selected;
  }
  if(seeds.length<2)return [group];
  const parts=seeds.map(()=>[]);
  for(const i of indices){const local=Array.from(positions.subarray(i*3,i*3+3));let best=0;for(let k=1;k<seeds.length;k++)if(distance(local,seeds[k].local)<distance(local,seeds[best].local))best=k;parts[best].push(i);}
  return parts.flatMap((part,i)=>part.length?[itemFromPoints('',group.label,part,positions,{sam_instance:{image:seeds[i].image,detection_index:seeds[i].index,box:seeds[i].box}})]:[]);
}

export function buildLabelledItems({positions,pointLabels={},tags=[],newGroups=[],getFrames}){
  const known=new Map(),base=[];
  for(const [key,value] of Object.entries(pointLabels)){const index=Number(key);if(!value.item_id||!Number.isInteger(index)||index<0||index*3+2>=positions.length)continue;
    if(!known.has(value.item_id))known.set(value.item_id,{label:name(value.label),indices:[]});known.get(value.item_id).indices.push(index);
  }
  for(const [id,value] of known)base.push(itemFromPoints(id,value.label,value.indices,positions));
  for(const group of newGroups)for(const part of splitDetections(group,positions,getFrames)){
    const id=newItemId(),item={...part,id,item_id:id};base.push(item);for(const index of item.point_indices)pointLabels[index].item_id=id;
  }
  const manual=tags.filter(tag=>!tag.detected&&tag.aggregation!=='label centroid'&&tag.name&&Array.isArray(tag.local));
  const ids=new Set();manual.forEach(tag=>{if(!tag.item_id||ids.has(tag.item_id))tag.item_id=newItemId();ids.add(tag.item_id);});
  const items=[],assigned=new Set();
  for(const item of base){const members=new Set(item.point_indices),seeds=manual.filter(tag=>members.has(tag.point_index));
    if(!seeds.length){items.push(item);continue;}
    const parts=seeds.map(()=>[]);
    for(const index of item.point_indices){const local=Array.from(positions.subarray(index*3,index*3+3));let best=seeds.findIndex(tag=>tag.point_index===index);
      if(best<0){best=0;for(let k=1;k<seeds.length;k++)if(distance(local,seeds[k].local)<distance(local,seeds[best].local))best=k;}
      parts[best].push(index);pointLabels[index].item_id=seeds[best].item_id;
    }
    seeds.forEach((tag,i)=>{assigned.add(tag);items.push({id:tag.item_id,item_id:tag.item_id,label:name(tag.name),local:[...tag.local],target:[...tag.local],point_index:tag.point_index,point_indices:parts[i],count:parts[i].length,manual:true,indoor:!!tag.indoor,floor:tag.floor});});
  }
  for(const tag of manual)if(!assigned.has(tag))items.push({id:tag.item_id,item_id:tag.item_id,label:name(tag.name),local:[...tag.local],target:[...tag.local],point_index:tag.point_index,point_indices:Number.isInteger(tag.point_index)?[tag.point_index]:[],count:1,manual:true,indoor:!!tag.indoor,floor:tag.floor});
  const owners=new Map();for(const item of items)for(const index of item.point_indices)owners.set(index,item.item_id);
  return {items,owners};
}

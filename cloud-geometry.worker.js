import {PointIndex,densifyPoints,buildTin,buildPhotoMosaic} from './cloud-geometry.js';
let positions=null,colors=null,index=null;
self.onmessage=({data})=>{
  if(data.type==='init'){positions=data.positions;colors=data.colors;index=null;return;}
  const {id,type,settings}=data;
  try{
    if(!positions)throw Error('Point cloud is not loaded.');
    let result;
    if(type==='densify'){index ||= new PointIndex(positions);result=densifyPoints(positions,settings.multiplier,index,undefined,colors);}
    else if(type==='tin'){index ||= new PointIndex(positions);result=buildTin(positions,settings.pointSize,undefined,index);}
    else if(type==='mosaic')result=buildPhotoMosaic(positions,settings.cameras,settings.frames,settings.budget);
    else throw Error('Unknown geometry operation.');
    const buffers=[];
    function collect(value){if(ArrayBuffer.isView(value))buffers.push(value.buffer);else if(value&&typeof value==='object')Object.values(value).forEach(collect);}
    collect(result);self.postMessage({id,result},[...new Set(buffers)]);
  }catch(error){self.postMessage({id,error:error.message});}
};

import * as THREE from 'three';
import {PointIndex,densifyPoints,buildTin,buildPhotoMosaic} from './cloud-geometry.js';

function createGeometryClient(positions,sourceColors){
  let worker=null,index=null,nextId=0,disposed=false;const pending=new Map();
  return {
    request(type,settings){
      if(disposed)return Promise.reject(Error('Viewer was closed.'));
      if(typeof Worker==='undefined')return Promise.resolve().then(()=>{
        if(type==='densify'){index ||= new PointIndex(positions);return densifyPoints(positions,settings.multiplier,index,undefined,sourceColors);}
        if(type==='tin'){index ||= new PointIndex(positions);return buildTin(positions,settings.pointSize,undefined,index);}
        return buildPhotoMosaic(positions,settings.cameras,settings.frames,settings.budget);
      });
      if(!worker){
        worker=new Worker(new URL('./cloud-geometry.worker.js',document.baseURI),{type:'module'});
        worker.onmessage=({data})=>{const task=pending.get(data.id);if(!task)return;pending.delete(data.id);data.error?task.reject(Error(data.error)):task.resolve(data.result);};
        worker.onerror=e=>{pending.forEach(task=>task.reject(Error(e.message||'Geometry worker failed.')));pending.clear();worker?.terminate();worker=null;};
        const copy=positions.slice(),rgb=sourceColors?.slice();worker.postMessage({type:'init',positions:copy,colors:rgb},rgb?[copy.buffer,rgb.buffer]:[copy.buffer]);
      }
      const id=++nextId;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,settings});});
    },
    dispose(){disposed=true;worker?.terminate();pending.forEach(task=>task.reject(Error('Viewer was closed.')));pending.clear();},
  };
}

function disposeObject(object){if(!object)return;object.traverse(child=>{child.geometry?.dispose();const materials=Array.isArray(child.material)?child.material:[child.material];for(const material of materials){material?.map?.dispose();material?.dispose();}});}

export function createCloudRepresentations({scene,host,positions,colors,sourceColors,points,state,onInfo=()=>{}}){
  const client=createGeometryClient(positions,sourceColors);let disposed=false,dense=null,tin=null,mosaic=null,frames=[],cameras=[],denseSources=null,tinSources=null;
  let denseKey='',tinKey='',mosaicKey='',generation={densify:0,tin:0,mosaic:0},timer=null;
  const info={original:positions.length/3,synthetic:0,triangles:0,meshVertices:0,photos:0,photoTotal:0,planarPhotos:0,busy:false,error:''};
  const busy=new Set();
  function publish(){info.busy=busy.size>0;host.setAttribute('data-pseudo-count',info.synthetic);host.setAttribute('data-tin-triangles',info.triangles);host.setAttribute('data-mosaic-photos',info.photos);host.setAttribute('data-display-mode',state.renderMode);onInfo({...info});}
  function visibility(){
    const mode=state.renderMode;points.visible=mode==='points'||(mode==='tin'&&!info.triangles)||(mode==='mosaic'&&!info.photos);
    if(dense)dense.visible=mode==='points';if(tin)tin.visible=mode==='tin';if(mosaic)mosaic.visible=mode==='mosaic';
    publish();
  }
  function copyColors(geometry,sources){
    let attribute=geometry.attributes.color;if(!attribute){attribute=new THREE.BufferAttribute(new Float32Array(sources.length*3),3);geometry.setAttribute('color',attribute);}
    for(let i=0;i<sources.length;i++)for(let k=0;k<3;k++)attribute.array[i*3+k]=colors[sources[i]*3+k];attribute.needsUpdate=true;
  }
  async function generate(kind,key,settings){
    const token=++generation[kind];busy.add(kind);info.error='';publish();
    try{
      const result=await client.request(kind,settings);if(disposed||token!==generation[kind])return;
      if(kind==='densify'){
        scene.remove(dense);disposeObject(dense);denseSources=result.colorSources;
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(result.positions,3));copyColors(geometry,denseSources);
        dense=new THREE.Points(geometry,new THREE.PointsMaterial({size:state.pointSize,vertexColors:true,sizeAttenuation:false}));dense.name='synthetic-neighbour-points';dense.visible=state.renderMode==='points';dense.material.color.setScalar(state.brightness);scene.add(dense);
        info.synthetic=result.count;info.requested=result.requestedCount;info.target=result.targetCount;denseKey=key;
      }else if(kind==='tin'){
        scene.remove(tin);disposeObject(tin);tinSources=result.colorSources;
        const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(result.positions,3));geometry.setIndex(new THREE.BufferAttribute(result.indices,1));copyColors(geometry,tinSources);
        tin=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide,wireframe:!!state.tinWireframe}));tin.name='local-delaunay-tin';tin.visible=state.renderMode==='tin';tin.material.color.setScalar(state.brightness);scene.add(tin);
        info.triangles=result.count;info.meshVertices=result.colorSources.length;tinKey=key;
      }else{
        scene.remove(mosaic);disposeObject(mosaic);mosaic=new THREE.Group();mosaic.name='oriented-photo-cutouts';mosaic.visible=state.renderMode==='mosaic';scene.add(mosaic);
        info.photos=0;info.photoTotal=result.total;info.planarPhotos=result.planar;const group=mosaic;
        await Promise.all(result.cutouts.map(async (cutout,i)=>{
          if(!/^(data:image\/|blob:)/.test(cutout.url||''))return;
          try{
            const texture=await new THREE.TextureLoader().loadAsync(cutout.url);
            if(disposed||token!==generation.mosaic||mosaic!==group){texture.dispose();return;}
            // Bound GPU texture memory; the full source frames stay available
            // in the photo browser and saved project.
            if(Math.max(texture.image.width,texture.image.height)>512){const canvas=document.createElement('canvas'),ratio=512/Math.max(texture.image.width,texture.image.height);canvas.width=Math.round(texture.image.width*ratio);canvas.height=Math.round(texture.image.height*ratio);canvas.getContext('2d').drawImage(texture.image,0,0,canvas.width,canvas.height);texture.image=canvas;texture.needsUpdate=true;}
            texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearFilter;
            const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(cutout.positions,3));geometry.setAttribute('uv',new THREE.BufferAttribute(cutout.uv,2));geometry.setIndex(new THREE.BufferAttribute(cutout.indices,1));
            const material=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide,transparent:true,opacity:state.mosaicOpacity,depthWrite:false});material.color.setScalar(state.brightness);
            const mesh=new THREE.Mesh(geometry,material);mesh.name=cutout.image;mesh.renderOrder=i;group.add(mesh);info.photos++;publish();
          }catch(error){info.error='A source photo could not be decoded: '+error.message;}
        }));
        if(disposed||token!==generation.mosaic)return;mosaicKey=key;
      }
    }catch(error){if(!disposed&&token===generation[kind]){info.error=error.message;if(kind==='densify')denseKey='';if(kind==='tin')tinKey='';if(kind==='mosaic')mosaicKey='';}}
    finally{if(!disposed&&token===generation[kind]){busy.delete(kind);visibility();}}
  }
  function update(){
    if(disposed)return;
    const multiplier=Math.max(0,Math.min(1000,Number(state.densify)||0)),key=String(multiplier);
    if(!multiplier){generation.densify++;busy.delete('densify');scene.remove(dense);disposeObject(dense);dense=null;denseSources=null;info.synthetic=0;info.requested=0;info.target=0;denseKey='0';}
    else if(key!==denseKey){denseKey=key;generate('densify',key,{multiplier});}
    if(state.renderMode==='tin'){
      const key=String(state.pointSize/2);if(key!==tinKey){tinKey=key;generate('tin',key,{pointSize:state.pointSize/2});}
      if(tin)tin.material.wireframe=!!state.tinWireframe;
    }
    if(state.renderMode==='mosaic'){
      const key=String(state.mosaicBudget);if(frames.length&&key!==mosaicKey){mosaicKey=key;generate('mosaic',key,{cameras,frames,budget:state.mosaicBudget});}
      if(mosaic)mosaic.children.forEach(mesh=>mesh.material.opacity=state.mosaicOpacity);
    }
    visibility();
  }
  return {
    update(debounce=false){clearTimeout(timer);if(debounce)timer=setTimeout(update,160);else update();},
    setSources(nextCameras,nextFrames){cameras=nextCameras||[];frames=nextFrames||[];state.hasPhotos=frames.some(f=>cameras.some(c=>c.image===f.image||c.image?.split('/').pop()===f.image));generation.mosaic++;busy.delete('mosaic');mosaicKey='';scene.remove(mosaic);disposeObject(mosaic);mosaic=null;info.photos=0;update();},
    setBrightness(value){dense?.material.color.setScalar(value);tin?.material.color.setScalar(value);mosaic?.children.forEach(mesh=>mesh.material.color.setScalar(value));},
    setPointSize(size){if(dense)dense.material.size=size;this.update(true);},
    updateColors(){if(dense&&denseSources)copyColors(dense.geometry,denseSources);if(tin&&tinSources)copyColors(tin.geometry,tinSources);},
    getInfo(){return {...info};},
    pickOriginal(raycaster,camera){
      const matrix=camera.matrixWorldInverse.elements;
      const depth=p=>-(matrix[2]*p[0]+matrix[6]*p[1]+matrix[10]*p[2]+matrix[14]);
      const visible=p=>{const z=depth(p);return z>=camera.near&&z<=camera.far;};
      function nearestOriginal(p){let best=-1,distance=Infinity;for(let i=0;i<positions.length;i+=3){
        const x=positions[i],y=positions[i+1],z=positions[i+2],cameraDepth=-(matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14]);if(cameraDepth<camera.near||cameraDepth>camera.far)continue;
        const d=(p.x-x)**2+(p.y-y)**2+(p.z-z)**2;if(d<distance){distance=d;best=i/3;}
      }return best;}
      if(state.renderMode==='points'&&dense?.visible){
        const hits=raycaster.intersectObject(dense);hits.sort((a,b)=>a.distanceToRay/Math.max(a.distance,1e-9)-b.distanceToRay/Math.max(b.distance,1e-9));
        for(const hit of hits){const p=Array.from(dense.geometry.attributes.position.array.subarray(hit.index*3,hit.index*3+3));if(!visible(p))continue;
          let index=denseSources[hit.index];if(!visible(Array.from(positions.subarray(index*3,index*3+3))))index=nearestOriginal(new THREE.Vector3(...p));
          if(index>=0)return {index,score:hit.distanceToRay/Math.max(hit.distance,1e-9)};
        }
      }
      const surface=state.renderMode==='tin'?tin:state.renderMode==='mosaic'?mosaic:null;
      if(surface?.visible)for(const hit of raycaster.intersectObject(surface,true)){
        if(!visible(hit.point.toArray()))continue;const index=nearestOriginal(hit.point);if(index>=0)return {index,score:0};
      }
      return null;
    },
    dispose(){disposed=true;clearTimeout(timer);client.dispose();for(const object of [dense,tin,mosaic]){scene.remove(object);disposeObject(object);}},
  };
}

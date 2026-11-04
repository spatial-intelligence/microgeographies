import Delaunator from './vendor/delaunator.module.js';

const squared=(a,b)=>a.reduce((s,v,k)=>s+(v-b[k])**2,0);
const dot=(a,b)=>a.reduce((s,v,k)=>s+v*b[k],0);
const point=(positions,i)=>[positions[i*3],positions[i*3+1],positions[i*3+2]];
const hash=i=>{i=Math.imul(i^(i>>>16),0x45d9f3b);i=Math.imul(i^(i>>>16),0x45d9f3b);return (i^(i>>>16))>>>0;};
const median=values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)]||0;};

export function bounds(positions){
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<positions.length;i+=3)for(let k=0;k<3;k++){min[k]=Math.min(min[k],positions[i+k]);max[k]=Math.max(max[k],positions[i+k]);}
  return {min,max,span:Math.hypot(...max.map((v,k)=>v-min[k]))||1};
}

// Balanced implicit k-d tree. Split on the longest local axis so flat walls
// and floors do not degenerate into exhaustive searches along a zero axis.
export class PointIndex {
  constructor(positions){
    this.positions=positions;this.ids=Uint32Array.from({length:positions.length/3},(_,i)=>i);this.axes=new Uint8Array(this.ids.length);
    const {ids,axes}=this;
    const compare=(a,b,axis)=>positions[a*3+axis]-positions[b*3+axis]||a-b;
    function select(lo,hi,mid,axis){
      while(lo<hi){const pivot=ids[(lo+hi)>>>1];let a=lo,b=hi;
        while(a<=b){while(compare(ids[a],pivot,axis)<0)a++;while(compare(ids[b],pivot,axis)>0)b--;if(a<=b){const id=ids[a];ids[a++]=ids[b];ids[b--]=id;}}
        if(mid<=b)hi=b;else if(mid>=a)lo=a;else return;
      }
    }
    function build(lo,hi){if(lo>hi)return;
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
      for(let j=lo;j<=hi;j++)for(let k=0;k<3;k++){const value=positions[ids[j]*3+k];min[k]=Math.min(min[k],value);max[k]=Math.max(max[k],value);}
      let axis=0;for(let k=1;k<3;k++)if(max[k]-min[k]>max[axis]-min[axis])axis=k;
      const mid=(lo+hi)>>>1;select(lo,hi,mid,axis);axes[mid]=axis;build(lo,mid-1);build(mid+1,hi);
    }
    build(0,ids.length-1);
  }
  nearestK(p,count=48,exclude=-1,minDistance=0){
    const found=[],{positions,ids,axes}=this,minSq=minDistance*minDistance;
    function search(lo,hi){if(lo>hi)return;const mid=(lo+hi)>>>1,id=ids[mid],axis=axes[mid],offset=p[axis]-positions[id*3+axis];
      const d=(p[0]-positions[id*3])**2+(p[1]-positions[id*3+1])**2+(p[2]-positions[id*3+2])**2;
      if(id!==exclude&&d>minSq){let at=0;while(at<found.length&&(found[at].d<d||found[at].d===d&&found[at].index<id))at++;if(at<count){found.splice(at,0,{index:id,d});if(found.length>count)found.pop();}}
      const limit=()=>found.length<count?Infinity:found[found.length-1].d;
      if(offset<0){search(lo,mid-1);if(offset*offset<=limit())search(mid+1,hi);}else{search(mid+1,hi);if(offset*offset<=limit())search(lo,mid-1);}
    }
    search(0,ids.length-1);return found.map(v=>({index:v.index,distance:Math.sqrt(v.d)}));
  }
  nearest(p,exclude=-1,minDistance=0){
    let best=-1,bestSq=Infinity;const {positions,ids,axes}=this,minSq=minDistance<0?-1:minDistance*minDistance,excluded=exclude instanceof Set?exclude:null;
    function search(lo,hi){if(lo>hi)return;const mid=(lo+hi)>>>1,id=ids[mid],axis=axes[mid],offset=p[axis]-positions[id*3+axis];
      const d=(p[0]-positions[id*3])**2+(p[1]-positions[id*3+1])**2+(p[2]-positions[id*3+2])**2;
      if(id!==exclude&&!excluded?.has(id)&&d>minSq&&(d<bestSq||(d===bestSq&&id<best))){best=id;bestSq=d;}
      if(offset<0){search(lo,mid-1);if(offset*offset<=bestSq)search(mid+1,hi);}else{search(mid+1,hi);if(offset*offset<=bestSq)search(lo,mid-1);}
    }
    search(0,ids.length-1);return {index:best,distance:Math.sqrt(bestSq)};
  }
}

// Surface-aware seeded gap filling. Directions are in a local PCA tangent plane,
// so the eight compass sectors work on floors, walls and tilted objects alike.
export function densifyPoints(positions,multiplier,index=null,maxAdditional=2000000,colors=null){
  const n=positions.length/3,amount=Math.max(0,Math.min(1000,Number(multiplier)||0));
  const empty=()=>({positions:new Float32Array(),colorSources:new Uint32Array(),originalCount:n,count:0});
  if(!amount||n<2||maxAdditional<1)return empty();
  const box=bounds(positions);if(box.min.every((v,k)=>v===box.max[k]))return empty();
  index ||= new PointIndex(positions);const epsilon=box.span*1e-8,distances=[];
  for(let k=0;k<Math.min(512,n);k++){const i=Math.floor(k*n/Math.min(512,n)),d=index.nearest(point(positions,i),i,epsilon).distance;if(Number.isFinite(d))distances.push(d);}
  const maxGap=median(distances)*4,anchors=Math.min(n,100000),target=Math.min(maxAdditional,Math.floor(n*amount)),out=[],sources=[];
  // Original RGB is independent of the current height/class/distance display palette.
  const similar=(a,b)=>!colors||Math.hypot(...[0,1,2].map(k=>colors[a*3+k]-colors[b*3+k]))<=.32;
  for(let k=0;k<anchors;k++){
    const i=Math.min(n-1,Math.floor((k+.5)*n/anchors)),a=point(positions,i);
    const copies=Math.floor(target/anchors)+Number(k<target%anchors);if(!copies)continue;
    const neighbors=index.nearestK(a,48,i,epsilon).filter(v=>v.distance<=maxGap);
    if(!neighbors.length)continue;
    const localGap=Math.min(maxGap,median(neighbors.slice(0,8).map(v=>v.distance))*2.5);
    const plane=principalPlane(positions,[i,...neighbors.slice(0,16).map(v=>v.index)]),patches=[];
    if(plane){
      const sectors=Array(8).fill(null),normalTolerance=Math.max(neighbors[0].distance*.3,epsilon);
      for(const neighbor of neighbors){
        if(neighbor.distance>localGap)continue;
        const d=point(positions,neighbor.index).map((v,k)=>v-a[k]);
        if(Math.abs(dot(d,plane.normal))>normalTolerance)continue;
        const angle=(Math.atan2(dot(d,plane.v),dot(d,plane.u))+Math.PI*2)%(Math.PI*2),sector=Math.floor((angle+Math.PI/8)%(Math.PI*2)/(Math.PI/4));
        // Choose nearest geometry first, then reject its colour boundary. Do not
        // search past a different-coloured object for a matching point behind it.
        if(!sectors[sector]||neighbor.distance<sectors[sector].distance)sectors[sector]={...neighbor,angle};
      }
      const ring=sectors.filter(Boolean).sort((a,b)=>a.angle-b.angle);
      for(let j=0;j<ring.length;j++){
        const b=ring[j],c=ring[(j+1)%ring.length],angle=(c.angle-b.angle+Math.PI*2)%(Math.PI*2);
        if(b.index===c.index||angle>Math.PI*.56||!similar(i,b.index)||!similar(i,c.index)||!similar(b.index,c.index))continue;
        const pb=point(positions,b.index),pc=point(positions,c.index);
        if(squared(pb,pc)>localGap*localGap)continue;
        const area=b.distance*c.distance*Math.sin(angle)/2;if(area>epsilon*epsilon)patches.push({b:pb,c:pc,gap:area,used:0});
      }
    }else{
      // Thin/collinear structures only support interpolation on actual segments.
      const b=neighbors.find(v=>v.distance<=localGap&&similar(i,v.index));
      if(b)patches.push({b:point(positions,b.index),c:null,gap:b.distance*b.distance,used:0});
    }
    const placed=[];
    for(let j=0;j<copies&&sources.length<maxAdditional&&patches.length;j++){
      let patch=patches[0];for(const p of patches)if(p.gap/(p.used+1)>patch.gap/(patch.used+1))patch=p;
      let best=null,score=-1;
      // Best of four random candidates approximates the largest unfilled local
      // gap while keeping the cloud irregular and stable across repeat loads.
      for(let attempt=0;attempt<4;attempt++){
        const seed=hash(i)^Math.imul(j+1,0x85ebca6b)^Math.imul(attempt+1,0x27d4eb2d);
        let t=(hash(seed)+.5)/4294967296,u=patch.c?(hash(seed^0xc2b2ae35)+.5)/4294967296:0;
        if(t+u>1){t=1-t;u=1-u;}
        const p=a.map((v,k)=>Math.fround(v+(patch.b[k]-v)*t+(patch.c?(patch.c[k]-v)*u:0)));
        let distance=squared(p,a);for(const neighbor of neighbors){const o=neighbor.index*3;distance=Math.min(distance,(p[0]-positions[o])**2+(p[1]-positions[o+1])**2+(p[2]-positions[o+2])**2);}for(const q of placed)distance=Math.min(distance,squared(p,q));
        if(distance>score){best=p;score=distance;}
      }
      patch.used++;if(score<=epsilon*epsilon)continue;
      const source=index.nearest(best,-1,-1).index;
      if(!similar(i,source))continue;
      out.push(...best);sources.push(source);if(placed.length<64)placed.push(best);else placed[j%64]=best;
    }
  }
  return {positions:new Float32Array(out),colorSources:new Uint32Array(sources),originalCount:n,count:sources.length,requestedCount:Math.floor(n*amount),targetCount:target};
}

// Symmetric 3x3 Jacobi eigensolver: the two largest principal axes define
// each local Delaunay patch. No global ground-plane assumption is needed.
function principalPlane(positions,ids){
  const center=[0,0,0];for(const id of ids)for(let k=0;k<3;k++)center[k]+=positions[id*3+k]/ids.length;
  const a=[[0,0,0],[0,0,0],[0,0,0]],v=[[1,0,0],[0,1,0],[0,0,1]];
  for(const id of ids){const p=point(positions,id).map((x,k)=>x-center[k]);for(let j=0;j<3;j++)for(let k=0;k<3;k++)a[j][k]+=p[j]*p[k];}
  for(let pass=0;pass<16;pass++){
    let p=0,q=1;for(const [j,k] of [[0,2],[1,2]])if(Math.abs(a[j][k])>Math.abs(a[p][q])){p=j;q=k;}
    if(Math.abs(a[p][q])<1e-12*Math.max(1,a[0][0]+a[1][1]+a[2][2]))break;
    const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle);
    const app=a[p][p],aqq=a[q][q],apq=a[p][q];
    a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;a[p][q]=a[q][p]=0;
    for(let k=0;k<3;k++){if(k!==p&&k!==q){const x=a[k][p],y=a[k][q];a[k][p]=a[p][k]=c*x-s*y;a[k][q]=a[q][k]=s*x+c*y;}
      const x=v[k][p],y=v[k][q];v[k][p]=c*x-s*y;v[k][q]=s*x+c*y;}
  }
  const axes=[0,1,2].sort((j,k)=>a[k][k]-a[j][j]);
  if(a[axes[1]][axes[1]]<Math.max(1e-16,a[axes[0]][axes[0]]*1e-10))return null;
  return {center,u:v.map(row=>row[axes[0]]),v:v.map(row=>row[axes[1]]),normal:v.map(row=>row[axes[2]])};
}

export function buildTin(positions,pointSize=1,maxVertices=300000,sourceIndex=null){
  const n=positions.length/3,target=Math.max(3,Math.min(n,maxVertices,Math.round(Math.min(n,60000)/Math.max(.0625,pointSize*pointSize))));
  if(n<3)return {positions:new Float32Array(),colorSources:new Uint32Array(),indices:new Uint32Array(),count:0};
  const box=bounds(positions),sampleDistances=[];
  if(box.min.every((v,k)=>v===box.max[k]))return {positions:new Float32Array(),colorSources:new Uint32Array(),indices:new Uint32Array(),count:0};
  sourceIndex ||= new PointIndex(positions);
  for(let k=0;k<Math.min(512,n);k++){const i=Math.floor(k*n/Math.min(512,n)),d=sourceIndex.nearest(point(positions,i),i,box.span*1e-9).distance;if(Number.isFinite(d))sampleDistances.push(d);}
  const spacing=Math.min(box.span/Math.sqrt(target)*.45,median(sampleDistances)*Math.sqrt(n/target)*.7),cells=new Map();
  // Spatial thinning avoids aliasing rows in organised depth clouds.
  const candidateBudget=Math.min(n,Math.max(300000,target*3));
  for(let j=0;j<candidateBudget;j++){
    const i=n<=candidateBudget?j:Math.min(n-1,Math.floor(((j*.6180339887498949)%1)*n));
    const key=[0,1,2].map(k=>Math.floor((positions[i*3+k]-box.min[k])/Math.max(spacing,1e-10))).join(',');
    const previous=cells.get(key);if(previous===undefined||hash(i)<hash(previous))cells.set(key,i);
  }
  const candidates=[...cells.values()];if(candidates.length>target)candidates.sort((a,b)=>hash(a)-hash(b));
  const sources=new Uint32Array(candidates.slice(0,target)),vertices=new Float32Array(sources.length*3);
  sources.forEach((id,i)=>vertices.set(positions.subarray(id*3,id*3+3),i*3));
  if(sources.length<3)return {positions:vertices,colorSources:sources,indices:new Uint32Array(),count:0};
  const index=new PointIndex(vertices),distances=[];
  for(let i=0;i<vertices.length/3;i+=Math.max(1,Math.floor(vertices.length/3/1024))){const d=index.nearest(point(vertices,i),i,box.span*1e-9).distance;if(Number.isFinite(d))distances.push(d);}
  const step=median(distances);if(!step)return {positions:vertices,colorSources:sources,indices:new Uint32Array(),count:0};
  const patchSize=step*10,patches=new Map(),cellOf=p=>p.map((v,k)=>Math.floor((v-box.min[k])/patchSize)),keyOf=cell=>cell.join(',');
  for(let i=0;i<sources.length;i++){const key=keyOf(cellOf(point(vertices,i)));if(!patches.has(key))patches.set(key,[]);patches.get(key).push(i);}
  const indices=[],seen=new Set(),maxEdgeSq=(step*4.5)**2;
  for(const key of patches.keys()){
    const cell=key.split(',').map(Number),ids=[];
    for(let x=-1;x<=1;x++)for(let y=-1;y<=1;y++)for(let z=-1;z<=1;z++)ids.push(...(patches.get(keyOf([cell[0]+x,cell[1]+y,cell[2]+z]))||[]));
    if(ids.length<3)continue;
    // Bound a pathological dense overlap without blocking the browser worker.
    if(ids.length>2400){ids.sort((a,b)=>hash(sources[a])-hash(sources[b]));ids.length=2400;}
    const plane=principalPlane(vertices,ids);if(!plane)continue;
    const projected=new Float64Array(ids.length*2);
    ids.forEach((id,i)=>{const p=point(vertices,id).map((v,k)=>v-plane.center[k]);projected[i*2]=dot(p,plane.u);projected[i*2+1]=dot(p,plane.v);});
    const triangles=new Delaunator(projected).triangles;
    for(let j=0;j<triangles.length;j+=3){
      const face=[ids[triangles[j]],ids[triangles[j+1]],ids[triangles[j+2]]],ps=face.map(i=>point(vertices,i));
      const centroid=[0,1,2].map(k=>(ps[0][k]+ps[1][k]+ps[2][k])/3);
      if(keyOf(cellOf(centroid))!==key)continue;
      if([squared(ps[0],ps[1]),squared(ps[1],ps[2]),squared(ps[2],ps[0])].some(d=>d>maxEdgeSq))continue;
      const ab=ps[1].map((v,k)=>v-ps[0][k]),ac=ps[2].map((v,k)=>v-ps[0][k]),cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]],area=Math.hypot(...cross);
      if(area<step*step*1e-5||Math.abs(dot(cross,plane.normal))<area*.55)continue;
      const id=face.slice().sort((a,b)=>a-b).join(',');if(seen.has(id))continue;seen.add(id);indices.push(...face);
    }
  }
  return {positions:vertices,colorSources:sources,indices:new Uint32Array(indices),count:indices.length/3};
}

export function cameraPose(camera){
  let [w,x,y,z]=camera.qvec||[1,0,0,0];const length=Math.hypot(w,x,y,z)||1;w/=length;x/=length;y/=length;z/=length;
  const rotation=[[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]];
  const pinhole=['PINHOLE','OPENCV','FULL_OPENCV'].includes(camera.model||'PINHOLE'),p=camera.params||[];
  return {rotation,translation:camera.tvec||[0,0,0],intrinsics:pinhole?p.slice(0,4):[p[0],p[0],p[1],p[2]]};
}

export function buildPhotoCutout(positions,camera,frame,resolution=32){
  const {rotation:r,translation:t,intrinsics:[fx,fy,cx,cy]}=cameraPose(camera);
  if(![fx,fy,camera.width,camera.height].every(v=>v>0))return null;
  const supplied=frame.depth?.length>=4,side=supplied?Math.round(Math.sqrt(frame.depth.length)):resolution;
  if(supplied&&side*side!==frame.depth.length)return null;
  const depth=supplied?Float32Array.from(frame.depth):new Float32Array(side*side),positive=[];
  if(!supplied){
    const stride=Math.max(1,Math.ceil(positions.length/3/120000));
    for(let i=0;i<positions.length/3;i+=stride){const p=point(positions,i),q=r.map((row,k)=>dot(row,p)+t[k]);if(q[2]<=0)continue;
      const u=fx*q[0]/q[2]+cx,v=fy*q[1]/q[2]+cy;if(u<0||v<0||u>=camera.width||v>=camera.height)continue;
      positive.push(q[2]);const cell=Math.min(side-1,Math.floor(v/camera.height*side))*side+Math.min(side-1,Math.floor(u/camera.width*side));if(!depth[cell]||q[2]<depth[cell])depth[cell]=q[2];
    }
  }
  const world=q=>[0,1,2].map(k=>r.reduce((sum,row,j)=>sum+row[k]*(q[j]-t[j]),0));
  const vertices=new Float32Array(side*side*3),uv=new Float32Array(side*side*2),indices=[];
  for(let y=0;y<side;y++)for(let x=0;x<side;x++){
    const i=y*side+x,z=depth[i],u=x/(side-1),v=y/(side-1);
    vertices.set(world([(u*camera.width-cx)/fx*z,(v*camera.height-cy)/fy*z,z]),i*3);uv.set([u,1-v],i*2);
  }
  for(let y=0;y<side-1;y++)for(let x=0;x<side-1;x++){
    const a=y*side+x,b=a+1,c=a+side,d=c+1;
    for(const face of [[a,b,c],[b,d,c]]){const values=face.map(i=>depth[i]);if(values.some(v=>!Number.isFinite(v)||v<=0))continue;
      if(Math.max(...values)-Math.min(...values)>Math.max(.1,Math.min(...values)*.15))continue;indices.push(...face);}
  }
  if(indices.length>=3)return {positions:vertices,uv,indices:new Uint32Array(indices),image:frame.image,url:frame.url,planar:false};
  if(supplied||!positive.length)return null;
  // Sparse COLMAP has no depth image. Place an explicitly identified photo
  // plane at the median visible cloud depth, preserving the recovered pose.
  const z=median(positive),plane=[];
  for(const [u,v] of [[0,0],[1,0],[0,1],[1,1]])plane.push(...world([(u*camera.width-cx)/fx*z,(v*camera.height-cy)/fy*z,z]));
  return {positions:new Float32Array(plane),uv:new Float32Array([0,1,1,1,0,0,1,0]),indices:new Uint32Array([0,1,2,1,3,2]),image:frame.image,url:frame.url,planar:true};
}

export function buildPhotoMosaic(positions,cameras,frames,budget=64){
  const matching=cameras.map(camera=>({camera,frame:frames.find(f=>f.image===camera.image||f.image===camera.image?.split('/').pop())})).filter(item=>item.frame);
  const limit=Math.min(matching.length,Math.max(1,Math.min(250,budget))),cutouts=[];
  for(let k=0;k<limit;k++){const i=limit===1?0:Math.round(k*(matching.length-1)/(limit-1)),{camera,frame}=matching[i],cutout=buildPhotoCutout(positions,camera,frame);if(cutout)cutouts.push(cutout);}
  return {cutouts,total:matching.length,count:cutouts.length,planar:cutouts.filter(c=>c.planar).length};
}

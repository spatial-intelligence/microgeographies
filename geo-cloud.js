const EARTH_R = 6371000;

export function geographicPoint(positions, index, reference) {
  const p = Array.from(positions.subarray(index*3,index*3+3));
  const enu = reference.matrix.map((row,k) => row.reduce((sum,v,j)=>sum+v*p[j],reference.translation[k]));
  const origin = reference.origin;
  return [origin.lon+enu[0]/(EARTH_R*Math.cos(origin.lat*Math.PI/180))*180/Math.PI,
    origin.lat+enu[1]/EARTH_R*180/Math.PI, (origin.altitude_m || 0)+enu[2]];
}

// One canvas instead of thousands of DOM markers. Reprojects on map movement.
export function createCloudMapLayer(L, map, positions, colors, reference) {
  const canvas = L.DomUtil.create("canvas", "cloud-map-canvas", map.getPane("overlayPane"));
  canvas.style.pointerEvents = "none";
  const indices = [], stride = Math.max(1,Math.ceil(positions.length/3/20000));
  for (let i=0;i<positions.length/3;i+=stride) indices.push(i);
  const points = indices.map(i=> { const c=geographicPoint(positions,i,reference); return L.latLng(c[1],c[0]); });
  function draw() {
    const size=map.getSize(), ratio=Math.min(devicePixelRatio || 1,2);
    canvas.width=size.x*ratio;canvas.height=size.y*ratio;
    canvas.style.width=`${size.x}px`;canvas.style.height=`${size.y}px`;
    L.DomUtil.setPosition(canvas,map.containerPointToLayerPoint([0,0]));
    const ctx=canvas.getContext("2d");ctx.scale(ratio,ratio);ctx.globalAlpha=.65;
    points.forEach((point,j)=> {
      const p=map.latLngToContainerPoint(point); if(p.x<0||p.y<0||p.x>size.x||p.y>size.y)return;
      const i=indices[j]; ctx.fillStyle=`rgb(${[0,1,2].map(k=>Math.round(colors[i*3+k]*255)).join(",")})`;
      ctx.fillRect(p.x-1,p.y-1,2,2);
    });
  }
  map.on("moveend zoomend resize",draw); draw();
  return {remove(){map.off("moveend zoomend resize",draw);canvas.remove();},
    bounds: L.latLngBounds(points)};
}

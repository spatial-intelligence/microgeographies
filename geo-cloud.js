const EARTH_R = 6371000;

// Semantic summaries are grouped by label, rather than exporting every cloud
// sample as a separate feature. They are not individual object instances.
export function buildMappedFeatures(positions, labels, votes, reference, geoms = {}) {
  const collection = {type: "FeatureCollection", features: [], georeference: reference || null,
    aggregation: "Per-label centroid or principal-axis line"};
  if (!reference?.available) return collection;
  const groups = new Map();
  for (let i=0;i<labels.length;i++) {
    if (!labels[i]) continue;
    let group = groups.get(labels[i]);
    if (!group) { group = {indices:[], sum:[0,0,0], votes:0}; groups.set(labels[i],group); }
    group.indices.push(i); group.votes += votes[i] || 0;
    for (let k=0;k<3;k++) group.sum[k] += positions[i*3+k];
  }
  for (const [label, group] of groups) {
    const centroid = new Float64Array(group.sum.map(value=>value/group.indices.length));
    let geometry = {type:"Point",coordinates:geographicPoint(centroid,0,reference)};
    if (geoms[label.toLowerCase()] === "line" && group.indices.length >= 2) {
      // Principal horizontal axis in ENU metres, using the fitted transform.
      const enu = i => reference.matrix.slice(0,2).map(row=>row.reduce((v,m,k)=>v+m*(positions[i*3+k]-centroid[k]),0));
      let xx=0,xy=0,yy=0;
      for(const i of group.indices) {const [e,n]=enu(i);xx+=e*e;xy+=e*n;yy+=n*n;}
      const angle=.5*Math.atan2(2*xy,xx-yy), axis=[Math.cos(angle),Math.sin(angle)];
      let lo=Infinity,hi=-Infinity,first=group.indices[0],last=first;
      for(const i of group.indices) {const p=enu(i),t=p[0]*axis[0]+p[1]*axis[1]; if(t<lo){lo=t;first=i;}if(t>hi){hi=t;last=i;}}
      if(hi-lo>1e-6) geometry={type:"LineString",coordinates:[geographicPoint(positions,first,reference),geographicPoint(positions,last,reference)]};
    }
    collection.features.push({type:"Feature",geometry,properties:{label,point_count:group.indices.length,
      votes:group.votes,source:"Reconstructed labelled cloud",aggregation:collection.aggregation}});
  }
  return collection;
}

export function addMappedFeaturesToMap(L, layer, collection, onEdit = null) {
  if (!L || !layer) return;
  for (const feature of collection.features) {
    const popup=document.createElement("span");
    popup.textContent=`${feature.properties.label} · ${feature.properties.point_count} cloud points (label summary)`;
    const geometry=feature.geometry;
    if(geometry.type === "Point") {
      const marker=L.marker([geometry.coordinates[1],geometry.coordinates[0]],
        {icon:L.divIcon({className:'mapped-feature-tag',html:'',iconSize:[16,16],iconAnchor:[8,8]})}).addTo(layer).bindPopup(popup);
      // Avoid native focus scrolling a nested map panel between down/up.
      marker.getElement().addEventListener('mousedown',e=>{e.preventDefault();e.stopPropagation();});
      if(onEdit)marker.on('click',()=>onEdit(feature));
    }
    else L.polyline(geometry.coordinates.map(c=>[c[1],c[0]]),{color:"#0891b2",weight:4}).addTo(layer).bindPopup(popup);
  }
}

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

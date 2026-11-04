// Port of SLAM-image-1/static/app.js main viewer. Camera, material,
// OrbitControls defaults, fit/top and render-loop behaviour follow that app.
// Its navigation/roll/identify modules and Three.js r180 are copied unchanged.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { createViewNavigation } from "./view-navigation.js";
import { createViewRoll } from "./view-roll.js";
import { attachPointIdentify } from "./point-identify.js";
import { createIdentifyTooltip, createMeasurementOverlay, createControlPointOverlay } from "./viewer-annotations.js";
import { createGaussianLayer } from "./gaussian-view.js";
import { createViewerCameraControls } from "./viewer-camera-controls.js";
import { createCloudRepresentations } from "./cloud-representations.js";
import { createClassLegend } from "./viewer-class-legend.js";

// Wireframes only: camera poses must never become opaque scene geometry.
export function createCameraOverlay(cameras, scale) {
  const group = new THREE.Group();
  group.name = "camera-overlays";
  const vertices = [], colors = [], centers = [];
  const segment = (a, b, color) => {
    vertices.push(...a.toArray(), ...b.toArray());
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  };
  for (let i = 0; i < cameras.length; i++) {
    const c = cameras[i], q = c.qvec, t = c.tvec, p = c.params;
    if (q?.length !== 4 || t?.length !== 3 || !p?.length ||
        ![...q, ...t, ...p, c.width, c.height].every(Number.isFinite)) continue;
    const inverse = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize().invert();
    const center = new THREE.Vector3(...t).negate().applyQuaternion(inverse);
    const pinhole = c.model === "PINHOLE" || c.model === "OPENCV" || c.model === "FULL_OPENCV";
    const [fx, fy, cx, cy] = pinhole ? p : [p[0], p[0], p[1], p[2]];
    if (!(fx > 0 && fy > 0)) continue;
    const color = new THREE.Color().setHSL(i / Math.max(cameras.length, 1), .8, .65);
    const corners = [[0, 0], [c.width - 1, 0], [c.width - 1, c.height - 1], [0, c.height - 1]]
      .map(([x, y]) => new THREE.Vector3((x - cx) / fx * scale, (y - cy) / fy * scale, scale)
        .applyQuaternion(inverse).add(center));
    for (let k = 0; k < 4; k++) {
      segment(center, corners[k], color);
      segment(corners[k], corners[(k + 1) % 4], color);
    }
    if (centers.length) segment(centers[centers.length - 1], center, color);
    centers.push(center);
  }
  if (vertices.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({vertexColors: true})));
  }
  return group;
}

export function cloudHeightValues(positions, axis = [0,-1,0]) {
  const heights = new Float32Array(positions.length/3);
  let lowest = Infinity;
  for(let i=0;i<heights.length;i++) {
    heights[i] = axis[0]*positions[i*3]+axis[1]*positions[i*3+1]+axis[2]*positions[i*3+2];
    lowest = Math.min(lowest,heights[i]);
  }
  for(let i=0;i<heights.length;i++) heights[i]-=lowest;
  return heights;
}

function createCloudView(host, positions, rgb, classes, labels, votes, state, cameras, reference) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#101c2c");
  const camera = new THREE.PerspectiveCamera(state.fov, 1, .001, 1000000);
  camera.up.set(0, -1, 0); // Unaligned COLMAP frame, as in SLAM-image-1.
  const q = cameras?.find(c => c.qvec?.length === 4)?.qvec;
  // COLMAP stores world-to-camera rotation, so invert it to orient the view.
  const basis = q ? new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize().invert() : null;
  if (basis) camera.up.applyQuaternion(basis);
  const reconstructionUp = camera.up.clone();
  const heightAxis = reference?.available ? reference.matrix[2] : camera.up.toArray();
  const groundUp = new THREE.Vector3(...heightAxis).normalize();
  let groundMinimum = Infinity, groundAuto = 0;
  function updateGround(reference){
    groundUp.copy(reconstructionUp);
    if(reference?.available)groundUp.fromArray(reference.matrix[2]);
    groundUp.normalize();
    groundMinimum=Infinity;
    const elevations=[];
    for(let i=0;i<positions.length;i+=3){const h=groundUp.x*positions[i]+groundUp.y*positions[i+1]+groundUp.z*positions[i+2];groundMinimum=Math.min(groundMinimum,h);if(i%Math.max(3,Math.ceil(positions.length/3/16384)*3)===0)elevations.push(h);}
    elevations.sort((a,b)=>a-b);groundAuto=elevations[Math.floor((elevations.length-1)*.02)]-groundMinimum;
    state.groundAuto=groundAuto;

  }
  updateGround(reference);
  const heights = cloudHeightValues(positions, heightAxis);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.append(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "3D viewer: WASD move, QE turn, ZC roll, RF rise/lower, Home fit, plus/minus zoom. Drag to orbit.");
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.mouseButtons.LEFT=THREE.MOUSE.PAN;
  controls.mouseButtons.RIGHT=THREE.MOUSE.ROTATE;
  const geo = new THREE.BufferGeometry();
  const colors = new Float32Array(positions.length);
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const center = geo.boundingBox.getCenter(new THREE.Vector3());
  const extent = geo.boundingBox.getSize(new THREE.Vector3());
  // Distant residual sky/outliers should not shrink the useful scene to a dot.
  if (positions.length >= 3000) {
    const axes = [[], [], []], step = Math.max(1, Math.ceil(positions.length / 3 / 8192));
    for (let i = 0; i < positions.length / 3; i += step) {
      for (let k = 0; k < 3; k++) axes[k].push(positions[i * 3 + k]);
    }
    const lo = [], hi = [];
    for (const axis of axes) {
      axis.sort((a, b) => a - b);
      lo.push(axis[Math.floor((axis.length - 1) * .02)]);
      hi.push(axis[Math.ceil((axis.length - 1) * .98)]);
    }
    center.fromArray(lo).add(new THREE.Vector3(...hi)).multiplyScalar(.5);
    extent.fromArray(hi).sub(new THREE.Vector3(...lo));
  }
  const span = Math.max(extent.length(), .01);
  const material = new THREE.PointsMaterial({ size: state.pointSize, vertexColors: true, sizeAttenuation: false });
  material.color.setScalar(state.brightness);
  const points = new THREE.Points(geo, material);
  scene.add(points);
  const classLegend=createClassLegend({host,labels,colors:classes,state});
  let cameraPanel=null;
  const representations=createCloudRepresentations({scene,host,positions,colors,sourceColors:rgb,points,state,onInfo:info=>{
    cameraPanel?.setGeometryInfo?.(info);
    if(host.dispatchEvent&&typeof CustomEvent!=='undefined')host.dispatchEvent(new CustomEvent('viewer-display-change',{detail:{mode:state.renderMode,densify:state.densify,info}}));
  }});
  const cameraOverlay = createCameraOverlay(cameras || [], span * .012);
  cameraOverlay.visible = state.camerasVisible;
  scene.add(cameraOverlay);
  const raycaster = new THREE.Raycaster();
  const measurement = createMeasurementOverlay({host,scene,positions});
  const controlPoints = createControlPointOverlay({host,positions,onPick: id => state.onControlPointPick?.(id)});
  const pickPoint = e => {
    const r=renderer.domElement.getBoundingClientRect();
    camera.updateMatrixWorld();
    raycaster.params.Points.threshold=Math.max(camera.position.distanceTo(controls.target)*2*Math.tan(camera.fov*Math.PI/360)/Math.max(r.height,1)*5,span/100000);
    raycaster.setFromCamera(new THREE.Vector2(2*(e.clientX-r.left)/r.width-1,1-2*(e.clientY-r.top)/r.height),camera);
    const rendered=representations.pickOriginal(raycaster,camera);
    if(rendered&&state.renderMode!=='points')return rendered.index;
    const hits=raycaster.intersectObject(points);
    hits.sort((a,b)=>(a.distanceToRay/Math.max(a.distance,1e-9))-(b.distanceToRay/Math.max(b.distance,1e-9))||a.distance-b.distance);
    const raw=hits.find(hit=>{
      const p=new THREE.Vector3().fromBufferAttribute(geo.attributes.position,hit.index).applyMatrix4(camera.matrixWorldInverse);
      return -p.z>=camera.near&&-p.z<=camera.far;
    });
    if(rendered&&(!raw||rendered.score<raw.distanceToRay/Math.max(raw.distance,1e-9)))return rendered.index;
    return raw?.index ?? null;
  };
  let toolDown=null;
  const startTool=e=>{if(e.button===0)toolDown={x:e.clientX,y:e.clientY,id:e.pointerId};};
  let standaloneMeasurement=[];
  const endTool=e=>{const down=toolDown;toolDown=null;if(e.button!==0||!down||down.id!==e.pointerId||Math.hypot(e.clientX-down.x,e.clientY-down.y)>4||!['control','measure','tag','photos'].includes(state.tool))return;const index=pickPoint(e);if(index!==null){
    if(state.onPointPick)state.onPointPick(index);else if(state.tool==='measure'){if(standaloneMeasurement.length===2)standaloneMeasurement=[];standaloneMeasurement.push(index);setMeasurement(standaloneMeasurement,reference?.scale_m_per_unit||state.depthScale||1);}
  }else{pickStatus.hidden=false;pickStatus.textContent='No surface here - click a visible point, mesh or photo cutout.';}};
  const cancelTool=()=>{toolDown=null;};
  renderer.domElement.addEventListener('pointerdown',startTool);
  renderer.domElement.addEventListener('pointerup',endTool);
  renderer.domElement.addEventListener('pointercancel',cancelTool);
  const identify = attachPointIdentify({
    host, canvas: renderer.domElement, getTool: () => state.tool,
    tooltip: createIdentifyTooltip(host),
    identify: async index => ({ label: labels[index] || "Unclassified", object_id: -1 }),
    pick: pickPoint,
  });
  const toolButtons=[];
  const toolstrip=document.createElement('div');toolstrip.className='viewer-toolstrip';toolstrip.setAttribute('role','group');toolstrip.setAttribute('aria-label','3D viewing tools');host.append(toolstrip);
  const toolIcons={identify:'<circle cx="12" cy="12" r="8"/><path d="M12 11v6m0-10v1"/>',measure:'<path d="m3 15 12-12 6 6L9 21zM6 12l3 3m0-6 3 3m0-6 3 3"/>',photos:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',tag:'<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="8" cy="8" r="1"/>'};
  const pickStatus=document.createElement('div');pickStatus.className='viewer-pick-status';pickStatus.setAttribute('role','status');pickStatus.hidden=true;host.append(pickStatus);
  for(const [tool,text,aria] of [['identify','Identify','Identify point class'],['measure','Measure','Measure in this 3D view'],['photos','Photos','Find source photos in this 3D view'],['tag','Tag','Tag a point in this 3D view']]){
    if(['photos','tag'].includes(tool)&&!['videoView','videoSecondView'].includes(host.id))continue;
    const button=document.createElement('button');button.type='button';button.className='viewer-direct-tool viewer-tool-'+tool;button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${toolIcons[tool]}</svg><span class="viewer-tool-label">${text}</span>`;button.setAttribute('aria-label',aria);button.title=aria;toolstrip.append(button);toolButtons.push({button,tool});
    if(tool==='identify')button.className+=' viewer-identify-button';
    button.onclick=()=>{state.tool=state.tool===tool?'orbit':tool;syncTool();if(host.dispatchEvent&&typeof CustomEvent!=='undefined')host.dispatchEvent(new CustomEvent('viewer-tool-change',{detail:{tool:state.tool}}));};
  }
  function syncTool(){identify.clear();toolButtons.forEach(({button,tool})=>button.setAttribute('aria-pressed',String(state.tool===tool)));}
  function setMeasurement(indices,scale=1){measurement.set(indices,true,scale);pickStatus.hidden=!indices.length;
    if(indices.length===1)pickStatus.textContent='Choose the second point.';
    else if(indices.length===2){const a=indices[0]*3,b=indices[1]*3,d=Math.hypot(positions[a]-positions[b],positions[a+1]-positions[b+1],positions[a+2]-positions[b+2])*scale;pickStatus.textContent=`Distance: ${d.toFixed(3)} ${state.metric||reference?.available?'m':'units'} / original samples`;}
  }
  syncTool();
  controls.addEventListener("start", identify.clear);
  function color() {
    if (state.colorMode === "distance" || state.colorMode === "height") {
      const distances = new Float32Array(positions.length / 3);
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < distances.length; i++) {
        const d = state.colorMode === "height" ? heights[i] : Math.hypot(positions[i*3]-camera.position.x, positions[i*3+1]-camera.position.y, positions[i*3+2]-camera.position.z);
        distances[i] = d; min = Math.min(min, d); max = Math.max(max, d);
      }
      const c = new THREE.Color();
      for (let i = 0; i < distances.length; i++) {
        const fraction=(distances[i]-min)/Math.max(max-min, 1e-9);
        c.setHSL((state.colorMode === "height" ? 1-fraction : fraction)*.66, .8, .55);
        colors.set([c.r,c.g,c.b], i*3);
      }
    } else colors.set(state.colorMode === "class" && classes ? classes : rgb);
    geo.attributes.color.needsUpdate = true;
    gaussianLayer?.setColorMode(state.colorMode, heightAxis);
    representations.updateColors();
    classLegend.refresh();
  }
  // These fit/top offsets and clipping planes are the other app's main
  // viewer implementation, using the full cloud's bounding-box diagonal.
  function enforceGround(){
    if(!state.groundBarrier)return;
    const level=state.groundLevel===null||!Number.isFinite(state.groundLevel)?groundAuto:state.groundLevel;
    const lift=groundMinimum+level+Math.max(span*1e-6,1e-7)-camera.position.dot(groundUp);
    if(lift>0){
      camera.position.addScaledVector(groundUp,lift);
      // WALK keeps its look direction; ORBIT continues looking at its target.
      if(state.navigationMode==='walk')controls.target.addScaledVector(groundUp,lift);
      else {camera.lookAt(controls.target);if(roll.angle)camera.rotateZ(roll.angle);}
      camera.updateMatrixWorld();
    }
  }
  function syncOrbitUp() {
    // The bundled OrbitControls caches world-up when constructed. Keep its
    // orbit basis in step when a preset or copied camera changes that up.
    controls._quat.setFromUnitVectors(camera.up,new THREE.Vector3(0,1,0));
    controls._quatInverse.copy(controls._quat).invert();
  }
  function fit(top = false) {
    cancelFlight(); keys.clear();
    identify.clear();
    controls.target.copy(center);
    const offset = new THREE.Vector3(top ? 0 : span*.45, top ? -span : span*-.35, top ? .0001 : span*-.65);
    if (basis) offset.applyQuaternion(basis);
    camera.position.copy(center).add(offset);
    camera.near = Math.max(span/10000, .00001);
    camera.far = span*100;
    camera.updateProjectionMatrix();
    roll.reset();applyCameraSettings();
  }
  function preset(name) {
    if(name === 'perspective') { camera.up.set(0,-1,0); if(basis) camera.up.applyQuaternion(basis); syncOrbitUp(); fit(); return; }
    const directions = {top:[0,-1,0],bottom:[0,1,0],down:[0,-1,0],left:[-1,0,0],right:[1,0,0],front:[0,0,-1],back:[0,0,1]};
    if(!directions[name]) return;
    cancelFlight(); keys.clear(); identify.clear(); roll.set(0);
    const direction = new THREE.Vector3(...directions[name]);
    const up = new THREE.Vector3(...(name==='top'||name==='down'?[0,0,1]:name==='bottom'?[0,0,-1]:[0,-1,0]));
    if(basis) {direction.applyQuaternion(basis);up.applyQuaternion(basis);}
    controls.target.copy(center);camera.up.copy(up);syncOrbitUp();
    camera.position.copy(center).addScaledVector(direction,span);
    camera.lookAt(center);camera.updateMatrixWorld();controls.update();
  }
  const roll = createViewRoll({ host, camera, controls, onNavigate: identify.clear });
  let flight = null, gaussianLayer = null;
  const keys = new Set();
  const getPose = () => ({position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), roll: roll.angle});
  function cancelFlight() {
    if (flight) { const resolve = flight.resolve; flight = null; controls.enabled = true; resolve(false); }
  }
  function flyTo(pose, duration = 1000) {
    cancelFlight(); keys.clear(); identify.clear();
    if(host.offsetParent===null){
      camera.position.fromArray(pose.position);controls.target.fromArray(pose.target);camera.up.fromArray(pose.up);syncOrbitUp();roll.set(pose.roll||0);applyCameraSettings();return Promise.resolve(true);
    }
    const from = getPose(); controls.enabled = false;
    return new Promise(resolve => { flight = {from, to: pose, elapsed: 0, duration: Math.max(1, duration), resolve}; });
  }
  function stepCamera(dt) {
    if (flight) {
      const f = flight; f.elapsed += dt * 1000;
      const t = Math.min(1, f.elapsed/f.duration), smooth = t*t*(3-2*t);
      camera.position.fromArray(f.from.position).lerp(new THREE.Vector3(...f.to.position), smooth);
      controls.target.fromArray(f.from.target).lerp(new THREE.Vector3(...f.to.target), smooth);
      camera.up.fromArray(f.from.up).lerp(new THREE.Vector3(...f.to.up), smooth).normalize();
      syncOrbitUp();
      // Remove the previous roll before setting the absolute interpolated orientation.
      roll.set(0); camera.lookAt(controls.target);
      const delta = Math.atan2(Math.sin(f.to.roll-f.from.roll), Math.cos(f.to.roll-f.from.roll));
      roll.set(f.from.roll + delta*smooth);
      if (t === 1) { flight = null; controls.enabled = true; f.resolve(true); }
    }
    if (!keys.size) return;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = camera.up.clone().normalize();
    const speed = span * .18 * dt * (keys.has("shift") ? 3 : 1);
    const offset = new THREE.Vector3();
    if (keys.has("w")) offset.addScaledVector(forward, speed);
    if (keys.has("s")) offset.addScaledVector(forward, -speed);
    if (keys.has("a")) offset.addScaledVector(right, -speed);
    if (keys.has("d")) offset.addScaledVector(right, speed);
    if (keys.has("r")) offset.addScaledVector(up, speed);
    if (keys.has("f")) offset.addScaledVector(up, -speed);
    camera.position.add(offset); controls.target.add(offset);
    const yaw = (Number(keys.has("q"))-Number(keys.has("e"))) * dt;
    if (yaw) controls.target.copy(camera.position).add(forward.applyAxisAngle(up, yaw).multiplyScalar(Math.max(span*.1, camera.position.distanceTo(controls.target))));
    const bank = (Number(keys.has("z"))-Number(keys.has("c"))) * dt;
    if (bank) roll.set(roll.angle + bank);
  }
  const navigation = createViewNavigation({ host, camera, controls, updateCamera: () => roll.update(), onNavigate: identify.clear });
  function resizeView() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
  }
  const resize = new ResizeObserver(resizeView);
  resize.observe(host);
  resizeView();
  let frame, previousTime = null;
  function loop(time = 0) {
    frame = requestAnimationFrame(loop);
    const dt = previousTime === null ? 1/60 : Math.min(.05, Math.max(0, (time-previousTime)/1000));
    previousTime = time;
    if (host.offsetParent === null) { keys.clear(); cancelFlight(); return; }
    stepCamera(dt);
    if (controls.enabled) roll.update();
    enforceGround();
    if (state.colorMode === "distance") color();
    gaussianLayer?.update(camera, renderer.domElement.height);
    measurement.update(camera); controlPoints.update(camera);
    renderer.render(scene, camera);
  }
  function zoomBy(factor) {
    identify.clear();
    roll.update();
    const offset = camera.position.clone().sub(controls.target);
    const distance = Math.max(camera.near*2, Math.min(camera.far*.8, offset.length()/factor));
    camera.position.copy(controls.target).add(offset.setLength(distance));
    roll.update();
  }
  function keydown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if ("wasdqezcrf".includes(key) && key.length === 1 || key === "shift") { cancelFlight(); identify.clear(); keys.add(key); }
    else if (e.key === "Home") { cancelFlight(); fit(); }
    else if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(.8);
    else return;
    e.preventDefault();
  }
  const keyup = e => keys.delete(e.key.toLowerCase());
  const blur = () => keys.clear();
  const pointerdown = () => { cancelFlight(); renderer.domElement.focus({preventScroll: true}); };
  let lookDrag=null;
  const startLook=e=>{if(state.navigationMode==='walk'&&e.button===0){lookDrag={x:e.clientX,y:e.clientY};renderer.domElement.setPointerCapture(e.pointerId);}};
  const look=e=>{if(!lookDrag||state.navigationMode!=='walk')return;const dx=e.clientX-lookDrag.x,dy=e.clientY-lookDrag.y;lookDrag={x:e.clientX,y:e.clientY};
    const direction=controls.target.clone().sub(camera.position),distance=direction.length(),up=camera.up.clone().normalize();
    direction.normalize().applyAxisAngle(up,-dx*.004);const right=new THREE.Vector3().crossVectors(direction,up).normalize(),pitched=direction.clone().applyAxisAngle(right,-dy*.004);
    if(Math.abs(pitched.dot(up))<.995)direction.copy(pitched);
    controls.target.copy(camera.position).add(direction.multiplyScalar(Math.max(distance,.01)));camera.lookAt(controls.target);
  };
  const stopLook=()=>lookDrag=null;
  renderer.domElement.addEventListener('pointerdown',startLook);renderer.domElement.addEventListener('pointermove',look);renderer.domElement.addEventListener('pointerup',stopLook);renderer.domElement.addEventListener('pointercancel',stopLook);
  function applyCameraSettings(){camera.fov=state.fov;controls.enableRotate=state.navigationMode!=='walk';
    controls.mouseButtons.LEFT=state.navigationMode==='walk'?THREE.MOUSE.ROTATE:THREE.MOUSE.PAN;
    controls.mouseButtons.RIGHT=state.navigationMode==='walk'?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;
    if(Number.isFinite(state.depthMax)){camera.near=Math.max(.001,state.depthMin/(state.depthScale||1));camera.far=Math.max(camera.near+.001,state.depthMax/(state.depthScale||1));}camera.updateProjectionMatrix();enforceGround();}
  cameraPanel=createViewerCameraControls({host,toolbar:toolstrip,state,span,apply:()=>{applyCameraSettings();applyDisplay();}});
  function applyDisplay(){
    if(state.renderMode==='gaussians'&&!gaussianLayer)state.renderMode='points';
    if(gaussianLayer)gaussianLayer.mesh.visible=state.renderMode==='gaussians';
    representations.update(true);cameraPanel.refresh();classLegend.refresh();
  }
  renderer.domElement.addEventListener("keydown", keydown);
  renderer.domElement.addEventListener("keyup", keyup);
  renderer.domElement.addEventListener("blur", blur);
  renderer.domElement.addEventListener("pointerdown", pointerdown);
  color(); fit(); applyCameraSettings();loop();
  return { fit, zoomBy, color, getPose, flyTo, cancelFlight, resetRoll: () => roll.reset(),
    preset,
    syncTool,
    setGroundReference(reference){updateGround(reference);enforceGround();},
    updateCameraSettings(){cameraPanel.refresh();applyCameraSettings();applyDisplay();},
    setPhotoSources(nextCameras,frames){representations.setSources(nextCameras,frames);cameraPanel.refresh();},
    getGeometryInfo:representations.getInfo,
    setMeasurement,
    setControlPoints: points => controlPoints.set(points),
    setGaussians(data) {
      if (gaussianLayer) { scene.remove(gaussianLayer.mesh); gaussianLayer.dispose(); }
      gaussianLayer = data ? createGaussianLayer(data) : null;
      if (gaussianLayer) { scene.add(gaussianLayer.mesh); gaussianLayer.setBrightness(state.brightness); gaussianLayer.setSize(state.pointSize/2); gaussianLayer.setColorMode(state.colorMode,heightAxis); }
      state.hasGaussians=!!gaussianLayer;applyDisplay();
    },
    setRenderMode(mode) {state.renderMode=mode;applyDisplay();},
    setDensify(multiplier){state.densify=Math.max(0,Math.min(1000,Number(multiplier)||0));applyDisplay();},
    setBrightness(value) { material.color.setScalar(value); gaussianLayer?.setBrightness(value);representations.setBrightness(value); },
    setCamerasVisible(visible) { cameraOverlay.visible = visible; },
    setSize(size) { material.size = size; gaussianLayer?.setSize(size/2);representations.setPointSize(size); }, clearIdentify: identify.clear,
    dispose() {
      cancelFlight(); gaussianLayer?.dispose();
      cancelAnimationFrame(frame);
      identify.dispose(); navigation.dispose(); roll.dispose();
      toolButtons.forEach(({button})=>button.remove());toolstrip.remove();pickStatus.remove();
      measurement.dispose(); controlPoints.dispose();
      cameraPanel.dispose();
      classLegend.dispose();
      representations.dispose();
      renderer.domElement.removeEventListener('pointerdown',startLook);renderer.domElement.removeEventListener('pointermove',look);renderer.domElement.removeEventListener('pointerup',stopLook);renderer.domElement.removeEventListener('pointercancel',stopLook);
      renderer.domElement.removeEventListener('pointerdown',startTool);
      renderer.domElement.removeEventListener('pointerup',endTool);
      renderer.domElement.removeEventListener('pointercancel',cancelTool);
      resize.disconnect(); controls.removeEventListener("start", identify.clear);
      controls.dispose(); geo.dispose(); material.dispose();
      cameraOverlay.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
      renderer.domElement.removeEventListener("keydown", keydown);
      renderer.domElement.removeEventListener("keyup", keyup);
      renderer.domElement.removeEventListener("blur", blur);
      renderer.domElement.removeEventListener("pointerdown", pointerdown);
      renderer.dispose(); renderer.domElement.remove();
    },
  };
}

// Adapter for this app's existing PLY, class colours, tools and exports.
export function createViewer(container, oldPopup) {
  let view = null;
  const state = { colorMode: "photo", pointSize: 2, brightness: 1, tool: "orbit", camerasVisible: true, navigationMode:'orbit',groundBarrier:false,groundLevel:null,groundAuto:0,fov:55,depthMin:0,depthMax:Infinity,depthScale:1,metric:false,
    renderMode:'points',densify:0,tinWireframe:false,mosaicOpacity:.85,mosaicBudget:64,hasPhotos:false,hasGaussians:false,classLegendOpen:false };
  if (oldPopup) oldPopup.hidden = true;
  return {
    setCloud(positions, rgb, classes, labels = [], votes = [], cameras = [], reference = null) {
      if (!positions.length) throw new Error("No point cloud to display");
      view?.dispose(); container.innerHTML = "";
      view = createCloudView(container, positions, rgb, classes, labels, votes, state, cameras, reference);
    },
    fitBounds() { view?.fit(); }, resetView() { view?.fit(); },
    topView() { view?.fit(true); }, resetRoll() { view?.resetRoll(); },
    zoomBy(factor) { view?.zoomBy(factor); },
    setTool(tool) { state.tool = tool; view?.syncTool(); },
    onPointPick(handler) { state.onPointPick = handler; },
    onControlPointPick(handler) { state.onControlPointPick = handler; },
    setPreset(name) { view?.preset(name); },
    setGroundReference(reference){view?.setGroundReference(reference);},
    getCameraSettings(){return Object.fromEntries(['navigationMode','groundBarrier','groundLevel','fov','depthMin','depthMax','depthScale','metric','renderMode','densify','tinWireframe','mosaicOpacity','mosaicBudget','pointSize','brightness','colorMode','camerasVisible','classLegendOpen'].map(key=>[key,state[key]]));},
    setCameraSettings(settings){for(const key of Object.keys(this.getCameraSettings()))if(settings[key]!==undefined)state[key]=settings[key];state.fov=Math.max(25,Math.min(110,Number(state.fov)||55));view?.updateCameraSettings();view?.setSize(state.pointSize);view?.setBrightness(state.brightness);view?.setCamerasVisible(state.camerasVisible);view?.color();},
    setMeasurement(indices, scale=1) { view?.setMeasurement(indices,scale); },
    setControlPoints(points) { view?.setControlPoints(points); },
    setColorMode(mode) { state.colorMode = mode; view?.color(); },
    setPointSize(mult) { state.pointSize = 2 * mult; view?.setSize(state.pointSize); },
    setBrightness(value) { state.brightness = Math.max(.25, Math.min(3, Number(value) || 1)); view?.setBrightness(state.brightness); },
    setGaussians(data) { view?.setGaussians(data); },
    setPhotoSources(cameras,frames) {view?.setPhotoSources(cameras,frames);},
    setDensify(multiplier){state.densify=Math.max(0,Math.min(1000,Number(multiplier)||0));view?.setDensify(state.densify);},
    getGeometryInfo(){return view?.getGeometryInfo()||null;},
    setRenderMode(mode) {state.renderMode=['points','tin','mosaic','gaussians'].includes(mode)?mode:'points';view?.setRenderMode(state.renderMode);},
    getPose() { return view?.getPose() || null; },
    flyTo(pose, duration) { return view?.flyTo(pose, duration) || Promise.resolve(false); },
    cancelFlight() { view?.cancelFlight(); },
    setCamerasVisible(visible) { state.camerasVisible = Boolean(visible); view?.setCamerasVisible(state.camerasVisible); },
    dispose() { view?.dispose(); view = null; container.innerHTML = ""; },
  };
}

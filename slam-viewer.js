// Port of SLAM-image-1/static/app.js main viewer. Camera, material,
// OrbitControls defaults, fit/top and render-loop behaviour follow that app.
// Its navigation/roll/identify modules and Three.js r180 are copied unchanged.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { createViewNavigation } from "./view-navigation.js";
import { createViewRoll } from "./view-roll.js";
import { attachPointIdentify } from "./point-identify.js";
import { createIdentifyTooltip } from "./viewer-annotations.js";

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

function createCloudView(host, positions, rgb, classes, labels, votes, state, cameras) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#101c2c");
  const camera = new THREE.PerspectiveCamera(55, 1, .001, 1000000);
  camera.up.set(0, -1, 0); // Unaligned COLMAP frame, as in SLAM-image-1.
  const q = cameras?.find(c => c.qvec?.length === 4)?.qvec;
  // COLMAP stores world-to-camera rotation, so invert it to orient the view.
  const basis = q ? new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize().invert() : null;
  if (basis) camera.up.applyQuaternion(basis);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.append(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute("aria-label", "3D viewer: drag to orbit, right-drag to pan, wheel to zoom, F to fit, R to reset roll");
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
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
  const points = new THREE.Points(geo, material);
  scene.add(points);
  const cameraOverlay = createCameraOverlay(cameras || [], span * .012);
  cameraOverlay.visible = state.camerasVisible;
  scene.add(cameraOverlay);
  const raycaster = new THREE.Raycaster();
  const identify = attachPointIdentify({
    host, canvas: renderer.domElement, getTool: () => state.tool,
    tooltip: createIdentifyTooltip(host),
    identify: async index => ({ label: labels[index] || "Unclassified", object_id: -1 }),
    pick: e => {
      const r = renderer.domElement.getBoundingClientRect();
      camera.updateMatrixWorld();
      raycaster.params.Points.threshold = Math.max(camera.position.distanceTo(controls.target) * 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(r.height, 1) * 5, span / 100000);
      raycaster.setFromCamera(new THREE.Vector2(2 * (e.clientX-r.left)/r.width-1, 1-2*(e.clientY-r.top)/r.height), camera);
      return raycaster.intersectObject(points)[0]?.index ?? null;
    },
  });
  controls.addEventListener("start", identify.clear);
  function color() {
    if (state.colorMode === "distance") {
      const distances = new Float32Array(positions.length / 3);
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < distances.length; i++) {
        const d = Math.hypot(positions[i*3]-camera.position.x, positions[i*3+1]-camera.position.y, positions[i*3+2]-camera.position.z);
        distances[i] = d; min = Math.min(min, d); max = Math.max(max, d);
      }
      const c = new THREE.Color();
      for (let i = 0; i < distances.length; i++) {
        c.setHSL((distances[i]-min)/Math.max(max-min, 1e-9)*.66, .8, .55);
        colors.set([c.r,c.g,c.b], i*3);
      }
    } else colors.set(state.colorMode === "class" && classes ? classes : rgb);
    geo.attributes.color.needsUpdate = true;
  }
  // These fit/top offsets and clipping planes are the other app's main
  // viewer implementation, using the full cloud's bounding-box diagonal.
  function fit(top = false) {
    identify.clear();
    controls.target.copy(center);
    const offset = new THREE.Vector3(top ? 0 : span*.45, top ? -span : span*-.35, top ? .0001 : span*-.65);
    if (basis) offset.applyQuaternion(basis);
    camera.position.copy(center).add(offset);
    camera.near = Math.max(span/10000, .00001);
    camera.far = span*100;
    camera.updateProjectionMatrix();
    roll.reset();
  }
  const roll = createViewRoll({ host, camera, controls, onNavigate: identify.clear });
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
  let frame;
  function loop() {
    frame = requestAnimationFrame(loop);
    if (host.offsetParent === null) return;
    if (controls.enabled) roll.update();
    if (state.colorMode === "distance") color();
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
    if (e.key.toLowerCase() === "f") fit();
    else if (e.key.toLowerCase() === "r") roll.reset();
    else if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(.8);
    else return;
    e.preventDefault();
  }
  renderer.domElement.addEventListener("keydown", keydown);
  color(); fit(); loop();
  return { fit, zoomBy, color, resetRoll: () => roll.reset(),
    setCamerasVisible(visible) { cameraOverlay.visible = visible; },
    setSize(size) { material.size = size; }, clearIdentify: identify.clear,
    dispose() {
      cancelAnimationFrame(frame);
      identify.dispose(); navigation.dispose(); roll.dispose();
      resize.disconnect(); controls.removeEventListener("start", identify.clear);
      controls.dispose(); geo.dispose(); material.dispose();
      cameraOverlay.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
      renderer.domElement.removeEventListener("keydown", keydown);
      renderer.dispose(); renderer.domElement.remove();
    },
  };
}

// Adapter for this app's existing PLY, class colours, tools and exports.
export function createViewer(container, oldPopup) {
  let view = null;
  const state = { colorMode: "photo", pointSize: 2, tool: "orbit", camerasVisible: true };
  if (oldPopup) oldPopup.hidden = true;
  return {
    setCloud(positions, rgb, classes, labels = [], votes = [], cameras = []) {
      if (!positions.length) throw new Error("No point cloud to display");
      view?.dispose(); container.innerHTML = "";
      view = createCloudView(container, positions, rgb, classes, labels, votes, state, cameras);
    },
    fitBounds() { view?.fit(); }, resetView() { view?.fit(); },
    topView() { view?.fit(true); }, resetRoll() { view?.resetRoll(); },
    zoomBy(factor) { view?.zoomBy(factor); },
    setTool(tool) { state.tool = tool; view?.clearIdentify(); },
    setColorMode(mode) { state.colorMode = mode; view?.color(); },
    setPointSize(mult) { state.pointSize = 2 * mult; view?.setSize(state.pointSize); },
    setCamerasVisible(visible) { state.camerasVisible = Boolean(visible); view?.setCamerasVisible(state.camerasVisible); },
    dispose() { view?.dispose(); view = null; container.innerHTML = ""; },
  };
}

// Port of SLAM-image-1/static/app.js main viewer. Camera, material,
// OrbitControls defaults, fit/top and render-loop behaviour follow that app.
// Its navigation/roll/identify modules and Three.js r180 are copied unchanged.
import * as THREE from "three";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { createViewNavigation } from "./view-navigation.js";
import { createViewRoll } from "./view-roll.js";
import { attachPointIdentify } from "./point-identify.js";
import { createIdentifyTooltip } from "./viewer-annotations.js";

function createCloudView(host, positions, rgb, classes, labels, votes, state) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#101c2c");
  const camera = new THREE.PerspectiveCamera(55, 1, .001, 1000000);
  camera.up.set(0, -1, 0); // Unaligned COLMAP frame, as in SLAM-image-1.
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
  const span = Math.max(geo.boundingBox.getSize(new THREE.Vector3()).length(), .01);
  const material = new THREE.PointsMaterial({ size: state.pointSize, vertexColors: true, sizeAttenuation: false });
  const points = new THREE.Points(geo, material);
  scene.add(points);
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
    camera.position.copy(center).add(new THREE.Vector3(top ? 0 : span*.45, top ? -span : span*-.35, top ? .0001 : span*-.65));
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
    setSize(size) { material.size = size; }, clearIdentify: identify.clear,
    dispose() {
      cancelAnimationFrame(frame);
      identify.dispose(); navigation.dispose(); roll.dispose();
      resize.disconnect(); controls.removeEventListener("start", identify.clear);
      controls.dispose(); geo.dispose(); material.dispose();
      renderer.domElement.removeEventListener("keydown", keydown);
      renderer.dispose(); renderer.domElement.remove();
    },
  };
}

// Adapter for this app's existing PLY, class colours, tools and exports.
export function createViewer(container, oldPopup) {
  let view = null;
  const state = { colorMode: "photo", pointSize: 2, tool: "orbit" };
  if (oldPopup) oldPopup.hidden = true;
  return {
    setCloud(positions, rgb, classes, labels = [], votes = []) {
      if (!positions.length) throw new Error("No point cloud to display");
      view?.dispose(); container.innerHTML = "";
      view = createCloudView(container, positions, rgb, classes, labels, votes, state);
    },
    fitBounds() { view?.fit(); }, resetView() { view?.fit(); },
    topView() { view?.fit(true); }, resetRoll() { view?.resetRoll(); },
    zoomBy(factor) { view?.zoomBy(factor); },
    setTool(tool) { state.tool = tool; view?.clearIdentify(); },
    setColorMode(mode) { state.colorMode = mode; view?.color(); },
    setPointSize(mult) { state.pointSize = 2 * mult; view?.setSize(state.pointSize); },
    dispose() { view?.dispose(); view = null; container.innerHTML = ""; },
  };
}

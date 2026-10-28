// 3D point-cloud viewers for /api/sfm results (loaded lazily via
// dynamic import, only after a reconstruction arrives, so the page
// opens with no console errors even when the three.js CDN is offline).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Small categorical palette for the labeled view.
const PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe",
  "#008080", "#e6beff", "#9a6324", "#fffac8", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075", "#808080",
];

function colorForLabel(label) {
  let h = 0;
  const s = String(label);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Parse the ASCII PLY the backend emits (x y z + uchar rgb) into
// {positions: Float32Array, colors: Float32Array (0..1), count}.
export function parsePly(text) {
  const lines = String(text).split("\n");
  const end = lines.indexOf("end_header");
  if (end < 0) throw new Error("PLY has no end_header");
  const n = parseInt(lines[2].split(/\s+/)[2], 10);
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = lines[end + 1 + i].trim().split(/\s+/).map(Number);
    positions[i * 3] = p[0]; positions[i * 3 + 1] = p[1]; positions[i * 3 + 2] = p[2];
    colors[i * 3] = (p[3] || 0) / 255;
    colors[i * 3 + 1] = (p[4] || 0) / 255;
    colors[i * 3 + 2] = (p[5] || 0) / 255;
  }
  return { positions, colors, count: n };
}

// Per-class colors for the labeled view: points in point_labels get
// their class color, the rest stay neutral grey.
export function labeledColors(count, pointLabels) {
  const out = new Float32Array(count * 3);
  const grey = new THREE.Color("#8a8a8a");
  for (let i = 0; i < count; i++) {
    const info = pointLabels[String(i)];
    const c = info ? new THREE.Color(colorForLabel(info.label)) : grey;
    out[i * 3] = c.r; out[i * 3 + 1] = c.g; out[i * 3 + 2] = c.b;
  }
  return out;
}

function softSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.7)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

// Render one cloud. container: element for the canvas; popup: bubble
// element positioned next to click; pointLabels: {index: {label,
// votes}} or null. Returns a handle with dispose().
export function renderCloud(container, popup, positions, colors, pointLabels) {
  const count = positions.length / 3;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#101418");
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1e7);

  // Frame the cloud: center + radius from the bounding sphere.
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    box.expandByPoint(v);
  }
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = Math.max(sphere.radius, 1e-6);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  const mat = new THREE.PointsMaterial({
    size: radius / 200,
    map: softSprite(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  camera.position.copy(center).add(new THREE.Vector3(radius * 1.2, radius * 0.8, radius * 1.6));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.update();

  function resize() {
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = radius / 100;

  function describe(i) {
    const info = pointLabels ? pointLabels[String(i)] : null;
    if (!info) return `point ${i} — no label`;
    let s = `${info.label} (point ${i}, ${info.votes} vote${info.votes === 1 ? "" : "s"})`;
    if (typeof info.score === "number") s += `, score ${info.score.toFixed(2)}`;
    return s;
  }

  function onClick(e) {
    // Canvas-relative mouse: the two viewers sit side by side, so
    // window-based coordinates would pick the wrong points.
    const r = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(points);
    if (!hits.length) { popup.hidden = true; return; }
    const i = hits[0].index;
    popup.textContent = describe(i);
    // Bubble next to the mouse, relative to the positioned wrap.
    const wrap = container.parentElement.getBoundingClientRect();
    popup.style.left = `${e.clientX - wrap.left + 12}px`;
    popup.style.top = `${e.clientY - wrap.top + 12}px`;
    popup.hidden = false;
  }
  renderer.domElement.addEventListener("click", onClick);

  let alive = true;
  (function loop() {
    if (!alive) return;
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();

  return {
    dispose() {
      alive = false;
      ro.disconnect();
      renderer.domElement.removeEventListener("click", onClick);
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      container.innerHTML = "";
    },
  };
}

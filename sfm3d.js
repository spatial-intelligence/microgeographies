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

// ---- Export builders (pure: positions/colors/labels arrays) --------

export function sampleIndex(count, pct) {
  const stride = Math.max(1, Math.round(100 / Math.max(1, Math.min(100, pct))));
  const idx = [];
  for (let i = 0; i < count; i += stride) idx.push(i);
  return idx;
}

function classMapOf(labels, idx) {
  const names = [];
  const seen = {};
  idx.forEach((i) => {
    const l = labels[i];
    if (l && !(l in seen)) { seen[l] = true; names.push(l); }
  });
  names.sort();
  const map = { "": -1 };
  names.forEach((l, k) => { map[l] = k; });
  return { names, map };
}

function u8(c) { return Math.max(0, Math.min(255, Math.round(c * 255))); }

export function buildXyzText(pos, col, labels, idx) {
  // "x y z r g b label" per line; label last so spaces are harmless.
  const lines = idx.map((i) => {
    const l = labels[i] || "unlabeled";
    return pos[i * 3] + " " + pos[i * 3 + 1] + " " + pos[i * 3 + 2] + " " +
      u8(col[i * 3]) + " " + u8(col[i * 3 + 1]) + " " + u8(col[i * 3 + 2]) +
      " " + l;
  });
  return lines.join("\n") + "\n";
}

export function buildPlyText(pos, col, labels, idx) {
  const { names, map } = classMapOf(labels, idx);
  const head = ["ply", "format ascii 1.0",
    "comment class_ids: " + names.map((l, k) => k + "=" + l).join(", "),
    "element vertex " + idx.length,
    "property float x", "property float y", "property float z",
    "property uchar red", "property uchar green", "property uchar blue",
    "property int class_id", "end_header"];
  idx.forEach((i) => {
    const l = labels[i] || "";
    head.push(pos[i * 3] + " " + pos[i * 3 + 1] + " " + pos[i * 3 + 2] + " " +
      u8(col[i * 3]) + " " + u8(col[i * 3 + 1]) + " " + u8(col[i * 3 + 2]) +
      " " + map[l]);
  });
  return head.join("\n") + "\n";
}

export function buildGeoJson(pos, col, labels, votes, idx) {
  // Local SfM frame (not geographic): flagged in a foreign member.
  const feats = idx.map((i) => ({
    type: "Feature",
    geometry: { type: "Point",
      coordinates: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] },
    properties: {
      label: labels[i] || "unlabeled",
      votes: votes[i] || 0,
      color: [u8(col[i * 3]), u8(col[i * 3 + 1]), u8(col[i * 3 + 2])]
    }
  }));
  return JSON.stringify({ type: "FeatureCollection", frame: "local-sfm",
    features: feats });
}

// One large viewer with toolbar tools and bottom drag strips.
// container: element for the canvas; popup: bubble positioned next
// to clicks in identify mode. Tools: "orbit" (navigate only) and
// "identify" (click pops the label bubble); color mode "photo"
// (reconstruction RGB), "class" (per-label colors) or "distance"
// (red near → blue far from the live camera position). The drag
// strips do nothing on hover — press and slide: top strip zooms,
// bottom strip pans, side strips roll the camera around the viewing
// axis from vertical slides (see dragZone). Left-drag orbits,
// right-drag pans. Point size scales with setPointSize.
// Returns a handle with setCloud / setTool / setColorMode /
// setPointSize / resetView / dragZone / dispose.
export function createViewer(container, popup) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.style.display = "block";
  renderer.domElement.style.width = "100%";
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#101418");
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1e7);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // Left-drag orbits, right-drag pans (OrbitControls also suppresses
  // the context menu on its element, so right-drag never opens one).
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };

  const raycaster = new THREE.Raycaster();
  let points = null;
  let radius = 1;
  let center = new THREE.Vector3();
  let tool = "identify";
  let colorMode = "photo";
  let photoColors = null;
  let classColors = null;
  let labelOf = [];
  let voteOf = [];
  let count = 0;
  let pointScale = 1; // user multiplier from the point-size slider
  let distColors = null; // Float32Array cache for distance mode
  let distScratch = null; // per-point distances, reused across updates

  function resize() {
    const w = Math.max(container.clientWidth, 1);
    const h = Math.max(container.clientHeight, 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);

  function frame() {
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const pos = points.geometry.getAttribute("position").array;
    for (let i = 0; i < count; i++) {
      v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      box.expandByPoint(v);
    }
    center = box.getCenter(new THREE.Vector3());
    radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-6);
    points.material.size = (radius / 200) * pointScale;
    raycaster.params.Points.threshold = radius / 100;
    camera.position.copy(center).add(
      new THREE.Vector3(radius * 1.2, radius * 0.8, radius * 1.6));
    controls.target.copy(center);
    controls.update();
    resize();
  }

  function setCloud(positions, colorsPhoto, colorsClass, labels, votes) {
    if (points) { scene.remove(points); points.geometry.dispose(); }
    count = positions.length / 3;
    photoColors = colorsPhoto;
    classColors = colorsClass;
    labelOf = labels || [];
    voteOf = votes || [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(
      colorMode === "class" && classColors ? classColors : photoColors, 3));
    geo.computeBoundingSphere();
    const mat = new THREE.PointsMaterial({
      size: 1,
      map: softSprite(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    });
    points = new THREE.Points(geo, mat);
    scene.add(points);
    distColors = null;
    distScratch = null;
    frame();
    applyColorMode();
    popup.hidden = true;
  }

  // Red-near → blue-far ramp (matches the page depth maps).
  const RAMP = [
    [0.00, 165, 0, 38], [0.20, 244, 109, 67], [0.40, 254, 224, 139],
    [0.60, 166, 217, 106], [0.80, 116, 173, 209], [1.00, 49, 54, 149],
  ];

  function rampColor(t, out, o) {
    const x = Math.min(1, Math.max(0, t));
    let a = RAMP[0], b = RAMP[RAMP.length - 1];
    for (let i = 0; i < RAMP.length - 1; i++) {
      if (x >= RAMP[i][0] && x <= RAMP[i + 1][0]) { a = RAMP[i]; b = RAMP[i + 1]; break; }
    }
    const span = (b[0] - a[0]) || 1;
    const k = (x - a[0]) / span;
    out[o] = (a[1] + (b[1] - a[1]) * k) / 255;
    out[o + 1] = (a[2] + (b[2] - a[2]) * k) / 255;
    out[o + 2] = (a[3] + (b[3] - a[3]) * k) / 255;
  }

  // Recolor by distance from the live camera position (t=0 near).
  // Min/max rescale every update so contrast holds as you move.
  function updateDistanceColors() {
    if (!points || !count) return;
    const pos = points.geometry.getAttribute("position").array;
    if (!distColors || distColors.length !== count * 3) {
      distColors = new Float32Array(count * 3);
    }
    if (!distScratch || distScratch.length !== count) {
      distScratch = new Float32Array(count);
    }
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < count; i++) {
      const dx = pos[i * 3] - cx, dy = pos[i * 3 + 1] - cy, dz = pos[i * 3 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      distScratch[i] = d;
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    const span = (mx - mn) || 1;
    for (let i = 0; i < count; i++) {
      rampColor((distScratch[i] - mn) / span, distColors, i * 3);
    }
    points.geometry.setAttribute("color",
      new THREE.BufferAttribute(distColors, 3));
  }

  function applyColorMode() {
    if (!points) return;
    if (colorMode === "class" && classColors) {
      points.geometry.setAttribute("color",
        new THREE.BufferAttribute(classColors, 3));
    } else if (colorMode === "distance") {
      updateDistanceColors();
    } else {
      points.geometry.setAttribute("color",
        new THREE.BufferAttribute(photoColors, 3));
    }
  }

  function setColorMode(m) {
    colorMode = m;
    applyColorMode();
  }

  function setPointSize(mult) {
    pointScale = Math.min(8, Math.max(0.1, Number(mult) || 1));
    if (points) points.material.size = (radius / 200) * pointScale;
  }

  // Drag-strip motion, applied per pointermove while pressed on a
  // strip — nothing moves on hover alone. dx/dy are pixel deltas
  // since the last event: pan grabs the scene, zoom slides right to
  // move in (left to move out), roll spins the camera around the
  // viewing axis from vertical slides (drag down to roll clockwise).
  // Scales derive from the cloud radius and viewport so small and
  // large scenes feel the same.
  function dragZone(move, dx, dy) {
    if (!points || (!dx && !dy)) return;
    const off = camera.position.clone().sub(controls.target);
    if (move === "roll") {
      if (!dy) return;
      const axis = off.clone().normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(axis, dy * 0.005);
      off.applyQuaternion(q);
      camera.position.copy(controls.target).add(off);
      camera.up.applyQuaternion(q);
    } else if (move === "pan") {
      const hPx = Math.max(renderer.domElement.clientHeight, 1);
      const wpp = (2 * off.length() *
        Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / hPx;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
      const step = right.multiplyScalar(-dx * wpp).addScaledVector(up, dy * wpp);
      camera.position.add(step);
      controls.target.add(step);
    } else if (move === "zoom") {
      const k = Math.exp(-dx * 0.005);
      const r = Math.min(Math.max(off.length() * k,
        controls.minDistance || radius * 0.05),
        controls.maxDistance || radius * 20);
      off.setLength(r);
      camera.position.copy(controls.target).add(off);
    }
    controls.update();
  }

  // Distance colors track the live camera while that mode is on.
  controls.addEventListener("change", () => {
    if (colorMode === "distance") updateDistanceColors();
  });

  function describe(i) {
    const l = labelOf[i];
    if (!l) return `point ${i} — no label`;
    let s = `${l} (point ${i})`;
    if (voteOf[i]) s += `, ${voteOf[i]} vote${voteOf[i] === 1 ? "" : "s"}`;
    return s;
  }

  let downAt = null;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    downAt = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    // Click (not drag) in identify mode pops the label bubble.
    // Non-left mouse buttons (e.g. right-drag pan) never identify.
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    popup.hidden = true;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (tool !== "identify" || moved > 6 || !points) return;
    const r = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObject(points);
    if (!hits.length) return;
    const i = hits[0].index;
    popup.textContent = describe(i);
    const wrap = (popup.offsetParent || container.parentElement).getBoundingClientRect();
    popup.style.left = `${e.clientX - wrap.left + 12}px`;
    popup.style.top = `${e.clientY - wrap.top + 12}px`;
    popup.hidden = false;
  });

  let alive = true;
  ro.observe(container);
  resize();
  (function loop() {
    if (!alive) return;
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();

  function resetView() {
    if (!points) return;
    popup.hidden = true;
    frame();
  }

  return {
    setCloud,
    setColorMode,
    setPointSize,
    resetView,
    setTool(m) { tool = m; if (m !== "identify") popup.hidden = true; },
    dragZone,
    dispose() {
      alive = false;
      ro.disconnect();
      renderer.dispose();
      container.innerHTML = "";
    },
  };
}

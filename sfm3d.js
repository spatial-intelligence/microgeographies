// 3D point-cloud viewers for /api/sfm results (loaded lazily via
// dynamic import, only after a reconstruction arrives, so the page
// opens with no console errors even when the three.js CDN is offline).
import * as THREE from "three";

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

// The runtime viewer is ported from SLAM-image-1; export helpers above stay unchanged.
export { createViewer } from "./slam-viewer.js";

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.MG_CONFIG || {};

  const fileInput = $("fileInput"), promptsInput = $("promptsInput"),
    gpsBtn = $("gpsBtn"), gpsOut = $("gpsOut"),
    endpointInput = $("endpointInput"), tokenInput = $("tokenInput"),
    mockCheck = $("mockCheck"), sendBtn = $("sendBtn"), statusOut = $("statusOut"),
    canvas = $("photoCanvas"), boxList = $("boxList"),
    rawOut = $("rawOut"), exportBtn = $("exportBtn");

  let imgEl = null, fileBlob = null, boxes = [], gps = null, lastRaw = {};

  // Secure-context note (geolocation needs HTTPS, localhost counts as secure).
  $("secureNote").textContent = window.isSecureContext
    ? "Secure context — GPS available."
    : "Not a secure context — GPS needs HTTPS (or localhost).";

  // Restore non-secret prefs; token lives in localStorage of this browser only.
  endpointInput.value = localStorage.getItem("mg.endpoint") || cfg.samEndpoint || "/api/sam";
  tokenInput.value = localStorage.getItem("mg.token") || "";
  promptsInput.value = cfg.defaultPrompts || "door, steps";
  mockCheck.checked = cfg.mockByDefault !== false;
  endpointInput.addEventListener("change", () => localStorage.setItem("mg.endpoint", endpointInput.value));
  tokenInput.addEventListener("change", () => localStorage.setItem("mg.token", tokenInput.value));

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileBlob = f;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => { imgEl = img; URL.revokeObjectURL(url); boxes = []; draw(); renderList(); };
    img.onerror = () => setStatus("Could not read that image.", true);
    img.src = url;
  });

  gpsBtn.addEventListener("click", () => {
    if (!("geolocation" in navigator)) { gpsOut.textContent = "Geolocation not supported."; return; }
    gpsOut.textContent = "Locating…";
    navigator.geolocation.getCurrentPosition(
      (p) => {
        gps = { lat: p.coords.latitude, lon: p.coords.longitude,
                accuracyM: p.coords.accuracy, at: new Date(p.timestamp).toISOString() };
        gpsOut.textContent = `Lat ${gps.lat.toFixed(6)}, lon ${gps.lon.toFixed(6)} (±${Math.round(gps.accuracyM)} m, ${gps.at})`;
      },
      (e) => { gpsOut.textContent = `Location failed: ${e.message}`; },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });

  sendBtn.addEventListener("click", async () => {
    if (!fileBlob) { setStatus("Pick a photo first.", true); return; }
    const prompts = promptsInput.value.split(",").map(s => s.trim()).filter(Boolean);
    if (!prompts.length) { setStatus("Enter at least one object prompt.", true); return; }
    setStatus("Sending…");
    try {
      const data = mockCheck.checked ? mockResult(prompts) : await postSam(fileBlob, prompts);
      lastRaw = data;
      rawOut.textContent = JSON.stringify(data, null, 2);
      boxes = normalizeBoxes(data, canvas.width, canvas.height);
      draw(); renderList(); exportBtn.disabled = boxes.length === 0;
      setStatus(`Done — ${boxes.length} box(es).`);
    } catch (e) {
      setStatus(`Error: ${e.message}`, true);
    }
  });

  async function postSam(blob, prompts) {
    const fd = new FormData();
    fd.append("image", blob);
    fd.append("prompts", JSON.stringify(prompts));
    if (gps) { fd.append("lat", String(gps.lat)); fd.append("lon", String(gps.lon)); }
    const headers = {};
    if (tokenInput.value) headers["Authorization"] = "Bearer " + tokenInput.value;
    const res = await fetch(endpointInput.value, { method: "POST", headers, body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  // Stand-in when there is no backend yet. Uses the real prompts as labels.
  function mockResult(prompts) {
    return new Promise((resolve) => setTimeout(() => resolve({
      mock: true,
      results: prompts.slice(0, 3).map((p, i) => ({
        label: p, score: 0.99 - i * 0.05,
        box: [0.1 + i * 0.12, 0.15 + i * 0.1, 0.45 + i * 0.12, 0.6 + i * 0.1]
      }))
    }), 400));
  }

  // Accept common detection shapes and reduce to pixel-space xyxy.
  // Supported items: {box|bbox|xyxy|xywh: [4 numbers], label, score},
  // {box: {xmin,ymin,xmax,ymax}} (HF style, 0..1 or 0..1000),
  // {boxes: [...], labels: [...], scores: [...]}, or a bare array.
  // An explicit item.format of "xyxy" or "xywh" always wins; otherwise
  // normalized values (all <= 1) read as xyxy when c > a and d > b,
  // and pixel values read as xyxy when they fit the image as corners.
  function normalizeBoxes(data, W, H) {
    let items = [];
    if (Array.isArray(data)) items = data;
    else if (data && typeof data === "object") {
      if (Array.isArray(data.results)) items = data.results;
      else if (Array.isArray(data.detections)) items = data.detections;
      else if (Array.isArray(data.predictions)) items = data.predictions;
      else if (Array.isArray(data.boxes)) {
        items = data.boxes.map((b, i) => ({
          box: b, label: (data.labels || [])[i], score: (data.scores || [])[i]
        }));
      }
    }
    const out = [];
    for (const it of items) {
      const fmt = String(it.format || "").toLowerCase();
      let coords = it.box ?? it.bbox ?? null;
      if (!coords && it.xyxy) coords = it.xyxy;
      if (!coords && it.xywh) coords = it.xywh;
      if (coords && !Array.isArray(coords) && coords.xmin !== undefined) {
        const m = Math.max(coords.xmin, coords.ymin, coords.xmax, coords.ymax);
        const s = m > 1 ? 1000 : 1; // HF uses a 0..1000 grid
        coords = [coords.xmin / s, coords.ymin / s, coords.xmax / s, coords.ymax / s];
      }
      if (!coords && it.xmin !== undefined) {
        const m = Math.max(it.xmin, it.ymin, it.xmax, it.ymax);
        const s = m > 1 ? 1000 : 1;
        coords = [it.xmin / s, it.ymin / s, it.xmax / s, it.ymax / s];
      }
      if (!Array.isArray(coords) || coords.length < 4) continue;
      const [a, b, c, d] = coords.map(Number);
      if (![a, b, c, d].every(Number.isFinite)) continue;
      let isXywh;
      if (fmt.includes("xywh")) isXywh = true;
      else if (fmt.includes("xyxy")) isXywh = false;
      else if (it.xywh !== undefined && it.xyxy === undefined) isXywh = true;
      else {
        const normalized = Math.max(a, b, c, d) <= 1 && Math.min(a, b) >= 0;
        if (normalized) isXywh = !(c > a && d > b);
        else isXywh = !(c > a && d > b && c <= W && d <= H);
      }
      let x1, y1, x2, y2;
      if (isXywh) { x1 = a; y1 = b; x2 = a + c; y2 = b + d; }
      else { x1 = a; y1 = b; x2 = c; y2 = d; }
      if (Math.max(x1, y1, x2, y2) <= 1 && Math.min(x1, y1) >= 0) {
        x1 *= W; y1 *= H; x2 *= W; y2 *= H;
      }
      out.push({ x1: clamp(Math.min(x1, x2), 0, W), y1: clamp(Math.min(y1, y2), 0, H),
                 x2: clamp(Math.max(x1, x2), 0, W), y2: clamp(Math.max(y1, y2), 0, H),
                 label: labelOf(it, out.length), score: scoreOf(it) });
    }
    return out;
  }

  function labelOf(it, i) { return it.label || it.name || it.class || it.category || `object ${i + 1}`; }
  function scoreOf(it) { const s = it.score ?? it.confidence ?? it.conf; return typeof s === "number" ? s : null; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function draw() {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!imgEl) return;
    const scale = Math.min(1, 640 / imgEl.naturalWidth);
    canvas.width = Math.round(imgEl.naturalWidth * scale);
    canvas.height = Math.round(imgEl.naturalHeight * scale);
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3; ctx.font = "16px system-ui, sans-serif";
    boxes.forEach((b, i) => {
      const hue = (i * 67) % 360;
      ctx.strokeStyle = `hsl(${hue} 90% 35%)`;
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      const tag = b.score == null ? b.label : `${b.label} ${(b.score * 100).toFixed(0)}%`;
      const w = ctx.measureText(tag).width + 12;
      ctx.fillStyle = `hsl(${hue} 90% 35%)`;
      ctx.fillRect(b.x1, Math.max(0, b.y1 - 22), w, 22);
      ctx.fillStyle = "#fff";
      ctx.fillText(tag, b.x1 + 6, Math.max(14, b.y1 - 6));
    });
  }

  function renderList() {
    boxList.innerHTML = "";
    if (!boxes.length) { boxList.innerHTML = '<li class="hint">No boxes.</li>'; return; }
    boxes.forEach((b) => {
      const li = document.createElement("li");
      li.textContent = b.score == null ? b.label
        : `${b.label} — ${(b.score * 100).toFixed(1)}% [${[b.x1, b.y1, b.x2, b.y2].map(v => Math.round(v)).join(", ")} px]`;
      boxList.appendChild(li);
    });
  }

  exportBtn.addEventListener("click", () => {
    const gj = { type: "FeatureCollection", features: boxes.map((b) => ({
      type: "Feature",
      geometry: gps ? { type: "Point", coordinates: [gps.lon, gps.lat] } : null,
      properties: { label: b.label, score: b.score,
        boxPx: [b.x1, b.y1, b.x2, b.y2].map(Math.round),
        photoGpsAccuracyM: gps ? gps.accuracyM : null,
        photoGpsAt: gps ? gps.at : null }
    })) };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(gj, null, 2)], { type: "application/geo+json" }));
    a.download = "microgeographies-results.geojson";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  function setStatus(msg, isErr) {
    statusOut.textContent = msg;
    statusOut.style.color = isErr ? "#b00020" : "";
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();

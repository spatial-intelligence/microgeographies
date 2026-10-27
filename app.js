(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.MG_CONFIG || {};

  const fileInput = $("fileInput"), promptsInput = $("promptsInput"),
    gpsBtn = $("gpsBtn"), gpsOut = $("gpsOut"),
    headingBtn = $("headingBtn"), headingOut = $("headingOut"),
    headingInput = $("headingInput"), hfovInput = $("hfovInput"),
    rangeInput = $("rangeInput"),
    endpointInput = $("endpointInput"), modelInput = $("modelInput"),
    tokenInput = $("tokenInput"),
    sendBtn = $("sendBtn"), statusOut = $("statusOut"),
    canvas = $("photoCanvas"), boxList = $("boxList"),
    depthImg = $("depthImg"), depthNote = $("depthNote"),
    rawOut = $("rawOut"), exportBtn = $("exportBtn"), pngBtn = $("pngBtn");

  let imgEl = null, fileBlob = null, boxes = [], gps = null, lastRaw = {};
  let sentSize = null; // pixel size of the image SAM actually saw
  let headingDeg = null; // compass bearing of the camera axis

  headingBtn.addEventListener("click", () => {
    if (!("DeviceOrientationEvent" in window)) {
      headingOut.textContent = "Compass not available — type the heading manually.";
      return;
    }
    const start = () => {
      headingOut.textContent = "Reading compass — hold the phone steady, pointing at the subject…";
      const handler = (e) => {
        let h = null, approx = false;
        if (e.webkitCompassHeading != null && e.webkitCompassHeading !== 0) {
          h = e.webkitCompassHeading; // iOS, true north
        } else if (e.alpha != null) {
          h = (360 - e.alpha) % 360; // Android; true north only when absolute
          approx = e.absolute !== true;
        }
        if (h == null || Number.isNaN(h)) return;
        window.removeEventListener("deviceorientationabsolute", handler);
        window.removeEventListener("deviceorientation", handler);
        headingDeg = Math.round(h * 10) / 10;
        headingInput.value = headingDeg;
        headingOut.textContent = `Heading ${headingDeg}°${approx ? " (relative — may not be true north)" : ""}.`;
      };
      window.addEventListener("deviceorientationabsolute", handler);
      window.addEventListener("deviceorientation", handler);
      setTimeout(() => {
        window.removeEventListener("deviceorientationabsolute", handler);
        window.removeEventListener("deviceorientation", handler);
        if (headingDeg == null) headingOut.textContent = "No compass reading — type the heading manually.";
      }, 8000);
    };
    // iOS needs an explicit permission gesture.
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission().then((r) => {
        if (r === "granted") start();
        else headingOut.textContent = "Compass permission denied — type the heading manually.";
      }).catch(() => { headingOut.textContent = "Compass failed — type the heading manually."; });
    } else {
      start();
    }
  });
  headingInput.addEventListener("change", () => {
    const v = parseFloat(headingInput.value);
    headingDeg = Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
    if (headingDeg != null) headingOut.textContent = `Heading ${headingDeg}° (manual).`;
  });

  function currentHeading() {
    const v = parseFloat(headingInput.value);
    if (Number.isFinite(v)) return ((v % 360) + 360) % 360;
    return headingDeg;
  }

  // Secure-context note (geolocation needs HTTPS, localhost counts as secure).
  $("secureNote").textContent = window.isSecureContext
    ? "Secure context — GPS available."
    : "Not a secure context — GPS needs HTTPS (or localhost).";

  // Restore non-secret prefs; token lives in localStorage of this browser only.
  endpointInput.value = localStorage.getItem("mg.endpoint") || cfg.samEndpoint || "/api/sam";
  modelInput.value = localStorage.getItem("mg.model") || cfg.metaModel || "sam-3.1";
  tokenInput.value = localStorage.getItem("mg.token") || "";
  promptsInput.value = cfg.defaultPrompts || "door, steps";
  endpointInput.addEventListener("change", () => localStorage.setItem("mg.endpoint", endpointInput.value));
  modelInput.addEventListener("change", () => localStorage.setItem("mg.model", modelInput.value));
  tokenInput.addEventListener("change", () => localStorage.setItem("mg.token", tokenInput.value));

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileBlob = f;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      imgEl = img; URL.revokeObjectURL(url); boxes = []; sentSize = null;
      exportBtn.disabled = true; pngBtn.disabled = true;
      draw(); renderList();
    };
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
      const data = await postSam(fileBlob, prompts);
      lastRaw = data;
      rawOut.textContent = JSON.stringify(data, null, 2);
      // Meta returns pixels in the sent image, but the canvas may differ
      // in size — normalize at sent size, then scale to the canvas.
      let NW = canvas.width, NH = canvas.height, rescale = 1;
      if (data.meta && data.sentW) {
        NW = data.sentW; NH = data.sentH;
        rescale = canvas.width / NW;
      }
      boxes = normalizeBoxes(data, NW, NH);
      if (rescale !== 1) boxes.forEach((b) => {
        b.x1 *= rescale; b.x2 *= rescale; b.y1 *= rescale; b.y2 *= rescale;
      });
      sentSize = (data.meta && data.sentW)
        ? { w: data.sentW, h: data.sentH }
        : { w: canvas.width, h: canvas.height };
      // Meta-direct boxes carry no geo: run them through the Python
      // backend projector (depth + heading + OSM snap) when possible.
      let extra = "";
      if (data.meta) extra = await projectMetaBoxes(data);
      else { extra = gpsNote(data.gps_source); showDepth(data.depth_png); }
      draw(); renderList();
      exportBtn.disabled = boxes.length === 0;
      pngBtn.disabled = boxes.length === 0;
      if (data.meta && data.results.length > boxes.length) {
        setStatus(`Done — ${boxes.length} box(es) drawn (${data.results.length - boxes.length} dropped as invalid).`);
      } else {
        setStatus(`Done — ${boxes.length} box(es).`);
      }
      if (extra) setStatus(statusOut.textContent + extra);
    } catch (e) {
      setStatus(`Error: ${e.message}`, true);
    }
  });

  function isMetaEndpoint(url) { return /api\.meta\.ai/i.test(url); }

  async function postSam(blob, prompts) {
    if (isMetaEndpoint(endpointInput.value)) return postSamMeta(blob, prompts);
    // Generic detector-style backend: multipart image + JSON prompts.
    const fd = new FormData();
    fd.append("image", blob);
    fd.append("prompts", JSON.stringify(prompts));
    if (gps) { fd.append("lat", String(gps.lat)); fd.append("lon", String(gps.lon)); }
    const hdg = currentHeading();
    if (hdg != null) fd.append("heading", String(hdg));
    fd.append("hfov", hfovInput.value || "60");
    fd.append("max_range", rangeInput.value || "30");
    const headers = {};
    if (tokenInput.value) headers["Authorization"] = "Bearer " + tokenInput.value;
    const res = await fetch(endpointInput.value, { method: "POST", headers, body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  function gpsNote(src) {
    if (src === "exif") return " Location came from the photo EXIF.";
    if (src === "none") return " No location — projection skipped.";
    return "";
  }

  // Project Meta-direct boxes to approx map pins via the Python backend
  // (/api/project on the same origin). Boxes are rescaled to the
  // uploaded original's pixels first; results merge back by index.
  // Absence of a backend (static hosting) is not an error — boxes stay.
  // Returns a status suffix ("" when nothing to report).
  async function projectMetaBoxes(data) {
    const hdg = currentHeading();
    if (hdg == null) return " No heading — projection skipped.";
    if (!imgEl || !data.sentW) return "";
    const k = imgEl.naturalWidth / canvas.width; // canvas px -> uploaded-original px
    const payload = boxes.map((b) => ({
      label: b.label,
      box: [b.x1 * k, b.y1 * k, b.x2 * k, b.y2 * k].map(Math.round),
      score: b.score,
    }));
    const fd = new FormData();
    fd.append("image", fileBlob);
    fd.append("boxes", JSON.stringify(payload));
    if (gps) { fd.append("lat", String(gps.lat)); fd.append("lon", String(gps.lon)); }
    fd.append("heading", String(hdg));
    fd.append("hfov", hfovInput.value || "60");
    fd.append("max_range", rangeInput.value || "30");
    let res;
    try {
      res = await fetch("/api/project", { method: "POST", body: fd });
    } catch (e) {
      return " Projection backend unreachable — boxes only.";
    }
    if (!res.ok) return " Projection failed — boxes only.";
    const proj = await res.json();
    showDepth(proj.depth_png);
    (proj.detections || []).forEach((d, i) => {
      if (!boxes[i]) return;
      if (d.geo) boxes[i].geo = d.geo;
      if (d.snapped) boxes[i].snapped = d.snapped;
      if (d.geo_error) boxes[i].geo_error = d.geo_error;
    });
    const n = (proj.detections || []).filter((d) => d.geo).length;
    return gpsNote(proj.gps_source) + (n ? ` ${n} pin(s) projected.` : "");
  }

  // Meta Responses API, matching the proven Colab shape: one request per
  // concept, image sent once as a data URL, boxes pulled from each reply.
  async function postSamMeta(blob, prompts) {
    if (!tokenInput.value) throw new Error("Paste your Meta API key into the Token field first.");
    if (!imgEl) throw new Error("Pick a photo first.");
    // Phone photos are huge and sometimes odd formats — normalize to a
    // bounded JPEG so the API gets what it accepts. Boxes come back in
    // these sent dimensions (recorded for rescaling).
    const sent = prepareImage(imgEl, 1600);
    const imageDataUrl = sent.dataUrl;
    const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + tokenInput.value };
    const all = [];
    let n = 0;
    for (const concept of prompts) {
      setStatus(`Asking SAM about "${concept}" (${++n}/${prompts.length})…`);
      const body = {
        model: modelInput.value.trim(),
        stream: false,
        input: [{
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: concept },
            { type: "input_image", image_url: imageDataUrl }
          ]
        }]
      };
      let res;
      try {
        res = await fetch(endpointInput.value, {
          method: "POST", headers, body: JSON.stringify(body)
        });
      } catch (e) {
        throw new Error(`Network/CORS failure calling Meta directly (${e.message}). ` +
          `Use "/api/sam" with server/proxy.mjs forwarding to ${endpointInput.value} instead.`);
      }
      if (!res.ok) throw new Error(`Meta HTTP ${res.status} on "${concept}": ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      for (const b of extractBoxesFromMeta(data, concept)) all.push(b);
    }
    return { meta: true, results: all, sentW: sent.w, sentH: sent.h };
  }

  // Draw the image into an offscreen canvas capped at maxDim on the long
  // edge and export JPEG. Returns { dataUrl, w, h } of what was sent.
  function prepareImage(img, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    return { dataUrl: c.toDataURL("image/jpeg", 0.85), w, h };
  }

  // Proven sam-3.1 reply shape: output items with type "message"
  // carry content items with type "output_text", whose text holds tokens
  // like <|box;x1=..;y1=..;x2=..;y2=..|><|mask;…;data=H,W,payload|>.
  // Boxes are integer pixels in the original image. Mask payloads are
  // kept for later decoding (see README) but not drawn.
  function extractBoxesFromMeta(data, fallbackLabel) {
    let text = "";
    if (typeof data.output_text === "string") text += data.output_text;
    for (const o of data.output || []) {
      if (o.type && o.type !== "message") continue;
      for (const c of o.content || []) {
        if ((!c.type || c.type === "output_text") && typeof c.text === "string") text += c.text;
      }
    }
    const out = [];
    const REC = /<\|box;(.*?)\|><\|mask;(.*?)\|>/gs;
    let m;
    while ((m = REC.exec(text)) !== null) {
      const b = kv(m[1]);
      const box = [b.x1, b.y1, b.x2, b.y2].map(Number);
      if (!box.every(Number.isFinite)) continue;
      let maskH = null, maskW = null, maskPayload = null;
      const at = m[2].indexOf("data=");
      if (at >= 0) {
        const parts = m[2].slice(at + 5).split(",");
        if (parts.length >= 3) {
          maskH = parseInt(parts[0], 10); maskW = parseInt(parts[1], 10);
          maskPayload = parts.slice(2).join(",");
        }
      }
      out.push({ label: fallbackLabel, box, format: "xyxy", maskH, maskW, maskPayload });
    }
    return out;
  }

  function kv(s) {
    const o = {};
    for (const p of String(s).split(";")) {
      const i = p.indexOf("=");
      if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
    return o;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("Could not read image."));
      r.readAsDataURL(blob);
    });
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
                 label: labelOf(it, out.length), score: scoreOf(it),
                 maskH: it.maskH ?? null, maskW: it.maskW ?? null,
                 maskPayload: it.maskPayload ?? null,
                 geo: it.geo ?? null, snapped: it.snapped ?? null,
                 geo_error: it.geo_error ?? null });
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
    paintBoxes(ctx, boxes, canvas.width);
  }

  // Draws labelled boxes on any 2D context. Line widths and text scale
  // with the render width so exports stay legible at any resolution.
  function paintBoxes(ctx, list, W) {
    ctx.lineWidth = Math.max(2, Math.round(W / 220));
    const fs = Math.max(12, Math.round(W / 40));
    ctx.font = `${fs}px system-ui, sans-serif`;
    list.forEach((b, i) => {
      const hue = (i * 67) % 360;
      ctx.strokeStyle = `hsl(${hue} 90% 35%)`;
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      const tag = b.score == null ? b.label : `${b.label} ${(b.score * 100).toFixed(0)}%`;
      const w = ctx.measureText(tag).width + fs * 0.75;
      const th = fs * 1.4;
      ctx.fillStyle = `hsl(${hue} 90% 35%)`;
      ctx.fillRect(b.x1, Math.max(0, b.y1 - th), w, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(tag, b.x1 + fs * 0.35, Math.max(fs, b.y1 - th * 0.28));
    });
  }

  // Full-resolution export: re-renders the photo at the size SAM saw it
  // with the boxes scaled up, then downloads a PNG.
  pngBtn.addEventListener("click", () => {
    if (!imgEl || !boxes.length || !sentSize) return;
    const c = document.createElement("canvas");
    c.width = sentSize.w; c.height = sentSize.h;
    const ctx = c.getContext("2d");
    ctx.drawImage(imgEl, 0, 0, c.width, c.height);
    const k = c.width / canvas.width;
    paintBoxes(ctx, boxes.map((b) => ({
      ...b, x1: b.x1 * k, y1: b.y1 * k, x2: b.x2 * k, y2: b.y2 * k
    })), c.width);
    c.toBlob((blob) => {
      if (!blob) { setStatus("Image export failed.", true); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "microgeographies-annotated.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  });

  // Preferred map pin for a box: OSM-snapped outline point, else the
  // depth-projected point, else the camera location, else nothing.
  function pinOf(b) {
    if (b.snapped) return { lon: b.snapped.lon, lat: b.snapped.lat, kind: "snapped" };
    if (b.geo) return { lon: b.geo.lon, lat: b.geo.lat, kind: "projected" };
    if (gps) return { lon: gps.lon, lat: gps.lat, kind: "camera" };
    return null;
  }

  function osmUrl(lat, lon) {
    return `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=19/${lat.toFixed(6)}/${lon.toFixed(6)}`;
  }

  function renderList() {
    boxList.innerHTML = "";
    if (!boxes.length) { boxList.innerHTML = '<li class="hint">No boxes.</li>'; return; }
    boxes.forEach((b) => {
      const li = document.createElement("li");
      const coords = `[${[b.x1, b.y1, b.x2, b.y2].map(v => Math.round(v)).join(", ")} px]`;
      const score = b.score == null ? "" : ` — ${(b.score * 100).toFixed(1)}%`;
      const mask = b.maskPayload ? " +mask" : "";
      li.textContent = `${b.label}${score} ${coords}${mask}`;
      if (b.geo) {
        const pin = pinOf(b);
        const span = document.createElement("span");
        const px = b.geo.pixel ? `pixel (${b.geo.pixel.x}, ${b.geo.pixel.y})` : "pixel ?";
        const enu = b.geo.enu_m
          ? `x ${b.geo.enu_m.x} m E, y ${b.geo.enu_m.y} m N, z ${b.geo.enu_m.z} m up`
          : "x/y/z ?";
        span.textContent = ` approx ${b.geo.lat.toFixed(6)}, ${b.geo.lon.toFixed(6)}` +
          ` (${b.geo.distance_m.toFixed(1)} m @ ${b.geo.bearing_deg.toFixed(1)}°)` +
          (b.snapped ? " — on building outline" : "");
        li.appendChild(document.createElement("br"));
        li.appendChild(span);
        const sub = document.createElement("span");
        sub.textContent = ` ${px} → ${enu} (from camera)`;
        li.appendChild(document.createElement("br"));
        li.appendChild(sub);
        const a = document.createElement("a");
        a.href = osmUrl(pin.lat, pin.lon);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = pin.kind === "snapped" ? "OpenStreetMap pin (snapped)" : "OpenStreetMap pin";
        li.appendChild(document.createTextNode(" "));
        li.appendChild(a);
      } else if (b.geo_error) {
        const span = document.createElement("span");
        span.textContent = ` no pin: ${b.geo_error}`;
        li.appendChild(document.createElement("br"));
        li.appendChild(span);
      }
      boxList.appendChild(li);
    });
  }

  exportBtn.addEventListener("click", () => {
    const hdg = currentHeading();
    const gj = { type: "FeatureCollection", features: boxes.map((b) => {
      const pin = pinOf(b);
      return {
        type: "Feature",
        geometry: pin ? { type: "Point", coordinates: [pin.lon, pin.lat] } : null,
        properties: { label: b.label, score: b.score,
          pinKind: pin ? pin.kind : null, // snapped | projected | camera
          geo: b.geo ?? null, snapped: b.snapped ?? null,
          cameraHeadingDeg: hdg,
          boxPx: [b.x1, b.y1, b.x2, b.y2].map(Math.round),
          maskH: b.maskH, maskW: b.maskW, maskPayload: b.maskPayload,
          photoGpsAccuracyM: gps ? gps.accuracyM : null,
          photoGpsAt: gps ? gps.at : null }
      };
    }) };
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

  function showDepth(dataUrl) {
    if (!dataUrl) return;
    depthImg.src = dataUrl;
    depthImg.hidden = false;
    depthNote.textContent = "Monocular depth — blue far, red near. Warm areas are closer to the camera.";
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();

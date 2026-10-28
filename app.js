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
    mapNote = $("mapNote"),
    rawOut = $("rawOut"), exportBtn = $("exportBtn"), pngBtn = $("pngBtn"),
    reprojectBtn = $("reprojectBtn");

  let map = null, mapLayers = null;

  let imgEl = null, fileBlob = null, boxes = [], gps = null, lastRaw = {};
  let origBoxes = []; // last SAM boxes in uploaded-original pixels, for re-projection
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

  // EXIF preview at load time: says what the photo carries and what the
  // backend will therefore use, before anything is sent.
  function previewExif(file) {
    exifOut.textContent = "Reading photo metadata…";
    if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name || "")) {
      exifOut.textContent = "HEIC photo — direction/location tags can't be read here. Convert to JPEG first, or use live GPS + manual heading.";
      return;
    }
    file.arrayBuffer().then((buf) => {
      const ex = window.MG_EXIF ? window.MG_EXIF.parseGPS(buf) : null;
      if (!ex || !ex.hasExif) {
        exifOut.textContent = "No EXIF in this photo (screenshot, PNG, or stripped upload) — the live fix will be used. Press Get GPS location, and capture or type the heading.";
        return;
      }
      const bits = [];
      if (ex.lat != null && ex.lon != null) bits.push(`location ${ex.lat.toFixed(6)}, ${ex.lon.toFixed(6)}`);
      if (ex.heading != null) bits.push(`heading ${ex.heading}°`);
      if (!bits.length) {
        exifOut.textContent = "Photo has EXIF but no GPS location — the live fix will be used. Press Get GPS location, and capture or type the heading.";
        return;
      }
      const used = [];
      if (ex.lat != null) used.push("location");
      if (ex.heading != null && currentHeading() == null) used.push("heading");
      exifOut.textContent = `Photo EXIF holds ${bits.join(" + ")} — will be used (${used.join(" + ")}), not this computer's.`;
    }).catch(() => {
      exifOut.textContent = "Could not read photo metadata — the live fix will be used.";
    });
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

  const exifOut = $("exifOut");
  const manualLat = $("manualLat"), manualLon = $("manualLon");

  // Typed correction wins over everything (photo EXIF and button fix).
  function currentManual() {
    const la = parseFloat(manualLat.value), lo = parseFloat(manualLon.value);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
    return { lat: la, lon: lo };
  }

  function locationFields(fd) {
    const m = currentManual();
    if (m) {
      fd.append("lat", String(m.lat));
      fd.append("lon", String(m.lon));
      fd.append("prefer", "manual");
    } else if (gps) {
      fd.append("lat", String(gps.lat));
      fd.append("lon", String(gps.lon));
    }
  }

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileBlob = f;
    previewExif(f);
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      imgEl = img; URL.revokeObjectURL(url); boxes = []; sentSize = null;
      origBoxes = [];
      exportBtn.disabled = true; pngBtn.disabled = true; reprojectBtn.disabled = true;
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
    // MobileNet finds its own fixed vocabulary — prompts are ignored.
    if (!prompts.length && samBackend() !== "mobilenet") { setStatus("Enter at least one object prompt.", true); return; }
    setStatus("Sending…");
    try {
      const data = await postSam(fileBlob, prompts);
      lastRaw = data;
      rawOut.textContent = JSON.stringify(data, null, 2);
      // Meta, browser-local SAM and MobileNet return pixels in the sent
      // image, but the canvas may differ in size — normalize at sent
      // size, then scale to the canvas.
      const direct = data.meta || data.browser || data.mobilenet;
      let NW = canvas.width, NH = canvas.height, rescale = 1;
      if (direct && data.sentW) {
        NW = data.sentW; NH = data.sentH;
        rescale = canvas.width / NW;
      } else if (imgEl) {
        // Backend boxes are full-upload pixels: normalize there, then
        // scale down to the canvas.
        NW = imgEl.naturalWidth; NH = imgEl.naturalHeight;
        rescale = canvas.width / NW;
      }
      boxes = normalizeBoxes(data, NW, NH);
      if (rescale !== 1) boxes.forEach((b) => {
        b.x1 *= rescale; b.x2 *= rescale; b.y1 *= rescale; b.y2 *= rescale;
      });
      sentSize = (direct && data.sentW)
        ? { w: data.sentW, h: data.sentH }
        : { w: canvas.width, h: canvas.height };
      draw(); renderList(); // SAM boxes on screen immediately
      // Direct boxes carry no geo: run them through the Python backend
      // projector (depth + heading + OSM snap) when possible.
      let extra = "";
      if (direct) {
        setStatus(`SAM finished — ${boxes.length} box(es). Starting depth processing…`);
        extra = await projectMetaBoxes(data);
      }
      else {
        setStatus(`SAM finished — ${boxes.length} box(es). Starting depth processing…`);
        extra = gpsNote(data.gps_source) + headingNote(data); showDepth(data.depth_png);
        origBoxes = rawDetections(data); // backend boxes are already original-px
      }
      draw(); renderList();
      exportBtn.disabled = boxes.length === 0;
      pngBtn.disabled = boxes.length === 0;
      reprojectBtn.disabled = origBoxes.length === 0;
      if (direct && data.results.length > boxes.length) {
        setStatus(`Done — ${boxes.length} box(es) drawn (${data.results.length - boxes.length} dropped as invalid).`);
      } else {
        setStatus(`Done — ${boxes.length} box(es).`);
      }
      if (extra) setStatus(statusOut.textContent + extra);
      renderMap();
    } catch (e) {
      setStatus(`Error: ${e.message}`, true);
    }
  });

  function isMetaEndpoint(url) { return /api\.meta\.ai/i.test(url); }

  function samBackend() {
    const el = document.querySelector('input[name="samBackend"]:checked');
    return el ? el.value : "api";
  }

  async function postSam(blob, prompts) {
    if (samBackend() === "browser") return postSamLocal(blob, prompts);
    if (samBackend() === "clip") return postSamClip(blob, prompts);
    if (samBackend() === "mobilenet") return postSamMobileNet();
    if (isMetaEndpoint(endpointInput.value)) return postSamMeta(blob, prompts);
    // Generic detector-style backend: multipart image + JSON prompts.
    const fd = new FormData();
    fd.append("image", blob);
    fd.append("prompts", JSON.stringify(prompts));
    locationFields(fd);
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
    if (src === "manual") return " Location uses your typed correction.";
    if (src === "none") return " No location — projection skipped.";
    return "";
  }

  // Project Meta-direct boxes to approx map pins via the Python backend
  // (/api/project on the same origin). Boxes are rescaled to the
  // uploaded original's pixels first; results merge back by index.
  // Absence of a backend (static hosting) is not an error — boxes stay.
  // Returns a status suffix ("" when nothing to report).
  async function projectMetaBoxes(data) {
    // No manual heading is fine: the backend falls back to the photo's
    // EXIF direction when present.
    const hdg = currentHeading();
    if (!imgEl || !data.sentW) return "";
    const k = imgEl.naturalWidth / canvas.width; // canvas px -> uploaded-original px
    const payload = boxes.map((b) => ({
      label: b.label,
      box: [b.x1 * k, b.y1 * k, b.x2 * k, b.y2 * k].map(Math.round),
      score: b.score,
    }));
    origBoxes = payload; // stored for heading-free re-projection
    const fd = new FormData();
    fd.append("image", fileBlob);
    fd.append("boxes", JSON.stringify(payload));
    locationFields(fd);
    if (hdg != null) fd.append("heading", String(hdg));
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
    return gpsNote(proj.gps_source) + headingNote(proj) +
      (n ? ` ${n} pin(s) projected.`
         : (proj.heading_source === "none" ? " No heading — projection skipped." : ""));
  }

  function headingNote(proj) {
    if (proj.heading_source === "exif" && proj.heading_deg != null) {
      if (!headingInput.value) headingOut.textContent = `Heading ${proj.heading_deg}° (from photo EXIF).`;
      return ` Heading ${proj.heading_deg}° from photo EXIF.`;
    }
    return "";
  }

  // Browser MobileNet (coco-ssd, MobileNetV2 backbone): a fixed ~80-kind
  // vocabulary (person, car, chair, …), so prompts are ignored. Boxes
  // come back in sent-image pixels, like the other direct paths.
  async function postSamMobileNet() {
    if (!window.MG_MOBILE) throw new Error("mobilenet.js failed to load.");
    if (!imgEl) throw new Error("Pick a photo first.");
    setStatus("Loading MobileNet (one-time few-MB download, then offline)…");
    await window.MG_MOBILE.ensureModel((label, frac) => {
      setStatus(`Fetching ${label}… ${Math.round(frac * 100)}%`);
    });
    // Phone photos are huge — cap the long edge so detection stays fast.
    const scale = Math.min(1, 1600 / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
    const w = Math.max(1, Math.round(imgEl.naturalWidth * scale));
    const h = Math.max(1, Math.round(imgEl.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(imgEl, 0, 0, w, h);
    setStatus("Finding known objects with MobileNet…");
    const found = await window.MG_MOBILE.detect(c);
    return { mobilenet: true, results: found, sentW: w, sentH: h };
  }

  // Local CLIP windows: the backend scores sliding windows against the
  // prompts — offline after a one-time ~350 MB download, coarse boxes.
  // Reply shape matches /api/detect, so the normal path below just works.
  async function postSamClip(blob, prompts) {
    setStatus("Scoring windows with local CLIP (first run downloads weights)…");
    const fd = new FormData();
    fd.append("image", blob);
    fd.append("concepts", JSON.stringify(prompts));
    locationFields(fd);
    const hdg = currentHeading();
    if (hdg != null) fd.append("heading", String(hdg));
    fd.append("hfov", hfovInput.value || "60");
    fd.append("max_range", rangeInput.value || "30");
    fd.append("detector", "clip");
    const res = await fetch("/api/detect", { method: "POST", body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  // In-browser SAM3 INT8: image encoded once, text concepts run through
  // the local decoder. Boxes come back in sent-image pixels, like Meta.
  async function postSamLocal(blob, prompts) {
    if (!window.MG_SAM3) throw new Error("sam3local.js failed to load.");
    if (!navigator.gpu) {
      setStatus("No WebGPU — WASM fallback will be very slow (minutes). Continuing anyway…");
    }
    setStatus("Loading browser SAM (one-time ~930 MB download, then offline)…");
    const r = await window.MG_SAM3.ensureSessions((label, frac) => {
      setStatus(`Fetching SAM ${label}… ${Math.round(frac * 100)}%`);
    });
    if (r.wasmFallback) setStatus("WebGPU refused the quantized ops — WASM fallback, expect minutes.");
    const sent = prepareImage(imgEl, 1008);
    const full = document.createElement("canvas");
    full.width = 1008; full.height = 1008;
    const fctx = full.getContext("2d");
    const tmp = new Image();
    await new Promise((resolve, reject) => {
      tmp.onload = resolve;
      tmp.onerror = () => reject(new Error("Could not decode image."));
      tmp.src = sent.dataUrl;
    });
    fctx.drawImage(tmp, 0, 0, 1008, 1008);
    const px = fctx.getImageData(0, 0, 1008, 1008).data;
    const chw = new Uint8Array(3 * 1008 * 1008);
    const plane = 1008 * 1008;
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      chw[j] = px[i]; chw[plane + j] = px[i + 1]; chw[2 * plane + j] = px[i + 2];
    }
    setStatus("Encoding image in browser…");
    const feats = await window.MG_SAM3.encodeImage(chw);
    const all = [];
    let n = 0;
    for (const concept of prompts) {
      setStatus(`Finding "${concept}" in browser (${++n}/${prompts.length})…`);
      for (const b of await window.MG_SAM3.detect(feats, concept, sent.w, sent.h)) all.push(b);
    }
    if (window.MG_SAM3.wasFallback()) {
      setStatus("WebGPU refused a quantized op mid-run — finished on WASM instead (slow).");
    }
    return { browser: true, results: all, sentW: sent.w, sentH: sent.h };
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
    const cam = currentManual() || gps;
    if (cam) return { lon: cam.lon, lat: cam.lat, kind: "camera" };
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

  // Processing routes: one mode switch at the top, each mode showing
  // only its sections (renumbered in place). Depth runs solely inside
  // the two routes that need pins (single photo, batch); the 3D route
  // is COLMAP geometry with depth-free labels.
  const MODES = {
    single: { sections: ["secPhoto", "secObjects", "secLoc", "secDetector", "secResults"],
              note: "Single-photo route: detect, depth, map pin." },
    "set-depth": { sections: ["secSet", "secBatch"],
              note: "Set route: the shared zip + concepts above; depth runs per photo for pins." },
    "set-3d": { sections: ["secSet", "secSfm"],
              note: "Set route: the shared zip + concepts above; COLMAP only — no depth pass." },
  };
  const modeOut = $("modeOut");
  function currentMode() {
    const el = document.querySelector('input[name="mode"]:checked');
    return (el && MODES[el.value]) ? el.value : "single";
  }
  function setMode(mode) {
    if (!MODES[mode]) mode = "single";
    document.querySelectorAll('input[name="mode"]').forEach((el) => {
      el.checked = el.value === mode;
    });
    const vis = MODES[mode].sections;
    let n = 0;
    ["secPhoto", "secObjects", "secLoc", "secDetector", "secResults",
     "secSet", "secBatch", "secSfm"].forEach((id) => {
      const sec = $(id);
      if (!sec) return;
      const show = vis.indexOf(id) >= 0;
      sec.hidden = !show;
      if (show) {
        n++;
        const h = sec.querySelector("h2");
        if (h) h.textContent = `${n}. ${sec.dataset.title || h.textContent}`;
      }
    });
    if (modeOut) modeOut.textContent = MODES[mode].note;
    document.body.classList.toggle("wide", mode === "set-3d");
    try { localStorage.setItem("mg.mode", mode); } catch (e) { /* private mode */ }
  }
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener("change", () => setMode(el.value));
  });
  try { setMode(localStorage.getItem("mg.mode") || "single"); }
  catch (e) { setMode("single"); }

  // Batch: a zip of photos in, per-image previews + JSON plus one merged
  // feature set out. Same origin (/api/batch) like /api/project.
  const zipInput = $("zipInput"), batchBtn = $("batchBtn"), batchOut = $("batchOut"),
    batchGrid = $("batchGrid"), mergedList = $("mergedList"), mergedBtn = $("mergedBtn"),
    radiusInput = $("radiusInput"), simInput = $("simInput"),
    setConcepts = $("setConcepts"), setDetector = $("setDetector");
  let lastBatch = null, batchLayers = null;

  // Shared zip drop zone: drag-and-drop plus click-to-browse, sharing
  // zipInput as the fallback picker. One upload feeds both set routes.
  const zipDrop = $("zipDrop");
  function zipName() {
    const f = zipInput.files[0];
    zipDrop.innerHTML = f
      ? `Selected: <b></b> (${(f.size / 1024).toFixed(0)} KB) — drop another .zip or click to change.`
      : `Drop a <b>.zip</b> of photos here, or click to pick one.`;
    if (f) zipDrop.querySelector("b").textContent = f.name;
  }
  if (zipDrop) {
    zipDrop.addEventListener("click", () => zipInput.click());
    zipDrop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zipInput.click(); }
    });
    zipInput.addEventListener("change", zipName);
    ["dragenter", "dragover"].forEach((ev) => zipDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      zipDrop.classList.add("over");
    }));
    ["dragleave", "drop"].forEach((ev) => zipDrop.addEventListener(ev, (e) => {
      e.preventDefault();
      zipDrop.classList.remove("over");
    }));
    zipDrop.addEventListener("drop", (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) {
        zipInput.files = dt.files;
        zipName();
      }
    });
  }

  batchBtn.addEventListener("click", async () => {
    const zf = zipInput.files[0];
    if (!zf) { batchOut.textContent = "Pick a zip of photos first."; return; }
    const prompts = setConcepts.value.split(",").map(s => s.trim()).filter(Boolean);
    if (!prompts.length) { batchOut.textContent = "Enter at least one concept above."; return; }
    batchOut.textContent = "Processing… depth runs per photo, so a dozen images take a while.";
    try {
      const fd = new FormData();
      fd.append("zipfile", zf);
      fd.append("concepts", JSON.stringify(prompts));
      fd.append("detector", (setDetector && setDetector.value) || "sam");
      locationFields(fd);
      const hdg = currentHeading();
      if (hdg != null) fd.append("heading", String(hdg));
      fd.append("hfov", hfovInput.value || "60");
      fd.append("max_range", rangeInput.value || "30");
      fd.append("merge_radius_m", radiusInput.value || "8");
      fd.append("sim_min", simInput.value || "0.75");
      const res = await fetch("/api/batch", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      lastBatch = await res.json();
      if (lastBatch.error) throw new Error(lastBatch.error);
      renderBatch();
      const n = lastBatch.merged ? lastBatch.merged.features.length : 0;
      batchOut.textContent = `Done — ${lastBatch.images.length} photo(s)` +
        (lastBatch.skipped ? ` (${lastBatch.skipped} skipped over the 20-photo cap)` : "") +
        `, ${n} merged feature(s).`;
    } catch (e) {
      batchOut.textContent = `Error: ${e.message}`;
    }
  });

  function saveJson(obj, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function renderBatch() {
    batchGrid.innerHTML = "";
    lastBatch.images.forEach((im, i) => {
      const div = document.createElement("div");
      div.className = "batch-item";
      const img = document.createElement("img");
      img.src = im.thumbnail;
      img.alt = im.name;
      div.appendChild(img);
      const h = document.createElement("h4");
      h.textContent = im.name;
      div.appendChild(h);
      const meta = document.createElement("div");
      const loc = im.location ? `${im.location.lat.toFixed(5)}, ${im.location.lon.toFixed(5)}` : "no location";
      meta.textContent = `${loc} (${im.gps_source}) — ${im.detections.length} box(es)`;
      div.appendChild(meta);
      const ul = document.createElement("ul");
      im.detections.forEach((d) => {
        const li = document.createElement("li");
        li.textContent = d.geo
          ? `${d.label}: ${d.geo.distance_m.toFixed(1)} m @ ${d.geo.bearing_deg.toFixed(1)}°`
          : `${d.label}: no pin (${d.geo_error || "no location/heading"})`;
        ul.appendChild(li);
      });
      div.appendChild(ul);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Download JSON";
      btn.addEventListener("click", () => saveJson({
        image: im.name, location: im.location, gps_source: im.gps_source,
        heading_deg: im.heading_deg, heading_source: im.heading_source,
        detections: im.detections.map((d) => ({
          label: d.label, score: d.score, box: d.box,
          geo: d.geo || null, snapped: d.snapped || null
        }))
      }, im.name.replace(/\.[^.]+$/, "") + "-tagged.json"));
      div.appendChild(btn);
      batchGrid.appendChild(div);
    });
    mergedList.innerHTML = "";
    const feats = (lastBatch.merged && lastBatch.merged.features) || [];
    if (!feats.length) mergedList.innerHTML = '<li class="hint">Nothing merged — pins were too far apart or looked different.</li>';
    feats.forEach((f) => {
      const li = document.createElement("li");
      const [lon, lat] = f.geometry.coordinates;
      li.textContent = `${f.properties.label} ×${f.properties.count}: ` +
        `${lat.toFixed(6)}, ${lon.toFixed(6)} (from ${f.properties.merged_from.map((m) => m.image).join(", ")})`;
      mergedList.appendChild(li);
    });
    mergedBtn.disabled = feats.length === 0;
    renderBatchPins(feats);
  }

  mergedBtn.addEventListener("click", () => {
    if (lastBatch && lastBatch.merged) saveJson(lastBatch.merged, "microgeo-merged.json");
  });

  function renderBatchPins(feats) {
    if (!window.L || !map) return;
    if (batchLayers) batchLayers.remove();
    if (!feats.length) return;
    batchLayers = window.L.layerGroup().addTo(map);
    const bounds = [];
    feats.forEach((f) => {
      const [lon, lat] = f.geometry.coordinates;
      window.L.circleMarker([lat, lon], { radius: 8, color: "#b00020" })
        .addTo(batchLayers)
        .bindPopup(`<b>${f.properties.label} ×${f.properties.count}</b><br>merged pin`);
      bounds.push([lat, lon]);
    });
    map.fitBounds(bounds, { padding: [20, 20] });
  }

  // 3D reconstruction: the shared zip, POSTed to /api/sfm with the
  // set concepts for depth-free server-side labels (empty concepts =
  // unlabeled cloud, fastest). No depth pass runs on this route.
  // Rendered as raw + labeled point clouds; three.js loads lazily
  // (dynamic import of sfm3d.js) so the page opens cleanly even when
  // the CDN is unreachable; a 503 (no COLMAP on the server) degrades
  // to a plain message.
  const sfmBtn = $("sfmBtn"), sfmOut = $("sfmOut");
  let sfmViews = [];

  if (sfmBtn) sfmBtn.addEventListener("click", async () => {
    const zf = zipInput.files[0];
    if (!zf) { sfmOut.textContent = "Pick a zip of photos above first."; return; }
    const concepts = setConcepts.value.split(",").map(s => s.trim()).filter(Boolean);
    sfmOut.textContent = concepts.length
      ? "Detecting labels (boxes only, no depth), then reconstructing 3D — matching takes a while on many photos…"
      : "Reconstructing 3D unlabeled (no detection, no depth)…";
    try {
      const fd = new FormData();
      fd.append("zipfile", zf);
      fd.append("concepts", JSON.stringify(concepts));
      fd.append("detector", (setDetector && setDetector.value) || "sam");
      fd.append("use_gpu", ($("sfmCpu") && $("sfmCpu").checked) ? "0" : "1");
      const res = await fetch("/api/sfm", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) {
        sfmOut.textContent = "3D unavailable: the server has no COLMAP installed " +
          "(install the COLMAP CLI or pycolmap to enable /api/sfm). " +
          "Batch detection + map pins above keep working.";
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(data.error || "request failed").slice(0, 200)}`);
      if (data.error) throw new Error(data.error);
      let lib;
      try {
        lib = await import("./sfm3d.js");
      } catch (e) {
        sfmOut.textContent = "3D data arrived, but the three.js library could not load " +
          "(needs internet for the pinned CDN) — try again online.";
        return;
      }
      if (!data.ply) throw new Error("the server returned no point cloud");
      const cloud = lib.parsePly(data.ply);
      if (!cloud.count) throw new Error("the server returned an empty point cloud");
      sfmViews.forEach((v) => v.dispose());
      sfmViews = [
        lib.renderCloud($("sfmRaw"), $("sfmRawPopup"), cloud.positions, cloud.colors, data.point_labels || null),
        lib.renderCloud($("sfmLabeled"), $("sfmLabeledPopup"),
          cloud.positions, lib.labeledColors(cloud.count, data.point_labels || {}), data.point_labels || null),
      ];
      $("sfmRawEmpty").hidden = true;
      $("sfmLabeledEmpty").hidden = true;
      const unreg = (data.unregistered || []).length;
      const warns = (data.warnings || []).join(" ");
      const nLab = Object.keys(data.point_labels || {}).length;
      sfmOut.textContent = `Done — ${cloud.count} 3D point(s)` +
        (data.total_points > cloud.count ? ` (downsampled from ${data.total_points})` : "") +
        ` from ${(data.registered || []).length} placed photo(s)` +
        (unreg ? `, ${unreg} photo(s) COLMAP could not place` : "") +
        (concepts.length ? `, ${nLab} labeled point(s) (no depth pass)` : ", unlabeled cloud") +
        (data.gpu_used ? " (GPU)." : ".") +
        (warns ? ` Note: ${warns}` : "");
    } catch (e) {
      sfmOut.textContent = `Error: ${e.message}`;
    }
  });

  // Raw detections out of a backend reply, untouched by canvas scaling:
  // [{label, box:[x1,y1,x2,y2] original-px, score}]. Our backend emits
  // {box,label,score}; other shapes pass through box/bbox/xyxy arrays.
  function rawDetections(data) {
    let items = [];
    if (data && typeof data === "object") {
      if (Array.isArray(data.results)) items = data.results;
      else if (Array.isArray(data.detections)) items = data.detections;
      else if (Array.isArray(data.predictions)) items = data.predictions;
    }
    const out = [];
    items.forEach((it, i) => {
      const c = it.box || it.bbox || it.xyxy || null;
      if (!Array.isArray(c) || c.length < 4) return;
      const v = c.slice(0, 4).map(Number);
      if (!v.every(Number.isFinite)) return;
      out.push({ label: it.label || it.name || `object ${i + 1}`,
                 box: v.map(Math.round),
                 score: typeof it.score === "number" ? it.score : null });
    });
    return out;
  }

  // Re-run depth + geometry on the stored SAM boxes with the CURRENT
  // heading / HFOV / range — no SAM call, so geometry can be iterated fast.
  reprojectBtn.addEventListener("click", async () => {
    if (!fileBlob || !origBoxes.length) return;
    setStatus("Starting depth processing (stored boxes, no SAM)…");
    try {
      const fd = new FormData();
      fd.append("image", fileBlob);
      fd.append("boxes", JSON.stringify(origBoxes));
      locationFields(fd);
      const hdg = currentHeading();
      if (hdg != null) fd.append("heading", String(hdg));
      fd.append("hfov", hfovInput.value || "60");
      fd.append("max_range", rangeInput.value || "30");
      const res = await fetch("/api/project", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const proj = await res.json();
      showDepth(proj.depth_png);
      let n = 0;
      (proj.detections || []).forEach((d, i) => {
        if (!boxes[i]) return;
        boxes[i].geo = d.geo || null;
        boxes[i].snapped = d.snapped || null;
        boxes[i].geo_error = d.geo_error || null;
        if (d.geo) n++;
      });
      lastRaw.location = proj.location || lastRaw.location;
      renderList();
      renderMap();
      setStatus(`Re-projected — ${n} pin(s).` + gpsNote(proj.gps_source) + headingNote(proj));
    } catch (e) {
      setStatus(`Error: ${e.message}`, true);
    }
  });

  function showDepth(dataUrl) {
    if (!dataUrl) return;
    depthImg.src = dataUrl;
    depthImg.hidden = false;
    depthNote.textContent = "Monocular depth — blue far, red near. Warm areas are closer to the camera.";
  }

  // Map view: camera fix plus one marker per projected pin, each popup
  // carrying label, distance, azimuth and ENU. Needs the Leaflet CDN;
  // without it (offline) the list below still carries every number.
  function renderMap() {
    if (!window.L) {
      mapNote.textContent = "Map library unavailable (needs internet for tiles) — pins are listed above.";
      return;
    }
    const cam = currentManual() || (gps ? { lat: gps.lat, lon: gps.lon } : null) || (lastRaw.location || null);
    const pins = boxes.filter((b) => b.geo).map((b) => ({ b, p: pinOf(b) })).filter((x) => x.p);
    if (!cam && !pins.length) {
      mapNote.textContent = "No pins yet — they arrive with the next Send.";
      return;
    }
    if (!map) {
      map = window.L.map("map");
      window.L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
      }).addTo(map);
    }
    if (mapLayers) mapLayers.remove();
    mapLayers = window.L.layerGroup().addTo(map);
    const bounds = [];
    if (cam) {
      const mk = window.L.marker([cam.lat, cam.lon], { draggable: true }).addTo(mapLayers);
      mk.bindPopup("Camera — drag me to correct the fix");
      mk.on("dragend", () => {
        const p = mk.getLatLng();
        manualLat.value = p.lat.toFixed(6);
        manualLon.value = p.lng.toFixed(6);
        mapNote.textContent = `Camera moved to ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} (manual override) — Send or Re-project to apply.`;
      });
      bounds.push([cam.lat, cam.lon]);
    }
    pins.forEach(({ b, p }) => {
      const g = b.geo;
      const enu = g.enu_m ? `<br>x ${g.enu_m.x} m E, y ${g.enu_m.y} m N, z ${g.enu_m.z} m` : "";
      const snap = b.snapped ? "<br>on building outline" : "";
      window.L.marker([p.lat, p.lon]).addTo(mapLayers).bindPopup(
        `<b>${b.label}</b><br>${g.distance_m.toFixed(1)} m @ ${g.bearing_deg.toFixed(1)}°${enu}${snap}`);
      bounds.push([p.lat, p.lon]);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [20, 20] });
    else map.setView(bounds[0], 18);
    mapNote.textContent = `${pins.length} pin(s)` +
      (pins.some(({ b }) => b.snapped) ? " (door/window snapped to building outline)." : ".");
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();

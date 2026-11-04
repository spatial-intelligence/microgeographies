(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.MG_CONFIG || {};
  let videoOverviewWindow=null,videoOverviewHome=null;
  function dockVideoOverview(){
    const pane=$("videoSecondPane");videoOverviewWindow?.hide();pane.hidden=true;videoOverviewHome?.append(pane);pane.classList.remove('floating-overview');$("videoSecondFloat").setAttribute('aria-expanded','false');
  }
  async function floatVideoOverview(layout=null){
    const pane=$("videoSecondPane");
    if(pane.classList.contains('floating-overview')&&!layout){dockVideoOverview();return;}
    videoOverviewHome ||= pane.parentElement;
    if(!videoOverviewWindow){const {createToolWindow}=await import('./floating-windows.js');videoOverviewWindow=createToolWindow({id:'videoOverviewWindow',title:'Second 3D view',content:pane,width:520,left:Math.max(12,innerWidth*.4),top:110,className:'overview-window',onClose:dockVideoOverview});videoOverviewWindow.element.style.height='380px';}
    else videoOverviewWindow.element.querySelector('.tool-window-body').append(pane);
    pane.hidden=false;pane.classList.add('floating-overview');$("videoSecondFloat").setAttribute('aria-expanded','true');if(layout)videoOverviewWindow.setLayout(layout);videoOverviewWindow.show();
  }
  const overviewMaps = new Map(), cloudMapLayers = new Map();
  let sfmBookmarks = null, videoBookmarks = null;
  let setFeatureSource = "model", setBusy = false;
  async function openMapTagEditor(options){const {editMapTag}=await import('./map-tag-editor.js');editMapTag(options);}
  function editFeatureTag(feature,redraw){
    const [lon,lat]=feature.geometry.coordinates,p=feature.properties;
    openMapTagEditor({name:p.name||p.label,lat,lon,indoor:p.indoor,floor:p.floor,onSave:value=>{
      Object.assign(p,{name:value.name,label:value.name,indoor:value.indoor,floor:value.floor});feature.geometry.coordinates=[value.lon,value.lat,...feature.geometry.coordinates.slice(2)];redraw();
    }});
  }
  function reconstructionPhotos(data){return data.source_frames||Object.entries(data.thumbnails||{}).map(([image,url])=>({image,url}));}
  function geometrySummary(detail){const i=detail.info;if(!i)return '';let text=detail.mode==='tin'?`${i.triangles.toLocaleString()} triangles / ${i.meshVertices.toLocaleString()} vertices - smaller Point Size makes a finer TIN.`:detail.mode==='mosaic'?`${i.photos} / ${i.photoTotal} source photos${i.planarPhotos?' / '+i.planarPhotos+' photo planes at estimated scene depth':''}.`:`${i.original.toLocaleString()} original + ${i.synthetic.toLocaleString()} synthetic points (x${(i.synthetic/Math.max(1,i.original)).toFixed(1)} added).${i.requested>i.target?' Preview capped at 2 million added points.':''} Picking and exports use original samples.`;if(i.busy)text+=' Building preview...';if(i.error)text+=' '+i.error;return text;}
  function registerMap(id, instance) {
    overviewMaps.set(id, instance);
    window.MGMaps.addBasemaps(instance, id);
    new ResizeObserver(() => instance.invalidateSize()).observe($(id));
  }
  function initWorkflowMaps(mode) {
    if (mode === "single") renderMap();
    if ((mode === "set-depth" || mode === "set-3d") && !sfmMap) renderSfmMap({});
    if ((mode === "set-video" || mode === "video-survey") && !videoMap) renderVideoMap({});
    if ((mode === "set-depth" || mode === "set-3d") && !overviewMaps.has("batchMap") && window.L) {
      const instance = window.L.map("batchMap", {maxZoom: 22}).setView([20,0],2);
      registerMap("batchMap", instance);
    }
    overviewMaps.forEach(instance => instance.invalidateSize());
  }
  function updateCloudMap(id, cloud, reference, library) {
    cloudMapLayers.get(id)?.remove(); cloudMapLayers.delete(id);
    if (!reference?.available || !overviewMaps.has(id)) return;
    const instance = overviewMaps.get(id);
    const layer = library.createCloudMapLayer(window.L, instance, cloud.positions, cloud.colors, reference);
    cloudMapLayers.set(id, layer);
    if (layer.bounds.isValid()) instance.fitBounds(layer.bounds, {padding:[24,24], maxZoom:20});
  }

  const fileInput = $("fileInput"), promptsInput = $("promptsInput"),
    headingOut = $("headingOut"),
    headingInput = $("headingInput"), hfovInput = $("hfovInput"),
    rangeInput = $("rangeInput"),
    depthBackend = $("depthBackend"), depthModel = $("depthModel"),
    endpointInput = $("endpointInput"), modelInput = $("modelInput"),
    tokenInput = $("tokenInput"),
    sendBtn = $("sendBtn"), statusOut = $("statusOut"),
    canvas = $("photoCanvas"), boxList = $("boxList"),
    depthNote = $("depthNote"),
    mapNote = $("mapNote"),
    rawOut = $("rawOut"), exportBtn = $("exportBtn"),
    exportMenu = $("exportMenu"), exportGeoBtn = $("exportGeoBtn"),
    exportPngBtn = $("exportPngBtn"),
    reprojectBtn = $("reprojectBtn"),
    locBtn = $("locBtn"), locState = $("locState"),
    locDlg = $("locDlg"), locClose = $("locClose"),
    cfgBtn = $("cfgBtn"), cfgDlg = $("cfgDlg"), cfgClose = $("cfgClose"),
    detectorSummary = $("detectorSummary"),
    osmFile = $("osmFile"), matchTol = $("matchTol"), snapPath = $("snapPath"),
    matchOut = $("matchOut"), matchList = $("matchList"),
    measureBtn = $("measureBtn"), hoverTip = $("hoverTip");

  let map = null, mapLayers = null;
  let manualClearedNote = ""; // one-shot: previous photo's manual override was just cleared

  let imgEl = null, fileBlob = null, boxes = [], gps = null, lastRaw = {};
  let origBoxes = []; // last SAM boxes in uploaded-original pixels, for re-projection
  let sentSize = null; // pixel size of the image SAM actually saw
  let headingDeg = null; // compass bearing of the camera axis

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

  // One-shot EXIF verdict line: prefixes the "manual override was
  // cleared" note once, on the final verdict, then consumes it.
  function sayExif(msg) {
    exifOut.textContent = manualClearedNote + msg;
    manualClearedNote = "";
  }

  // EXIF preview at load time: says what the photo carries and what the
  // backend will therefore use, before anything is sent.
  function previewExif(file) {
    photoLocationHints.reset();
    exifOut.textContent = "Reading photo metadata…";
    if (/heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name || "")) {
      photoLocationHints.setAvailable(true);
      sayExif("HEIC photo — direction/location tags can't be read here. Convert to JPEG first, or enter the photo location and heading manually.");
      return;
    }
    file.arrayBuffer().then((buf) => {
      if(file!==fileBlob)return;
      const ex = window.MG_EXIF ? window.MG_EXIF.parseGPS(buf) : null;
      photoLocationHints.setAvailable(ex?.lat==null||ex?.lon==null);
      if (!ex || !ex.hasExif) {
        sayExif("No EXIF in this photo (screenshot, PNG, or stripped upload) — use Estimate location or enter its location and heading using Location & heading.");
        return;
      }
      const bits = [];
      if (ex.lat != null && ex.lon != null) bits.push(`location ${ex.lat.toFixed(6)}, ${ex.lon.toFixed(6)}`);
      if (ex.heading != null) bits.push(`heading ${ex.heading}°`);
      if (!bits.length) {
        sayExif("Photo has EXIF but no GPS location — use Estimate location or enter its location and heading using Location & heading.");
        return;
      }
      const used = [];
      if (ex.lat != null) used.push("location");
      if (ex.heading != null && currentHeading() == null) used.push("heading");
      sayExif(`Photo EXIF holds ${bits.join(" + ")} — will be used (${used.join(" + ")}), not this computer's.`);
    }).catch(() => {
      if(file!==fileBlob)return;
      photoLocationHints.setAvailable(true);
      sayExif("Could not read photo metadata — enter the photo location and heading manually.");
    });
  }

  // Light/dark theme. The inline script in <head> already set
  // html[data-theme] before first paint (blueprint dark by default);
  // here we sync the toggle label + theme-color meta and persist.
  const themeBtn = $("themeBtn"), themeLabel = $("themeLabel"),
    themeMeta = document.getElementById("themeColorMeta");
  function paintTheme(t) {
    document.documentElement.dataset.theme = t;
    if (themeLabel) themeLabel.textContent = t === "dark" ? "Light" : "Dark";
    if (themeMeta) themeMeta.setAttribute("content", t === "dark" ? "#050816" : "#10233c");
  }
  function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }
  if (themeBtn) {
    paintTheme(currentTheme());
    themeBtn.addEventListener("click", () => {
      const next = currentTheme() === "dark" ? "light" : "dark";
      paintTheme(next);
      try { localStorage.setItem("mg.theme", next); } catch (e) { /* private mode */ }
    });
  }

  // Restore non-secret prefs; token lives in localStorage of this browser only.
  endpointInput.value = localStorage.getItem("mg.endpoint") || cfg.samEndpoint || "/api/sam";
  modelInput.value = localStorage.getItem("mg.model") || cfg.metaModel || "sam-3.1";
  tokenInput.value = localStorage.getItem("mg.token") || "";
  promptsInput.value = cfg.defaultPrompts || "door, steps";
  endpointInput.addEventListener("change", () => localStorage.setItem("mg.endpoint", endpointInput.value));
  modelInput.addEventListener("change", () => localStorage.setItem("mg.model", modelInput.value));
  tokenInput.addEventListener("change", () => localStorage.setItem("mg.token", tokenInput.value));
  // Setup is set-once: detector choice + geometry persist too.
  try {
    const savedBackend = localStorage.getItem("mg.samBackend");
    if (savedBackend) {
      document.querySelectorAll('input[name="samBackend"]').forEach((el) => {
        el.checked = el.value === savedBackend;
      });
    }
  } catch (e) { /* private mode */ }
  if (localStorage.getItem("mg.hfov")) hfovInput.value = localStorage.getItem("mg.hfov");
  if (localStorage.getItem("mg.range")) rangeInput.value = localStorage.getItem("mg.range");
  hfovInput.addEventListener("change", () => localStorage.setItem("mg.hfov", hfovInput.value));
  rangeInput.addEventListener("change", () => localStorage.setItem("mg.range", rangeInput.value));
  document.querySelectorAll('input[name="samBackend"]').forEach((el) => {
    el.addEventListener("change", () => {
      try { localStorage.setItem("mg.samBackend", samBackend()); } catch (e) { /* private mode */ }
      refreshDetectorSummary();
    });
  });

  $("singleDetectorChoice").value=samBackend();
  $("singleDetectorChoice").onchange=e=>{const radio=document.querySelector('input[name="samBackend"][value="'+e.target.value+'"]');if(radio){radio.checked=true;radio.dispatchEvent(new Event('change'));}};
  document.querySelectorAll('input[name="samBackend"]').forEach(el=>el.addEventListener('change',()=>$("singleDetectorChoice").value=samBackend()));
  const exifOut = $("exifOut");
  const manualLat = $("manualLat"), manualLon = $("manualLon");
  const photoLocationHints=window.MGLocationHints.createPhoto({
    getImage:()=>imgEl?prepareImage(imgEl,960).dataUrl:null,
    getToken:()=>tokenInput.value,
    onSelect:candidate=>{
      manualLat.value=String(candidate.lat);manualLon.value=String(candidate.lon);
      refreshLocState();renderMap();
      locState.textContent=`Location: estimated near ${candidate.name} (${candidate.confidence} confidence). Check the map and set heading in Location & heading.`;
      setStatus('Estimated location selected. Send or Re-project to apply it to map pins.');
    }
  });

  // Depth backend override (monocular range). Auto = Depth Anything
  // unless a YOLO weight is named; persisted like the SAM prefs.
  if (depthBackend) {
    depthBackend.value = localStorage.getItem("mg.depthBackend") || "";
    depthBackend.addEventListener("change", () => localStorage.setItem("mg.depthBackend", depthBackend.value));
  }
  if (depthModel) {
    depthModel.value = localStorage.getItem("mg.depthModel") || "";
    depthModel.addEventListener("change", () => localStorage.setItem("mg.depthModel", depthModel.value));
  }
  function depthFields(fd) {
    if (depthBackend && depthBackend.value) fd.append("depth_backend", depthBackend.value);
    if (depthModel && depthModel.value.trim()) fd.append("model", depthModel.value.trim());
  }

  // Setup + location dialogs (native <dialog>, Esc closes natively).
  function openDlg(d) {
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }
  if (cfgBtn) cfgBtn.addEventListener("click", () => openDlg(cfgDlg));
  if (locBtn) locBtn.addEventListener("click", () => openDlg(locDlg));
  if (cfgClose) cfgClose.addEventListener("click", () => cfgDlg.close());
  $("clearGpuBtn").addEventListener("click", async () => {
    const button = $("clearGpuBtn"), status = $("clearGpuStatus");
    button.disabled = true;
    status.classList.remove("status-error");
    status.textContent = "Clearing backend GPU memory…";
    try {
      const response = await fetch("/api/gpu/clear", {method: "POST"});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.detail ||
        (response.status === 404 ? "Restart the backend to enable GPU memory cleanup." : "Could not clear GPU memory."));
      status.textContent = data.cuda_available
        ? `GPU models unloaded. Released ${(data.released_bytes / 1048576).toFixed(0)} MB; ${(data.reserved_bytes / 1048576).toFixed(0)} MB still reserved by the backend. Models reload on the next run.`
        : "Backend models unloaded. No active CUDA allocations to clear.";
    } catch (error) {
      status.classList.add("status-error");
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  if (locClose) locClose.addEventListener("click", () => { locDlg.close(); refreshLocState(); });
  const mapDialog = $("mapDialog");
  let expandedMap = null;
  document.querySelectorAll("[data-expand-map]").forEach(button => button.addEventListener("click", () => {
    const id = button.dataset.expandMap, instance = overviewMaps.get(id);
    if (!instance) return;
    const element = $(id), placeholder = document.createComment("map position");
    element.before(placeholder); $("mapDialogHost").append(element);
    expandedMap = {element, placeholder, instance};
    openDlg(mapDialog); requestAnimationFrame(() => instance.invalidateSize());
  }));
  $("mapDialogClose").addEventListener("click", () => mapDialog.close());
  mapDialog.addEventListener("close", () => {
    if (!expandedMap) return;
    const {element, placeholder, instance} = expandedMap;
    placeholder.replaceWith(element); expandedMap = null;
    requestAnimationFrame(() => instance.invalidateSize());
  });
  [cfgDlg, locDlg].forEach((d) => {
    if (d) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  });

  // One-line detector summary for the slim card: backend + model + depth.
  const BACKEND_NAMES = { api: "API", browser: "Browser SAM", clip: "CLIP", mobilenet: "MobileNet" };
  function refreshDetectorSummary() {
    if (!detectorSummary) return;
    const b = BACKEND_NAMES[samBackend()] || samBackend();
    const bits = [b];
    if (samBackend() === "api" && modelInput.value.trim()) bits.push(modelInput.value.trim());
    const db = depthBackend ? depthBackend.value : "";
    bits.push(db === "yolo" ? "YOLO depth" : db === "da" ? "DA depth" : "auto depth");
    detectorSummary.textContent = bits.join(" · ");
  }
  if (cfgDlg) cfgDlg.addEventListener("change", refreshDetectorSummary);
  refreshDetectorSummary();

  // One-line location state for the photo card.
  function refreshLocState() {
    if (!locState) return;
    const m = currentManual();
    if (m) locState.textContent = `Location: manual override ${m.lat.toFixed(5)}, ${m.lon.toFixed(5)}.`;
    else locState.textContent = "Location: photo EXIF, or enter a correction.";
  }
  refreshLocState();

  // Prompts with optional geometry: "door, steps |line" marks steps as
  // a linear feature (map polyline); everything else is a point pin.
  function parsePrompts(value) {
    const out = [];
    for (const part of String(value || "").split(",")) {
      const m = part.match(/^(.*?)\|\s*(lines?|points?)\s*$/i);
      if (m) {
        if (m[1].trim()) out.push({ name: m[1].trim(), geom: /^lines?$/i.test(m[2]) ? "line" : "point" });
      } else if (part.trim()) {
        out.push({ name: part.trim(), geom: "point" });
      }
    }
    return out.slice(0, 10);
  }
  function geomsMap(list) {
    const o = {};
    for (const p of list || []) {
      if (p.geom === "line" && p.name) o[p.name.toLowerCase()] = "line";
    }
    return o;
  }

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
    imgEl = null;
    // A manual location override belongs to the photo it was made for:
    // a drag-correction from a previous image must not silently hijack
    // this photo's EXIF (it sent prefer=manual, so Re-project kept the
    // old pins instead of relocating). The GPS button fix still carries
    // over; re-drag or re-type per photo as needed.
    if (manualLat.value || manualLon.value) {
      manualLat.value = "";
      manualLon.value = "";
      manualClearedNote = "Cleared the previous photo's manual location override — ";
    }
    previewExif(f);
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      if(f!==fileBlob){URL.revokeObjectURL(url);return;}
      imgEl = img; URL.revokeObjectURL(url); boxes = []; sentSize = null;
      origBoxes = [];
      lastDepth = null;
      exportBtn.disabled = true; reprojectBtn.disabled = true;
      refreshLocState();
      draw(); renderList();
    };
    img.onerror = () => setStatus("Could not read that image.", true);
    img.src = url;
  });

  sendBtn.addEventListener("click", async () => {
    if (!fileBlob) { setStatus("Pick a photo first.", true); return; }
    const parsed = parsePrompts(promptsInput.value);
    const prompts = parsed.map((p) => p.name);
    const promptGeoms = geomsMap(parsed);
    // MobileNet finds its own fixed vocabulary — prompts are ignored.
    if (!prompts.length && samBackend() !== "mobilenet") { setStatus("Enter at least one object prompt.", true); return; }
    setStatus("Sending…");
    try {
      const data = await postSam(fileBlob, prompts, promptGeoms);
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
      // Direct boxes carry no geom: fall back to the prompt's |line flag.
      boxes.forEach((b) => {
        if (!b.geom) b.geom = promptGeoms[(b.label || "").toLowerCase()] || "point";
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
        extra = await projectMetaBoxes(data, promptGeoms);
      }
      else {
        setStatus(`SAM finished — ${boxes.length} box(es). Starting depth processing…`);
        extra = gpsNote(data.gps_source) + headingNote(data); showDepth(data.depth_png, data);
        setLastDepth(data);
        origBoxes = rawDetections(data); // backend boxes are already original-px
      }
      draw(); renderList();
      exportBtn.disabled = boxes.length === 0;
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

  function geomsField(fd, geoms) {
    if (geoms && Object.keys(geoms).length) fd.append("geoms", JSON.stringify(geoms));
  }

  async function postSam(blob, prompts, geoms) {
    if (samBackend() === "browser") return postSamLocal(blob, prompts);
    if (samBackend() === "clip") return postSamClip(blob, prompts, geoms);
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
  async function projectMetaBoxes(data, geoms) {
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
    depthFields(fd);
    geomsField(fd, geoms);
    let res;
    try {
      res = await fetch("/api/project", { method: "POST", body: fd });
    } catch (e) {
      return " Projection backend unreachable — boxes only.";
    }
    if (!res.ok) return " Projection failed — boxes only.";
    const proj = await res.json();
    showDepth(proj.depth_png, proj);
    setLastDepth(proj);
    (proj.detections || []).forEach((d, i) => {
      if (!boxes[i]) return;
      if (d.geo) boxes[i].geo = d.geo;
      if (d.snapped) boxes[i].snapped = d.snapped;
      if (d.geom) boxes[i].geom = d.geom;
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
  async function postSamClip(blob, prompts, geoms) {
    setStatus("Scoring windows with local CLIP (first run downloads weights)…");
    const fd = new FormData();
    fd.append("image", blob);
    fd.append("concepts", JSON.stringify(prompts));
    geomsField(fd, geoms);
    locationFields(fd);
    const hdg = currentHeading();
    if (hdg != null) fd.append("heading", String(hdg));
    fd.append("hfov", hfovInput.value || "60");
    fd.append("max_range", rangeInput.value || "30");
    depthFields(fd);
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
    if (!tokenInput.value) { openDlg(cfgDlg); throw new Error("Enter your SAM 3.1 API key in Settings."); }
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
                 geom: it.geom ?? null,
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

  // Export menu: one compact EXPORT button with GeoJSON / PNG actions.
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!exportMenu.hidden && !e.target.closest(".export-wrap")) exportMenu.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !exportMenu.hidden) exportMenu.hidden = true;
    if (e.key === "Escape" && measuring) setMeasuring(false);
  });
  exportGeoBtn.addEventListener("click", () => { exportMenu.hidden = true; exportGeoJSON(); });
  exportPngBtn.addEventListener("click", () => { exportMenu.hidden = true; exportPNG(); });

  // Full-resolution export: re-renders the photo at the size SAM saw it
  // with the boxes scaled up, then downloads a PNG.
  function exportPNG() {
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
  }

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
    updateOsm(); // snaps + OSM matches first: the list links use moved positions
    boxList.innerHTML = "";
    if (!boxes.length) { boxList.innerHTML = '<li class="hint">No boxes.</li>'; return; }
    boxes.forEach((b) => {
      const li = document.createElement("li");
      const coords = `[${[b.x1, b.y1, b.x2, b.y2].map(v => Math.round(v)).join(", ")} px]`;
      const score = b.score == null ? "" : ` — ${(b.score * 100).toFixed(1)}%`;
      const mask = b.maskPayload ? " +mask" : "";
      const gl = b.geom === "line" ? " · line" : "";
      li.textContent = `${b.label}${score} ${coords}${mask}${gl}`;
      if (b.geo) {
        const pin = effPin(b);
        const span = document.createElement("span");
        const px = b.geo.pixel ? `pixel (${b.geo.pixel.x}, ${b.geo.pixel.y})` : "pixel ?";
        const enu = b.geo.enu_m
          ? `x ${b.geo.enu_m.x} m E, y ${b.geo.enu_m.y} m N, z ${b.geo.enu_m.z} m up`
          : "x/y/z ?";
        span.textContent = ` approx ${b.geo.lat.toFixed(6)}, ${b.geo.lon.toFixed(6)}` +
          ` (${b.geo.distance_m.toFixed(1)} m @ ${b.geo.bearing_deg.toFixed(1)}°)` +
          (b.snapped ? " — on building outline" : "") +
          (b.pathSnapInfo ? ` — path-snapped ${b.pathSnapInfo.dist.toFixed(1)} m` : "") +
          (b.osm ? ` — OSM ${osmDescribe(b.osm.tags)} ${b.osm.dist.toFixed(1)} m` : "");
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
        a.textContent = pin.kind === "snapped" ? "OpenStreetMap pin (snapped)"
          : pin.kind === "path" ? "OpenStreetMap pin (path-snapped)" : "OpenStreetMap pin";
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
    drawDepth(); // overlay follows boxes (and their distances) everywhere
  }

  function exportGeoJSON() {
    const hdg = currentHeading();
    const gj = { type: "FeatureCollection", features: boxes.map((b) => {
      const pin = effPin(b);
      const ends = b.geom === "line" ? effEnds(b) : null;
      const geometry = ends
        ? { type: "LineString", coordinates: [[ends[0].lon, ends[0].lat], [ends[1].lon, ends[1].lat]] }
        : pin ? { type: "Point", coordinates: [pin.lon, pin.lat] } : null;
      return {
        type: "Feature",
        geometry,
        properties: { label: b.label, name:b.label, indoor:b.indoor??false, floor:b.indoor?b.floor:null, score: b.score,
          geom: b.geom || "point",
          pinKind: pin ? pin.kind : null, // path | snapped | projected | camera
          geo: b.geo ?? null, snapped: b.snapped ?? null,
          osm: b.osm ?? null, pathSnap: b.pathSnapInfo ?? null,
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
  }

  function setStatus(msg, isErr) {
    statusOut.textContent = msg;
    statusOut.classList.toggle("status-error", !!isErr);
  }

  // Processing routes: one mode switch at the top, each mode showing
  // only its sections (renumbered in place). Depth runs solely inside
  // the two routes that need pins (single photo, batch); the 3D route
  // is COLMAP geometry with depth-free labels.
  const MODES = {
    "image-resize": {sections:["secResize"],title:"Resize image ZIP",
      note:"Downsize photos and download a resized ZIP.",blurb:"Resize photos while retaining EXIF/GPS metadata."},
    "region-download": { sections: ["secRegion"], title: "Download region GeoJSON",
      note: "Download OpenStreetMap features for the visible region.",
      blurb: "Export buildings, entrances, roads, paths and other mapped features." },
    single: { sections: ["secPhoto", "secObjects", "secResults", "secMatch", "secStage", "secExport"],
              note: "Single-photo route: detect, depth, map pin.",
              title: "Single photo",
              blurb: "Detect objects, monocular depth, map pin." },
    "set-depth": { sections: ["secSet", "secSetObjects", "secSetProcess", "secSetResults", "secSfm", "secExport"],
              note: "Set route: the shared zip + concepts above; depth runs per photo for pins.",
              title: "Photo set → pins",
              blurb: "Zip in, depth + merged map pins per photo." },
    "set-3d": { sections: ["secSet", "secSetObjects", "secSetProcess", "secSetResults", "secSfm", "secExport"],
              note: "Build a photo-set model with COLMAP or DA3, then export features or the cloud.",
              title: "Photo set → 3D",
              blurb: "Photo ZIP to a labelled COLMAP or DA3 model and mapped features." },
    "video-survey": { sections: ["secVideo", "secExport"], note: "Video-only DA3 Giant-Large survey", title: "Video to registered 3D survey", blurb: "Register a video cloud, measure and tag world-coordinate locations." },
    "set-video": { sections: ["secVideo", "secExport"],
              note: "Photo + video route: DA3 point cloud, tagged features, map pins.",
              title: "Photo + video → DA3 cloud",
              blurb: "Photo + video zip; DA3 cloud, tagged features, map pins. Needs GPU install." },
  };
  const modeOut = $("modeOut");
  function syncSetLabellingControls() {
    const disabled = !$("sfmUseSam").checked;
    $("setSamToggle").hidden = false;
    $("batchBtn").disabled = disabled || setBusy;
    ["setConcepts", "setDetector", "setApiToken"].forEach((id) => { $(id).disabled = disabled; });
    ["setConcepts", "setDetector"].forEach(id => { $(id).closest("label").hidden = disabled; });
    $("setLabellingNote").hidden = !disabled;
  }
  $("sfmUseSam").addEventListener("change", syncSetLabellingControls);
  function currentMode() {
    const el = document.querySelector('input[name="mode"]:checked');
    return (el && MODES[el.value]) ? el.value : "single";
  }
  function setMode(mode) {
    $("videoProjectStatus").classList.remove("show");
    dockVideoOverview();
    document.querySelectorAll(".tool-window").forEach(panel=>panel.hidden=true);
    if (!MODES[mode]) mode = "single";
    document.querySelectorAll('input[name="mode"]').forEach((el) => {
      el.checked = el.value === mode;
    });
    const vis = MODES[mode].sections;
    let n = 0;
    ["secPhoto", "secObjects", "secDetector", "secResults", "secMatch", "secStage",
     "secSet", "secSetObjects", "secSetProcess", "secSetResults", "secSfm", "secVideo", "secExport", "secRegion", "secResize"].forEach((id) => {
      const sec = $(id);
      if (!sec) return;
      const show = vis.indexOf(id) >= 0;
      sec.hidden = !show;
      if (show) {
        const h = sec.querySelector("h2");
        if (h) h.textContent = sec.dataset.title || h.textContent.replace(/^\d+\.\s*/, "");
      }
    });
    if (modeOut) modeOut.textContent = MODES[mode].note;
    document.body.classList.toggle("wide", mode === "set-3d" || mode === "set-video" || mode === "video-survey");
    document.body.dataset.mode = mode;
    document.body.classList.toggle("photo-set-console", mode === "set-depth" || mode === "set-3d");
    // The Leaflet map lives in the fixed single-mode stage: re-measure
    // it whenever single mode (re)appears, or tiles render for a
    // zero-size box.
    if (mode === "single" && map) {
      requestAnimationFrame(() => map.invalidateSize());
    }
    const surveyMode = mode === "video-survey";
    $("workflowTitle").textContent=MODES[mode].title;$("workflowTitle").hidden=false;
    $("videoProjectBar").hidden = !surveyMode;
    $("videoSamToggle").hidden = !surveyMode;
    $("videoSecondPane").hidden = true;
    $("videoSecondFloat").hidden = !surveyMode;
    $("videoOnlyRow").hidden = !surveyMode;
    $("videoSurveyIntro").hidden = !surveyMode;
    $("videoSurveyTools").hidden = !surveyMode;
    $("videoLocateRow").hidden = $("videoLocateHintNote").hidden = !surveyMode;
    if(!surveyMode){$("videoLocationHints").close?.();$("videoLocationHintsBar").hidden=true;}
    $("videoZip").closest("label").hidden = surveyMode;
    $("videoZip").closest(".card").querySelector("p.hint").hidden = surveyMode;
    ["videoConcepts", "videoDetector"].forEach(id => $(id).closest("label").hidden = surveyMode && !$("videoUseSam").checked);
    $("videoSnap").closest("label").hidden = surveyMode;
    $("videoBtn").textContent = surveyMode ? "Build video cloud" : "Build cloud + map features";
    syncSetLabellingControls();
    try { localStorage.setItem("mg.mode", mode); } catch (e) { /* private mode */ }
  }
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener("change", () => openWorkflow(el.value));
  });
  // Landing + sub-page routing: the donut on #landing opens one
  // workflow view; the workflow nav returns to the landing.
  const landing = $("landing"), workflowNav = $("workflowNav"),
    workflowTitle = $("workflowTitle"), workflowBlurb = $("workflowBlurb"),
    backBtn = $("backBtn");
  const ALL_SECTIONS = ["secPhoto", "secObjects", "secDetector", "secResults", "secMatch", "secStage",
    "secSet", "secSetObjects", "secSetProcess", "secSetResults", "secSfm", "secVideo", "secExport", "secRegion", "secResize"];
  function paintWorkflowNav(mode) {
    if (workflowTitle) workflowTitle.textContent = MODES[mode].title;
    if (workflowBlurb) workflowBlurb.textContent = MODES[mode].blurb;
    document.querySelectorAll('.workflow-switch [data-workflow]').forEach((btn) => {
      if (btn.getAttribute("data-workflow") === mode) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
  }
  function workflowUrl(mode) {
    const u = new URL(window.location.href);
    u.searchParams.set("workflow", mode);
    u.hash = "";
    return u.toString();
  }
  function landingUrl() {
    const u = new URL(window.location.href);
    u.searchParams.delete("workflow");
    u.hash = "";
    return u.toString();
  }
  function openWorkflow(mode, opts) {
    sfmBookmarks?.stop(); videoBookmarks?.stop();
    if (!MODES[mode]) mode = "single";
    setMode(mode);
    paintWorkflowNav(mode);
    if (landing) landing.hidden = true;
    if (workflowNav) workflowNav.hidden = true;
    document.body.dataset.view = "workflow";
    document.querySelectorAll("[data-export-workflow]").forEach(el => { el.hidden = !el.dataset.exportWorkflow.split(" ").includes(mode); });
    requestAnimationFrame(() => {
      if (mode === "region-download") window.MGRegion.open((geojson) => {
        const n = loadOsm(geojson);
        snapPath.checked = true;
        matchOut.textContent = `Region: ${n.nPoints} point(s), ${n.nLines} line/outline(s) loaded. Snap to path enabled.`;
        updateOsm();
        openWorkflow("single");
      });
      initWorkflowMaps(mode);
      if(mode==='video-survey')locationHints.refresh();
      if (mode.startsWith("set-") && mode !== "set-video") setMapSource(mode === "set-3d" ? "model" : "photos");
    });
    const nav = (opts && opts.push === false) ? "replaceState" : "pushState";
    try {
      window.history[nav]({ workflow: mode }, "", workflowUrl(mode));
    } catch (e) { /* file:// or private mode */ }
    window.scrollTo(0, 0);
  }
  function showLanding(opts) {
    $("workflowTitle").hidden=true;
    $("videoProjectStatus").classList.remove("show");
    dockVideoOverview();$("videoProjectBar").hidden=true;
    document.querySelectorAll(".tool-window").forEach(panel=>panel.hidden=true);
    sfmBookmarks?.stop(); videoBookmarks?.stop();
    ALL_SECTIONS.forEach((id) => { const sec = $(id); if (sec) sec.hidden = true; });
    if (landing) landing.hidden = false;
    if (workflowNav) workflowNav.hidden = true;
    document.body.dataset.view = "landing";
    document.body.classList.remove("wide", "photo-set-console");
    const nav = (opts && opts.push === false) ? "replaceState" : "pushState";
    try {
      window.history[nav]({}, "", landingUrl());
    } catch (e) { /* file:// or private mode */ }
    window.scrollTo(0, 0);
  }
  function routeFromUrl() {
    try {
      const u = new URL(window.location.href);
      const q = u.searchParams.get("workflow");
      if (q && MODES[q]) return q;
      const m = (u.hash || "").match(/^#\/workflow\/([\w-]+)/);
      if (m && MODES[m[1]]) return m[1];
    } catch (e) { /* ignore */ }
    return null;
  }
  document.querySelectorAll('[data-workflow]').forEach((el) => {
    if (el.classList && el.classList.contains("donut-quad")) {
      el.addEventListener("click", () => openWorkflow(el.getAttribute("data-workflow")));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWorkflow(el.getAttribute("data-workflow")); }
      });
    } else {
      el.addEventListener("click", () => openWorkflow(el.getAttribute("data-workflow")));
    }
  });
  $("homeLink").addEventListener("click", e => { e.preventDefault(); showLanding(); });
  $("settingsBtn").addEventListener("click", () => openDlg(cfgDlg));
  if (backBtn) backBtn.addEventListener("click", () => showLanding());
  window.addEventListener("popstate", () => {
    const routed = routeFromUrl();
    if (routed) openWorkflow(routed, { push: false });
    else showLanding({ push: false });
  });
  window.addEventListener("hashchange", () => {
    const routed = routeFromUrl();
    if (routed) openWorkflow(routed, { push: false });
  });
  let storedMode = "single";
  try { storedMode = localStorage.getItem("mg.mode") || "single"; }
  catch (e) { /* private mode */ }
  if (!MODES[storedMode]) storedMode = "single";
  setMode(storedMode);
  paintWorkflowNav(storedMode);
  const initial = routeFromUrl();
  if (initial) openWorkflow(initial, { push: false });
  else showLanding({ push: false });

  // Batch: a zip of photos in, per-image previews + JSON plus one merged
  // feature set out. Same origin (/api/batch) like /api/project.
  const zipInput = $("zipInput"), batchBtn = $("batchBtn"), batchOut = $("batchOut"),
    batchGrid = $("batchGrid"), mergedList = $("mergedList"), mergedBtn = $("mergedBtn"),
    radiusInput = $("radiusInput"), simInput = $("simInput"),
    setConcepts = $("setConcepts"), setDetector = $("setDetector");
  let lastBatch = null, batchLayers = null;
  const setApiToken = $("setApiToken");
  setApiToken.value = tokenInput.value;
  setApiToken.addEventListener("input", () => {
    tokenInput.value = setApiToken.value;
  });
  setApiToken.addEventListener("change", () => tokenInput.dispatchEvent(new Event("change")));
  tokenInput.addEventListener("input", () => { setApiToken.value = tokenInput.value; });
  function zipDetectorFields(fd) {
    if (setDetector.value === "api") {
      if (!setApiToken.value.trim()) { openDlg(cfgDlg); throw new Error("Enter your SAM 3.1 API key in Settings."); }
      fd.append("sam_token", setApiToken.value.trim());
    }
  }

  // Shared zip drop zone: drag-and-drop plus click-to-browse, sharing
  // zipInput as the fallback picker. One upload feeds both set routes.
  const zipDrop = $("zipDrop");
  function zipName() {
    const f = zipInput.files[0];
    zipDrop.innerHTML = f
      ? `Selected: <b></b> (${(f.size / 1024).toFixed(0)} KB) — drop another .zip or click to change.`
      : `Drop a <b>.zip</b> of photos here, or click to pick one.`;
    if (f) zipDrop.querySelector("b").textContent = f.name;
    clearSetResults();
  }
  if (zipDrop) {
    zipDrop.addEventListener("click", () => { if (!setBusy) zipInput.click(); });
    zipDrop.addEventListener("keydown", (e) => {
      if (!setBusy && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); zipInput.click(); }
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
      if (!setBusy && dt && dt.files && dt.files.length) {
        zipInput.files = dt.files;
        zipName();
      }
    });
  }

  batchBtn.addEventListener("click", async () => {
    const zf = zipInput.files[0];
    if (!zf) { batchOut.textContent = "Pick a zip of photos first."; return; }
    const setParsed = parsePrompts(setConcepts.value);
    const prompts = setParsed.map((p) => p.name);
    if (!prompts.length) { batchOut.textContent = "Enter at least one concept above."; return; }
    busySet(true);
    batchOut.textContent = "Processing… depth runs per photo, so a dozen images take a while.";
    try {
      const fd = new FormData();
      fd.append("zipfile", zf);
      fd.append("concepts", JSON.stringify(prompts));
      geomsField(fd, geomsMap(setParsed));
      fd.append("detector", (setDetector && setDetector.value) || "sam");
      zipDetectorFields(fd);
      locationFields(fd);
      const hdg = currentHeading();
      if (hdg != null) fd.append("heading", String(hdg));
      fd.append("hfov", hfovInput.value || "60");
      fd.append("max_range", rangeInput.value || "30");
      depthFields(fd);
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
    } finally { busySet(false); }
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
      const dep = im.depth_backend === "yolo" ? " — depth: YOLO26 (metric)"
        : im.depth_backend === "da" ? " — depth: DA (relative)" : "";
      meta.textContent = `${loc} (${im.gps_source}) — ${im.detections.length} box(es)${dep}`;
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
    $("setResultsNote").textContent = `${feats.length} mapped photo feature(s). Build 3D model to explore this ZIP in 3D.`;
    renderBatchPins(feats);
    setMapSource("photos");
  }

  mergedBtn.addEventListener("click", () => {
    const collection = selectedSetFeatures();
    if (collection?.features.length) downloadVideoArtifact(JSON.stringify(collection), "microgeo-mapped-features.geojson", "application/geo+json");
  });

  function renderBatchPins(feats) {
    const map = overviewMaps.get("batchMap");
    if (!window.L || !map) return;
    if (batchLayers) batchLayers.remove();
    if (!feats.length) return;
    batchLayers = window.L.layerGroup().addTo(map);
    const bounds = [];
    feats.forEach((f) => {
      const [lon, lat] = f.geometry.coordinates;
      const marker=window.L.marker([lat, lon], {icon:window.L.divIcon({className:'mapped-feature-tag',html:'',iconSize:[16,16],iconAnchor:[8,8]})})
        .addTo(batchLayers)
        .bindPopup(`<b>${f.properties.label} ×${f.properties.count}</b><br>merged pin`);
      marker.getElement().addEventListener('mousedown',e=>{e.preventDefault();e.stopPropagation();});
      marker.on('click',()=>editFeatureTag(f,renderBatch));
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
  let sfmViewer = null;
  let sfmLib = null;
  let sfmMap = null, sfmMapLayers = null;
  let sfmReport = null;
  $("sfmDiagnostics").addEventListener("click", () => {
    if (sfmReport) saveJson(sfmReport, "microgeo-reconstruction-diagnostics.json");
  });

  function renderSfmMap(data) {
    const note = $("sfmMapNote");
    if (sfmMapLayers) { sfmMapLayers.remove(); sfmMapLayers = null; }
    const locations = Object.entries(data.photo_locations || {}).filter(([, p]) =>
      Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
      Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
    if (!window.L) { note.textContent = "Map library unavailable. Internet access is required to load the map."; return; }
    if (!sfmMap) {
      sfmMap = window.L.map("sfmMap").setView([20, 0], 2);
      registerMap("sfmMap", sfmMap);
      new ResizeObserver(() => sfmMap.invalidateSize()).observe($("sfmMap"));
    }
    sfmMapLayers = window.L.layerGroup().addTo(sfmMap);
    const registered = new Set(data.registered || []);
    locations.forEach(([name, p]) => {
      const caption = document.createElement("span");
      caption.textContent = `${name} · ${registered.has(name) ? "Registered" : "Not registered"}`;
      window.L.circleMarker([p.lat, p.lon], {
        radius: 7, color: registered.has(name) ? "#183b68" : "#b45309", fillOpacity: 0.8,
      }).addTo(sfmMapLayers).bindPopup(caption);
    });
    if (locations.length) sfmMap.fitBounds(locations.map(([, p]) => [p.lat, p.lon]), { padding: [28, 28], maxZoom: 18 });
    else sfmMap.setView([20, 0], 2);
    note.textContent = locations.length ? `${locations.length} photo(s) with EXIF GPS. Blue: registered; amber: unregistered.` :
      "These photos contain no usable EXIF GPS. The 3D reconstruction still works.";
  }
  // Loaded cloud for viewing + export: Float32Arrays plus parallel
  // label/vote arrays (null label = unlabeled).
  let sfmData = null;
  let sfmFeatureLayer=null;
  function drawSfmMappedFeatures(){if(!sfmMap||!sfmData?.features)return;if(!sfmFeatureLayer)sfmFeatureLayer=window.L.layerGroup().addTo(sfmMap);sfmFeatureLayer.clearLayers();sfmLib.addMappedFeaturesToMap(window.L,sfmFeatureLayer,sfmData.features,f=>editFeatureTag(f,drawSfmMappedFeatures));}
  function selectedSetFeatures() {
    return setFeatureSource === "photos" ? lastBatch?.merged : sfmData?.features;
  }
  function refreshSetExport() {
    if (currentMode() !== "set-depth" && currentMode() !== "set-3d") return;
    const features = selectedSetFeatures()?.features || [];
    $("mergedBtn").disabled = !features.length || setBusy;
    $("sfmGeoBtn").disabled = !sfmData || setBusy;
    const note = $("exportNote");
    note.textContent = features.length
      ? `${features.length} mapped feature(s) from ${setFeatureSource === "photos" ? "photo mapping" : "3D label summaries"}. Point cloud downloads separately.`
      : sfmData && setFeatureSource === "model" && !sfmData.georeference?.available
        ? "Cloud ready. Mapped features need a reliable EXIF GPS fit; PLY/XYZ can still be exported."
        : "Mapped features need object labels and GPS. Build a model for PLY/XYZ export.";
  }
  function setMapSource(source) {
    setFeatureSource = source;
    $("setModelMapPanel").hidden = source !== "model";
    $("setBatchMapPanel").hidden = source !== "photos";
    $("setModelMapBtn").setAttribute("aria-pressed", String(source === "model"));
    $("setPhotoMapBtn").setAttribute("aria-pressed", String(source === "photos"));
    requestAnimationFrame(() => overviewMaps.get(source === "model" ? "sfmMap" : "batchMap")?.invalidateSize());
    refreshSetExport();
  }
  $("setModelMapBtn").addEventListener("click", () => setMapSource("model"));
  $("setPhotoMapBtn").addEventListener("click", () => setMapSource("photos"));
  function clearSetResults() {
    sfmViewer?.dispose(); sfmBookmarks?.hide();
    $("sfmBookmarksOpen").disabled=true;
    $("sfmBookmarks").hidden = true;
    lastBatch = null; sfmData = null; sfmReport = null;
    cloudMapLayers.get("sfmMap")?.remove(); cloudMapLayers.delete("sfmMap");
    sfmMapLayers?.clearLayers(); sfmFeatureLayer?.clearLayers(); batchLayers?.clearLayers();
    $("sfmEmpty").hidden = false;
    $("sfmOut").textContent = ""; $("batchOut").textContent = "";
    $("sfmDiagnostics").disabled = true;
    ["sfmCleanWrap","sfmSamBox","sfmImgWrap","sfmWarn","sfmStats","sfmLog"].forEach(id=>{$(id).hidden=true;});
    $("batchGrid").replaceChildren(); $("mergedList").replaceChildren();
    $("sfmMapNote").textContent = "Reconstruct the uploaded ZIP to align its cloud and labelled features.";
    $("setResultsNote").textContent = "Build a model to explore the cloud, or map photo features for GeoJSON.";
    refreshSetExport();
  }
  function busySet(value) {
    setBusy = value;
    ["sfmBtn","zipInput","sfmEngine","sfmUseSam"].forEach(id=>{$(id).disabled=value;});
    $("zipDrop").setAttribute("aria-disabled",String(value));
    syncSetLabellingControls(); refreshSetExport();
  }
  $("sfmEngine").addEventListener("change", () => {
    $("sfmDenseRow").hidden = $("sfmEngine").value !== "colmap";
    $("sfmBackend").hidden = $("sfmEngine").value !== "colmap";
  });

  function sfmEnsureViewer() {
    if (sfmViewer || !sfmLib) return sfmViewer;
    sfmViewer = sfmLib.createViewer($("sfmView"), $("sfmPopup"));
    sfmBookmarks = sfmLib.attachBookmarks($("sfmBookmarks"), () => sfmViewer);
    wireSfmTools();
    return sfmViewer;
  }

  function sfmToolButton(id, active) {
    const el = $(id);
    if (el) {
      el.classList.toggle("active", !!active);
      el.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  // COLMAP availability, asked once on load so a missing backend is
  // visible before a long upload rather than after it. Never fatal:
  // on a static host without the API this just says so.
  (function checkSfmBackend() {
    const el = $("sfmBackend");
    if (!el || !window.fetch) return;
    fetch("/api/health").then((r) => (r.ok ? r.json() : null)).then((h) => {
      if (!h) { el.textContent = "COLMAP status unknown (no backend reply)."; return; }
      if (h.sfm_available) {
        el.textContent = `COLMAP ready on this server (${h.sfm_backend === "cli" ? "COLMAP program" : "pycolmap"}).`;
        el.classList.add("ok");
      } else {
        el.textContent = "COLMAP is not installed on this server, so Reconstruct 3D will report it is unavailable. Batch pins above still work.";
        el.classList.add("bad");
      }
    }).catch(() => {
      el.textContent = "COLMAP status unknown (backend unreachable from here).";
    });
  })();

  function renderSfmStats(data, cloudCount, dense, nLab) {
    const stats = $("sfmStats"), warn = $("sfmWarn");
    if (stats) {
      const placed = (data.registered || []).length;
      const totalPhotos = placed + (data.unregistered || []).length;
      const ori = data.orientations || {};
      const counts = {};
      Object.values(ori).forEach((o) => { counts[o] = (counts[o] || 0) + 1; });
      const oriText = ["landscape", "portrait", "square"]
        .filter((k) => counts[k]).map((k) => `${counts[k]} ${k}`).join(", ") || "—";
      const total = dense ? (data.dense_total || 0) : (data.total_points || 0);
      const items = [
        ["Photos placed", `${placed} / ${totalPhotos}`],
        ["Points shown", total > cloudCount ? `${cloudCount} of ${total}` : String(cloudCount)],
        ["Model", data.model || (dense ? "COLMAP Dense" : "COLMAP Sparse")],
        ["Labelled points", String(nLab)],
        ["Orientations", oriText],
        ["GPU", data.gpu_used ? "Yes" : "No (CPU)"],
      ];
      if (data.diagnostics) {
        items.push(["Camera calibrations", String(data.diagnostics.camera_count)]);
        const error = data.diagnostics.mean_reprojection_error_px;
        items.push(["Mean reprojection", Number.isFinite(error) ? `${error.toFixed(2)} px` : "Unavailable"]);
      }
      stats.innerHTML = "";
      items.forEach(([k, v]) => {
        const cell = document.createElement("div");
        cell.className = "stat";
        const key = document.createElement("span");
        key.className = "stat-k";
        key.textContent = k;
        const val = document.createElement("span");
        val.className = "stat-v";
        val.textContent = v;
        cell.appendChild(key);
        cell.appendChild(val);
        stats.appendChild(cell);
      });
      stats.hidden = false;
    }
    if (warn) {
      const list = data.warnings || [];
      warn.innerHTML = "";
      list.forEach((w) => {
        const li = document.createElement("li");
        li.textContent = String(w);
        warn.appendChild(li);
      });
      warn.hidden = list.length === 0;
    }
  }

  // Toolbar: orbit / identify modes, photo/class colors, export dialog.
  function wireSfmTools() {
    const orbit = $("toolOrbit"), ident = $("toolIdentify");
    if (orbit) orbit.addEventListener("click", () => {
      sfmViewer.setTool("orbit");
      sfmToolButton("toolOrbit", true);
      sfmToolButton("toolIdentify", false);
    });
    if (ident) ident.addEventListener("click", () => {
      sfmViewer.setTool("identify");
      sfmToolButton("toolOrbit", false);
      sfmToolButton("toolIdentify", true);
    });
    const colorSel = $("toolColorMode");
    if (colorSel) colorSel.addEventListener("change", () => {
      if (sfmViewer) sfmViewer.setColorMode(colorSel.value);
    });
    const sizeSel = $("sfmPointSize");
    $("sfmBrightness").addEventListener("input", () => sfmViewer?.setBrightness($("sfmBrightness").value));
    if (sizeSel) sizeSel.addEventListener("input", () => {
      const v = parseFloat(sizeSel.value) || 1;
      const val = $("sfmPointSizeVal");
      if (val) val.textContent = `${v}×`;
      if (sfmViewer) sfmViewer.setPointSize(v);
    });
    const reset = $("toolReset");
    if (reset) reset.addEventListener("click", () => {
      if (sfmViewer) sfmViewer.fitBounds();
    });
    $("toolTop").addEventListener("click", () => sfmViewer?.topView());
    $("toolResetRoll").addEventListener("click", () => sfmViewer?.resetRoll());
    $("toolZoomIn").addEventListener("click", () => sfmViewer?.zoomBy(1.25));
    $("toolZoomOut").addEventListener("click", () => sfmViewer?.zoomBy(.8));
    function expand(value) {
      $("sfmWrap").classList.toggle("expanded", value);
      document.body.classList.toggle("viewer-expanded", value);
      // Icon button: update the accessible label, not the whole content
      // (which holds the SVG icon + visually-hidden text).
      const label = value ? "Restore viewer" : "Expand viewer";
      const vh = $("toolExpand").querySelector(".vh");
      if (vh) vh.textContent = label;
      $("toolExpand").setAttribute("aria-label", label);
      $("toolExpand").setAttribute("aria-pressed", String(value));
    }
    $("toolExpand").addEventListener("click", () => expand(!$("sfmWrap").classList.contains("expanded")));
    document.addEventListener("keydown", e => { if (e.key === "Escape") expand(false); });
    const exp = $("toolExport");
    if (exp) exp.addEventListener("click", () => {
      if (!sfmData) { sfmOut.textContent = "Reconstruct a cloud first, then export it."; return; }
      $("sfmExportInfo").textContent =
        `${sfmData.count} points loaded${sfmData.dense ? " (dense)" : " (sparse)"}.`;
      openDlg($("sfmExportDlg"));
    });
    const close = $("sfmExportClose");
    if (close) close.addEventListener("click", () => { $("sfmExportDlg").close(); });
    const go = $("sfmExportGo");
    if (go) go.addEventListener("click", sfmExportDownload);
  }

  $("sfmView").addEventListener('viewer-tool-change',e=>{sfmToolButton('toolOrbit',e.detail.tool==='orbit');sfmToolButton('toolIdentify',e.detail.tool==='identify');});
  $("sfmRenderMode").onchange=()=>sfmViewer?.setRenderMode($("sfmRenderMode").value);
  $("sfmDensify").oninput=()=>{ $("sfmDensifyVal").textContent='x'+$("sfmDensify").value;sfmViewer?.setDensify($("sfmDensify").value);};
  $("sfmView").addEventListener('viewer-display-change',e=>{const d=e.detail;$("sfmRenderMode").value=d.mode;$("sfmDensify").value=d.densify;$("sfmDensifyVal").textContent='x'+d.densify;$("sfmDensify").disabled=d.mode!=='points';$("sfmGeometryInfo").textContent=geometrySummary(d);});
  // SAM stage box: the per-image boxes that fed 3D label voting,
  // shown before the 3D view. data.detections maps image name (or
  // basename) to [{label, box, score}]. Every box is listed with its
  // score and original-pixel coordinates, plus the raw payload.
  function renderSfmSam(data, detector) {
    const boxEl = $("sfmSamBox"), note = $("sfmSamNote"), list = $("sfmSamList");
    if (!boxEl) return;
    if (data.label_objects === false) { boxEl.hidden = true; list.innerHTML = ""; return; }
    const dets = (data && data.detections) || {};
    const names = Object.keys(dets).sort();
    const total = names.reduce((n, k) => n + (dets[k] || []).length, 0);
    boxEl.hidden = false;
    list.innerHTML = "";
    if (!total) {
      note.textContent = "No object detections were returned. The cloud below is unlabelled; check the reconstruction notes for any detector errors.";
      return;
    }
    note.textContent = `${total} box(es) from ${detector} across ` +
      `${names.length} photo(s) — these voted the 3D point labels. ` +
      `Boxes are [x1, y1, x2, y2] in original photo pixels.`;
    const MAX_PER_IMAGE = 8;
    names.forEach((key) => {
      const items = dets[key] || [];
      const base = key.split("/").pop();
      const li = document.createElement("li");
      const head = document.createElement("b");
      head.textContent = `${base} — ${items.length} box(es)`;
      li.appendChild(head);
      const sub = document.createElement("ul");
      items.slice(0, MAX_PER_IMAGE).forEach((d) => {
        const label = String((d && d.label) || "object");
        const s = d && typeof d.score === "number" ? ` @ ${d.score.toFixed(2)}` : "";
        const b = d && Array.isArray(d.box)
          ? ` [${d.box.slice(0, 4).map((v) => Math.round(Number(v))).join(", ")}]` : "";
        const row = document.createElement("li");
        row.textContent = `${label}${s}${b}`;
        sub.appendChild(row);
      });
      if (items.length > MAX_PER_IMAGE) {
        const more = document.createElement("li");
        more.textContent = `…and ${items.length - MAX_PER_IMAGE} more (see raw JSON).`;
        sub.appendChild(more);
      }
      li.appendChild(sub);
      list.appendChild(li);
    });
    const raw = document.createElement("li");
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Raw SAM detections JSON";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(dets, null, 1);
    det.appendChild(sum);
    det.appendChild(pre);
    raw.appendChild(det);
    list.appendChild(raw);
  }

  // SAM image viewer: every set photo as a thumbnail with its boxes
  // drawn over it, so the label stage can be checked by eye before
  // the 3D cloud. Boxes are original-pixel; thumbnails are scaled
  // by the server-sent sizes. Detection keys are matched by basename
  // (explicit detections may carry subfolder paths).
  function renderSfmSamImages(data) {
    const wrap = $("sfmImgWrap"), grid = $("sfmImgGrid");
    if (!wrap || !grid) return;
    if (data.label_objects === false) { wrap.hidden = true; grid.innerHTML = ""; return; }
    const thumbs = (data && data.thumbnails) || {};
    const sizes = (data && data.image_sizes) || {};
    const orient = (data && data.orientations) || {};
    const placed = new Set((data && data.registered) || []);
    const dets = (data && data.detections) || {};
    const byBase = {};
    Object.keys(dets).forEach((k) => {
      const b = k.split("/").pop();
      (byBase[b] = byBase[b] || []).push(...(dets[k] || []));
    });
    const names = [...new Set([...Object.keys(thumbs), ...Object.keys(byBase)])].sort();
    grid.innerHTML = "";
    if (!names.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    names.forEach((base) => {
      const items = byBase[base] || [];
      const cell = document.createElement("figure");
      cell.className = "sam-cell";
      const cv = document.createElement("canvas");
      const cap = document.createElement("figcaption");
      const sz = sizes[base];
      const meta = [orient[base] || null,
        sz ? `${sz[0]}×${sz[1]}` : null,
        placed.has(base) ? "placed" : "not placed"].filter(Boolean).join(" · ");
      cap.textContent = `${base} — ${items.length} box(es) (${meta})`;
      cap.className = placed.has(base) ? "placed" : "not-placed";
      cell.appendChild(cv);
      cell.appendChild(cap);
      grid.appendChild(cell);
      const url = thumbs[base];
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        cv.width = img.naturalWidth;
        cv.height = img.naturalHeight;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const size = sizes[base] || [img.naturalWidth, img.naturalHeight];
        if (!size[0] || !size[1]) return;
        const sx = cv.width / size[0], sy = cv.height / size[1];
        paintBoxes(ctx, items.filter((d) => d && Array.isArray(d.box) && d.box.length >= 4).map((d) => ({
          label: String(d.label || "object"),
          score: typeof d.score === "number" ? d.score : null,
          x1: d.box[0] * sx, y1: d.box[1] * sy,
          x2: d.box[2] * sx, y2: d.box[3] * sy,
        })), cv.width);
      };
      img.src = url;
    });
  }

  function renderSfmCleanImages(data) {
    const grid = $("sfmCleanGrid");
    grid.innerHTML = "";
    const thumbnails = Object.entries(data.thumbnails || {});
    $("sfmCleanWrap").hidden = !thumbnails.length;
    thumbnails.forEach(([name, url]) => {
      const figure = document.createElement("figure");
      figure.className = "sam-cell";
      const image = document.createElement("img");
      image.src = url;
      image.alt = `Unlabelled reconstruction input: ${name}`;
      image.loading = "lazy";
      const caption = document.createElement("figcaption");
      caption.textContent = name;
      figure.append(image, caption);
      grid.appendChild(figure);
    });
  }

  function sfmExportDownload() {
    if (!sfmData || !sfmLib) return;
    const pctEl = document.querySelector('input[name="expPct"]:checked');
    const fmtEl = document.querySelector('input[name="expFmt"]:checked');
    const pct = pctEl ? parseFloat(pctEl.value) : 50;
    const fmt = fmtEl ? fmtEl.value : "xyz";
    const idx = sfmLib.sampleIndex(sfmData.count, pct);
    let text, ext, mime;
    if (fmt === "ply") {
      text = sfmLib.buildPlyText(sfmData.positions, sfmData.colors, sfmData.labels, idx);
      ext = "ply"; mime = "text/plain";
    } else if (fmt === "geojson") {
      text = sfmLib.buildGeoJson(sfmData.positions, sfmData.colors, sfmData.labels, sfmData.votes, idx, sfmData.georeference?.available ? sfmData.georeference : null);
      ext = "geojson"; mime = "application/geo+json";
    } else {
      text = sfmLib.buildXyzText(sfmData.positions, sfmData.colors, sfmData.labels, idx);
      ext = "xyz"; mime = "text/plain";
    }
    const blob = new Blob([text], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `microgeo-cloud-${idx.length}pts.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    $("sfmExportDlg").close();
    sfmOut.textContent = `Exported ${idx.length} point(s) as ${ext}.`;
  }

  if (sfmBtn) sfmBtn.addEventListener("click", async () => {
    const zf = zipInput.files[0];
    if (!zf) { sfmOut.textContent = "Pick a zip of photos above first."; return; }
    const wantLabels = $("sfmUseSam").checked;
    const parsedConcepts = parsePrompts(setConcepts.value);
    const concepts = wantLabels ? parsedConcepts.map(p => p.name) : [];
    const wantDense = $("sfmDense") && $("sfmDense").checked;
    // Progress UI: bar + scrolling log of the live server lines, so a
    // long reconstruction reads as working, not crashed. Cleared here,
    // filled from the stream below, hidden again when done.
    const prog = $("sfmProg"), logBox = $("sfmLog");
    const logLines = [];
    const t0 = Date.now();
    let stagePct = 5, stageLabel = "Reconstructing from unlabelled photos";
    let lastPaint = 0;
    const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`;
    const paintProgress = () => {
      if (prog) { prog.hidden = false; prog.value = stagePct; }
      sfmOut.textContent = `${stageLabel}… (${elapsed()} elapsed)`;
      lastPaint = Date.now();
    };
    const pushLog = (line) => {
      logLines.push(line);
      if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
      if (logBox) {
        logBox.hidden = false;
        logBox.textContent = logLines.slice(-20).join("\n");
        logBox.scrollTop = logBox.scrollHeight;
      }
    };
    // Stage words from the server markers and raw COLMAP lines.
    const stageOf = (line) => {
      const l = line.toLowerCase();
      if (l.includes("labelling copies")) return [97, "Labelling separate photo copies"];
      if (l.indexOf("undistort") >= 0) return [72, "Undistorting for dense stereo"];
      if (l.indexOf("patch_match") >= 0 || l.indexOf("dense stereo matching") >= 0) return [80, "Dense stereo matching"];
      if (l.indexOf("fus") >= 0) return [94, "Fusing depth maps"];
      if (l.indexOf("extract") >= 0) return [12, "Extracting features"];
      if (l.indexOf("match") >= 0) return [40, "Matching features"];
      if (l.indexOf("map") >= 0) return [62, "Mapping cameras"];
      return null;
    };
    if ($("sfmSamBox")) $("sfmSamBox").hidden = true;
    if ($("sfmImgWrap")) $("sfmImgWrap").hidden = true;
    $("sfmCleanWrap").hidden = true;
    if ($("sfmStats")) $("sfmStats").hidden = true;
    if ($("sfmWarn")) $("sfmWarn").hidden = true;
    busySet(true);
    paintProgress();
    try {
      const detectorUsed = (setDetector && setDetector.value) || "sam";
      const fd = new FormData();
      fd.append("zipfile", zf);
      fd.append("concepts", JSON.stringify(concepts));
      fd.append("label_objects", wantLabels ? "1" : "0");
      fd.append("reconstruction_engine", $("sfmEngine").value);
      fd.append("detector", detectorUsed);
      if (concepts.length) zipDetectorFields(fd);
      fd.append("dense", wantDense ? "1" : "0");
      fd.append("use_gpu", ($("sfmCpu") && $("sfmCpu").checked) ? "0" : "1");
      // The reply streams NDJSON: {type:"log"} lines while COLMAP
      // runs, then one {type:"result"} with the payload (or error).
      const res = await fetch("/api/sfm", { method: "POST", body: fd });
      if (res.status === 503) {
        let why = "";
        try { why = (await res.json()).error || ""; } catch (e) { /* plain 503 */ }
        sfmOut.textContent = "3D unavailable: " + (why ||
          "the server has no COLMAP installed (install the COLMAP CLI or pycolmap to enable /api/sfm).") +
          " Batch detection + map pins above keep working.";
        return;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: request failed`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", data = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (value) buf += dec.decode(value, { stream: true });
        let idx, finished = false;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg = null;
          try { msg = JSON.parse(line); } catch (e) { continue; }
          if (!msg || msg.type === "ping") continue;
          if (msg.type === "log") {
            pushLog(String(msg.line));
            const st = stageOf(String(msg.line));
            if (st && (st[0] !== stagePct || st[1] !== stageLabel)) {
              stagePct = st[0]; stageLabel = st[1];
              paintProgress();
            } else if (Date.now() - lastPaint > 5000) {
              paintProgress(); // elapsed keeps ticking on quiet stretches
            }
          } else if (msg.type === "result") {
            data = msg.data || {};
            finished = true;
            break;
          }
        }
        if (finished || done) break;
      }
      if (!data) throw new Error("the 3D stream ended before any result arrived");
      if (data.error) throw new Error(data.error);
      sfmReport = {diagnostics: data.diagnostics, cameras: data.cameras,
        georeference: data.georeference,
        registered: data.registered, unregistered: data.unregistered, warnings: data.warnings,
        label_objects: data.label_objects, colmap_inputs_annotated: data.colmap_inputs_annotated};
      $("sfmDiagnostics").disabled = false;
      renderSfmMap(data);
      renderSfmCleanImages(data);
      try {
        sfmLib = sfmLib || await import("./sfm3d.js");
      } catch (e) {
        sfmOut.textContent = "3D data arrived, but the local viewer files could not load. Rebuild the container and refresh the page.";
        return;
      }
      // Dense cloud preferred; sparse fallback when stereo failed.
      const dense = !!data.dense_ply;
      const cloud = sfmLib.parsePly(dense ? data.dense_ply : data.ply);
      if (!cloud.count) throw new Error("the server returned an empty point cloud");
      const labelsRaw = dense ? (data.dense_labels || {}) : (data.point_labels || {});
      const labels = [], votes = [];
      for (let i = 0; i < cloud.count; i++) {
        const info = labelsRaw[String(i)];
        labels.push(info ? info.label : null);
        votes.push(info ? (info.votes || 0) : 0);
      }
      sfmData = {
        positions: cloud.positions, colors: cloud.colors,
        labels, votes, count: cloud.count, dense, georeference: data.georeference,
        features: sfmLib.buildMappedFeatures(cloud.positions, labels, votes, data.georeference, geomsMap(parsedConcepts)),
      };
      const viewer = sfmEnsureViewer();
      sfmBookmarks.setScene(cloud.positions);
      $("sfmBookmarks").hidden = false;
      viewer.setCloud(cloud.positions, cloud.colors,
        sfmLib.labeledColors(cloud.count, dense ? (data.dense_labels || {}) : (data.point_labels || {})),
        labels, votes, data.cameras || [], data.georeference);
      const sourcePhotos=reconstructionPhotos(data);
      viewer.setPhotoSources(data.cameras||[],sourcePhotos);
      $("sfmRenderMode").querySelector('[value="mosaic"]').disabled=!sourcePhotos.length;
      viewer.setDensify($("sfmDensify").value);viewer.setRenderMode($("sfmRenderMode").value);
      viewer.setColorMode($("toolColorMode").value);
      viewer.setBrightness($("sfmBrightness").value);
      viewer.setPointSize(Number($("sfmPointSize").value));
      updateCloudMap("sfmMap", cloud, data.georeference, sfmLib);
      const reference = data.georeference;
      $("sfmMapNote").textContent += reference?.available
        ? ` Cloud aligned using ${reference.photos_used.length} photos; GPS fit RMS ${reference.rms_m.toFixed(2)} m.${reference.altitude_assumed_level ? " Camera heights assumed level." : ""}`
        : ` ${reference?.reason || "No geographic cloud alignment available."}`;
      drawSfmMappedFeatures();
      setMapSource("model");
      $("sfmEmpty").hidden = true;
      const unreg = (data.unregistered || []).length;
      const nLab = labels.filter(Boolean).length;
      const total = dense ? (data.dense_total || 0) : (data.total_points || 0);
      sfmOut.textContent = `Done — ${cloud.count} 3D point(s)` +
        (total > cloud.count ? ` (from ${total}${dense ? " dense" : ""})` : "") +
        ` [${data.model || (dense ? "COLMAP Dense" : "COLMAP Sparse")}]` +
        ` from ${(data.registered || []).length} placed photo(s)` +
        (unreg ? `, ${unreg} photo(s) COLMAP could not place — they are named in the photo grid below` : "") +
        (concepts.length ? `, ${nLab} labelled point(s)` : ", unlabelled cloud") +
        (data.gpu_used ? " (GPU)." : ".") +
        ((data.warnings || []).length ? " See notes below." : "");
      $("setResultsNote").textContent = `${data.model || (dense ? "COLMAP Dense" : "COLMAP Sparse")} | ${cloud.count.toLocaleString()} points | ${sfmData.features.features.length} mapped label summaries`;
      renderSfmStats(data, cloud.count, dense, nLab);
      renderSfmSam(data, detectorUsed === "api" ? "Meta API SAM 3.1" : detectorUsed === "clip" ? "Local CLIP" : "Server SAM 3");
      renderSfmSamImages(data);
    } catch (e) {
      sfmOut.textContent = `Error: ${e.message}`;
    } finally {
      busySet(false);
      if (prog) prog.hidden = true;
    }
  });

  // Photo + video workflow (/api/video-cloud): DA3 cloud -> tagged
  // features -> map pins. Self-contained; the other routes are untouched.
  const videoZip = $("videoZip"), videoConcepts = $("videoConcepts"),
    videoDetector = $("videoDetector"), videoToken = $("videoToken"),
    videoTokenRow = $("videoTokenRow"), videoSnap = $("videoSnap"),
    videoBtn = $("videoBtn"), videoOut = $("videoOut"),
    videoProg = $("videoProg"), videoLog = $("videoLog"),
    videoFeatures = $("videoFeatures"), videoExportBtn = $("videoExportBtn"),
    videoMapNote = $("videoMapNote");
  let videoViewer = null, videoSecondViewer = null, videoLib = null, videoMap = null, videoMarkers = null;
  let videoData = null, videoCloud = null;
  let videoHintsForCurrentData=true;
  const locationHints=window.MGLocationHints.create({getMap:()=>videoMap,getData:()=>videoData,
    isSurvey:()=>document.body.dataset.mode==='video-survey',
    getVideoFile:()=>$('videoOnly').files[0],getToken:()=>tokenInput.value.trim(),
    onChange:value=>{if(videoHintsForCurrentData&&videoData)videoData.location_hint=value;}});
  // A single Settings key is shared immediately across every API workflow.
  videoToken.value = tokenInput.value;
  [tokenInput, setApiToken, videoToken].forEach(input => input.addEventListener("input", () => {
    [tokenInput, setApiToken, videoToken].forEach(other => { other.value = input.value; });
    try { localStorage.setItem("mg.token", input.value); } catch (_) { /* private mode */ }
  }));
  $("sfmGeoBtn").addEventListener("click", () => {
    if (!sfmData) return;
    $("sfmExportInfo").textContent = `${sfmData.count.toLocaleString()} points. PLY/XYZ preserve the reconstruction coordinate frame.`;
    openDlg($("sfmExportDlg"));
  });

  $("videoUseSam").addEventListener("change", () => {const hide=currentMode()==="video-survey"&&!$("videoUseSam").checked;[videoConcepts,videoDetector].forEach(el=>el.closest("label").hidden=hide);});
  videoDetector.addEventListener("change", () => {
    videoTokenRow.hidden = true;
  });

  async function readNdjson(res, onLog, onEvent) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", result = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.type === "log" && onLog) onLog(m.line);
        else if (m.type === "result") result = m.data;
        else if(onEvent)onEvent(m);
      }
      if (done) break;
    }
    return result;
  }

  videoBtn.addEventListener("click", async () => {
    const surveyMode = currentMode() === "video-survey";
    const zf = surveyMode ? $("videoOnly").files[0] : videoZip.files[0];
    if (!zf) { videoOut.textContent = surveyMode ? "Pick a video first." : "Pick the zip (1 photo + 1 video) first."; return; }
    const useLabels = !surveyMode || $("videoUseSam").checked;
    if (useLabels && videoDetector.value === "api" && !tokenInput.value.trim()) {
      openDlg(cfgDlg); videoOut.textContent = "Enter your SAM 3.1 API key in Settings."; return;
    }
    const parsed = useLabels ? parsePrompts(videoConcepts.value) : [];
    const hintToken=tokenInput.value.trim();
    videoHintsForCurrentData=false;locationHints.reset();
    const fd = new FormData();
    fd.append(surveyMode ? "video" : "zipfile", zf);
    fd.append("concepts", JSON.stringify(parsed.map((p) => p.name)));
    fd.append("max_frames", $("videoMaxFrames").value || "16");
    fd.append("max_points", $("videoMaxPoints").value || "1000000");
    fd.append("sample_fps", $("videoSampleFps").value || "10");
    fd.append("resolution", $("videoResolution").value || "low");
    fd.append("gaussians", $("videoOutput").value === "gaussians" ? "1" : "0");
    fd.append("consistency", $("videoConsistency").checked ? "1" : "0");
    fd.append("filter_black", $("videoFilterBlack").checked ? "1" : "0");
    fd.append("skip_titles", $("videoSkipTitles").checked ? "1" : "0");
    fd.append("locate_hint", surveyMode&&$("videoLocateHint").checked ? "1" : "0");
    geomsField(fd, geomsMap(parsed));
    fd.append("detector", videoDetector.value || "sam");
    if (videoDetector.value === "api") fd.append("sam_token", tokenInput.value.trim());
    if (videoSnap.checked) fd.append("snap", "1");
    videoBtn.disabled = true;
    videoProg.hidden = false;
    videoLog.hidden = false;
    videoLog.textContent = "";
    videoOut.textContent = "Building…";
    try {
      const res = await fetch("/api/video-cloud", { method: "POST", body: fd });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); msg = j.error || msg; } catch (e) { /* keep status */ }
        throw new Error(msg);
      }
      const data = await readNdjson(res, (line) => {
        videoLog.textContent += line + "\n";
        videoLog.scrollTop = videoLog.scrollHeight;
      },message=>{if(surveyMode&&message.type==='location_hint_frame')void locationHints.locate(message.data.url,hintToken,message.data.time_s);});
      if (!data) throw new Error("the video stream ended before any result arrived");
      if (data.error) throw new Error(data.error);
      data.location_hint=locationHints.snapshot();videoData = data;videoHintsForCurrentData=true;
      await renderVideoResult(data);
      await attachVideoSurvey();
    } catch (e) {
      videoOut.textContent = `Error: ${e.message}`;
    } finally {
      videoBtn.disabled = false;
      videoProg.hidden = true;
    }
  });

  async function renderVideoResult(data) {
    // 3D cloud via the shared SfM viewer stack (read-only reuse).
    videoLib = videoLib || await import("./sfm3d.js");
    const cloud = videoLib.parsePly(data.ply || "");
    if (!cloud.count) throw new Error("the server returned an empty point cloud");
    videoCloud = cloud;
    const raw = data.point_labels || {};
    const labels = [], votes = [];
    for (let i = 0; i < cloud.count; i++) {
      const info = raw[String(i)];
      labels.push(info ? info.label : null);
      votes.push(info ? (info.votes || 0) : 0);
    }
    if (!videoViewer) {
      videoViewer = videoLib.createViewer($("videoView"), $("videoPopup"));
      videoBookmarks = videoLib.attachBookmarks($("videoBookmarks"), () => videoViewer);
    }
    videoBookmarks.setScene(cloud.positions);
    videoViewer.setCloud(cloud.positions, cloud.colors,
      videoLib.labeledColors(cloud.count, raw), labels, votes, data.cameras || [], data.georeference);
    videoViewer.setColorMode($("videoColorMode").value);
    videoViewer.setCamerasVisible($("videoShowCameras").checked);
    videoViewer.setPointSize(Number($("videoPointSize").value));
    videoViewer.setBrightness($("videoBrightness").value);
    const sourcePhotos=reconstructionPhotos(data);
    videoViewer.setPhotoSources(data.cameras||[],sourcePhotos);
    videoViewer.setDensify($("videoDensify").value);
    $("videoRenderMode").querySelector('[value="mosaic"]').disabled=!sourcePhotos.length;
    videoViewer.setGaussians(data.gaussians || null);
    $("videoRenderMode").querySelector('[value="gaussians"]').disabled = !data.gaussians;
    $("videoRenderMode").value = data.gaussians ? "gaussians" : "points";
    videoViewer.setRenderMode($("videoRenderMode").value);
    videoViewer.setCameraSettings({metric:!!data.metric,depthScale:data.georeference?.scale_m_per_unit||1,depthMin:0,depthMax:Infinity});
    videoViewer.fitBounds();
    if (!videoSecondViewer) videoSecondViewer = videoLib.createViewer($("videoSecondView"));
    videoSecondViewer.setCloud(cloud.positions, cloud.colors,
      videoLib.labeledColors(cloud.count, raw), labels, votes, data.cameras || [], data.georeference);
    videoSecondViewer.setPhotoSources(data.cameras||[],sourcePhotos);
    videoSecondViewer.setRenderMode('points');videoSecondViewer.setDensify($("videoDensify").value);
    videoSecondViewer.setColorMode($("videoColorMode").value);
    videoSecondViewer.setCamerasVisible($("videoShowCameras").checked);
    videoSecondViewer.setPointSize(Number($("videoPointSize").value));
    videoSecondViewer.setBrightness($("videoBrightness").value);
    videoSecondViewer.setPreset($("videoSecondPreset").value);
    videoSecondViewer.setCameraSettings({metric:!!data.metric,depthScale:data.georeference?.scale_m_per_unit||1,depthMin:0,depthMax:Infinity});
    videoSecondViewer.setLinkedCamera({getPose:()=>videoViewer?.getPose(),onChange:pose=>videoViewer?.flyTo(pose,1)});
    $("videoSecondEmpty").hidden = true;
    document.body.classList.add("has-video-cloud");
    if(currentMode()==="video-survey") $("videoSetup").open=false;
    $("videoEmpty").hidden = true;
    $("videoPlyBtn").disabled = false;
    $("videoDiagnosticsBtn").disabled = false;
    const feats = data.features || [];
    videoFeatures.hidden = currentMode() === "video-survey";
    videoFeatures.innerHTML = "";
    if (!feats.length) {
      videoFeatures.innerHTML = '<li class="hint">No map features — no photo EXIF fix/heading, or no concept boxes matched the cloud.</li>';
    }
    feats.forEach((f) => {
      const li = document.createElement("li");
      const pin = f.snapped || f;
      li.textContent = `${f.label} (${f.geom}) — ${f.count} pts — ` +
        `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)} · ${f.distance_m} m @ ${f.bearing_deg}°` +
        (f.snapped ? ` → snapped outline ${f.snapped.lat.toFixed(6)}, ${f.snapped.lon.toFixed(6)}` : "");
      li.title = "Click to centre the map";
      li.style.cursor = "pointer";
      li.addEventListener("click", () => {
        if (videoMap) videoMap.setView([pin.lat, pin.lon], 20);
      });
      videoFeatures.appendChild(li);
    });
    renderVideoMap(data);
    updateCloudMap("videoMap", cloud, data.georeference, videoLib);
    videoMapNote.textContent += data.georeference?.available
      ? " Metric cloud overlaid using the photo GPS and heading; first view assumed level."
      : ` ${data.georeference?.reason || "No geographic alignment available."}`;
    if(currentMode()==="video-survey"&&!data.georeference?.available)videoMapNote.textContent="Add cloud/map control pairs to register this cloud.";
    videoExportBtn.disabled = !feats.length;
    $("videoCloudGeoBtn").disabled = false;
    const nLab = labels.filter(Boolean).length;
    videoOut.textContent = `Done — ${cloud.count} point(s) from ${data.frames} frame(s)` +
      (data.mock ? " (mock DA3)" : "") +
      (data.diagnostics?.device ? ` · ${data.diagnostics.device}` : "") +
      `, ${nLab} labelled, ${feats.length} map feature(s) · ${data.model || "DA3"}` +
      (data.warnings && data.warnings.length ? `. ${data.warnings.join(" ")}` : ".");
  }

  let videoSurvey = null, surveyMarkers = null;
  async function attachVideoSurvey() {
    $("secVideo").insertBefore($("videoSurveyTools"),$("secVideo").querySelector(".video-result-layout"));
    if (!videoSurvey) {
      const {createVideoSurvey} = await import("./video-survey.js");
      videoSurvey = createVideoSurvey({host: $("videoSurveyTools"),
        getContext: () => ({viewer: videoViewer, viewers: [videoViewer,videoSecondViewer], cloud: videoCloud, data: videoData, map: videoMap}),
        onReference: reference => {
          videoData.georeference = reference;
          videoViewer.setMeasurement([]);
          videoSecondViewer?.setMeasurement([]);
          [videoViewer,videoSecondViewer].forEach(v=>v?.setGroundReference(reference));
          [videoViewer,videoSecondViewer].forEach(v=>v?.setCameraSettings({depthScale:reference.scale_m_per_unit||1,metric:reference.available||!!videoData.metric,depthMin:0,depthMax:Infinity}));
          updateCloudMap("videoMap", videoCloud, reference, videoLib);
          videoMapNote.textContent = reference.available ? `Manual registration - RMS ${reference.rms_m.toFixed(2)} m. ${reference.method}` : reference.reason;
        },
        onTags: features => {
          if (!videoMap) return;
          if (!surveyMarkers) surveyMarkers = window.L.layerGroup().addTo(videoMap);
          surveyMarkers.clearLayers();
          features.forEach((f,i) => {if(!f.geometry?.coordinates)return;const text=document.createElement("span");text.textContent=`${f.properties.name} / ${f.properties.indoor ? "Indoor / floor " + f.properties.floor : "Outdoor"}`;
            const isReview=f.properties.feature_type==='image_question';
            const marker=window.L.marker([f.geometry.coordinates[1],f.geometry.coordinates[0]],{draggable:!isReview,icon:window.L.divIcon({className:isReview?'survey-review-marker':'survey-tag-marker',html:'',iconSize:[14,14]})}).addTo(surveyMarkers).bindTooltip(text);
            if(isReview){const answer=document.createElement('pre');answer.textContent=JSON.stringify(f.properties.spark_answer,null,2);marker.bindPopup(answer);return;}
            marker.on('click',()=>videoSurvey.editTag(i));marker.on('dragend',()=>{const p=marker.getLatLng();videoSurvey.moveTag(i,p.lat,p.lng);});});
        }});
    }
    videoSurvey.attach(); videoSurvey.reset();
  }

  $("videoShowCameras").addEventListener("change", () => {
    videoViewer?.setCamerasVisible($("videoShowCameras").checked);
    videoSecondViewer?.setCamerasVisible($("videoShowCameras").checked);
  });
  [$("videoView"),$("videoSecondView")].forEach(host=>host.addEventListener('viewer-tool-change',e=>{if(currentMode()==='video-survey'&&videoSurvey)videoSurvey.setTool(e.detail.tool,e.detail.anchor);else [videoViewer,videoSecondViewer].forEach(view=>view?.setTool(e.detail.tool));}));
  $("videoDensify").oninput=()=>{const multiplier=$("videoDensify").value;$("videoDensifyVal").textContent='x'+multiplier;videoViewer?.setDensify(multiplier);videoSecondViewer?.setDensify(multiplier);};
  $("videoView").addEventListener('viewer-display-change',e=>{const d=e.detail;$("videoRenderMode").value=d.mode;$("videoDensify").value=d.densify;$("videoDensifyVal").textContent='x'+d.densify;$("videoDensify").disabled=d.mode!=='points';$("videoGeometryInfo").textContent=geometrySummary(d);});
  $("videoPointSize").addEventListener("input", () => {
    videoViewer?.setPointSize(Number($("videoPointSize").value));
    videoSecondViewer?.setPointSize(Number($("videoPointSize").value));
  });
  $("videoColorMode").addEventListener("change", () => {
    if ($("videoColorMode").value === "class" && $("videoRenderMode").value === "gaussians") { $("videoRenderMode").value = "points"; videoViewer?.setRenderMode("points"); }
    videoViewer?.setColorMode($("videoColorMode").value);
    videoSecondViewer?.setColorMode($("videoColorMode").value);
  });
  $("videoBrightness").addEventListener("input", () => {videoViewer?.setBrightness($("videoBrightness").value);videoSecondViewer?.setBrightness($("videoBrightness").value);});
  $("videoRenderMode").addEventListener("change", () => {
    if ($("videoRenderMode").value === "gaussians" && $("videoColorMode").value === "class") { $("videoColorMode").value = "photo"; videoViewer?.setColorMode("photo"); }
    videoViewer?.setRenderMode($("videoRenderMode").value);
  });
  $("videoFit").addEventListener("click", () => { videoViewer?.cancelFlight(); videoViewer?.fitBounds(); });
  $("videoSecondFloat").onclick=()=>floatVideoOverview();
  $("videoSecondPreset").addEventListener("change", () => videoSecondViewer?.setPreset($("videoSecondPreset").value));
  $("videoSecondCopy").addEventListener("click", () => {const pose=videoViewer?.getPose();if(pose)videoSecondViewer?.flyTo(pose,300);});
  let currentVideoProjectId=null,currentVideoProjectName='',projectStatusTimer=null;
  const projectSettingIds=['videoColorMode','videoBrightness','videoShowCameras','videoSecondPreset','videoPointSize','videoRenderMode','videoDensify','videoOutput','videoConcepts','videoDetector','videoMaxFrames','videoMaxPoints','videoSampleFps','videoResolution','videoUseSam','videoConsistency','videoFilterBlack','videoSkipTitles','videoLocateHint'];
  function videoProjectSettings(){return Object.fromEntries(projectSettingIds.map(id=>{const el=$(id);return [id,el.type==='checkbox'?el.checked:el.value];}));}
  function restoreVideoProjectSettings(settings){for(const [id,value] of Object.entries(settings||{})){if(!projectSettingIds.includes(id))continue;const el=$(id);if(el.type==='checkbox')el.checked=!!value;else el.value=value;}$("videoUseSam").dispatchEvent(new Event('change'));}
  async function projectStore(){return (await import('./project-store.js')).projectStore;}
  function projectStatus(message){const el=$("videoProjectStatus");el.textContent=message;el.classList.add('show');clearTimeout(projectStatusTimer);projectStatusTimer=setTimeout(()=>el.classList.remove('show'),5000);}
  function requestProjectName(title,name='',confirm='Save'){
    const dialog=$("videoProjectNameDialog"),input=$("videoProjectName");$("videoProjectNameTitle").textContent=title;$("videoProjectNameConfirm").textContent=confirm;input.value=name;input.setCustomValidity('');
    return new Promise(resolve=>{let result=null;dialog.onclose=()=>resolve(result);$("videoProjectNameCancel").onclick=()=>dialog.close();
      input.oninput=()=>input.setCustomValidity('');$("videoProjectNameForm").onsubmit=e=>{e.preventDefault();if(!input.value.trim()){input.setCustomValidity('Enter a project name.');input.reportValidity();return;}result=input.value.trim();dialog.close();};
      dialog.showModal();input.focus();input.select();
    });
  }
  async function refreshVideoProjects(){
    const rows=await (await projectStore()).list(),list=$("videoProjectList");list.replaceChildren();
    $("videoProjectCurrent").textContent=currentVideoProjectName||'Projects';$("videoProjectCurrent").title=currentVideoProjectName||'Choose a saved project';
    if(!rows.length){const empty=document.createElement('p');empty.textContent='No saved projects yet.';list.append(empty);}
    rows.forEach(row=>{
      const item=document.createElement('div');item.className='project-menu-row';item.dataset.projectId=row.id;item.setAttribute('role','listitem');item.classList.toggle('current',row.id===currentVideoProjectId);
      const load=document.createElement('button');load.type='button';load.className='project-load';load.textContent=row.name;load.title='Load '+row.name;load.onclick=()=>projectAction(()=>loadVideoProject(row.id));
      const rename=document.createElement('button');rename.type='button';rename.textContent='Rename';rename.className='project-rename';rename.setAttribute('aria-label','Rename '+row.name);rename.onclick=()=>projectAction(async()=>{
        $("videoProjectMenu").open=false;const name=await requestProjectName('Rename project',row.name,'Rename');if(name===null)return;
        const saved=await (await projectStore()).rename(row.id,name);if(row.id===currentVideoProjectId)currentVideoProjectName=saved.name;await refreshVideoProjects();projectStatus('Renamed project to '+saved.name+'.');
      });
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.className='project-delete';remove.setAttribute('aria-label','Delete '+row.name);remove.title='Delete saved project';remove.onclick=()=>projectAction(async()=>{
        await (await projectStore()).delete(row.id);if(currentVideoProjectId===row.id){currentVideoProjectId=null;currentVideoProjectName='';}await refreshVideoProjects();$("videoProjectMenu").open=false;projectStatus('Saved project deleted. The open survey remains available.');
      });
      item.append(load,rename,remove);list.append(item);
    });
  }
  async function projectAction(action){$("videoProjectSave").disabled=true;try{await action();}catch(error){projectStatus('Project action failed: '+error.message);}finally{$("videoProjectSave").disabled=false;}}
  for(const [id,asNew] of [['videoProjectSave',false],['videoProjectSaveAs',true]])$(id).onclick=()=>projectAction(async()=>{
    if(!videoData||!videoSurvey)throw Error('Build or load a cloud first.');$("videoProjectMenu").open=false;
    const name=await requestProjectName(asNew?'Save as new project':'Save project',asNew?'':currentVideoProjectName);if(name===null)return;
    const saved=await (await projectStore()).save({id:asNew?null:currentVideoProjectId,name,format:1,densifyUnits:'multiplier',appVersion:document.querySelector('.ver').textContent.replace(/^v/,''),data:videoData,survey:videoSurvey.snapshot(),settings:videoProjectSettings(),
      views:[videoViewer,videoSecondViewer].map(v=>({pose:v.getPose(),settings:v.getCameraSettings()})),map:{center:videoMap.getCenter(),zoom:videoMap.getZoom()},overview:{floating:$("videoSecondPane").classList.contains('floating-overview'),layout:videoOverviewWindow?.getLayout()}});
    currentVideoProjectId=saved.id;currentVideoProjectName=saved.name;await refreshVideoProjects();projectStatus('Saved '+saved.name+' in this browser.');
  });
  async function loadVideoProject(id){
    $("videoProjectMenu").open=false;const project=await (await projectStore()).get(id);if(!project?.data?.ply)throw Error('Saved project has no cloud.');
    if(project.densifyUnits!=='multiplier'){
      if(project.settings?.videoDensify!==undefined)project.settings.videoDensify=Number(project.settings.videoDensify)/100;
      for(const view of project.views||[])if(view.settings?.densify!==undefined)view.settings.densify=Number(view.settings.densify)/100;
    }
    videoHintsForCurrentData=false;locationHints.restore(project.data.location_hint);videoData=project.data;videoHintsForCurrentData=true;
    dockVideoOverview();restoreVideoProjectSettings(project.settings);await renderVideoResult(videoData);await attachVideoSurvey();videoSurvey.restore(project.survey);
    for(const [i,view] of [videoViewer,videoSecondViewer].entries()){if(project.views?.[i]?.settings)view.setCameraSettings(project.views[i].settings);if(project.views?.[i]?.pose)await view.flyTo(project.views[i].pose,1);}
    if(project.map)videoMap.setView(project.map.center,project.map.zoom);if(project.overview?.floating)await floatVideoOverview(project.overview.layout);
    currentVideoProjectId=id;currentVideoProjectName=project.name;await refreshVideoProjects();projectStatus('Loaded '+project.name+'.');
  }
  refreshVideoProjects().catch(error=>projectStatus('Project storage unavailable: '+error.message));
  document.addEventListener('pointerdown',e=>{if(!$("videoProjectMenu").contains(e.target))$("videoProjectMenu").open=false;});
  const divider=$("videoPaneDivider");let splitting=false;
  function resizeVideoPanes(x){const rect=divider.parentElement.getBoundingClientRect(),width=Math.max(22,Math.min(48,(rect.right-x)/rect.width*100));divider.parentElement.style.setProperty('--map-width',width+'%');}
  divider.onpointerdown=e=>{splitting=true;divider.setPointerCapture(e.pointerId);e.preventDefault();};divider.onpointermove=e=>{if(splitting)resizeVideoPanes(e.clientX);};divider.onpointerup=divider.onpointercancel=()=>splitting=false;
  divider.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){const rect=divider.getBoundingClientRect();resizeVideoPanes(rect.left+(e.key==='ArrowLeft'?-24:24));e.preventDefault();}};
  function downloadVideoArtifact(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("videoPlyBtn").addEventListener("click", () => {
    if (videoData) downloadVideoArtifact(videoData.ply, "da3-cloud.ply", "text/plain");
  });
  $("videoDiagnosticsBtn").addEventListener("click", () => {
    if (videoData) downloadVideoArtifact(JSON.stringify({
      model: videoData.model, diagnostics: videoData.diagnostics,
      cameras: videoData.cameras, warnings: videoData.warnings
    }, null, 2), "da3-diagnostics.json", "application/json");
  });

  function renderVideoMap(data) {
    const feats = data.features || [];
    if (!window.L) { videoMapNote.textContent = "Map library unavailable (needs internet)."; return; }
    if (!videoMap) {
      videoMap = window.L.map("videoMap", { maxZoom: 22 }).setView([20, 0], 2);
      registerMap("videoMap", videoMap);
      videoMarkers = window.L.layerGroup().addTo(videoMap);
    }
    videoMarkers.clearLayers();
    const bounds = [];
    if (data.location) {
      window.L.marker([data.location.lat, data.location.lon]).addTo(videoMarkers)
        .bindPopup("Photo (start)");
      bounds.push([data.location.lat, data.location.lon]);
    }
    feats.forEach((f, i) => {
      const desc = `<b>${f.label}</b> (${f.geom})<br>${f.count} labelled pts · ${f.distance_m} m @ ${f.bearing_deg}°`;
      if (f.geom === "line" && f.endpoints) {
        window.L.polyline(f.endpoints.map((e) => [e.lat, e.lon]),
          { color: `hsl(${(i * 67) % 360} 90% 35%)`, weight: 4 })
          .addTo(videoMarkers).bindPopup(desc);
        f.endpoints.forEach((e) => bounds.push([e.lat, e.lon]));
      } else {
        const p = f.snapped || f;
        const marker=window.L.marker([p.lat, p.lon]).addTo(videoMarkers).bindPopup(desc);
        marker.on('click',()=>openMapTagEditor({name:f.name||f.label,lat:p.lat,lon:p.lon,indoor:f.indoor,floor:f.floor,onSave:value=>{Object.assign(f,{name:value.name,label:value.name,lat:value.lat,lon:value.lon,indoor:value.indoor,floor:value.floor});delete f.snapped;renderVideoMap(videoData);}}));
        bounds.push([p.lat, p.lon]);
      }
    });
    if (bounds.length > 1) videoMap.fitBounds(bounds, { padding: [20, 20] });
    else if (bounds.length) videoMap.setView(bounds[0], 19);
    videoMapNote.textContent = `${feats.length} feature(s) from photo ${data.gps_source || "?"} fix` +
      (data.heading_deg != null ? `, heading ${data.heading_deg}°` : "") + ".";
    locationHints.refresh();
  }

  videoExportBtn.addEventListener("click", () => {
    if (!videoData) return;
    const feats = videoData.features || [];
    const gj = { type: "FeatureCollection", features: feats.map((f) => ({
      type: "Feature",
      geometry: f.geom === "line" && f.endpoints
        ? { type: "LineString", coordinates: f.endpoints.map((e) => [e.lon, e.lat]) }
        : { type: "Point", coordinates: [(f.snapped || f).lon, (f.snapped || f).lat] },
      properties: f,
    })) };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(gj, null, 2)], { type: "application/geo+json" }));
    a.download = "microgeographies-video-features.geojson";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("videoCloudGeoBtn").addEventListener("click", () => {
    if (!videoCloud || !videoLib) return;
    const reference = videoData.georeference?.available ? videoData.georeference : null;
    downloadVideoArtifact(videoLib.buildGeoJson(videoCloud.positions, videoCloud.colors, [], [],
      videoLib.sampleIndex(videoCloud.count,100), reference), "microgeo-video-cloud.geojson", "application/geo+json");
    $("exportNote").textContent = reference ? "Exported metric cloud in WGS84 coordinates." : "No GPS/heading alignment: local coordinates exported as properties with null map geometry.";
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
      depthFields(fd);
      geomsField(fd, geomsMap(parsePrompts(promptsInput.value)));
      const res = await fetch("/api/project", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const proj = await res.json();
      showDepth(proj.depth_png, proj);
      setLastDepth(proj);
      let n = 0;
      (proj.detections || []).forEach((d, i) => {
        if (!boxes[i]) return;
        boxes[i].geo = d.geo || null;
        boxes[i].snapped = d.snapped || null;
        if (d.geom) boxes[i].geom = d.geom;
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

  let lastDepth = null; // {grid, metric} from the last depth pass, for hover readouts
  function setLastDepth(info) {
    lastDepth = info && Array.isArray(info.depth_grid) && info.depth_grid.length
      ? { grid: info.depth_grid, metric: Array.isArray(info.metric_grid) ? info.metric_grid : null }
      : null;
  }

  let depthImage = null; // loaded colorized depth PNG for the overlay

  function depthLabel(info) {
    if (!info) return "";
    if (info.depth_backend === "yolo") {
      return ` via YOLO26-depth${info.depth_model ? " " + info.depth_model : ""} (metric metres)`;
    }
    if (info.depth_backend === "da") return " via Depth Anything (relative)";
    return "";
  }

  function showDepth(dataUrl, info) {
    if (!dataUrl) return;
    const img = new Image();
    img.onload = () => {
      depthImage = img;
      drawDepth();
      depthNote.textContent = `Monocular depth${depthLabel(info)} — blue far, red near. ` +
        "Boxes carry label + metres so placement and range read off the colors.";
    };
    img.src = dataUrl;
  }

  // SAM boxes over the depth map: box fractions from the photo canvas
  // mapped onto the depth canvas, tagged with label + distance, so a
  // wrongly placed box or a wrong range shows up against the colors.
  function drawDepth() {
    const cv = $("depthCanvas");
    if (!cv) return;
    if (!depthImage) { cv.hidden = true; return; }
    cv.width = depthImage.naturalWidth;
    cv.height = depthImage.naturalHeight;
    cv.hidden = false;
    const ctx = cv.getContext("2d");
    ctx.drawImage(depthImage, 0, 0);
    if (!boxes.length || !canvas.width || !canvas.height) return;
    const sx = cv.width / canvas.width, sy = cv.height / canvas.height;
    const fs = Math.max(11, Math.round(cv.width / 40));
    ctx.font = `${fs}px system-ui, sans-serif`;
    boxes.forEach((b, i) => {
      const hue = (i * 67) % 360;
      const x1 = b.x1 * sx, y1 = b.y1 * sy;
      const x2 = b.x2 * sx, y2 = b.y2 * sy;
      ctx.lineWidth = Math.max(2, Math.round(cv.width / 220));
      ctx.strokeStyle = `hsl(${hue} 90% 35%)`;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      const dist = b.geo && typeof b.geo.distance_m === "number"
        ? ` ${b.geo.distance_m.toFixed(1)}m` : (b.geo_error ? " no depth" : "");
      const tag = `${b.label}${dist}`;
      const w = ctx.measureText(tag).width + fs * 0.75;
      const th = fs * 1.4;
      ctx.fillStyle = `hsl(${hue} 90% 35%)`;
      ctx.fillRect(x1, Math.max(0, y1 - th), w, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(tag, x1 + fs * 0.35, Math.max(fs, y1 - th * 0.28));
    });
  }

  // ---- Map-match: user-supplied OSM GeoJSON vs detections ----
  let osmData = null; // {points: [{lon,lat,tags}], lines: [{pts: [[lon,lat]..], tags}]}
  let osmLayer = null;

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000, p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function nearestOnSeg(lat, lon, la1, lo1, la2, lo2) {
    // Nearest point on a segment, equirectangular metres (street scale).
    const kx = 6371000 * Math.cos(lat * Math.PI / 180), ky = 6371000;
    const torad = Math.PI / 180;
    const px = lon * torad * kx, py = lat * torad * ky;
    const ax = lo1 * torad * kx, ay = la1 * torad * ky;
    const bx = lo2 * torad * kx, by = la2 * torad * ky;
    const dx = bx - ax, dy = by - ay;
    const denom = dx * dx + dy * dy;
    const t = denom ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / denom)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    return { lat: cy / ky / torad, lon: cx / kx / torad, dist: Math.hypot(px - cx, py - cy) };
  }

  function loadOsm(obj) {
    const feats = obj && obj.type === "FeatureCollection" && Array.isArray(obj.features) ? obj.features : null;
    if (!feats) throw new Error("not a GeoJSON FeatureCollection");
    const points = [], lines = [];
    const centroid = (ring) => {
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (const c of ring || []) {
        x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]);
        y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]);
      }
      return [(x0 + x1) / 2, (y0 + y1) / 2];
    };
    for (const f of feats) {
      const g = f && f.geometry, tags = (f && f.properties) || {};
      if (!g || !g.coordinates) continue;
      if (g.type === "Point") points.push({ lon: g.coordinates[0], lat: g.coordinates[1], tags });
      else if (g.type === "MultiPoint") for (const c of g.coordinates) points.push({ lon: c[0], lat: c[1], tags });
      else if (g.type === "LineString") lines.push({ pts: g.coordinates, tags });
      else if (g.type === "MultiLineString") for (const l of g.coordinates) lines.push({ pts: l, tags });
      else if (g.type === "Polygon") {
        for (const r of g.coordinates) lines.push({ pts: r, tags });
        const c = centroid(g.coordinates[0]);
        points.push({ lon: c[0], lat: c[1], tags });
      } else if (g.type === "MultiPolygon") {
        for (const p of g.coordinates) {
          for (const r of p) lines.push({ pts: r, tags });
          const c = centroid(p[0]);
          points.push({ lon: c[0], lat: c[1], tags });
        }
      }
    }
    osmData = { points, lines };
    return { nPoints: points.length, nLines: lines.length };
  }

  if (osmFile) osmFile.addEventListener("change", () => {
    const f = osmFile.files[0];
    if (!f) return;
    f.text().then((t) => {
      const n = loadOsm(JSON.parse(t));
      matchOut.textContent = `${f.name}: ${n.nPoints} point(s), ${n.nLines} path(s) loaded.`;
      updateOsm();
      renderMap();
    }).catch((e) => { matchOut.textContent = `Could not read GeoJSON: ${e.message}`; });
  });
  if (matchTol) matchTol.addEventListener("change", () => { updateOsm(); renderMap(); });
  if (snapPath) snapPath.addEventListener("change", () => { updateOsm(); renderMap(); });
  function matchTolerance() {
    const v = parseFloat(matchTol && matchTol.value);
    return Number.isFinite(v) && v > 0 ? v : 15;
  }

  // Label → OSM tag affinity: which mapped tags count as "the same kind
  // of thing" as a detection label, and how strongly (0–4).
  const OSM_AFFINITY = [
    { re: /door|entrance|gate|portal|doorway/i, keys: ["entrance", "door"], w: 3 },
    { re: /door|entrance|gate|portal|doorway/i, keys: ["building"], w: 1 },
    { re: /window/i, keys: ["window"], w: 3 },
    { re: /step|stair/i, keys: ["highway"], want: /steps/i, w: 3 },
    { re: /step|stair/i, keys: ["steps", "footway"], w: 2 },
    { re: /bin|waste|litter|trash|recycl|dumpster/i, keys: ["amenity", "waste", "recycling"], w: 3 },
    { re: /wall/i, keys: ["barrier"], want: /wall/i, w: 3 },
    { re: /wall|fence|rail/i, keys: ["barrier", "building"], w: 2 },
    { re: /building|house|shop|office|garage/i, keys: ["building"], w: 3 },
    { re: /road|street|avenue/i, keys: ["highway"], w: 3 },
    { re: /path|footway|sidewalk|pavement|trail|cycle|bike/i, keys: ["highway"], want: /footway|path|cycleway|steps|track/i, w: 3 },
    { re: /path|footway|sidewalk|pavement|trail/i, keys: ["footway", "sidewalk"], w: 2 },
    { re: /bench/i, keys: ["amenity"], want: /bench/i, w: 3 },
    { re: /lamp|light|pole/i, keys: ["highway", "man_made"], want: /lamp|light|pole|utility/i, w: 2 },
    { re: /bollard|post/i, keys: ["barrier"], want: /bollard/i, w: 3 },
    { re: /bus|stop/i, keys: ["highway", "public_transport"], want: /bus/i, w: 3 },
    { re: /hydrant/i, keys: ["emergency"], want: /hydrant/i, w: 3 },
    { re: /tree/i, keys: ["natural"], want: /tree/i, w: 3 },
  ];
  function osmAffinity(label, tags) {
    let best = 0;
    for (const r of OSM_AFFINITY) {
      if (!r.re.test(label || "")) continue;
      for (const k of r.keys) {
        if (tags[k] == null || tags[k] === "") continue;
        let w = r.w;
        if (r.want && r.want.test(String(tags[k]))) w += 1;
        if (w > best) best = w;
      }
    }
    const nm = tags.name || tags.ref;
    if (nm && String(nm).toLowerCase().indexOf(String(label).toLowerCase()) !== -1 && best < 2) best = 2;
    return Math.min(4, best);
  }
  function osmDescribe(tags) {
    if (tags.name) return String(tags.name);
    const pick = ["entrance", "door", "highway", "building", "amenity", "barrier", "natural", "shop"].find((k) => tags[k]);
    return pick ? `${pick}=${tags[pick]}` : "tagged feature";
  }
  function osmPopup(tags) {
    const text = document.createElement("div");
    text.style.whiteSpace = "pre-wrap";
    text.textContent = osmDescribe(tags || {}) + "\n" +
      Object.entries(tags || {}).slice(0, 8).map(([k, v]) => `${k}=${v}`).join("\n");
    return text;
  }

  function isPathLine(tags) {
    if (tags.highway || tags.footway || tags.sidewalk || tags.cycleway) return true;
    return /path|road|street|lane|way|trail|track|footway|sidewalk/i.test(String(tags.name || ""));
  }
  function snapToPath(lat, lon) {
    // Nearest point on any OSM path/road line, or null when disabled,
    // empty, or beyond tolerance.
    if (!snapPath || !snapPath.checked || !osmData) return null;
    const tol = matchTolerance();
    let best = null;
    for (const ln of osmData.lines) {
      if (!isPathLine(ln.tags)) continue;
      for (let i = 0; i + 1 < ln.pts.length; i++) {
        const a = ln.pts[i], b = ln.pts[i + 1];
        const n = nearestOnSeg(lat, lon, a[1], a[0], b[1], b[0]);
        if (n.dist <= tol && (!best || n.dist < best.dist)) {
          best = { lat: n.lat, lon: n.lon, dist: n.dist, tags: ln.tags };
        }
      }
    }
    return best;
  }

  // Effective positions: path-snapped when Snap-to-path moved the pin,
  // else the server pin (building-outline snap, else projection).
  function effPin(b) {
    if (b.editedPin) return {...b.editedPin,kind:"edited"};
    if (b.pathPin) return { lon: b.pathPin.lon, lat: b.pathPin.lat, kind: "path" };
    return pinOf(b);
  }
  function effEnds(b) {
    if (b.pathEnds) return b.pathEnds;
    if (b.geo && Array.isArray(b.geo.endpoints) && b.geo.endpoints.length === 2) {
      return b.geo.endpoints.map((e) => ({ lat: e.lat, lon: e.lon }));
    }
    return null;
  }

  function matchOsm(b, tol) {
    // Best OSM feature near the box's effective position, ranked by
    // label↔tag affinity, then distance. Lines match by nearest point.
    const ends = b.geom === "line" ? effEnds(b) : null;
    const anchor = ends
      ? { lat: (ends[0].lat + ends[1].lat) / 2, lon: (ends[0].lon + ends[1].lon) / 2 }
      : effPin(b);
    if (!anchor) return null;
    let best = null;
    const consider = (lat, lon, tags, kind) => {
      const dist = haversineM(anchor.lat, anchor.lon, lat, lon);
      if (dist > tol) return;
      const aff = osmAffinity(b.label || "", tags || {});
      if (aff < 1) return;
      const score = aff * 10 - dist;
      if (!best || score > best.score) best = { lat, lon, dist, tags: tags || {}, kind, score };
    };
    for (const p of osmData.points) consider(p.lat, p.lon, p.tags, "point");
    for (const ln of osmData.lines) {
      for (let i = 0; i + 1 < ln.pts.length; i++) {
        const a = ln.pts[i], c = ln.pts[i + 1];
        const n = nearestOnSeg(anchor.lat, anchor.lon, a[1], a[0], c[1], c[0]);
        consider(n.lat, n.lon, ln.tags, "line");
      }
    }
    return best;
  }

  function updateOsm() {
    // Recompute path snaps + OSM matches from current boxes. Snaps feed
    // matching, the map, and exports — everything downstream uses the
    // moved positions.
    const tol = matchTolerance();
    for (const b of boxes) {
      b.pathPin = null; b.pathEnds = null; b.pathSnapInfo = null; b.osm = null;
      if (!b.geo) continue;
      if (snapPath && snapPath.checked && osmData) {
        if (b.geom === "line") {
          const ends = effEnds(b); // raw server endpoints (pathEnds just cleared)
          if (ends) {
            const s = ends.map((e) => snapToPath(e.lat, e.lon));
            if (s[0] && s[1]) {
              b.pathEnds = [{ lat: s[0].lat, lon: s[0].lon }, { lat: s[1].lat, lon: s[1].lon }];
              b.pathSnapInfo = { dist: Math.max(s[0].dist, s[1].dist), tags: s[0].tags };
            }
          }
        } else {
          const p = pinOf(b);
          if (p) {
            const s = snapToPath(p.lat, p.lon);
            if (s) {
              b.pathPin = { lon: s.lon, lat: s.lat };
              b.pathSnapInfo = { dist: s.dist, tags: s.tags };
            }
          }
        }
      }
      if (osmData) b.osm = matchOsm(b, tol);
    }
    renderMatchList();
    drawOsm();
  }

  function renderMatchList() {
    if (!matchList) return;
    matchList.innerHTML = "";
    let any = false;
    for (const b of boxes) {
      if (!b.geo) continue;
      any = true;
      const li = document.createElement("li");
      let text = `${b.label}: `;
      if (b.pathSnapInfo) text += `snapped ${b.pathSnapInfo.dist.toFixed(1)} m to ${osmDescribe(b.pathSnapInfo.tags)}; `;
      if (b.osm) {
        const known = /door|entrance|gate/i.test(b.label || "") && (b.osm.tags.entrance || b.osm.tags.door);
        text += known
          ? `known entrance ${b.osm.dist.toFixed(1)} m away (${osmDescribe(b.osm.tags)})`
          : `near ${osmDescribe(b.osm.tags)} ${b.osm.dist.toFixed(1)} m away`;
      } else {
        text += osmData ? `no OSM feature within ${matchTolerance()} m` : "no OSM data loaded";
      }
      li.textContent = text;
      matchList.appendChild(li);
    }
    if (!any) matchList.innerHTML = '<li class="hint">No matches yet.</li>';
  }

  function drawOsm() {
    if (!window.L || !map) return;
    if (osmLayer) { osmLayer.remove(); osmLayer = null; }
    if (!osmData) return;
    osmLayer = window.L.layerGroup();
    const matchedPts = boxes.map((b) => b.osm).filter((m) => m && m.kind === "point");
    for (const p of osmData.points) {
      const hit = matchedPts.some((m) => Math.abs(m.lat - p.lat) < 1e-9 && Math.abs(m.lon - p.lon) < 1e-9);
      window.L.circleMarker([p.lat, p.lon], {
        radius: hit ? 7 : 4, color: hit ? "#16a34a" : "#b45309",
        weight: 2, fillOpacity: hit ? 0.5 : 0.25
      }).bindPopup(osmPopup(p.tags)).addTo(osmLayer);
    }
    for (const ln of osmData.lines) {
      window.L.polyline(ln.pts.map((c) => [c[1], c[0]]), {
        color: "#b45309", weight: 2, opacity: 0.7
      }).bindPopup(osmPopup(ln.tags)).addTo(osmLayer);
    }
    osmLayer.addTo(map);
  }

  // Measure tool: click the map to drop points; segments read in metres
  // with 5 m ticks and a running total. Esc or re-toggle ends it.
  let measuring = false, measurePts = [], measureLayer = null;
  function setMeasuring(on) {
    measuring = on;
    if (measureBtn) {
      measureBtn.setAttribute("aria-pressed", String(on));
      measureBtn.classList.toggle("active", on);
    }
    if (map) {
      map.getContainer().style.cursor = on ? "crosshair" : "";
      if (on) map.doubleClickZoom.disable();
      else map.doubleClickZoom.enable();
    }
    if (!on) {
      measurePts = [];
      if (measureLayer) { measureLayer.remove(); measureLayer = null; }
    }
  }
  function measureClick(e) {
    if (!measuring || !map) return;
    measurePts.push(e.latlng);
    drawMeasure();
  }
  function drawMeasure() {
    if (!map || !window.L) return;
    if (measureLayer) measureLayer.remove();
    measureLayer = window.L.layerGroup().addTo(map);
    if (!measurePts.length) return;
    window.L.polyline(measurePts.map((p) => [p.lat, p.lng]), { color: "#0ea5e9", weight: 3 }).addTo(measureLayer);
    let total = 0;
    for (let i = 0; i < measurePts.length; i++) {
      const p = measurePts[i];
      if (i > 0) {
        const q = measurePts[i - 1];
        const seg = haversineM(q.lat, q.lng, p.lat, p.lng);
        const n = Math.floor(seg / 5);
        for (let k = 1; k <= n; k++) {
          const f = (k * 5) / seg;
          window.L.circleMarker([q.lat + (p.lat - q.lat) * f, q.lng + (p.lng - q.lng) * f],
            { radius: 2, color: "#0ea5e9", weight: 1, fillOpacity: 1 }).addTo(measureLayer);
        }
        window.L.marker([(q.lat + p.lat) / 2, (q.lng + p.lng) / 2], {
          interactive: false,
          icon: window.L.divIcon({ className: "measure-tag", html: `${seg.toFixed(1)} m`, iconSize: null })
        }).addTo(measureLayer);
        total += seg;
      }
      window.L.circleMarker([p.lat, p.lng], { radius: 4, color: "#0ea5e9", weight: 2, fillOpacity: 0.6 }).addTo(measureLayer);
    }
    if (measurePts.length > 1) {
      const last = measurePts[measurePts.length - 1];
      window.L.marker([last.lat, last.lng], {
        interactive: false,
        icon: window.L.divIcon({ className: "measure-tag measure-total", html: `total ${total.toFixed(1)} m`, iconSize: null })
      }).addTo(measureLayer);
    }
  }
  if (measureBtn) measureBtn.addEventListener("click", () => setMeasuring(!measuring));

  // Hover readouts: class labels over the photo, metres over the depth map.
  function canvasPos(evt, cv) {
    const r = cv.getBoundingClientRect();
    return { x: (evt.clientX - r.left) / r.width * cv.width, y: (evt.clientY - r.top) / r.height * cv.height };
  }
  function showTip(evt, text) {
    if (!hoverTip) return;
    hoverTip.textContent = text;
    hoverTip.hidden = false;
    hoverTip.style.left = (evt.clientX + 14) + "px";
    hoverTip.style.top = (evt.clientY + 12) + "px";
  }
  function hideTip() { if (hoverTip) hoverTip.hidden = true; }
  canvas.addEventListener("mousemove", (e) => {
    if (!boxes.length) { hideTip(); return; }
    const p = canvasPos(e, canvas);
    const hit = boxes.filter((b) => p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2);
    if (!hit.length) { hideTip(); return; }
    showTip(e, hit.map((b) => b.score == null ? b.label : `${b.label} ${(b.score * 100).toFixed(0)}%`).join(" · "));
  });
  canvas.addEventListener("mouseleave", hideTip);
  $("depthCanvas").addEventListener("mousemove", (e) => {
    if (!lastDepth) { hideTip(); return; }
    const cv = $("depthCanvas");
    const g = lastDepth.metric || lastDepth.grid;
    const rows = g.length, cols = g[0].length;
    const p = canvasPos(e, cv);
    const c = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cv.width * cols)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cv.height * rows)));
    let m;
    if (lastDepth.metric) m = g[r][c];
    else {
      const maxr = parseFloat(rangeInput.value) || 30;
      m = 0.5 + (1 - g[r][c]) * (maxr - 0.5);
    }
    showTip(e, `${Number(m).toFixed(1)} m`);
  });
  $("depthCanvas").addEventListener("mouseleave", hideTip);

  // Map view: camera fix plus one marker per projected pin, each popup
  // carrying label, distance, azimuth and ENU. Needs the Leaflet CDN;
  // without it (offline) the list below still carries every number.
  function renderMap() {
    if (!window.L) {
      mapNote.textContent = "Map library unavailable (needs internet for tiles) — pins are listed above.";
      return;
    }
    const cam = currentManual() || (gps ? { lat: gps.lat, lon: gps.lon } : null) || (lastRaw.location || null);
    const pins = boxes.filter((b) => b.geo).map((b) => ({ b, p: effPin(b) })).filter((x) => x.p);
    if (!map) {
      map = window.L.map("map", { maxZoom: 22 }).setView([20, 0], 2);
      registerMap("map", map);
      map.on("click", measureClick);
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
        refreshLocState();
      });
      bounds.push([cam.lat, cam.lon]);
    }
    pins.forEach(({ b, p }) => {
      const g = b.geo;
      const col = `hsl(${(boxes.indexOf(b) * 67) % 360} 90% 35%)`;
      const enu = g.enu_m ? `<br>x ${g.enu_m.x} m E, y ${g.enu_m.y} m N, z ${g.enu_m.z} m` : "";
      const snap = b.snapped ? "<br>on building outline" : "";
      const osm = b.osm ? `<br>OSM: ${osmDescribe(b.osm.tags)} (${b.osm.dist.toFixed(1)} m)` : "";
      const path = b.pathSnapInfo ? `<br>snapped to path (${b.pathSnapInfo.dist.toFixed(1)} m)` : "";
      const ends = b.geom === "line" ? effEnds(b) : null;
      if (ends) {
        window.L.polyline([[ends[0].lat, ends[0].lon], [ends[1].lat, ends[1].lon]],
          { color: col, weight: 4 }).addTo(mapLayers).bindPopup(
          `<b>${b.label}</b> (line)<br>${g.distance_m.toFixed(1)} m @ ${g.bearing_deg.toFixed(1)}°${enu}${snap}${osm}${path}`);
        bounds.push([ends[0].lat, ends[0].lon], [ends[1].lat, ends[1].lon]);
      } else {
        const tagMarker=window.L.marker([p.lat, p.lon]).addTo(mapLayers).bindPopup(
          `<b>${b.label}</b><br>${g.distance_m.toFixed(1)} m @ ${g.bearing_deg.toFixed(1)}°${enu}${snap}${osm}${path}`);
        tagMarker.on('click',()=>openMapTagEditor({name:b.label,lat:p.lat,lon:p.lon,indoor:b.indoor,floor:b.floor,onSave:value=>{b.label=value.name;b.indoor=value.indoor;b.floor=value.floor;b.editedPin={lat:value.lat,lon:value.lon};renderList();renderMap();}}));
        bounds.push([p.lat, p.lon]);
      }
      if (p.kind === "path") {
        // Dashed connector: original projection → snapped position.
        const orig = pinOf(b);
        if (orig && (orig.lat !== p.lat || orig.lon !== p.lon)) {
          window.L.polyline([[orig.lat, orig.lon], [p.lat, p.lon]],
            { color: "#64748b", weight: 1, dashArray: "4 4", interactive: false }).addTo(mapLayers);
        }
      }
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [20, 20] });
    else if (bounds.length) map.setView(bounds[0], 18);
    else if (osmData && (osmData.points.length || osmData.lines.length)) {
      const first = osmData.points[0] || { lat: osmData.lines[0].pts[0][1], lon: osmData.lines[0].pts[0][0] };
      map.setView([first.lat, first.lon], 18);
    }
    drawOsm();
    mapNote.textContent = `${pins.length} pin(s)` +
      (pins.some(({ b }) => b.snapped) ? " (door/window snapped to building outline)" : "") +
      (osmData ? ` + ${osmData.points.length + osmData.lines.length} OSM features` : "") + ".";
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();

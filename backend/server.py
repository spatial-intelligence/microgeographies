"""Microgeographies SAM test backend.

POST /api/detect with multipart fields:
  image: image file
  concepts: JSON array, e.g. ["door", "steps"]
  lat, lon, accuracy: optional GPS strings (used only when the photo
    has no EXIF GPS — the photo's own location wins when present)
  heading: optional compass bearing of the camera axis, degrees (wins
    over the photo's EXIF direction; EXIF is used when this is empty)
  hfov: horizontal field of view, degrees (default 60)
  max_range: monocular-depth scale, metres mapped to the far end (default 30)
  project: "1" (default) attaches approx lat/lon per detection when a
    location and heading are known; "0" keeps boxes only

POST /api/project with multipart fields:
  image: image file (used for depth + EXIF GPS fallback)
  boxes: JSON array of {box: [x1,y1,x2,y2], label} in absolute pixels
  lat, lon, heading, hfov, max_range: as above

POST /api/depth with multipart fields:
  image: image file
Returns the monocular relative-depth grid (0 = far, 1 = near) plus any
EXIF GPS found in the photo.

Modes:
  MOCK_SAM=1    -> deterministic dummy boxes, no model download.
  MOCK_DEPTH=1  -> deterministic depth gradient, no model download.
  default       -> loads facebook/sam3 + Depth Anything V1 Small via
                   transformers (needs torch + GPU for speed).

Depth backends (per-request `depth_backend`, or DEPTH_BACKEND env):
  "da"   -> Depth Anything (relative depth, mapped via max_range)
  "yolo" -> YOLO26-depth (metric metres; needs ultralytics>=8.4.104;
            max_range acts as a ceiling). A `model` like
            "yolo26n-depth.pt" auto-selects this backend.
  ""     -> auto (default): YOLO weight names route to YOLO, else DA.
"""
import io
import json
import os

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

import depth as geo
import merge as mg

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_model = None
_processor = None


def mock_detections(w, h, concepts):
    dets = []
    for i, c in enumerate(concepts):
        pad = 0.15 + 0.05 * i
        dets.append({
            "label": c,
            "box": [round(w * pad), round(h * pad), round(w * (0.85 - 0.05 * i)), round(h * (0.85 - 0.05 * i))],
            "score": 0.99,
            "mock": True,
        })
    return dets


def load_model():
    global _model, _processor
    if _model is not None:
        return _model, _processor
    import torch
    from transformers import Sam3Model, Sam3Processor
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _processor = Sam3Processor.from_pretrained("facebook/sam3")
    _model = Sam3Model.from_pretrained("facebook/sam3").to(device)
    _model.eval()
    return _model, _processor


@app.get("/api/health")
def health():
    try:
        import sfm as _sfm
        sfm_ok = _sfm.sfm_backend_available()
        sfm_how = ("cli" if _sfm.colmap_binary() else
                   "pycolmap" if sfm_ok else None)
    except Exception:
        sfm_ok, sfm_how = False, None
    return {"ok": True, "mock": os.getenv("MOCK_SAM") == "1",
            "sfm_available": sfm_ok, "sfm_backend": sfm_how}


@app.post("/api/detect")
async def detect(
    image: UploadFile = File(...),
    concepts: str = Form(...),
    lat: str = Form(default=""),
    lon: str = Form(default=""),
    accuracy: str = Form(default=""),
    heading: str = Form(default=""),
    hfov: str = Form(default="60"),
    max_range: str = Form(default="30"),
    project: str = Form(default="1"),
    model: str = Form(default=""),
    prefer: str = Form(default=""),
    detector: str = Form(default="sam"),
    depth_backend: str = Form(default=""),
    geoms: str = Form(default=""),
):
    raw = await image.read()
    pil = geo.oriented_image(Image.open(io.BytesIO(raw)).convert("RGB"))
    w, h = pil.size
    names, geom_map = concepts_and_geoms(concepts, geoms)
    if not names:
        return {"error": "no concepts given", "detections": []}

    location, gps_source = geo.resolve_location(lat, lon, pil, prefer=prefer or "exif")
    heading_deg, heading_source = geo.resolve_heading(heading, pil)

    dets = run_detections(pil, names, detector=detector or "sam")
    depth_png = None
    result, grid = None, None
    depth_info = {"backend": None, "model": None, "metric": False}
    if project == "1":
        result, depth_error = get_depth_full(
            pil, model_id=model or None, backend=depth_backend or None)
        grid = result["grid"] if result else None
        depth_png = geo.depth_data_url(grid) if grid else None
        dets = project_boxes(pil, dets, location,
                             "" if heading_deg is None else str(heading_deg),
                             hfov, max_range, grid=grid,
                             depth_error=depth_error,
                             metric_grid=result.get("metric_grid") if result else None,
                             model_id=model or None,
                             backend=depth_backend or None,
                             geoms=geom_map)
        if result:
            depth_info = {"backend": result.get("backend"),
                          "model": result.get("model"),
                          "metric": result.get("metric_grid") is not None}
    return {
        "detections": dets,
        "image_width": w,
        "image_height": h,
        "gps": {"lat": lat, "lon": lon, "accuracy": accuracy},
        "location": location,
        "gps_source": gps_source,  # "live" | "exif" | "none"
        "heading_deg": heading_deg,  # resolved manual > EXIF > None
        "heading_source": heading_source,  # "manual" | "exif" | "none"
        "depth_png": depth_png,  # turbo-colorized depth map (blue far → red near)
        "depth_backend": depth_info["backend"],  # "da" | "yolo" | None
        "depth_model": depth_info["model"],
        "depth_metric": depth_info["metric"],  # True when ranges are metric (YOLO)
        "depth_grid": grid,  # relative 0..1, for hover readouts (None if project=0)
        "metric_grid": result.get("metric_grid") if result else None,
        "detector": detector or "sam",
    }


def parse_concepts(concepts):
    """Concept names from a JSON array or comma string (max 10)."""
    try:
        names = json.loads(concepts)
        if isinstance(names, str):
            names = [names]
    except (json.JSONDecodeError, TypeError):
        names = [c.strip() for c in (concepts or "").split(",")
                 if c.strip()]
    return [n for n in names if n][:10]


def split_geom(name):
    """Split a ``"label |line"`` concept into (clean label, geom).

    ``|line`` (or ``|lines``) marks a linear feature — drawn as a map
    polyline from the box's edge columns; anything else (including an
    explicit ``|point``) is a point pin. The clean label is what the
    detector is prompted with.
    """
    base, sep, suffix = str(name or "").partition("|")
    if sep:
        s = suffix.strip().lower()
        if s in ("line", "lines"):
            return base.strip(), "line"
        if s in ("point", "points"):
            return base.strip(), "point"
    return str(name or "").strip(), "point"


def parse_geoms(raw):
    """Explicit ``{label: "line"|"point"}`` map from a JSON object string.

    Wins over ``|line`` suffixes parsed from the concepts. Anything
    unparseable (or not an object) yields ``{}`` — never raises.
    """
    try:
        obj = json.loads(raw or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(obj, dict):
        return {}
    out = {}
    for k, v in obj.items():
        if str(v).strip().lower() in ("line", "lines"):
            out[str(k).strip().lower()] = "line"
    return out


def concepts_and_geoms(concepts, geoms_raw=""):
    """Clean concept names plus the effective label->geom map.

    ``|line`` suffixes in the concepts seed the map; the explicit
    ``geoms`` JSON object overrides them. Detector prompts always get
    the clean labels.
    """
    geoms, clean = {}, []
    for n in parse_concepts(concepts):
        base, g = split_geom(n)
        if not base:
            continue
        if g == "line":
            geoms[base.lower()] = "line"
        clean.append(base)
    geoms.update(parse_geoms(geoms_raw))
    return clean[:10], geoms


def detect_concepts_no_depth(pil_by_name, concepts, detector="sam", api_token=""):
    """Boxes for many images with no depth pass (SfM label source).

    Runs run_detections per image and returns (dets, errors): dets maps
    basename to [{label, box (original pixels), score}], errors holds
    short distinct failure notes (empty when every image scored).
    One bad image never sinks the rest, and failures are reported —
    never swallowed — so an unlabeled cloud always says why.
    """
    dets, errors, seen = {}, [], set()
    for name, pil in (pil_by_name or {}).items():
        try:
            if detector == "api":
                import meta
                boxes = meta.detect(pil, concepts, api_token)
            else:
                boxes = run_detections(pil, concepts, detector=detector or "sam")
        except Exception as e:
            note = f"{os.path.basename(name)}: {e}".strip()[:160]
            if note not in seen:
                seen.add(note)
                errors.append(note)
            continue
        out = []
        for b in boxes:
            box = b.get("box")
            if not isinstance(box, list) or len(box) < 4:
                continue
            out.append({"label": b.get("label", "object"),
                        "box": [round(float(v)) for v in box[:4]],
                        "score": b.get("score")})
        if out:
            dets[os.path.basename(name)] = out
    return dets, errors


def run_detections(pil, names, detector="sam"):
    """Boxes for one image: SAM (mock or real) or offline CLIP windows."""
    w, h = pil.size
    if detector == "clip":
        if os.getenv("MOCK_CLIP") == "1":
            return [{**d, "clip": True} for d in mock_detections(w, h, names)]
        import clip_detect as cd
        return cd.detect_clip(pil, names)
    if os.getenv("MOCK_SAM") == "1":
        return mock_detections(w, h, names)
    import torch

    model, processor = load_model()
    dets = []
    for label in names:
        inputs = processor(images=pil, text=label, return_tensors="pt").to(model.device)
        with torch.no_grad():
            res = model(**inputs)
        parsed = processor.post_process_instance_segmentation(
            res, threshold=0.5, mask_threshold=0.5,
            target_sizes=inputs.get("original_sizes").tolist(),
        )[0]
        for box, score in zip(parsed["boxes"].tolist(), parsed["scores"].tolist()):
            dets.append({"label": label, "box": [round(float(v)) for v in box],
                         "score": float(score)})
    return dets


def thumbnail_data_url(pil, max_w=480):
    """Downscaled JPEG preview of an image as a data URL."""
    import base64
    import io as _io
    img = pil.copy()
    img.thumbnail((max_w, max_w * 4))
    buf = _io.BytesIO()
    img.save(buf, "JPEG", quality=70)
    return ("data:image/jpeg;base64,"
            + base64.b64encode(buf.getvalue()).decode("ascii"))


def get_depth_full(pil, model_id=None, backend=None):
    """Full depth result for an image, or (None, error) when unavailable.

    Returns the estimate_depth_grid dict (``grid``, plus ``metric_grid``
    on the YOLO backend) so callers can use metric ranges directly.
    """
    try:
        grid_w, grid_h = geo.depth_grid_dims(pil)
        return geo.estimate_depth_grid(
            pil, grid_w=grid_w, grid_h=grid_h,
            model_id=model_id, backend=backend), None
    except Exception as e:
        return None, f"depth unavailable: {e}"


def get_depth(pil, model_id=None, backend=None):
    """Relative-depth grid for an image, or (None, error) when unavailable."""
    result, err = get_depth_full(pil, model_id=model_id, backend=backend)
    return (result["grid"] if result else None), err


def project_boxes(pil, dets, location, heading="", hfov="60", max_range="30",
                  grid=None, depth_error=None, metric_grid=None,
                  model_id=None, backend=None, geoms=None):
    """Attach approx 3D location (lat/lon + ENU metres + pixel) per detection.

    Needs a location (phone fix or EXIF) and a compass heading; without
    either the boxes pass through untouched. Depth-model and OSM
    failures degrade to partial geo (never a 500).

    With ``metric_grid`` (YOLO backend) the range is the median metric
    depth over the box, capped at ``max_range``; otherwise the relative
    grid maps through relative_to_metric. Either way ``geo`` carries
    ``range_source`` (``"metric"`` | ``"relative"``) and ``depth_rel``.

    ``geoms`` maps lowercase label -> ``"line"``. Line detections (e.g.
    steps, walls) also get ``geo["endpoints"]`` — two lat/lon pins
    projected from the box's left/right edge columns at the same range
    — so the page can draw them as map polylines. Every detection gets
    ``geom`` (``"line"`` | ``"point"``).
    """
    try:
        hdg = float(heading)
    except (TypeError, ValueError):
        return dets
    if location is None:
        return dets
    try:
        fov = float(hfov or 60.0)
    except ValueError:
        fov = 60.0
    try:
        maxr = float(max_range or 30.0)
    except ValueError:
        maxr = 30.0
    w, h = pil.size
    if grid is None:
        result, depth_error = get_depth_full(
            pil, model_id=model_id, backend=backend)
        if result is not None:
            grid = result["grid"]
            metric_grid = result.get("metric_grid")
    if grid is None:
        for d in dets:
            d["geo_error"] = depth_error or "depth unavailable"
        return dets
    depth = grid
    geoms = geoms or {}
    for d in dets:
        try:
            rel = geo.box_median_depth(depth, d["box"], w, h)
            if metric_grid is not None:
                raw = geo.box_median_depth(metric_grid, d["box"], w, h)
                raw = max(0.05, float(raw))
                dist = min(raw, maxr)  # max_range acts as a ceiling
                source = "metric"
            else:
                raw = dist = geo.relative_to_metric(rel, max_range_m=maxr)
                source = "relative"
            g = geo.project_detection(location["lat"], location["lon"], hdg,
                                      d["box"], w, h, dist, hfov_deg=fov)
            g["depth_rel"] = round(rel, 3)
            g["range_source"] = source
            if source == "metric":
                g["depth_m_raw"] = round(raw, 2)
            geom = "line" if geoms.get(str(d.get("label", "")).lower()) == "line" else "point"
            d["geom"] = geom
            if geom == "line":
                # Edge columns at the box's mid row, same range: a short
                # arc segment the page draws as a polyline.
                x1, _y1, x2, y2 = d["box"]
                cy = (_y1 + y2) / 2.0
                ends = []
                for ex in (x1, x2):
                    g2 = geo.project_detection(
                        location["lat"], location["lon"], hdg,
                        [ex, cy - 1, ex + 1, cy + 1], w, h, dist,
                        hfov_deg=fov)
                    ends.append({"lat": g2["lat"], "lon": g2["lon"]})
                g["endpoints"] = ends
            d["geo"] = g
            if str(d.get("label", "")).lower() in geo.SNAP_LABELS:
                snap = geo.snap_to_building_outline(g["lat"], g["lon"])
                if snap:
                    d["snapped"] = snap
        except Exception as e:  # one bad box must not sink the batch
            d["geo_error"] = str(e)[:200]
    return dets


@app.post("/api/project")
async def project(
    image: UploadFile = File(...),
    boxes: str = Form(...),
    lat: str = Form(default=""),
    lon: str = Form(default=""),
    heading: str = Form(default=""),
    hfov: str = Form(default="60"),
    max_range: str = Form(default="30"),
    model: str = Form(default=""),
    prefer: str = Form(default=""),
    depth_backend: str = Form(default=""),
    geoms: str = Form(default=""),
):
    """Project externally produced boxes (e.g. Meta SAM-3.1 in the browser).

    `boxes` is JSON: [{"box": [x1,y1,x2,y2], "label": "door"}, ...] in
    absolute pixels of the uploaded image. `geoms` is an optional JSON
    object mapping lowercase label -> "line" for linear features.
    """
    raw = await image.read()
    pil = geo.oriented_image(Image.open(io.BytesIO(raw)).convert("RGB"))
    try:
        dets = json.loads(boxes)
        if isinstance(dets, dict):
            dets = dets.get("detections", dets.get("results", []))
    except json.JSONDecodeError:
        return {"error": "boxes is not valid JSON", "detections": []}
    if not isinstance(dets, list):
        return {"error": "boxes must be a JSON array", "detections": []}
    location, gps_source = geo.resolve_location(lat, lon, pil, prefer=prefer or "exif")
    heading_deg, heading_source = geo.resolve_heading(heading, pil)
    result, depth_error = get_depth_full(
        pil, model_id=model or None, backend=depth_backend or None)
    grid = result["grid"] if result else None
    dets = project_boxes(pil, dets, location,
                         "" if heading_deg is None else str(heading_deg),
                         hfov, max_range, grid=grid, depth_error=depth_error,
                         metric_grid=result.get("metric_grid") if result else None,
                         model_id=model or None, backend=depth_backend or None,
                         geoms=parse_geoms(geoms))
    return {"detections": dets, "location": location, "gps_source": gps_source,
            "heading_deg": heading_deg, "heading_source": heading_source,
            "depth_png": geo.depth_data_url(grid) if grid else None,
            "depth_backend": result.get("backend") if result else None,
            "depth_model": result.get("model") if result else None,
            "depth_metric": bool(result and result.get("metric_grid") is not None),
            "depth_grid": grid,  # relative 0..1, for hover readouts
            "metric_grid": result.get("metric_grid") if result else None}


@app.post("/api/depth")
async def depth_map(image: UploadFile = File(...),
                    model: str = Form(default=""),
                    depth_backend: str = Form(default="")):
    """Monocular relative-depth grid for an image, plus any EXIF GPS."""
    raw = await image.read()
    pil = geo.oriented_image(Image.open(io.BytesIO(raw)).convert("RGB"))
    w, h = pil.size
    try:
        result = geo.estimate_depth_grid(
            pil, model_id=model or None, backend=depth_backend or None)
    except Exception as e:
        return {"error": f"depth unavailable: {e}",
                "image_width": w, "image_height": h}
    flat = [v for row in result["grid"] for v in row]
    out = {
        "image_width": w,
        "image_height": h,
        "grid_w": len(result["grid"][0]),
        "grid_h": len(result["grid"]),
        "grid": result["grid"],  # 0 = far, 1 = near
        "depth_min": min(flat),
        "depth_max": max(flat),
        "mock": result["mock"],
        "depth_backend": result.get("backend"),
        "depth_model": result.get("model"),
        "exif_gps": geo.extract_exif_gps(pil),
        "exif_heading": geo.extract_exif_heading(pil),
        "depth_png": geo.depth_data_url(result["grid"]),
    }
    if result.get("metric_grid") is not None:
        mflat = [v for row in result["metric_grid"] for v in row]
        out["metric_grid"] = result["metric_grid"]  # metres per cell (YOLO)
        out["metric_min_m"] = min(mflat)
        out["metric_max_m"] = max(mflat)
    return out


MAX_BATCH_IMAGES = 20
MAX_BATCH_BYTES = 200 * 1024 * 1024
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")


@app.post("/api/batch")
async def batch(
    zipfile: UploadFile = File(...),
    concepts: str = Form(...),
    lat: str = Form(default=""),
    lon: str = Form(default=""),
    heading: str = Form(default=""),
    hfov: str = Form(default="60"),
    max_range: str = Form(default="30"),
    model: str = Form(default=""),
    prefer: str = Form(default=""),
    detector: str = Form(default="sam"),
    depth_backend: str = Form(default=""),
    geoms: str = Form(default=""),
    merge_radius_m: str = Form(default=""),
    sim_min: str = Form(default="0.75"),
    sam_token: str = Form(default=""),
):
    """Batch-process a zip of photos; merge repeats into shared features.

    Each image runs the full detect + project pipeline (EXIF-first
    location/heading per photo, explicit lat/lon/heading as fallback),
    and returns its preview, detections, and depth map. Same-label
    detections then merge across photos when they sit within
    ``merge_radius_m`` metres AND their box crops look alike
    (similarity >= ``sim_min``) — positional-error duplicates fuse,
    while genuinely separate neighbours stay distinct.
    """
    import zipfile as _zip

    names, geom_map = concepts_and_geoms(concepts, geoms)
    if not names:
        return {"error": "no concepts given", "images": [], "merged": None}
    try:
        radius = float(merge_radius_m or 8.0)
    except ValueError:
        radius = 8.0
    try:
        sim = float(sim_min or 0.75)
    except ValueError:
        sim = 0.75

    raw = await zipfile.read()
    try:
        zf = _zip.ZipFile(io.BytesIO(raw))
    except _zip.BadZipFile:
        return {"error": "not a zip file", "images": [], "merged": None}
    members = [i for i in zf.infolist()
               if not i.is_dir() and i.filename.lower().endswith(IMAGE_EXTS)]
    members.sort(key=lambda i: i.filename)
    if sum(i.file_size for i in members) > MAX_BATCH_BYTES:
        return {"error": "zip contents exceed 200 MB", "images": [],
                "merged": None}

    images = []
    records = []
    for info in members[:MAX_BATCH_IMAGES]:
        try:
            pil = geo.oriented_image(Image.open(io.BytesIO(zf.read(info.filename))).convert("RGB"))
        except Exception:
            continue
        w, h = pil.size
        location, gps_source = geo.resolve_location(lat, lon, pil, prefer=prefer or "exif")
        hdg, hdg_source = geo.resolve_heading(heading, pil)
        if detector == "api":
            import meta
            try:
                found = meta.detect(pil, names, sam_token)
            except Exception as exc:
                return {"error": str(exc), "images": [], "merged": None}
        else:
            found = run_detections(pil, names, detector=detector or "sam")
        dets = mg.dedupe_same_image(found)
        result, depth_error = get_depth_full(
            pil, model_id=model or None, backend=depth_backend or None)
        grid = result["grid"] if result else None
        dets = project_boxes(pil, dets, location,
                             "" if hdg is None else str(hdg),
                             hfov, max_range, grid=grid,
                             depth_error=depth_error,
                             metric_grid=result.get("metric_grid") if result else None,
                             model_id=model or None,
                             backend=depth_backend or None,
                             geoms=geom_map)
        for d in dets:
            if d.get("geo"):
                records.append({
                    "label": d.get("label", ""), "lat": d["geo"]["lat"],
                    "lon": d["geo"]["lon"], "image": info.filename,
                    "vec": mg.crop_vector(pil, d["box"]),
                    "detail": {"distance_m": d["geo"].get("distance_m"),
                               "bearing_deg": d["geo"].get("bearing_deg")},
                })
        images.append({
            "name": info.filename, "image_width": w, "image_height": h,
            "thumbnail": thumbnail_data_url(pil),
            "depth_png": geo.depth_data_url(grid) if grid else None,
            "depth_backend": result.get("backend") if result else None,
            "depth_model": result.get("model") if result else None,
            "depth_metric": bool(result and result.get("metric_grid") is not None),
            "location": location, "gps_source": gps_source,
            "heading_deg": hdg, "heading_source": hdg_source,
            "detections": dets,
        })
    clusters = mg.cluster(records, radius_m=radius, sim_min=sim)
    return {
        "images": images,
        "skipped": max(0, len(members) - MAX_BATCH_IMAGES),
        "merged": mg.merged_feature_collection(clusters),
        "detector": detector or "sam",
    }


@app.post("/api/sfm")
async def sfm(
    zipfile: UploadFile = File(...),
    detections: str = Form(default=""),
    concepts: str = Form(default=""),
    detector: str = Form(default="sam"),
    dense: str = Form(default="0"),
    use_gpu: str = Form(default="1"),
    sam_token: str = Form(default=""),
    label_objects: str = Form(default="0"),
):
    """Reconstruct a zip of photos with COLMAP and label the 3D points.

    Multipart fields: `zipfile` (zip archive of photos), `detections`
    (optional JSON mapping image filename to
    [{label, box: [x1,y1,x2,y2], score}] in ORIGINAL pixels, same
    convention as /api/project), `concepts` (optional JSON array or
    comma string, e.g. ["door"]; detected per image with `detector`
    to fill images missing from `detections`), `detector`
    ("sam" | "clip", server-side only), `dense` ("1" to also run
    COLMAP multi-view stereo + fusion after the sparse model),
    `use_gpu` ("1" default: use CUDA only when actually available;
    "0" forces CPU). `label_objects` defaults to "0": no detector,
    API calls or label voting, even if concepts/detections are supplied.
    Set it to "1" to label disposable image copies after geometry finishes.

    No monocular-depth pass runs on this route: labels come from
    boxes only, and geometry comes from COLMAP. GPU choice is
    automatic: CUDA is used only when torch.cuda or nvidia-smi
    reports a real GPU, otherwise CPU flags are passed — `use_gpu`
    is an override to force CPU. Returns 503 (never 500) when
    neither the COLMAP binary nor pycolmap is installed.
    """
    import tempfile
    import zipfile as _zip

    from fastapi.responses import JSONResponse
    import sfm as sfm_mod

    try:
        raw = await zipfile.read()
    except Exception as e:
        return {"error": f"could not read zip: {e}", "cameras": []}
    try:
        zf = _zip.ZipFile(io.BytesIO(raw))
    except _zip.BadZipFile:
        return {"error": "not a zip file", "cameras": []}
    members = [i for i in zf.infolist()
               if not i.is_dir() and i.filename.lower().endswith(IMAGE_EXTS)]
    members.sort(key=lambda i: i.filename)
    if not members:
        return {"error": "no images in zip", "cameras": []}
    if sum(i.file_size for i in members) > MAX_BATCH_BYTES:
        return {"error": "zip contents exceed 200 MB", "cameras": []}

    want_gpu = str(use_gpu or "1").strip().lower() not in (
        "0", "false", "no", "off")
    gpu_used = bool(want_gpu and sfm_mod.gpu_available())
    warnings = []
    if want_gpu and not gpu_used:
        warnings.append("no GPU detected: COLMAP runs on CPU")

    if not sfm_mod.sfm_backend_available():
        return JSONResponse(status_code=503, content={
            "error": "colmap not installed: install the COLMAP CLI "
                     "(https://colmap.github.io) or `pip install pycolmap` "
                     "to enable /api/sfm",
            "cameras": [], "gpu_used": gpu_used, "warnings": warnings})

    want_labels = str(label_objects).strip().lower() in ("1", "true", "yes", "on")
    try:
        dets = json.loads(detections) if want_labels and (detections or "").strip() else {}
    except json.JSONDecodeError:
        dets = {}
        warnings.append("detections is not valid JSON: label voting skipped")
    if dets and not isinstance(dets, dict):
        dets = {}
        warnings.append("detections must map image filename to boxes: "
                        "label voting skipped")

    def job(emit):
        """Slow pipeline: runs in a worker thread while _stream()
        forwards log lines to the client (see below)."""
        nonlocal dets  # explicit detections merge with auto ones below
        try:
            names_in = parse_concepts(concepts) if want_labels else []
            want_dense = str(dense or "").strip().lower() not in (
                "", "0", "false", "no", "off")
            with tempfile.TemporaryDirectory(prefix="sfm-") as tmp:
                # Images live inside the workspace so patch_match_stereo
                # can use the same directory (COLMAP workspace layout).
                workspace = os.path.join(tmp, "workspace")
                img_dir = os.path.join(workspace, "images")
                os.makedirs(img_dir, exist_ok=True)
                kept = {}  # COLMAP name -> PIL (depth-free label source)
                clean_thumbnails = {}  # previews read from the actual COLMAP input files
                orientations = {}  # COLMAP name -> landscape/portrait/square
                photo_locations = {}
                taken, renamed = set(), []
                unreadable = 0
                exif_rotated = 0
                if len(members) > MAX_BATCH_IMAGES:
                    warnings.append(
                        f"zip holds {len(members)} photos: only the first "
                        f"{MAX_BATCH_IMAGES} (sorted by name) were used")
                for info in members[:MAX_BATCH_IMAGES]:
                    try:
                        data = zf.read(info.filename)
                        opened = Image.open(io.BytesIO(data))
                        try:
                            tag = opened.getexif().get(274, 1)
                        except Exception:
                            tag = 1
                        # COLMAP reads stored pixels/dimensions verbatim
                        # and ignores the EXIF orientation tag, so phone
                        # portraits (stored landscape, tagged rotated)
                        # must be physically rotated upright before
                        # COLMAP sees them, with no tag left to re-apply.
                        pil = geo.oriented_image(opened.convert("RGB"))
                    except Exception:
                        unreadable += 1
                        continue
                    if tag not in (None, 1, "1"):
                        exif_rotated += 1
                    # Flattening subfolders must not drop photos: two
                    # entries sharing a basename get distinct COLMAP
                    # names instead of overwriting each other.
                    orig_base = os.path.basename(info.filename)
                    base = sfm_mod.unique_image_name(orig_base, taken)
                    if base != orig_base:
                        renamed.append(f"{info.filename} -> {base}")
                    location = geo.extract_exif_gps(pil)
                    if location:
                        photo_locations[base] = location
                    # Keep lens/focal/GPS metadata after transposing pixels.
                    # Saving without EXIF loses COLMAP's focal-length prior.
                    exif = pil.getexif()
                    exif.pop(274, None)
                    exif[256], exif[257] = pil.size
                    if 34665 in exif:
                        sub = exif.get_ifd(34665)
                        sub[40962], sub[40963] = pil.size
                    pil.save(os.path.join(img_dir, base), exif=exif.tobytes(),
                             quality=95)
                    with Image.open(os.path.join(img_dir, base)) as clean_input:
                        clean_thumbnails[base] = thumbnail_data_url(clean_input)
                    kept[base] = pil
                    orientations[base] = sfm_mod.image_orientation(
                        pil.width, pil.height)
                if unreadable:
                    warnings.append(
                        f"{unreadable} photo(s) in the zip could not be "
                        "read and were skipped (HEIC photos, for example, "
                        "need converting to JPEG first)")
                if renamed:
                    warnings.append(
                        f"{len(renamed)} photo(s) shared the filename of "
                        "an earlier photo and were renamed so none were "
                        f"dropped: {'; '.join(renamed[:3])}")
                if exif_rotated:
                    warnings.append(
                        f"{exif_rotated} photo(s) carried an EXIF "
                        "orientation tag and were rotated upright for "
                        "COLMAP (it reads stored pixels and ignores "
                        "that tag, so unrotated portraits reconstruct "
                        "sideways with swapped width/height)")
                _ori_counts = {}
                for _o in orientations.values():
                    _ori_counts[_o] = _ori_counts.get(_o, 0) + 1
                if _ori_counts.get("landscape") and (
                        _ori_counts.get("portrait")):
                    warnings.append(
                        f"mixed orientations: {_ori_counts['landscape']} "
                        f"landscape and {_ori_counts['portrait']} "
                        "portrait photo(s) — COLMAP groups matching "
                        "EXIF camera/focal metadata and dimensions; "
                        "different portrait/landscape dimensions stay separate")
                names = sorted(os.listdir(img_dir))
                if len(names) < 2:
                    return {"error": "need at least 2 readable images "
                                     "for reconstruction",
                            "cameras": [], "gpu_used": gpu_used,
                            "warnings": warnings}
                model_dir, run_warnings = sfm_mod.reconstruct(
                    img_dir, workspace, gpu_used, emit)
                warnings.extend(run_warnings)
                cameras, points, colors, parse_warnings = sfm_mod.parse_model(
                    model_dir)
                warnings.extend(parse_warnings)
                from georeference import fit_photo_gps
                georeference = fit_photo_gps(cameras, photo_locations)
                diagnostics = sfm_mod.reconstruction_diagnostics(
                    model_dir, os.path.join(workspace, "sfm.db"), cameras)
                diagnostics["input_images"] = len(names)
                error_px = diagnostics["mean_reprojection_error_px"]
                if error_px is not None and error_px > 2:
                    warnings.append(f"Mean sparse reprojection error is {error_px:.2f} px: inspect calibration and matches in the diagnostics report.")
                if len(cameras) < len(names):
                    warnings.append(f"Only {len(cameras)} of {len(names)} photos registered in the selected model; the cloud does not combine the complete set.")
                if len(names) <= 4 and diagnostics["camera_count"] > 1:
                    warnings.append("This small set has multiple camera calibrations. Missing/different focal metadata or dimensions may leave calibration weakly constrained; inspect the diagnostics report.")
                warnings.extend(sfm_mod.camera_dimension_warnings(
                    cameras,
                    {base: (pil.width, pil.height)
                     for base, pil in kept.items()}))
                total = len(points)
                if total == 0:
                    warnings.append("COLMAP returned an empty model (no 3D "
                                    "points): photos matched too weakly to "
                                    "triangulate — retry with more overlap "
                                    "and texture")
                points, colors = sfm_mod.downsample(points, colors)
                if total > len(points):
                    warnings.append(f"downsampled {total} points "
                                    f"to {len(points)} for the PLY export")
                ply_text = sfm_mod.write_ply_ascii(points, colors)
                point_labels = {}
                registered = {c["image"] for c in cameras}
                dense_ply, dense_count, dense_total = None, 0, 0
                dense_labels = {}
                d_pts = []
                if want_dense:
                    if not gpu_used:
                        warnings.append("Dense stereo requires CUDA: returning sparse reconstruction because GPU processing is disabled or unavailable.")
                    elif sfm_mod.colmap_binary() is None:
                        warnings.append("dense needs the COLMAP CLI: "
                                        "pycolmap fallback gives sparse only")
                    else:
                        try:
                            fused, dense_warnings = sfm_mod.run_dense_cli(
                                sfm_mod.colmap_binary(), workspace, gpu_used,
                                emit)
                            warnings.extend(dense_warnings)
                            d_pts, d_cols = sfm_mod.read_ply_points(fused)
                            dense_total = len(d_pts)
                            if dense_total > sfm_mod.DENSE_PLY_CAP:
                                stride = -(-dense_total //
                                           sfm_mod.DENSE_PLY_CAP)
                                d_pts = d_pts[::stride]
                                d_cols = d_cols[::stride]
                                warnings.append(
                                    f"downsampled {dense_total} dense points "
                                    f"to {len(d_pts)} for the reply")
                            dense_count = len(d_pts)
                            dense_ply = sfm_mod.write_ply_ascii(d_pts, d_cols)
                        except Exception as e:
                            warnings.append(f"dense stereo failed ({e}): "
                                            "sparse cloud still returned")
                # Geometry finishes before any detector runs. Detectors
                # receive disposable pixel copies, never COLMAP input files
                # or the pristine images used for previews and diagnostics.
                if names_in:
                    emit("Labelling copies of source photos after reconstruction (no depth pass)")
                    if detector == "sam" and os.getenv("MOCK_SAM") == "1":
                        warnings.append("MOCK_SAM is enabled: labels are demo boxes, not model detections. Choose Meta API for real labels.")
                    auto, auto_errors = detect_concepts_no_depth(
                        {k: v.copy() for k, v in kept.items() if k not in dets},
                        names_in, detector=detector or "sam",
                        **({"api_token": sam_token} if detector == "api" else {}))
                    if auto:
                        dets = {**auto, **dets}
                        warnings.append(f"detected {len(auto)} image(s) for {', '.join(names_in)} with {detector or 'sam'} (boxes only, no depth pass)")
                    else:
                        why = "; ".join(auto_errors[:3]) if auto_errors else "no boxes matched the concepts"
                        warnings.append(f"concepts detection returned no boxes ({why}): cloud is unlabeled")
                if want_labels and dets:
                    point_labels = {str(k): v for k, v in sfm_mod.vote_point_labels(points, cameras, dets).items()}
                    if dense_ply and d_pts:
                        dense_labels = {str(k): v for k, v in sfm_mod.vote_point_labels_numpy(d_pts, cameras, dets).items()}
                return {
                    "ply": ply_text,
                    "point_count": len(points),
                    "total_points": total,
                    # Per-image SAM/CLIP boxes that fed label voting
                    # ({image: [{label, box, score}]}), shown in the page's
                    # SAM stage box before the 3D view.
                    "detections": dets,
                    "label_objects": want_labels,
                    "colmap_inputs_annotated": False,
                    # Downscaled per-photo JPEGs + original sizes so the page
                    # can draw the boxes over the photos (SAM image viewer).
                    "thumbnails": clean_thumbnails,
                    "image_sizes": {base: [pil.width, pil.height]
                                    for base, pil in kept.items()},
                    # Upright orientation per photo (landscape/portrait/
                    # square), so the page can badge mixed sets.
                    "orientations": orientations,
                    "photo_locations": photo_locations,
                    "georeference": georeference,
                    "coordinate_frame": "local-sfm",
                    "diagnostics": diagnostics,
                    "cameras": cameras,
                    "point_labels": point_labels,
                    "registered": sorted(registered),
                    "unregistered": [n for n in names if n not in registered],
                    "dense_ply": dense_ply,
                    "dense_count": dense_count,
                    "dense_total": dense_total,
                    "dense_labels": dense_labels,
                    "gpu_used": gpu_used,
                    "warnings": warnings,
                }
        except Exception as e:  # reconstruction failure is data, never a 500
            # The backend may have warned before failing (e.g. CPU fallback):
            # those notes live on the error now that reconstruct() raised.
            warnings.extend(getattr(e, "warnings", None) or [])
            return {"error": f"sfm failed: {e}", "cameras": [],
                    "gpu_used": gpu_used, "warnings": warnings}

    from queue import Queue, Empty
    import threading
    from fastapi.responses import StreamingResponse
    log_queue: Queue = Queue()

    def _worker():
        try:
            log_queue.put({"type": "result", "data": job(log_queue.put)})
        except Exception as e:  # never leave the stream hanging
            log_queue.put({"type": "result", "data": {
                "error": f"sfm failed: {e}", "cameras": [],
                "gpu_used": gpu_used, "warnings": warnings}})

    def _stream():
        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()
        while True:
            try:
                message = log_queue.get(timeout=15)
            except Empty:
                if not thread.is_alive():
                    yield (json.dumps({"type": "result", "data": {
                        "error": "sfm worker stopped unexpectedly",
                        "cameras": [], "gpu_used": gpu_used,
                        "warnings": warnings}}) + "\n")
                    break
                yield '{"type": "ping"}\n'
                continue
            if isinstance(message, dict):
                yield json.dumps(message) + "\n"
                if message.get("type") == "result":
                    break
            else:
                yield json.dumps({"type": "log", "line": str(message)}) + "\n"
        thread.join(timeout=120)

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


@app.post("/api/video-cloud")
async def video_cloud(
    zipfile: UploadFile = File(...),
    concepts: str = Form(default="[]"),
    geoms: str = Form(default=""),
    detector: str = Form(default="sam"),
    sam_token: str = Form(default=""),
    lat: str = Form(default=""),
    lon: str = Form(default=""),
    heading: str = Form(default=""),
    prefer: str = Form(default="exif"),
    snap: str = Form(default="0"),
    max_frames: str = Form(default="16"),
    max_points: str = Form(default="1000000"),
    sample_fps: str = Form(default="10"),
    resolution: str = Form(default="low"),
    consistency: str = Form(default="1"),
    filter_black: str = Form(default="0"),
    skip_titles: str = Form(default="1"),
    gaussians: str = Form(default="0"),
):
    """Video workflow: photo (EXIF fix) + short video -> DA3 cloud -> map.

    Streams NDJSON like /api/sfm (log lines, then a result). The zip
    holds exactly one photo and one video. Frames are sampled from the
    video, run through Depth Anything 3 (metric depth + COLMAP-format
    poses), back-projected to a point cloud, concept boxes are voted
    onto its points, and per-label features (centroid pins, or
    PCA-endpoint lines for `|line` labels) are geo-located from the
    photo's EXIF location + heading. `snap=1` snaps door/window point
    features to OSM building outlines. Real inference needs
    depth-anything-3 + GPU; without it the result carries `error`
    (MOCK_DA3=1 gives the offline synthetic pass).
    """
    try:
        latf = float(lat) if lat else None
    except ValueError:
        latf = None
    try:
        lonf = float(lon) if lon else None
    except ValueError:
        lonf = None
    try:
        mf = max(1, min(120, int(max_frames or 16)))
    except ValueError:
        mf = 16
    try:
        point_cap = max(1000, min(2000000, int(max_points or 1000000)))
    except ValueError:
        point_cap = 1000000
    try:
        sampling_rate = float(sample_fps)
        if not 0.1 <= sampling_rate <= 30:
            sampling_rate = 10.
    except ValueError:
        sampling_rate = 10.
    data = await zipfile.read()
    if len(data) > MAX_BATCH_BYTES:
        return {"error": (f"zip too large ({len(data) / 1e6:.0f} MB, "
                          f"max {MAX_BATCH_BYTES / 1e6:.0f} MB)")}

    concept_names, geom_map = concepts_and_geoms(concepts, geoms)

    def job(emit):
        import shutil
        import tempfile
        import zipfile as _zip

        import da3 as da3_mod
        import sfm as sfm_mod

        warnings = []
        try:
            zf = _zip.ZipFile(io.BytesIO(data))
        except _zip.BadZipFile:
            return {"error": "not a zip file", "warnings": warnings}
        infos = [i for i in zf.infolist()
                 if not i.is_dir() and "__MACOSX" not in i.filename]
        if sum(i.file_size for i in infos) > MAX_BATCH_BYTES:
            return {"error": "zip contents exceed the 200 MB extraction limit",
                    "warnings": warnings}
        video_info = next((i for i in infos
                           if i.filename.lower()
                           .endswith(da3_mod.VIDEO_EXTS)), None)
        photo_info = next((i for i in infos
                           if i.filename.lower().endswith(IMAGE_EXTS)), None)
        if video_info is None:
            names = ", ".join(sorted(os.path.basename(i.filename)
                                     for i in infos)) or "(none)"
            return {"error": "zip holds no video (mp4/mov/avi/mkv/webm); "
                             f"found: {names}", "warnings": warnings}
        if photo_info is None:
            return {"error": "zip holds no photo (jpg/png) with EXIF",
                    "warnings": warnings}
        tmp = tempfile.mkdtemp(prefix="mg-video-")
        try:
            vpath = os.path.join(tmp, os.path.basename(video_info.filename))
            with open(vpath, "wb") as fh:
                fh.write(zf.read(video_info))
            photo = geo.oriented_image(
                Image.open(io.BytesIO(zf.read(photo_info))).convert("RGB"))
            location, gps_source = geo.resolve_location(
                latf, lonf, photo, prefer=prefer or "exif")
            heading_deg, heading_source = geo.resolve_heading(
                heading, photo)
            emit(f"Photo {photo_info.filename}: "
                 f"{location and (round(location['lat'], 5), round(location['lon'], 5))} "
                 f"({gps_source}); heading {heading_deg} ({heading_source})")

            extraction = {}
            frames = da3_mod.extract_frames(vpath, tmp, max_frames=mf,
                                            sample_fps=sampling_rate,
                                            skip_titles=skip_titles == "1",
                                            diagnostics=extraction)
            skipped = extraction.get("skipped_title_frames", [])
            if skipped:
                warnings.append(f"Skipped {len(skipped)} black title/blank frames before DA3 inference.")
                emit(f"Excluded black title/blank frame indices: {skipped}")
            emit(f"Sampled {len(frames)} frame(s) from "
                 f"{video_info.filename}")
            times = [f.get("time_s") for f in frames]
            if times and all(t is not None for t in times):
                emit(f"Sampled video time: {times[0]:.2f}s to {times[-1]:.2f}s")
                if len(times) > 1 and times[-1] > times[0]:
                    effective_fps = (len(times) - 1) / (times[-1] - times[0])
                    emit(f"Effective sampling: {effective_fps:.2f} fps (requested {sampling_rate:g})")
                    if effective_fps < sampling_rate * .8:
                        warnings.append(f"Frame budget reduced sampling to {effective_fps:.2f} fps; increase frames for more overlap.")

            emit(f"Running DA3 on {len(frames)} frames; cloud budget {point_cap} points")
            scene = da3_mod.estimate_scene(frames, emit=emit,
                                           resolution=resolution, infer_gs=gaussians == "1")
            emit(f"Depth pass done ({scene['model']})")
            if not scene.get("mock") and not str(scene.get("device", "")).startswith("cuda"):
                warnings.append("DA3 ran on CPU; CUDA was unavailable to the backend process.")

            names = [f["name"] for f in frames]
            pils = {names[i]: scene["processed"][i]
                    for i in range(len(names))}
            dets, errors = {}, {}
            if concept_names:
                dets, errors = detect_concepts_no_depth(
                    pils, concept_names, detector or "sam", sam_token)
                warnings.extend(str(e) for e in errors)
                emit(f"Tagged {sum(len(v) for v in dets.values())} box(es) "
                     f"on {len(dets)} frame(s)")

            diagnostics = dict(extraction)
            points, colors = da3_mod.build_cloud(
                scene, cap=point_cap, diagnostics=diagnostics,
                consistency=consistency == "1", filter_black=filter_black == "1")
            diagnostics.update(device=scene.get("device", "mock"),
                               gpu_name=scene.get("gpu_name"),
                               process_res_method=scene.get("process_res_method"),
                               ref_view_strategy=scene.get("ref_view_strategy"),
                               processed_sizes=[list(p.size) for p in scene["processed"]],
                               sampled_frame_indices=[f.get("frame_index") for f in frames],
                               sampled_times_s=[f.get("time_s") for f in frames],
                               frame_limit=mf, point_limit=point_cap)
            emit(f"Point cloud: {len(points)} point(s)")
            emit(f"Retained points per frame: {diagnostics['points_per_frame']}; "
                 f"confidence threshold: {diagnostics['confidence_threshold']}")
            emit(f"Cross-view cleanup removed {diagnostics['consistency_removed']} unsupported points")
            if not points:
                return {"error": "DA3 produced no usable non-sky geometry",
                        "warnings": warnings, "diagnostics": diagnostics}
            if not scene.get("is_metric"):
                warnings.append("DA3 did not report metric scale; geographic features disabled.")
            cameras = da3_mod.da3_cameras(scene, names)
            point_labels = (sfm_mod.vote_point_labels_numpy(
                points, cameras, dets) if dets else {})

            features = []
            if (location and heading_deg is not None and point_labels
                    and scene.get("is_metric")):
                pts_cam = da3_mod.to_first_camera(points, scene)
                features = da3_mod.cloud_features(
                    pts_cam, point_labels, location["lat"],
                    location["lon"], heading_deg, geoms=geom_map)
                if snap == "1":
                    for f in features:
                        if (f.get("geom") == "point"
                                and str(f["label"]).lower()
                                in geo.SNAP_LABELS):
                            s = geo.snap_to_building_outline(
                                f["lat"], f["lon"])
                            if s:
                                f["snapped"] = s
                emit(f"{len(features)} map feature(s) from "
                     f"{sum(f['count'] for f in features)} labelled point(s)")
            elif point_labels and (not location or heading_deg is None):
                warnings.append(
                    "No photo location/heading — features carry no "
                    "lat/lon; add EXIF GPS + direction (or manual values) "
                    "to place them on the map.")

            from georeference import video_reference
            return {
                "ply": sfm_mod.write_ply_ascii(points, colors),
                "gaussians": scene.get("gaussians"),
                "georeference": video_reference(scene, location, heading_deg),
                "cameras": cameras,
                "diagnostics": diagnostics,
                "point_labels": {str(k): {"label": v["label"],
                                          "votes": v.get("votes", 0)}
                                 for k, v in point_labels.items()},
                "features": features,
                "location": location, "gps_source": gps_source,
                "heading_deg": heading_deg,
                "heading_source": heading_source,
                "frames": len(frames), "total_points": len(points),
                "shown_points": len(points),
                "model": scene["model"], "mock": bool(scene.get("mock")),
                "warnings": warnings, "detector": detector or "sam",
            }
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    from queue import Empty, Queue
    import threading
    from fastapi.responses import StreamingResponse
    log_queue: Queue = Queue()

    def _worker():
        try:
            log_queue.put({"type": "result", "data": job(log_queue.put)})
        except Exception as e:  # never leave the stream hanging
            log_queue.put({"type": "result", "data": {
                "error": f"video-cloud failed: {e}", "warnings": []}})

    def _stream():
        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()
        while True:
            try:
                message = log_queue.get(timeout=15)
            except Empty:
                if not thread.is_alive():
                    yield (json.dumps({"type": "result", "data": {
                        "error": "video-cloud worker stopped unexpectedly",
                        "warnings": []}}) + "\n")
                    break
                yield '{"type": "ping"}\n'
                continue
            if isinstance(message, dict):
                yield json.dumps(message) + "\n"
                if message.get("type") == "result":
                    break
            else:
                yield json.dumps({"type": "log", "line": str(message)}) + "\n"
        thread.join(timeout=60)

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


# Single-origin serving: the page and the API share one host:port so the
# browser's Meta-direct path can reach /api/project without CORS or
# cross-port failures (which previously broke depth + pins silently).
# Mounted AFTER every /api/* route above so the API takes precedence.
try:
    from fastapi.staticfiles import StaticFiles
    from pathlib import Path
    app.mount("/", StaticFiles(directory=Path(__file__).resolve().parent.parent,
                               html=True), name="page")
except Exception:
    pass  # API-only mode when staticfiles is unavailable

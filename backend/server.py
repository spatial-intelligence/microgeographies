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
  default       -> loads facebook/sam3 + Depth Anything Small via
                   transformers (needs torch + GPU for speed).
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
):
    raw = await image.read()
    pil = geo.oriented_image(Image.open(io.BytesIO(raw)).convert("RGB"))
    w, h = pil.size
    try:
        names = json.loads(concepts)
        if isinstance(names, str):
            names = [names]
    except json.JSONDecodeError:
        names = [c.strip() for c in concepts.split(",") if c.strip()]
    names = [n for n in names if n][:10]
    if not names:
        return {"error": "no concepts given", "detections": []}

    location, gps_source = geo.resolve_location(lat, lon, pil, prefer=prefer or "exif")
    heading_deg, heading_source = geo.resolve_heading(heading, pil)

    dets = run_detections(pil, names, detector=detector or "sam")
    depth_png = None
    if project == "1":
        grid, depth_error = get_depth(pil, model_id=model or None)
        depth_png = geo.depth_data_url(grid) if grid else None
        dets = project_boxes(pil, dets, location,
                             "" if heading_deg is None else str(heading_deg),
                             hfov, max_range, grid=grid, depth_error=depth_error)
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


def detect_concepts_no_depth(pil_by_name, concepts, detector="sam"):
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


def get_depth(pil, model_id=None):
    """Relative-depth grid for an image, or (None, error) when unavailable."""
    try:
        grid_w, grid_h = geo.depth_grid_dims(pil)
        return geo.estimate_depth_grid(
            pil, grid_w=grid_w, grid_h=grid_h,
            model_id=model_id)["grid"], None
    except Exception as e:
        return None, f"depth unavailable: {e}"


def project_boxes(pil, dets, location, heading="", hfov="60", max_range="30",
                  grid=None, depth_error=None):
    """Attach approx 3D location (lat/lon + ENU metres + pixel) per detection.

    Needs a location (phone fix or EXIF) and a compass heading; without
    either the boxes pass through untouched. Depth-model and OSM
    failures degrade to partial geo (never a 500).
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
        grid, depth_error = get_depth(pil)
    if grid is None:
        for d in dets:
            d["geo_error"] = depth_error or "depth unavailable"
        return dets
    depth = grid
    for d in dets:
        try:
            rel = geo.box_median_depth(depth, d["box"], w, h)
            dist = geo.relative_to_metric(rel, max_range_m=maxr)
            g = geo.project_detection(location["lat"], location["lon"], hdg,
                                      d["box"], w, h, dist, hfov_deg=fov)
            g["depth_rel"] = round(rel, 3)
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
):
    """Project externally produced boxes (e.g. Meta SAM-3.1 in the browser).

    `boxes` is JSON: [{"box": [x1,y1,x2,y2], "label": "door"}, ...] in
    absolute pixels of the uploaded image.
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
    grid, depth_error = get_depth(pil, model_id=model or None)
    dets = project_boxes(pil, dets, location,
                         "" if heading_deg is None else str(heading_deg),
                         hfov, max_range, grid=grid, depth_error=depth_error)
    return {"detections": dets, "location": location, "gps_source": gps_source,
            "heading_deg": heading_deg, "heading_source": heading_source,
            "depth_png": geo.depth_data_url(grid) if grid else None}


@app.post("/api/depth")
async def depth_map(image: UploadFile = File(...),
                    model: str = Form(default="")):
    """Monocular relative-depth grid for an image, plus any EXIF GPS."""
    raw = await image.read()
    pil = geo.oriented_image(Image.open(io.BytesIO(raw)).convert("RGB"))
    w, h = pil.size
    try:
        result = geo.estimate_depth_grid(pil, model_id=model or None)
    except Exception as e:
        return {"error": f"depth unavailable: {e}",
                "image_width": w, "image_height": h}
    flat = [v for row in result["grid"] for v in row]
    return {
        "image_width": w,
        "image_height": h,
        "grid_w": len(result["grid"][0]),
        "grid_h": len(result["grid"]),
        "grid": result["grid"],  # 0 = far, 1 = near
        "depth_min": min(flat),
        "depth_max": max(flat),
        "mock": result["mock"],
        "exif_gps": geo.extract_exif_gps(pil),
        "exif_heading": geo.extract_exif_heading(pil),
        "depth_png": geo.depth_data_url(result["grid"]),
    }


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
    merge_radius_m: str = Form(default="8"),
    sim_min: str = Form(default="0.75"),
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

    try:
        names = json.loads(concepts)
        if isinstance(names, str):
            names = [names]
    except json.JSONDecodeError:
        names = [c.strip() for c in concepts.split(",") if c.strip()]
    names = [n for n in names if n][:10]
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
        dets = mg.dedupe_same_image(run_detections(pil, names, detector=detector or "sam"))
        grid, depth_error = get_depth(pil, model_id=model or None)
        dets = project_boxes(pil, dets, location,
                             "" if hdg is None else str(hdg),
                             hfov, max_range, grid=grid, depth_error=depth_error)
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
    "0" forces CPU).

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

    try:
        dets = json.loads(detections) if (detections or "").strip() else {}
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
            names_in = parse_concepts(concepts)
            want_dense = str(dense or "").strip().lower() not in (
                "", "0", "false", "no", "off")
            with tempfile.TemporaryDirectory(prefix="sfm-") as tmp:
                # Images live inside the workspace so patch_match_stereo
                # can use the same directory (COLMAP workspace layout).
                workspace = os.path.join(tmp, "workspace")
                img_dir = os.path.join(workspace, "images")
                os.makedirs(img_dir, exist_ok=True)
                kept = {}  # COLMAP name -> PIL (depth-free label source)
                orientations = {}  # COLMAP name -> landscape/portrait/square
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
                    pil.save(os.path.join(img_dir, base))
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
                        "portrait photo(s) — each photo gets its own "
                        "COLMAP camera, so both reconstruct together "
                        "in their upright frames")
                # Server-side labels without any depth pass: explicit
                # detections win per image, concepts fill the rest.
                if names_in:
                    auto, auto_errors = detect_concepts_no_depth(
                        {k: v for k, v in kept.items() if k not in dets},
                        names_in, detector=detector or "sam")
                    if auto:
                        dets = {**auto, **dets}
                        warnings.append(
                            f"detected {len(auto)} image(s) for "
                            f"{', '.join(names_in)} with {detector or 'sam'} "
                            "(boxes only, no depth pass)")
                    else:
                        why = ("; ".join(auto_errors[:3]) if auto_errors
                               else "no boxes matched the concepts")
                        warnings.append(
                            f"concepts detection returned no boxes ({why}): "
                            "cloud is unlabeled")
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
                point_labels = {str(k): v for k, v in
                                sfm_mod.vote_point_labels(
                                    points, cameras, dets).items()}
                registered = {c["image"] for c in cameras}
                dense_ply, dense_count, dense_total = None, 0, 0
                dense_labels = {}
                if want_dense:
                    if sfm_mod.colmap_binary() is None:
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
                            dense_labels = {
                                str(k): v for k, v in
                                sfm_mod.vote_point_labels_numpy(
                                    d_pts, cameras, dets).items()}
                        except Exception as e:
                            warnings.append(f"dense stereo failed ({e}): "
                                            "sparse cloud still returned")
                return {
                    "ply": ply_text,
                    "point_count": len(points),
                    "total_points": total,
                    # Per-image SAM/CLIP boxes that fed label voting
                    # ({image: [{label, box, score}]}), shown in the page's
                    # SAM stage box before the 3D view.
                    "detections": dets,
                    # Downscaled per-photo JPEGs + original sizes so the page
                    # can draw the boxes over the photos (SAM image viewer).
                    "thumbnails": {base: thumbnail_data_url(pil)
                                   for base, pil in kept.items()},
                    "image_sizes": {base: [pil.width, pil.height]
                                    for base, pil in kept.items()},
                    # Upright orientation per photo (landscape/portrait/
                    # square), so the page can badge mixed sets.
                    "orientations": orientations,
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

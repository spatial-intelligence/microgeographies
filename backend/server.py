"""Microgeographies SAM test backend.

POST /api/detect with multipart fields:
  image: image file
  concepts: JSON array, e.g. ["door", "steps"]
  lat, lon, accuracy: optional GPS strings (phone fix; EXIF GPS is used
    as a fallback when they are empty, e.g. photo uploaded later)
  heading: optional compass bearing of the camera axis, degrees
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
    return {"ok": True, "mock": os.getenv("MOCK_SAM") == "1"}


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
):
    raw = await image.read()
    pil = Image.open(io.BytesIO(raw)).convert("RGB")
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

    location, gps_source = geo.resolve_location(lat, lon, pil)

    if os.getenv("MOCK_SAM") == "1":
        dets = mock_detections(w, h, names)
    else:
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
    depth_png = None
    if project == "1":
        grid, depth_error = get_depth(pil)
        depth_png = geo.depth_data_url(grid) if grid else None
        dets = project_boxes(pil, dets, location, heading, hfov, max_range,
                             grid=grid, depth_error=depth_error)
    return {
        "detections": dets,
        "image_width": w,
        "image_height": h,
        "gps": {"lat": lat, "lon": lon, "accuracy": accuracy},
        "location": location,
        "gps_source": gps_source,  # "live" | "exif" | "none"
        "depth_png": depth_png,  # turbo-colorized depth map (blue far → red near)
    }


def get_depth(pil):
    """Relative-depth grid for an image, or (None, error) when unavailable."""
    try:
        return geo.estimate_depth_grid(pil)["grid"], None
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
):
    """Project externally produced boxes (e.g. Meta SAM-3.1 in the browser).

    `boxes` is JSON: [{"box": [x1,y1,x2,y2], "label": "door"}, ...] in
    absolute pixels of the uploaded image.
    """
    raw = await image.read()
    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    try:
        dets = json.loads(boxes)
        if isinstance(dets, dict):
            dets = dets.get("detections", dets.get("results", []))
    except json.JSONDecodeError:
        return {"error": "boxes is not valid JSON", "detections": []}
    if not isinstance(dets, list):
        return {"error": "boxes must be a JSON array", "detections": []}
    location, gps_source = geo.resolve_location(lat, lon, pil)
    grid, depth_error = get_depth(pil)
    dets = project_boxes(pil, dets, location, heading, hfov, max_range,
                         grid=grid, depth_error=depth_error)
    return {"detections": dets, "location": location, "gps_source": gps_source,
            "depth_png": geo.depth_data_url(grid) if grid else None}


@app.post("/api/depth")
async def depth_map(image: UploadFile = File(...)):
    """Monocular relative-depth grid for an image, plus any EXIF GPS."""
    raw = await image.read()
    pil = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = pil.size
    try:
        result = geo.estimate_depth_grid(pil)
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
        "depth_png": geo.depth_data_url(result["grid"]),
    }

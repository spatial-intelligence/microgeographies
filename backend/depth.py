"""Monocular depth + pixel-to-map projection for microgeographies.

Pipeline this module implements::

    photo + phone GPS (or EXIF GPS fallback) + compass heading
        -> monocular depth (relative depth map, 0 = far, 1 = near)
        -> per-detection range in metres
        -> bearing from box horizontal centre + camera heading
        -> approx lat/lon per detection (SAM door / bin / step boxes etc.)
        -> door/window-like pins snapped to the nearest OpenStreetMap
           building outline (delivery-point microgeography for robots).

Only the Python standard library and Pillow are required. The depth
model (torch + transformers) and the OSM lookup (network) are lazy and
degrade gracefully: ``MOCK_DEPTH=1`` gives a deterministic gradient for
tests, and a failed OSM query returns ``None`` instead of raising.

Depth scale note: a single image gives *relative* depth only. Ranges
are mapped linearly so that rel=1 (nearest) -> ``min_range_m`` and
rel=0 (farthest) -> ``max_range_m`` (default 0.5 m .. 30 m, tuned for
street-level facades). Treat every projected pin as approximate.
"""

import json
import math
import os
import statistics
import urllib.parse
import urllib.request

# Labels whose pins describe a building entrance and are therefore worth
# snapping onto the OSM building outline.
SNAP_LABELS = {"door", "doors", "doorway", "entrance", "gate", "window", "windows"}

EARTH_R_M = 6371000.0
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# No transformers-native Depth Anything V3 checkpoint exists yet (the V3
# weights on HF are ONNX/mobile ports), so V2-Small stays the default.
# Point DEPTH_MODEL_ID at another AutoModelForDepthEstimation id — e.g.
# depth-anything/Depth-Anything-V2-Base-hf — to swap without code changes.
DEFAULT_DEPTH_MODEL = os.environ.get(
    "DEPTH_MODEL_ID", "LiheYoung/depth-anything-small-hf")

_depth_model = None  # lazy (processor, model, device)
_depth_model_id = None


# --------------------------------------------------------------------------
# Geodesy helpers (pure, dependency-free)
# --------------------------------------------------------------------------

def destination_point(lat_deg, lon_deg, bearing_deg, distance_m):
    """Lat/lon reached from (lat, lon) after walking distance_m on bearing."""
    lat1 = math.radians(lat_deg)
    lon1 = math.radians(lon_deg)
    br = math.radians(bearing_deg)
    d = distance_m / EARTH_R_M
    lat2 = math.asin(math.sin(lat1) * math.cos(d)
                     + math.cos(lat1) * math.sin(d) * math.cos(br))
    lon2 = lon1 + math.atan2(math.sin(br) * math.sin(d) * math.cos(lat1),
                             math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), math.degrees(lon2)


def haversine_m(lat1, lon1, lat2, lon2):
    """Great-circle distance in metres between two lat/lon points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R_M * math.asin(math.sqrt(a))


def pixel_to_bearing(box_cx_frac, heading_deg, hfov_deg=60.0):
    """Compass bearing of the pixel column at fractional x (0..1).

    Pinhole model: the exact ray angle is
    ``atan((cx - 0.5) * 2 * tan(hfov / 2))`` added to the camera heading.
    """
    half = math.tan(math.radians(hfov_deg) / 2.0)
    offset = math.degrees(math.atan((box_cx_frac - 0.5) * 2.0 * half))
    return (heading_deg + offset) % 360.0


def relative_to_metric(rel01, max_range_m=30.0, min_range_m=0.5):
    """Map normalized relative depth (0 = far, 1 = near) to metres."""
    rel01 = min(1.0, max(0.0, float(rel01)))
    return min_range_m + (1.0 - rel01) * (max_range_m - min_range_m)


def box_center_frac(box_xyxy, img_w, img_h):
    """Fractional (cx, cy) centre of a pixel-space xyxy box."""
    x1, y1, x2, y2 = box_xyxy
    return ((x1 + x2) / 2.0 / img_w, (y1 + y2) / 2.0 / img_h)


def box_median_depth(depth_grid, box_xyxy, img_w, img_h):
    """Median relative depth over the box footprint.

    depth_grid is a rows x cols nested list in 0..1 (1 = near).
    Median (not mean) so a box straddling a depth edge stays robust.
    """
    rows = len(depth_grid)
    cols = len(depth_grid[0]) if rows else 0
    if not rows or not cols:
        return 0.5
    x1, y1, x2, y2 = box_xyxy
    c0 = min(cols - 1, max(0, int(x1 / img_w * cols)))
    c1 = min(cols - 1, max(0, int(x2 / img_w * cols)))
    r0 = min(rows - 1, max(0, int(y1 / img_h * rows)))
    r1 = min(rows - 1, max(0, int(y2 / img_h * rows)))
    vals = [depth_grid[r][c]
            for r in range(min(r0, r1), max(r0, r1) + 1)
            for c in range(min(c0, c1), max(c0, c1) + 1)]
    if not vals:
        return 0.5
    return float(statistics.median(vals))


def project_detection(lat, lon, heading_deg, box_xyxy, img_w, img_h,
                      depth_m, hfov_deg=60.0):
    """Project one detection box to an approx 3D location.

    Bearing comes from the box-centre column (pinhole model); elevation
    from the box-centre row assuming a level camera (pitch 0). Returns
    ``lat``/``lon`` plus ``enu_m`` — metres east (x), north (y), up (z)
    relative to the camera, z = 0 at the camera — and the ``pixel``
    box centre in image coordinates.
    """
    cx, cy = box_center_frac(box_xyxy, img_w, img_h)
    bearing = pixel_to_bearing(cx, heading_deg, hfov_deg)
    # Vertical field of view from the aspect ratio, then the ray's
    # elevation above the horizon (negative looks downward).
    vfov = 2.0 * math.degrees(math.atan(
        math.tan(math.radians(hfov_deg) / 2.0) * img_h / max(1, img_w)))
    elev = -math.degrees(math.atan(
        (cy - 0.5) * 2.0 * math.tan(math.radians(vfov) / 2.0)))
    br, el = math.radians(bearing), math.radians(elev)
    horiz = depth_m * math.cos(el)
    plat, plon = destination_point(lat, lon, bearing, depth_m)
    return {"lat": plat, "lon": plon,
            "bearing_deg": round(bearing, 2),
            "distance_m": round(depth_m, 2),
            "enu_m": {"x": round(horiz * math.sin(br), 2),
                      "y": round(horiz * math.cos(br), 2),
                      "z": round(depth_m * math.sin(el), 2)},
            "pixel": {"x": int(round(cx * img_w)),
                      "y": int(round(cy * img_h))}}


def _turbo_rgb(t):
    """Google-Turbo-like colormap (published polynomial approximation).

    t = 0 is deep blue (far), t = 1 is dark red (near) — the same
    direction as Depth Anything V3 outdoor visualizations.
    """
    t = min(1.0, max(0.0, float(t)))
    r = (0.13572138 + 4.61539260 * t - 42.66032258 * t**2
         + 132.13108234 * t**3 - 152.94239396 * t**4 + 59.28637943 * t**5)
    g = (0.09140261 + 2.19418839 * t + 4.84296658 * t**2
         - 14.18503333 * t**3 + 4.27729857 * t**4 + 2.82956604 * t**5)
    b = (0.10667330 + 12.64194608 * t - 60.58204836 * t**2
         + 110.36276771 * t**3 - 89.90310912 * t**4 + 27.34824973 * t**5)
    return (round(min(1.0, max(0.0, r)) * 255),
            round(min(1.0, max(0.0, g)) * 255),
            round(min(1.0, max(0.0, b)) * 255))


def depth_data_url(depth_grid, out_w=480):
    """Colorize a relative-depth grid as a PNG data URL (blue far → red near).

    Needs Pillow (already a backend dependency). Returns ``None`` when
    Pillow is unavailable so visualization stays optional.
    """
    try:
        from PIL import Image
        import base64
        import io as _io
    except ImportError:
        return None
    rows = len(depth_grid)
    cols = len(depth_grid[0]) if rows else 0
    if not rows or not cols:
        return None
    out_h = max(1, round(out_w * rows / cols))
    img = Image.new("RGB", (out_w, out_h))
    px = img.load()
    for y in range(out_h):
        grow = depth_grid[min(rows - 1, y * rows // out_h)]
        for x in range(out_w):
            px[x, y] = _turbo_rgb(grow[min(cols - 1, x * cols // out_w)])
    buf = _io.BytesIO()
    img.save(buf, "PNG")
    return ("data:image/png;base64,"
            + base64.b64encode(buf.getvalue()).decode("ascii"))


# --------------------------------------------------------------------------
# EXIF GPS fallback (photo uploaded later, no live phone fix)
# --------------------------------------------------------------------------

def _rational_to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        pass
    # Pillow IFDRational exposes numerator/denominator; tuples also occur.
    num = getattr(v, "numerator", None)
    den = getattr(v, "denominator", None)
    if num is not None and den:
        return num / den
    if isinstance(v, (tuple, list)) and len(v) == 2 and v[1]:
        return v[0] / v[1]
    return float(v)


def _dms_to_deg(dms):
    d, m, s = (_rational_to_float(v) for v in dms)
    return d + m / 60.0 + s / 3600.0


def _gps_ifd(pil_image):
    """Raw EXIF GPS IFD dict, or ``{}`` when the photo carries none."""
    try:
        exif = pil_image.getexif()
        if not exif:
            return {}
        gps_ifd = exif.get_ifd(0x8825) if hasattr(exif, "get_ifd") else {}
        return gps_ifd or {}
    except Exception:
        return {}


def extract_exif_gps(pil_image):
    """Return ``{"lat", "lon"}`` from JPEG EXIF GPS, else ``None``.

    Never raises: a photo without GPS tags (or without EXIF at all)
    simply yields ``None`` so the pipeline can fall back to the live fix.
    """
    try:
        gps_ifd = _gps_ifd(pil_image)
        if not gps_ifd:
            return None
        lat = _dms_to_deg(gps_ifd[2])
        if str(gps_ifd.get(1, "N")).upper().startswith("S"):
            lat = -lat
        lon = _dms_to_deg(gps_ifd[4])
        if str(gps_ifd.get(3, "E")).upper().startswith("W"):
            lon = -lon
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            return None
        return {"lat": lat, "lon": lon}
    except Exception:
        return None


def extract_exif_heading(pil_image):
    """Camera compass bearing from EXIF GPSImgDirection, else ``None``.

    Only true-north references (``GPSImgDirectionRef = "T"``) are trusted;
    magnetic ("M") readings need a declination model we do not carry, so
    they are ignored rather than used wrong. Never raises.
    """
    try:
        gps_ifd = _gps_ifd(pil_image)
        if 0x0011 not in gps_ifd:
            return None
        if str(gps_ifd.get(0x0010, "T")).upper() != "T":
            return None
        hdg = _rational_to_float(gps_ifd[0x0011]) % 360.0
        return round(hdg, 2) if math.isfinite(hdg) else None
    except Exception:
        return None


def resolve_location(explicit_lat, explicit_lon, pil_image, prefer="exif"):
    """Pick the camera location.

    Default (``prefer="exif"``): the photo's EXIF GPS wins — a saved photo
    was taken somewhere else, so its metadata beats wherever this computer
    happens to be now — otherwise the explicit fix. With
    ``prefer="manual"``, a deliberately typed correction wins over EXIF.
    Source is ``"exif"``, ``"live"``, ``"manual"``, or ``"none"``.
    """
    if prefer == "manual":
        try:
            lat = float(explicit_lat) if explicit_lat not in (None, "") else None
            lon = float(explicit_lon) if explicit_lon not in (None, "") else None
        except (TypeError, ValueError):
            lat, lon = None, None
        if (lat is not None and lon is not None
                and -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            return {"lat": lat, "lon": lon}, "manual"
    exif = extract_exif_gps(pil_image)
    if exif:
        return exif, "exif"
    try:
        lat = float(explicit_lat) if explicit_lat not in (None, "") else None
        lon = float(explicit_lon) if explicit_lon not in (None, "") else None
    except (TypeError, ValueError):
        lat, lon = None, None
    if lat is not None and lon is not None:
        return {"lat": lat, "lon": lon}, "live"
    return None, "none"


def resolve_heading(explicit_heading, pil_image):
    """Deliberate manual heading wins, else EXIF direction, else ``None``.

    Returns ``(heading_deg_or_None, source)`` with source ``"manual"``,
    ``"exif"``, or ``"none"``.
    """
    try:
        hdg = float(explicit_heading) if explicit_heading not in (None, "") else None
    except (TypeError, ValueError):
        hdg = None
    if hdg is not None and math.isfinite(hdg):
        return ((hdg % 360.0 + 360.0) % 360.0), "manual"
    exif_hdg = extract_exif_heading(pil_image)
    if exif_hdg is not None:
        return exif_hdg, "exif"
    return None, "none"


# --------------------------------------------------------------------------
# Monocular depth
# --------------------------------------------------------------------------

def mock_depth_grid(grid_w=80, grid_h=60):
    """Deterministic gradient for tests/offline: sky far, ground near."""
    return [[round(r / max(1, grid_h - 1), 4) for _c in range(grid_w)]
            for r in range(grid_h)]


def _load_depth_model(model_id=None):
    global _depth_model, _depth_model_id
    model_id = model_id or DEFAULT_DEPTH_MODEL
    if _depth_model is not None and _depth_model_id == model_id:
        return _depth_model
    import torch
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    device = "cuda" if torch.cuda.is_available() else "cpu"
    processor = AutoImageProcessor.from_pretrained(model_id)
    model = AutoModelForDepthEstimation.from_pretrained(model_id).to(device)
    model.eval()
    _depth_model = (processor, model, device)
    _depth_model_id = model_id
    return _depth_model


def estimate_depth_grid(pil_image, grid_w=80, grid_h=60, model_id=None):
    """Relative depth as a grid_h x grid_w nested list, 0 = far, 1 = near.

    Uses ``MOCK_DEPTH=1`` gradient when set (tests, offline dev),
    otherwise the depth model via transformers (downloads weights on
    first use). The full-resolution prediction is min-max normalized
    then downsampled to the grid by block averaging.
    """
    if os.getenv("MOCK_DEPTH") == "1":
        return {"grid": mock_depth_grid(grid_w, grid_h), "mock": True}
    import torch
    rgb = pil_image.convert("RGB")
    processor, model, device = _load_depth_model(model_id)
    inputs = processor(images=rgb, return_tensors="pt").to(device)
    with torch.no_grad():
        pred = model(**inputs).predicted_depth[0]
    # Normalize to 0..1 (1 = near). Depth Anything emits larger = closer.
    lo, hi = pred.min().item(), pred.max().item()
    norm = (pred - lo) / max(hi - lo, 1e-6)
    H, W = norm.shape
    grid = []
    for r in range(grid_h):
        row = []
        for c in range(grid_w):
            r0, r1 = r * H // grid_h, max(r * H // grid_h + 1, (r + 1) * H // grid_h)
            c0, c1 = c * W // grid_w, max(c * W // grid_w + 1, (c + 1) * W // grid_w)
            block = norm[r0:r1, c0:c1]
            row.append(round(float(block.mean().item()), 4))
        grid.append(row)
    return {"grid": grid, "mock": False}


# --------------------------------------------------------------------------
# OpenStreetMap building-outline snap
# --------------------------------------------------------------------------

def nearest_point_on_polygon(lat, lon, ring):
    """Nearest point on a closed ring [(lat, lon), ...] to (lat, lon).

    Equirectangular projection around the query point keeps this exact
    enough at street scale. Returns ``(plat, plon, dist_m)``.
    """
    lat0 = math.radians(lat)
    kx, ky = EARTH_R_M * math.cos(lat0), EARTH_R_M
    px, py = math.radians(lon) * kx, math.radians(lat) * ky
    best = None
    pts = [(math.radians(lo) * kx, math.radians(la) * ky, la, lo)
           for la, lo in ring]
    for (ax, ay, _ala, _alo), (bx, by, blat, blon) in zip(pts, pts[1:]):
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        t = ((px - ax) * dx + (py - ay) * dy) / seg2 if seg2 else 0.0
        t = min(1.0, max(0.0, t))
        cx, cy = ax + t * dx, ay + t * dy
        dist = math.hypot(px - cx, py - cy)
        if best is None or dist < best[0]:
            # Interpolate back in lat/lon along the segment.
            plat = _ala + t * (blat - _ala)
            plon = _alo + t * (blon - _alo)
            best = (dist, plat, plon)
    if best is None:
        return lat, lon, 0.0
    return best[1], best[2], best[0]


def fetch_buildings_near(lat, lon, radius_m=60, timeout_s=15):
    """Building footprint rings near a point via the Overpass API.

    Returns a list of ``{"id", "ring": [(lat, lon), ...]}``. Empty list
    on any network or parse failure — OSM is advisory, never fatal.
    """
    query = (f'[out:json][timeout:{int(timeout_s)}];'
             f'way["building"](around:{radius_m},{lat},{lon});'
             f'out geom;')
    body = urllib.parse.urlencode({"data": query}).encode()
    req = urllib.request.Request(OVERPASS_URL, data=body, method="POST",
                                 headers={"User-Agent": "microgeographies/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s + 5) as res:
            payload = json.loads(res.read().decode("utf-8", "replace"))
    except Exception:
        return []
    out = []
    for el in payload.get("elements", []):
        if el.get("type") != "way":
            continue
        ring = [(g["lat"], g["lon"]) for g in el.get("geometry", [])
                if "lat" in g and "lon" in g]
        if len(ring) >= 4:
            out.append({"id": el.get("id"), "ring": ring})
    return out


def snap_to_building_outline(lat, lon, radius_m=60):
    """Snap a door/window pin to the nearest OSM building outline.

    Returns ``{"lat", "lon", "building_id", "snap_m"}`` or ``None``
    when no building is found (offline, rural, or lookup failure).
    """
    buildings = fetch_buildings_near(lat, lon, radius_m)
    best = None
    for b in buildings:
        try:
            plat, plon, dist = nearest_point_on_polygon(lat, lon, b["ring"])
        except Exception:
            continue
        if best is None or dist < best["snap_m"]:
            best = {"lat": plat, "lon": plon,
                    "building_id": b["id"], "snap_m": round(dist, 2)}
    return best
"""Depth Anything 3 video -> geo-located point cloud (video workflow).

Pipeline::

    zip(photo with EXIF GPS + heading, short video)
        -> frames sampled from the video (OpenCV)
        -> Depth Anything 3 (metric depth + camera poses per frame)
        -> world-frame point cloud (first-camera frame, metres)
        -> per-frame concept boxes (existing detectors) voted onto points
        -> per-label features: centroid pin, or PCA-endpoint line
        -> lat/lon from the photo's EXIF fix + heading (destination_point)

DA3's nested Giant-Large checkpoints predict metric depth and
COLMAP-format (OpenCV world-to-camera) extrinsics, so ranges and
bearings need no scale calibration. ``MOCK_DA3=1`` gives a synthetic
scene for tests/offline dev (same pattern as MOCK_SAM/MOCK_DEPTH).

Real inference needs ``depth-anything-3`` + a CUDA GPU for speed:
``pip install git+https://github.com/ByteDance-Seed/depth-anything-3.git``
(weights ~3 GB download on first use; CC BY-NC 4.0 checkpoints). When
the package is missing this module raises a clear RuntimeError and the
endpoint degrades to an error payload, never a 500.

Only numpy is needed for the math here; torch/cv2/depth_anything_3 are
all lazy imports.
"""

import math
import os

import depth as geo

DA3_MODEL_ID = os.environ.get(
    "DA3_MODEL_ID", "depth-anything/DA3NESTED-GIANT-LARGE-1.1")
VIDEO_EXTS = (".mp4", ".mov", ".avi", ".mkv", ".webm")
MAX_CLOUD_POINTS = 50000

_da3_model = None  # lazy DepthAnything3 instance
_da3_model_id = None


def da3_available():
    """True when the depth_anything_3 package can be imported."""
    try:
        import depth_anything_3  # noqa: F401
        return True
    except ImportError:
        return False


# --------------------------------------------------------------------------
# Pose helpers (pure math; COLMAP convention x_cam = R * X + t)
# --------------------------------------------------------------------------

def rotmat_to_qvec(R):
    """COLMAP quaternion (qw, qx, qy, qz) from a 3x3 rotation matrix."""
    r00, r01, r02 = (float(v) for v in R[0])
    r10, r11, r12 = (float(v) for v in R[1])
    r20, r21, r22 = (float(v) for v in R[2])
    tr = r00 + r11 + r22
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2.0
        q = (0.25 * s, (r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s)
    elif r00 > r11 and r00 > r22:
        s = math.sqrt(1.0 + r00 - r11 - r22) * 2.0
        q = ((r21 - r12) / s, 0.25 * s, (r01 + r10) / s, (r02 + r20) / s)
    elif r11 > r22:
        s = math.sqrt(1.0 + r11 - r00 - r22) * 2.0
        q = ((r02 - r20) / s, (r01 + r10) / s, 0.25 * s, (r12 + r21) / s)
    else:
        s = math.sqrt(1.0 + r22 - r00 - r11) * 2.0
        q = ((r10 - r01) / s, (r02 + r20) / s, (r12 + r21) / s, 0.25 * s)
    n = math.sqrt(sum(v * v for v in q)) or 1.0
    return tuple(round(v / n, 6) for v in q)


def sample_frame_indices(total, max_frames):
    """Evenly spaced frame indices in [0, total), first and last included."""
    total, max_frames = int(total), max(1, int(max_frames))
    if total <= 0:
        return []
    if total <= max_frames:
        return list(range(total))
    step = (total - 1) / (max_frames - 1)
    return sorted({round(i * step) for i in range(max_frames)})


def extract_frames(video_path, out_dir, max_frames=12, max_dim=1024):
    """Sample frames from a video into out_dir as frame_NNN.jpg files.

    Returns [{"name", "path"}] in time order. Raises RuntimeError when
    OpenCV is missing, the video cannot be opened, or no frame decodes.
    Long edges are capped at max_dim (voting and DA3 both work in the
    extracted frame's own pixel space, so this stays consistent).
    """
    try:
        import cv2
    except ImportError as e:
        raise RuntimeError(
            "video frames need OpenCV (bundled via ultralytics)") from e
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(
            f"could not open video: {os.path.basename(video_path)}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    wanted = set(sample_frame_indices(total, max_frames)) if total > 0 else set()
    out, idx = [], 0
    try:
        grab_all = total <= 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if grab_all:
                stride_hint = max(1, max_frames)
                if idx % stride_hint:
                    idx += 1
                    continue
            elif idx not in wanted:
                idx += 1
                continue
            h, w = frame.shape[:2]
            if max_dim and max(w, h) > max_dim:
                k = max_dim / max(w, h)
                frame = cv2.resize(frame, (round(w * k), round(h * k)),
                                   interpolation=cv2.INTER_AREA)
            name = f"frame_{len(out) + 1:03d}.jpg"
            path = os.path.join(out_dir, name)
            if not cv2.imwrite(path, frame):
                raise RuntimeError(f"could not write frame {name}")
            out.append({"name": name, "path": path})
            if len(out) >= max_frames:
                break
            idx += 1
    finally:
        cap.release()
    if not out:
        raise RuntimeError("no frames could be decoded from the video")
    return out


def _load_da3(model_id=None):
    """Lazy DepthAnything3 instance; clear error when not installed."""
    global _da3_model, _da3_model_id
    model_id = model_id or DA3_MODEL_ID
    if _da3_model is not None and _da3_model_id == model_id:
        return _da3_model
    try:
        from depth_anything_3.api import DepthAnything3
    except ImportError as e:
        raise RuntimeError(
            "Depth Anything 3 could not be imported "
            f"({type(e).__name__}: {e}). Install with `pip install "
            "git+https://github.com/ByteDance-Seed/depth-anything-3.git "
            "addict` (plus a CUDA GPU and ~7 GB of weights on first "
            "use), or run with MOCK_DA3=1 for the offline pass") from e
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _da3_model = DepthAnything3.from_pretrained(model_id).to(device)
    _da3_model_id = model_id
    return _da3_model


def _mock_scene(frame_pils):
    """Synthetic DA3 prediction: gentle forward dolly over a 2-6 m scene.

    Depth is a vertical gradient (far at top, near at bottom) so pins
    land in front of every frame; extrinsics drift forward and pan
    slightly so the cloud has real 3D extent. Deterministic.
    """
    import numpy as np
    depths, confs, exts, ints = [], [], [], []
    for i, pil in enumerate(frame_pils):
        w, h = pil.size
        rows = np.linspace(1.0, 0.0, h, dtype=np.float32)  # top far
        plane = (2.0 + rows[:, None] * 4.0).repeat(w, axis=1)
        depths.append(plane.astype(np.float32))
        confs.append(np.full((h, w), 10.0, dtype=np.float32))
        ang = math.radians(1.5 * i)  # slow pan
        ca, sa = math.cos(ang), math.sin(ang)
        z = 0.35 * i  # forward dolly, metres
        R = np.array([[ca, 0.0, sa], [0.0, 1.0, 0.0], [-sa, 0.0, ca]],
                     dtype=np.float32)
        t = -R @ np.array([0.0, 0.0, z], dtype=np.float32)
        exts.append(np.concatenate([R, t[:, None]], axis=1))
        f = 0.85 * w
        ints.append(np.array([[f, 0.0, w / 2.0], [0.0, f, h / 2.0],
                              [0.0, 0.0, 1.0]], dtype=np.float32))
    return {"depth": depths, "conf": confs,
            "extrinsics": np.stack(exts), "intrinsics": np.stack(ints),
            "processed": list(frame_pils),
            "model": "mock-da3", "mock": True}


def estimate_scene(frames):
    """Run DA3 (or the mock) over extracted frames.

    ``frames``: [{"name", "path"}] from extract_frames. Returns
    {"depth": [2D arrays], "conf": [...], "extrinsics": (N,3,4),
    "intrinsics": (N,3,3), "processed": [PIL images] aligned with the
    frames, "model", "mock"}. Depth is in metres; extrinsics are
    OpenCV world-to-camera (COLMAP convention).
    """
    import numpy as np
    if os.getenv("MOCK_DA3") == "1":
        from PIL import Image
        return _mock_scene([Image.open(f["path"]) for f in frames])
    model = _load_da3()
    pred = model.inference([f["path"] for f in frames])
    depth = np.asarray(pred.depth, dtype=np.float32)
    conf = np.asarray(pred.conf, dtype=np.float32)
    from PIL import Image as _Image
    processed = [_Image.fromarray(np.asarray(img, dtype=np.uint8))
                 for img in np.asarray(pred.processed_images)]
    return {"depth": [depth[i] for i in range(len(processed))],
            "conf": [conf[i] for i in range(len(processed))],
            "extrinsics": np.asarray(pred.extrinsics, dtype=np.float32),
            "intrinsics": np.asarray(pred.intrinsics, dtype=np.float32),
            "processed": processed,
            "model": _da3_model_id, "mock": False}


def build_cloud(scene, conf_pct=40.0, cap=MAX_CLOUD_POINTS, stride=2):
    """Back-project DA3 depth into world-frame points + colors.

    Keeps pixels with finite positive depth and confidence at or above
    the scene's `conf_pct` percentile (adaptive: DA3 confidence is not
    0..1), samples every `stride`-th pixel, then even-stride caps the
    total. Returns (points [[x,y,z]...], colors [[r,g,b]...]) as plain
    lists (PLY/voting friendly).
    """
    import numpy as np
    chunks = []
    for i, proc in enumerate(scene["processed"]):
        d = np.asarray(scene["depth"][i], dtype=np.float64)
        c = np.asarray(scene["conf"][i], dtype=np.float64)
        K = np.asarray(scene["intrinsics"][i], dtype=np.float64)
        w2c = np.asarray(scene["extrinsics"][i], dtype=np.float64)
        valid = np.isfinite(d) & (d > 0.05)
        if np.isfinite(c).any():
            m = valid & np.isfinite(c)
            if m.any():
                valid &= np.isfinite(c) & (c >= np.percentile(c[m], conf_pct))
        ys, xs = np.nonzero(valid[::stride, ::stride])
        ys, xs = ys * stride, xs * stride
        if len(xs) == 0:
            continue
        z = d[ys, xs]
        fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
        xc = (xs - cx) / fx * z
        yc = (ys - cy) / fy * z
        R, t = w2c[:, :3], w2c[:, 3]
        cam = np.stack([xc, yc, z], axis=1)
        world = (cam - t) @ R  # == R^T (x - t), row form
        img = np.asarray(proc.convert("RGB"))
        chunks.append((world, img[ys, xs].copy()))
    if not chunks:
        return [], []
    points = np.concatenate([c[0] for c in chunks])
    colors = np.concatenate([c[1] for c in chunks])
    if cap and len(points) > cap:
        k = math.ceil(len(points) / cap)
        points, colors = points[::k], colors[::k]
    return ([[round(float(x), 3) for x in p] for p in points],
            [[int(v) for v in c] for c in colors])


def da3_cameras(scene, names):
    """COLMAP-shaped cameras from DA3 poses/intrinsics for label voting."""
    cams = []
    for i, proc in enumerate(scene["processed"]):
        w, h = proc.size
        K = scene["intrinsics"][i]
        w2c = scene["extrinsics"][i]
        R = [[float(v) for v in row[:3]] for row in w2c]
        t = [float(w2c[r][3]) for r in range(3)]
        cams.append({
            "image": names[i], "qvec": list(rotmat_to_qvec(R)),
            "tvec": t, "width": w, "height": h, "model": "PINHOLE",
            "params": [round(float(K[0][0]), 2), round(float(K[1][1]), 2),
                       round(float(K[0][2]), 2), round(float(K[1][2]), 2)],
        })
    return cams


def to_first_camera(points, scene):
    """Re-express world points in the first frame's camera coordinates.

    The heading refers to the first frame's optical axis, so feature
    geometry is computed there, not in DA3's arbitrary world frame.
    """
    import numpy as np
    if not points:
        return []
    w2c = scene["extrinsics"][0]
    R = np.asarray(w2c[:, :3], dtype=np.float64)
    t = np.asarray(w2c[:, 3], dtype=np.float64)
    pts = np.asarray(points, dtype=np.float64)
    out = pts @ R.T + t
    return [[float(x), float(y), float(z)] for x, y, z in out]


def enu_of(point_cam, heading_deg):
    """Metres (east, north, up) of a first-camera-frame point.

    Camera frame is OpenCV (x right, y down, z forward); the optical
    axis points along `heading_deg` (compass).
    """
    x, y, z = (float(v) for v in point_cam)
    h = math.radians(heading_deg)
    east = x * math.cos(h) + z * math.sin(h)
    north = -x * math.sin(h) + z * math.cos(h)
    return east, north, -y


def _line_endpoints_enu(pts_enu):
    """PCA-extreme endpoints (east, north) of a labelled point set."""
    import numpy as np
    P = np.asarray(pts_enu, dtype=np.float64)
    c = P.mean(axis=0)
    Q = P - c
    cov = Q.T @ Q
    _w, V = np.linalg.eigh(cov)
    axis = V[:, -1]
    if len(axis) == 3:
        axis = axis[:2]
    axis = axis / (np.linalg.norm(axis) + 1e-12)
    s = Q[:, :2] @ axis
    lo, hi = Q[int(np.argmin(s)), :2], Q[int(np.argmax(s)), :2]
    return c[:2] + lo, c[:2] + hi


def cloud_features(points_cam, point_labels, start_lat, start_lon,
                   heading_deg, geoms=None):
    """Per-label map features from labelled first-camera-frame points.

    Point features get the centroid pin; ``|line`` labels get PCA-extreme
    endpoints. Every feature carries lat/lon (destination_point) plus
    the ENU centroid/endpoints for the page. Sorted by label.
    """
    import numpy as np
    geoms = geoms or {}
    by_label = {}
    for idx, info in (point_labels or {}).items():
        i = int(idx)
        if i >= len(points_cam):
            continue
        by_label.setdefault(str(info.get("label", "")), []).append(i)
    feats = []
    for label in sorted(by_label):
        idxs = by_label[label]
        enu = np.array([enu_of(points_cam[i], heading_deg) for i in idxs])
        cen = enu.mean(axis=0)
        bearing = math.degrees(math.atan2(cen[0], cen[1])) % 360.0
        dist = float(math.hypot(cen[0], cen[1]))
        lat, lon = geo.destination_point(start_lat, start_lon, bearing, dist)
        feat = {"label": label, "geom": "point", "count": len(idxs),
                "lat": round(lat, 7), "lon": round(lon, 7),
                "distance_m": round(dist, 2),
                "bearing_deg": round(bearing, 1),
                "enu_m": {"x": round(float(cen[0]), 2),
                          "y": round(float(cen[1]), 2),
                          "z": round(float(cen[2]), 2)}}
        if geoms.get(label.lower()) == "line" and len(idxs) >= 2:
            lo, hi = _line_endpoints_enu(enu)
            ends = []
            for e, n in (lo, hi):
                b = math.degrees(math.atan2(e, n)) % 360.0
                d = float(math.hypot(e, n))
                elat, elon = geo.destination_point(start_lat, start_lon, b, d)
                ends.append({"lat": round(elat, 7), "lon": round(elon, 7)})
            feat["geom"] = "line"
            feat["endpoints"] = ends
        feats.append(feat)
    return feats

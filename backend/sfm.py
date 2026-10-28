"""COLMAP SfM helpers for the /api/sfm endpoint.

Pure helpers (pose math, COLMAP text-model parsing, ASCII PLY writing,
detection-label voting) are dependency-free so unit tests run without
COLMAP, torch, or a GPU. Only ``run_colmap_*`` shells out to the COLMAP
CLI (preferred) or falls back to pycolmap when the binary is missing.
"""

import math
import os
import shutil
import subprocess

MAX_SFM_POINTS = 50000  # downsample cap for the returned PLY

SUPPORTED_CAMERA_MODELS = ("SIMPLE_PINHOLE", "PINHOLE")


# --------------------------------------------------------------------------
# Environment probes (lazy, never raise)
# --------------------------------------------------------------------------

def gpu_available():
    """True when a CUDA GPU is actually usable right now."""
    try:
        import torch
        if torch.cuda.is_available():
            return True
    except Exception:
        pass
    nvidia_smi = shutil.which("nvidia-smi")
    if nvidia_smi:
        try:
            out = subprocess.run(
                [nvidia_smi, "-L"], capture_output=True, text=True,
                timeout=15).stdout.strip()
            # A line like "GPU 0: ..." means a visible GPU; the
            # "Failed to initialize NVML" banner means none.
            return bool(out) and "GPU " in out
        except Exception:
            return False
    return False


def colmap_binary():
    """Path of the COLMAP CLI binary, or None when not installed."""
    return shutil.which("colmap")


def pycolmap_available():
    """True when `import pycolmap` works (CLI fallback)."""
    try:
        import pycolmap  # noqa: F401
        return True
    except Exception:
        return False


def sfm_backend_available():
    """True when either COLMAP route (CLI binary or pycolmap) exists."""
    return colmap_binary() is not None or pycolmap_available()


# --------------------------------------------------------------------------
# Pose math (COLMAP convention: x_cam = R(qvec) * X + tvec)
# --------------------------------------------------------------------------

def qvec_to_rotmat(qvec):
    """3x3 rotation matrix from a COLMAP quaternion (qw, qx, qy, qz)."""
    qw, qx, qy, qz = (float(v) for v in qvec)
    return [
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw),
         2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz),
         2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw),
         1 - 2 * (qx * qx + qy * qy)],
    ]


def _intrinsics(model, params):
    """(fx, fy, cx, cy) for the supported COLMAP camera models."""
    if model == "SIMPLE_PINHOLE":
        f, cx, cy = (float(v) for v in params[:3])
        return f, f, cx, cy
    if model == "PINHOLE":
        fx, fy, cx, cy = (float(v) for v in params[:4])
        return fx, fy, cx, cy
    raise ValueError(f"unsupported camera model: {model}")


def project_point(xyz, qvec, tvec, model, params, width, height):
    """Project a 3D point into an image; None when behind the camera or
    outside the frame. Returns (u, v, depth) in original pixels."""
    fx, fy, cx, cy = _intrinsics(model, params)
    r = qvec_to_rotmat(qvec)
    x, y, z = (float(v) for v in xyz)
    tx, ty, tz = (float(v) for v in tvec)
    xc = r[0][0] * x + r[0][1] * y + r[0][2] * z + tx
    yc = r[1][0] * x + r[1][1] * y + r[1][2] * z + ty
    zc = r[2][0] * x + r[2][1] * y + r[2][2] * z + tz
    if zc <= 0:
        return None
    u = fx * xc / zc + cx
    v = fy * yc / zc + cy
    if not (0 <= u < width and 0 <= v < height):
        return None
    return u, v, zc


# --------------------------------------------------------------------------
# COLMAP text-model parsing (cameras.txt / images.txt / points3D.txt)
# --------------------------------------------------------------------------

def _data_lines(path):
    with open(path, "r", encoding="utf-8") as fh:
        return [ln.strip() for ln in fh
                if ln.strip() and not ln.startswith("#")]


def parse_cameras_text(path):
    """{camera_id: {model, width, height, params}} for the supported models.

    Unsupported models are skipped by the caller via the returned dict —
    entries are kept here, and filtering happens in parse_model so a
    warning can name them.
    """
    cams = {}
    for ln in _data_lines(path):
        parts = ln.split()
        cid = int(parts[0])
        cams[cid] = {"model": parts[1], "width": int(parts[2]),
                     "height": int(parts[3]),
                     "params": [float(v) for v in parts[4:]]}
    return cams


def _is_pose_line(parts):
    """A pose line ends with an image filename (not a bare number);
    a POINTS2D line is all numbers (possibly empty)."""
    if len(parts) < 10:
        return False
    try:
        float(parts[-1])
        return False
    except ValueError:
        return True


def _parse_pose_parts(parts):
    return {"image": " ".join(parts[9:]),
            "qvec": [float(v) for v in parts[1:5]],
            "tvec": [float(v) for v in parts[5:8]],
            "camera_id": int(parts[8])}


def parse_images_text(path):
    """Registered views: [{image, qvec, tvec, camera_id}].

    images.txt stores two lines per view (pose line + POINTS2D line);
    only registered views appear, so every entry here is registered.
    The POINTS2D line may be empty; blank lines are structural, so
    pairing uses raw line order with a numeric-tail fallback when
    blank lines were stripped.
    """
    with open(path, "r", encoding="utf-8") as fh:
        raw = [ln.strip() for ln in fh if not ln.startswith("#")]
    views = []
    if len(raw) >= 2:
        paired = True
        for i in range(0, len(raw) - 1, 2):
            if not _is_pose_line(raw[i].split()):
                paired = False
                break
        if paired:
            ok = True
            tmp = []
            for i in range(0, len(raw), 2):
                parts = raw[i].split()
                if not _is_pose_line(parts):
                    ok = False
                    break
                # The following line must be POINTS2D (empty or all-numeric).
                nxt = raw[i + 1].split() if i + 1 < len(raw) else []
                try:
                    [float(v) for v in nxt]
                except ValueError:
                    ok = False
                    break
                try:
                    tmp.append(_parse_pose_parts(parts))
                except (ValueError, IndexError):
                    ok = False
                    break
            if ok:
                return tmp
    for ln in raw:
        parts = ln.split()
        if not _is_pose_line(parts):
            continue
        try:
            views.append(_parse_pose_parts(parts))
        except (ValueError, IndexError):
            continue
    return views


def parse_points3d_text(path):
    """(points, colors): Nx3 float lists + Nx3 int RGB lists."""
    points, colors = [], []
    for ln in _data_lines(path):
        parts = ln.split()
        points.append([float(parts[1]), float(parts[2]), float(parts[3])])
        colors.append([int(parts[4]), int(parts[5]), int(parts[6])])
    return points, colors


def parse_model(sparse_dir):
    """Join cameras/images/points3D into (cameras, points, colors, warnings).

    cameras: [{image, qvec, tvec, width, height, model, params}].
    Views on unsupported camera models are dropped with a warning.
    """
    warnings = []
    cams = parse_cameras_text(os.path.join(sparse_dir, "cameras.txt"))
    views = parse_images_text(os.path.join(sparse_dir, "images.txt"))
    points, colors = parse_points3d_text(
        os.path.join(sparse_dir, "points3D.txt"))
    cameras = []
    for v in views:
        cam = cams.get(v["camera_id"])
        if cam is None:
            warnings.append(f"image {v['image']}: unknown camera id "
                            f"{v['camera_id']}, skipped")
            continue
        if cam["model"] not in SUPPORTED_CAMERA_MODELS:
            warnings.append(f"image {v['image']}: unsupported camera model "
                            f"{cam['model']}, skipped")
            continue
        cameras.append({"image": v["image"], "qvec": v["qvec"],
                        "tvec": v["tvec"], "width": cam["width"],
                        "height": cam["height"], "model": cam["model"],
                        "params": cam["params"]})
    return cameras, points, colors, warnings


# --------------------------------------------------------------------------
# Downsampling + ASCII PLY
# --------------------------------------------------------------------------

def downsample(points, colors, cap=MAX_SFM_POINTS):
    """Even-stride downsample to at most `cap` points (keeps order)."""
    if len(points) <= cap or cap <= 0:
        return points, colors
    stride = math.ceil(len(points) / cap)
    return points[::stride], colors[::stride]


def write_ply_ascii(points, colors):
    """Small ASCII PLY document (x y z red green blue) as text."""
    lines = ["ply", "format ascii 1.0",
             f"element vertex {len(points)}",
             "property float x", "property float y", "property float z",
             "property uchar red", "property uchar green",
             "property uchar blue", "end_header"]
    for (x, y, z), (r, g, b) in zip(points, colors):
        lines.append(f"{x} {y} {z} {int(r)} {int(g)} {int(b)}")
    return "\n".join(lines) + "\n"


def parse_ply_ascii(text):
    """Inverse of write_ply_ascii: (points, colors)."""
    lines = text.splitlines()
    end = lines.index("end_header")
    n = int(lines[2].split()[2])
    points, colors = [], []
    for ln in lines[end + 1:end + 1 + n]:
        x, y, z, r, g, b = ln.split()
        points.append([float(x), float(y), float(z)])
        colors.append([int(r), int(g), int(b)])
    return points, colors


# --------------------------------------------------------------------------
# Detection-label voting
# --------------------------------------------------------------------------

def _norm_detections(detections):
    """Map image key (full name and basename) -> detection list."""
    norm = {}
    if not isinstance(detections, dict):
        return norm
    for key, dets in detections.items():
        if not isinstance(dets, list):
            continue
        norm[key] = dets
        norm[os.path.basename(key)] = dets
    return norm


def vote_point_labels(points, cameras, detections):
    """Winning detection label per 3D point.

    Each point is projected into every registered image (pose + camera
    model); when the projection lands inside a detection box (original
    pixels), that label gets one vote. Returns
    {point_index: {"label": winner, "votes": winning_count,
                   "counts": {label: count}}}; points with no votes
    are absent. Ties break by total score, then label name.
    """
    norm = _norm_detections(detections)
    labels = {}
    for idx, xyz in enumerate(points):
        counts, scores = {}, {}
        for cam in cameras:
            dets = (norm.get(cam["image"])
                    or norm.get(os.path.basename(cam["image"])))
            if not dets:
                continue
            try:
                proj = project_point(xyz, cam["qvec"], cam["tvec"],
                                     cam["model"], cam["params"],
                                     cam["width"], cam["height"])
            except ValueError:
                continue
            if proj is None:
                continue
            u, v, _depth = proj
            for d in dets:
                try:
                    x1, y1, x2, y2 = d["box"]
                except (KeyError, TypeError, ValueError):
                    continue
                if min(x1, x2) <= u <= max(x1, x2) and \
                   min(y1, y2) <= v <= max(y1, y2):
                    label = str(d.get("label", ""))
                    counts[label] = counts.get(label, 0) + 1
                    try:
                        scores[label] = scores.get(label, 0.0) + float(
                            d.get("score", 1.0))
                    except (TypeError, ValueError):
                        scores[label] = scores.get(label, 0.0) + 1.0
        if counts:
            winner = sorted(counts, key=lambda l: (-counts[l],
                                                  -scores.get(l, 0.0),
                                                  l))[0]
            labels[idx] = {"label": winner, "votes": counts[winner],
                           "counts": dict(counts)}
    return labels


# --------------------------------------------------------------------------
# COLMAP execution (CLI preferred, pycolmap fallback)
# --------------------------------------------------------------------------

def _run(cmd, warnings):
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True,
                       timeout=1800)
    except subprocess.CalledProcessError as e:
        tail = (e.stderr or e.stdout or "")[-2000:]
        raise RuntimeError(f"{' '.join(cmd[:2])} failed: {tail}")


def run_colmap_cli(images_dir, workspace_dir, gpu_used):
    """Feature extraction + exhaustive matching + mapping. Returns the
    sparse model dir (workspace/sparse/0). Raises RuntimeError on failure."""
    warnings = []
    binary = colmap_binary()
    if binary is None:
        raise RuntimeError("colmap binary not found")
    db_path = os.path.join(workspace_dir, "sfm.db")
    sparse_dir = os.path.join(workspace_dir, "sparse")
    os.makedirs(sparse_dir, exist_ok=True)
    gpu_flag = "1" if gpu_used else "0"
    if not gpu_used:
        warnings.append("no GPU detected: COLMAP runs on CPU "
                        "(SIFT extraction/matching without CUDA)")
    _run([binary, "feature_extractor",
          "--database_path", db_path, "--image_path", images_dir,
          "--SiftExtraction.use_gpu", gpu_flag], warnings)
    _run([binary, "exhaustive_matcher",
          "--database_path", db_path,
          "--SiftMatching.use_gpu", gpu_flag], warnings)
    _run([binary, "mapper",
          "--database_path", db_path, "--image_path", images_dir,
          "--output_path", sparse_dir], warnings)
    model_dir = os.path.join(sparse_dir, "0")
    if not os.path.isdir(model_dir):
        raise RuntimeError("COLMAP mapper produced no model "
                           "(too few matches? try more overlap)")
    return model_dir, warnings


def run_colmap_pycolmap(images_dir, workspace_dir, gpu_used):
    """Best-effort pycolmap pipeline when the CLI binary is missing."""
    try:
        import pycolmap
    except Exception as e:
        raise RuntimeError(f"pycolmap unavailable: {e}")
    warnings = ["colmap CLI not found: using pycolmap fallback"]
    if not gpu_used:
        warnings.append("no GPU detected: pycolmap runs on CPU")
    db_path = os.path.join(workspace_dir, "sfm.db")
    sparse_dir = os.path.join(workspace_dir, "sparse")
    os.makedirs(sparse_dir, exist_ok=True)
    extract = getattr(pycolmap, "extract_features", None)
    match = getattr(pycolmap, "match_exhaustive", None)
    mapping = getattr(pycolmap, "incremental_mapping", None)
    if extract is None or match is None or mapping is None:
        raise RuntimeError("installed pycolmap lacks extract_features / "
                           "match_exhaustive / incremental_mapping")
    sift_opts = None
    try:
        sift_opts = pycolmap.SiftExtractionOptions()
        if hasattr(sift_opts, "use_gpu"):
            sift_opts.use_gpu = bool(gpu_used)
    except Exception:
        sift_opts = None
    kwargs = {"sift_options": sift_opts} if sift_opts is not None else {}
    extract(db_path, images_dir, **kwargs)
    match(db_path)
    maps = mapping(db_path, images_dir, sparse_dir)
    if not maps:
        raise RuntimeError("pycolmap produced no model "
                           "(too few matches? try more overlap)")
    best = max(maps.values(), key=lambda r: len(getattr(r, "points3D", [])))
    model_dir = os.path.join(sparse_dir, "0")
    best.write_text(model_dir)
    return model_dir, warnings


def reconstruct(images_dir, workspace_dir, gpu_used):
    """CLI preferred; pycolmap when no binary. Returns (model_dir, warnings)."""
    if colmap_binary() is not None:
        return run_colmap_cli(images_dir, workspace_dir, gpu_used)
    return run_colmap_pycolmap(images_dir, workspace_dir, gpu_used)

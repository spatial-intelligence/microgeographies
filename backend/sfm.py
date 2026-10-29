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


class SfmError(RuntimeError):
    """Reconstruction failure carrying the backend warnings so far.

    run_colmap_* build a warnings list as they go (GPU fallback, CPU
    notes); raising plain RuntimeError would strand those notes in a
    local that never reaches the caller, so every failure reply would
    lose its context. SfmError is still a RuntimeError, so existing
    callers catching RuntimeError are unaffected.
    """

    def __init__(self, message, warnings=()):
        super().__init__(message)
        self.warnings = list(warnings)

SUPPORTED_CAMERA_MODELS = ("SIMPLE_PINHOLE", "PINHOLE", "SIMPLE_RADIAL",
                            "RADIAL", "OPENCV", "FULL_OPENCV")


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


def _distortion(model, params):
    """(fx, fy, cx, cy, k1, k2, k3, p1, p2) for the supported models."""
    p = [float(v) for v in params]
    if model == "SIMPLE_PINHOLE":
        f, cx, cy = p[:3]
        return f, f, cx, cy, 0.0, 0.0, 0.0, 0.0, 0.0
    if model == "PINHOLE":
        fx, fy, cx, cy = p[:4]
        return fx, fy, cx, cy, 0.0, 0.0, 0.0, 0.0, 0.0
    if model == "SIMPLE_RADIAL":
        f, cx, cy, k = p[:4]
        return f, f, cx, cy, k, 0.0, 0.0, 0.0, 0.0
    if model == "RADIAL":
        f, cx, cy, k1, k2 = p[:5]
        return f, f, cx, cy, k1, k2, 0.0, 0.0, 0.0
    if model == "OPENCV":
        fx, fy, cx, cy, k1, k2, p1, p2 = p[:8]
        return fx, fy, cx, cy, k1, k2, 0.0, p1, p2
    if model == "FULL_OPENCV":
        fx, fy, cx, cy, k1, k2, p1, p2, k3, k4, k5, k6 = p[:12]
        return fx, fy, cx, cy, k1, k2, k3, p1, p2
    raise ValueError(f"unsupported camera model: {model}")


def project_point(xyz, qvec, tvec, model, params, width, height):
    """Project a 3D point into an image; None when behind the camera or
    outside the frame. Returns (u, v, depth) in original pixels.

    Applies the model's Brown-Conrady distortion, so distorted models
    (SIMPLE_RADIAL, RADIAL, OPENCV, ...) vote labels at the pixels
    where the features were actually observed.
    """
    fx, fy, cx, cy, k1, k2, k3, p1, p2 = _distortion(model, params)
    r = qvec_to_rotmat(qvec)
    x, y, z = (float(v) for v in xyz)
    tx, ty, tz = (float(v) for v in tvec)
    xc = r[0][0] * x + r[0][1] * y + r[0][2] * z + tx
    yc = r[1][0] * x + r[1][1] * y + r[1][2] * z + ty
    zc = r[2][0] * x + r[2][1] * y + r[2][2] * z + tz
    if zc <= 0:
        return None
    xn, yn = xc / zc, yc / zc
    r2 = xn * xn + yn * yn
    radial = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3))
    xd = xn * radial + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn)
    yd = yn * radial + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn
    u = fx * xd + cx
    v = fy * yd + cy
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
                       errors="replace", timeout=1800)
    except subprocess.CalledProcessError as e:
        tail = (e.stderr or e.stdout or "")[-2000:]
        raise RuntimeError(f"{' '.join(cmd[:2])} failed: {tail}")


def _sparse_listing(path):
    """Dir contents for diagnostics (never raises)."""
    try:
        return sorted(os.listdir(path))
    except OSError as e:
        return [f"<unreadable: {e}>"]


def _pick_model_dir(sparse_dir):
    """Best numeric model dir (largest points file, .txt or .bin).

    The mapper numbers models 0, 1, ... with 0 usually the largest,
    but size order is not guaranteed — pick by points-file size so a
    stray empty 0/ never shadows a real reconstruction. None when
    there is nothing to pick.
    """
    best, best_size = None, -1
    for name in _sparse_listing(sparse_dir):
        if not name.isdigit():
            continue
        model_dir = os.path.join(sparse_dir, name)
        if not os.path.isdir(model_dir):
            continue
        size = -1
        for fn in ("points3D.txt", "points3D.bin"):
            try:
                size = max(size, os.path.getsize(
                    os.path.join(model_dir, fn)))
            except OSError:
                continue
        if size > best_size:
            best, best_size = model_dir, size
    return best


def _ensure_text_model(binary, model_dir, warnings, runner=None):
    """Make sure model_dir holds cameras.txt, converting from binary.

    Recent COLMAP mappers write cameras.bin/images.bin/points3D.bin,
    which the parser below cannot read — convert in place with
    model_converter in that case. Raises RuntimeError with a dir
    listing plus actionable guidance when there is nothing usable.
    """
    if runner is None:
        runner = _run  # resolved at call time: tests may stub sfm._run
    if os.path.isfile(os.path.join(model_dir, "cameras.txt")):
        return
    has_bin = any(os.path.isfile(os.path.join(model_dir, fn))
                  for fn in ("cameras.bin", "images.bin",
                             "points3D.bin"))
    if has_bin:
        warnings.append("COLMAP wrote a binary model: converting to text")
        runner([binary, "model_converter",
                "--input_path", model_dir, "--output_path", model_dir,
                "--output_type", "TXT"], warnings)
    if os.path.isfile(os.path.join(model_dir, "cameras.txt")):
        return
    raise RuntimeError(
        f"COLMAP mapper left no usable model in {model_dir} "
        f"(contains: {_sparse_listing(model_dir)}). This usually means "
        "too few matching features: use more photos with 60-80% "
        "overlap, steady lighting, and textured subjects — blank "
        "walls, glass, and sky do not match.")


def _sift_gpu_flags(binary, gpu_used):
    """(extract_args, match_args) GPU flags for this COLMAP version.

    COLMAP 3.x spells them --SiftExtraction/use_gpu and
    --SiftMatching/use_gpu; 4.x moved them to --FeatureExtraction/
    --FeatureMatching (plus gpu_index). Probed from --help so either
    binary works without version pinning.
    """
    try:
        proc = subprocess.run(
            [binary, "feature_extractor", "--help"],
            capture_output=True, text=True, timeout=60)
        out = (proc.stdout or "") + (proc.stderr or "")
    except Exception:
        out = ""
    flag = "1" if gpu_used else "0"
    if "FeatureExtraction.use_gpu" in out:
        extract = ["--FeatureExtraction.use_gpu", flag]
        match = ["--FeatureMatching.use_gpu", flag]
        if gpu_used:
            extract += ["--FeatureExtraction.gpu_index", "0"]
            match += ["--FeatureMatching.gpu_index", "0"]
        return extract, match
    return (["--SiftExtraction.use_gpu", flag],
            ["--SiftMatching.use_gpu", flag])


def run_colmap_cli(images_dir, workspace_dir, gpu_used):
    """Feature extraction + exhaustive matching + mapping. Returns the
    best sparse model dir. Raises RuntimeError on failure."""
    warnings = []
    binary = colmap_binary()
    if binary is None:
        raise RuntimeError("colmap binary not found")
    db_path = os.path.join(workspace_dir, "sfm.db")
    sparse_dir = os.path.join(workspace_dir, "sparse")
    os.makedirs(sparse_dir, exist_ok=True)
    if not gpu_used:
        warnings.append("no GPU detected: COLMAP runs on CPU "
                        "(SIFT extraction/matching without CUDA)")
    extract_gpu, match_gpu = _sift_gpu_flags(binary, gpu_used)
    try:
        _run([binary, "feature_extractor",
              "--database_path", db_path, "--image_path", images_dir,
              *extract_gpu], warnings)
        _run([binary, "exhaustive_matcher",
              "--database_path", db_path,
              *match_gpu], warnings)
        _run([binary, "mapper",
              "--database_path", db_path, "--image_path", images_dir,
              "--output_path", sparse_dir], warnings)
        model_dir = _pick_model_dir(sparse_dir)
        if model_dir is None:
            raise RuntimeError(
                f"COLMAP mapper produced no model in {sparse_dir} "
                f"(contains: {_sparse_listing(sparse_dir)}). This usually "
                "means too few matching features: use more photos with "
                "60-80% overlap, steady lighting, and textured subjects — "
                "blank walls, glass, and sky do not match.")
        _ensure_text_model(binary, model_dir, warnings)
    except SfmError:
        raise
    except RuntimeError as e:
        raise SfmError(str(e), warnings) from e
    return model_dir, warnings


SPARSE_SIFT_MAX_FEATURES = 16384  # up from COLMAP's 8192 default:
# the pycolmap path has no dense-MVS fallback, so a richer sparse
# extraction is the only lever for denser clouds there.


def _validated_extraction_options(pycolmap, gpu_used, warnings):
    """FeatureExtractionOptions honoring gpu_used when the build allows.

    A GPU can be visible (nvidia-smi lists it) while the installed
    pycolmap wheel itself has no CUDA support — asking for GPU
    extraction then dies inside extract_features with the cryptic
    "Check failed: extraction_options.Check()". The options' own
    check() is the authority, so a failed GPU check falls back to CPU
    with a warning instead of raising. Returns (options, gpu_effective).
    """
    fe_opts = pycolmap.FeatureExtractionOptions()
    if hasattr(fe_opts, "use_gpu"):
        fe_opts.use_gpu = bool(gpu_used)
    sift = getattr(fe_opts, "sift", None)
    if sift is not None and hasattr(sift, "max_num_features"):
        try:
            sift.max_num_features = SPARSE_SIFT_MAX_FEATURES
        except (TypeError, ValueError, AttributeError):
            pass
    check = getattr(fe_opts, "check", None)
    if callable(check) and not check():
        if gpu_used:
            warnings.append(
                "GPU feature extraction is unavailable in this pycolmap "
                "build (no CUDA support): falling back to CPU")
            if hasattr(fe_opts, "use_gpu"):
                fe_opts.use_gpu = False
            recheck = getattr(fe_opts, "check", None)
            if callable(recheck) and not recheck():
                raise RuntimeError(
                    "pycolmap FeatureExtractionOptions invalid even on "
                    "CPU: cannot extract features")
        else:
            raise RuntimeError(
                "pycolmap FeatureExtractionOptions invalid: "
                "cannot extract features")
    return fe_opts, bool(getattr(fe_opts, "use_gpu", gpu_used))


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
    # Newer pycolmap speaks extraction_options + device; older ones
    # take sift_options. Prefer the new spelling when present.
    try:
        if hasattr(pycolmap, "FeatureExtractionOptions"):
            fe_opts, gpu_effective = _validated_extraction_options(
                pycolmap, gpu_used, warnings)
            kwargs = {"extraction_options": fe_opts}
            dev = getattr(pycolmap, "Device", None)
            if dev is not None:
                for attr in (("cuda", True), ("cpu", False)):
                    if gpu_effective == attr[1] and hasattr(dev, attr[0]):
                        kwargs["device"] = getattr(dev, attr[0])
                        break
            extract(db_path, images_dir, **kwargs)
        else:
            sift_opts = None
            try:
                sift_opts = pycolmap.SiftExtractionOptions()
                if hasattr(sift_opts, "use_gpu"):
                    sift_opts.use_gpu = bool(gpu_used)
            except Exception:
                sift_opts = None
            kwargs = ({"sift_options": sift_opts}
                      if sift_opts is not None else {})
            extract(db_path, images_dir, **kwargs)
        match(db_path)
        maps = mapping(db_path, images_dir, sparse_dir)
        if not maps:
            raise RuntimeError("pycolmap produced no model "
                               "(too few matches? try more overlap)")
        best = max(maps.values(),
                   key=lambda r: len(getattr(r, "points3D", [])))
        model_dir = os.path.join(sparse_dir, "0")
        best.write_text(model_dir)
    except SfmError:
        raise
    except (RuntimeError, ValueError) as e:
        raise SfmError(str(e), warnings) from e
    return model_dir, warnings


def reconstruct(images_dir, workspace_dir, gpu_used):
    """CLI preferred; pycolmap when no binary. Returns (model_dir, warnings)."""
    if colmap_binary() is not None:
        return run_colmap_cli(images_dir, workspace_dir, gpu_used)
    return run_colmap_pycolmap(images_dir, workspace_dir, gpu_used)


DENSE_PLY_CAP = 250000  # max dense points returned inline


def _dense_gpu_flags(binary, gpu_used):
    """GPU flag args for patch_match_stereo, probed from --help.

    Some builds spell it --PatchMatchStereo.use_gpu, others only
    --PatchMatchStereo.gpu_index (0 = first GPU, -1 = CPU).
    """
    try:
        proc = subprocess.run(
            [binary, "patch_match_stereo", "--help"],
            capture_output=True, text=True, timeout=60)
        out = (proc.stdout or "") + (proc.stderr or "")
    except Exception:
        out = ""
    args = []
    if "PatchMatchStereo.use_gpu" in out:
        args += ["--PatchMatchStereo.use_gpu", "1" if gpu_used else "0"]
    if "PatchMatchStereo.gpu_index" in out:
        if gpu_used or "PatchMatchStereo.use_gpu" not in out:
            args += ["--PatchMatchStereo.gpu_index",
                     "0" if gpu_used else "-1"]
    return args


def run_dense_cli(binary, workspace_dir, gpu_used):
    """patch_match_stereo + stereo_fusion. Returns (fused_ply, warnings).

    Expects workspace/images + workspace/sparse (COLMAP workspace
    layout). Raises RuntimeError with the tool's log tail on failure.
    """
    warnings = []
    if not gpu_used:
        warnings.append("dense stereo runs on CPU (slow on large photos)")
    _run([binary, "patch_match_stereo",
          "--workspace_path", workspace_dir,
          "--workspace_format", "COLMAP",
          *_dense_gpu_flags(binary, gpu_used)], warnings)
    fused = os.path.join(workspace_dir, "fused.ply")
    _run([binary, "stereo_fusion",
          "--workspace_path", workspace_dir,
          "--workspace_format", "COLMAP",
          "--input_type", "photometric",
          "--output_path", fused], warnings)
    if not os.path.isfile(fused):
        raise RuntimeError("stereo_fusion left no fused.ply "
                           f"(workspace: {_sparse_listing(workspace_dir)})")
    return fused, warnings


_PLY_SCALARS = {"char": "b", "uchar": "B", "short": "h", "ushort": "H",
                "int": "i", "uint": "I", "int8": "b", "uint8": "B",
                "int16": "h", "uint16": "H", "int32": "i", "uint32": "I",
                "float": "f", "float32": "f", "double": "d",
                "float64": "d"}


def read_ply_points(path):
    """(points, colors) from a PLY vertex cloud (ASCII or binary LE).

    Reads x y z plus red/green/blue (missing colors default to grey).
    Extra properties (normals, faces) are skipped.
    """
    with open(path, "rb") as fh:
        header = []
        while True:
            line = fh.readline().decode("ascii", "replace").strip()
            header.append(line)
            if line == "end_header" or not line:
                break
        if not header or not header[0].startswith("ply"):
            raise ValueError("not a PLY file")
        fmt = header[1].split() if len(header) > 1 else []
        binary = len(fmt) >= 2 and fmt[1] == "binary_little_endian"
        count, props = 0, []
        in_vertex = False
        for ln in header:
            parts = ln.split()
            if parts[:2] == ["element", "vertex"]:
                in_vertex = True
                count = int(parts[2])
            elif parts[:1] == ["element"]:
                in_vertex = False
            elif parts[:1] == ["property"] and in_vertex:
                if parts[1] == "list":
                    props.append(None)  # unsupported in vertices: skip
                else:
                    props.append((parts[1], parts[2]))
        names = [p[1] for p in props if p]
        try:
            xi, yi, zi = names.index("x"), names.index("y"), names.index("z")
        except ValueError:
            raise ValueError("PLY vertices lack x/y/z")
        col_idx = []
        for want in (("red", "green", "blue"), ("r", "g", "b")):
            if all(w in names for w in want):
                col_idx = [names.index(w) for w in want]
                break
        points, colors = [], []
        if binary:
            if any(p is None for p in props):
                raise ValueError("list properties unsupported in binary PLY")
            ok = [(t, nm) for t, nm in props if t in _PLY_SCALARS]
            if len(ok) != len(props):
                raise ValueError("unsupported binary PLY scalar type")
            fmt_row = "<" + "".join(_PLY_SCALARS[t] for t, _ in ok)
            names_b = [nm for _, nm in ok]
            import struct
            row_struct = struct.Struct(fmt_row)
            vals = fh.read(row_struct.size * count)
            if len(vals) < row_struct.size * count:
                raise ValueError("truncated binary PLY body")
            for tup in struct.iter_unpack(fmt_row, vals):
                row = dict(zip(names_b, tup))
                points.append([float(row["x"]), float(row["y"]),
                               float(row["z"])])
                colors.append(_clamp_rgb(
                    [row[names_b[i]] for i in col_idx]) if col_idx
                    else [128, 128, 128])
        else:
            for _ in range(count):
                parts = fh.readline().decode("ascii", "replace").split()
                if len(parts) < len(names):
                    raise ValueError("truncated ASCII PLY body")
                vals = dict(zip(names, parts))
                points.append([float(vals["x"]), float(vals["y"]),
                               float(vals["z"])])
                colors.append(_clamp_rgb(
                    [vals[names[i]] for i in col_idx]) if col_idx
                    else [128, 128, 128])
    return points, colors


def _clamp_rgb(vals):
    """Three channel values -> [0, 255] ints."""
    out = []
    for v in vals:
        try:
            out.append(max(0, min(255, int(round(float(v))))))
        except (TypeError, ValueError):
            out.append(0)
    return out


def vote_point_labels_numpy(points, cameras, detections):
    """Same contract as vote_point_labels, vectorized with numpy.

    points: [[x, y, z], ...]; returns {idx: {label, votes, counts}}.
    """
    import numpy as np
    norm = _norm_detections(detections)
    pts = np.asarray(points, dtype=np.float64)
    n = pts.shape[0]
    counts, scores = {}, {}
    for cam in cameras:
        dets = (norm.get(cam["image"])
                or norm.get(os.path.basename(cam["image"])))
        if not dets:
            continue
        fx, fy, cx, cy, k1, k2, k3, p1, p2 = _distortion(
            cam["model"], cam["params"])
        r = np.array(qvec_to_rotmat(cam["qvec"]), dtype=np.float64)
        t = np.array(cam["tvec"], dtype=np.float64)
        xc = pts @ r.T + t
        z = xc[:, 2]
        front = z > 0
        xn = np.zeros(n)
        yn = np.zeros(n)
        xn[front] = xc[front, 0] / z[front]
        yn[front] = xc[front, 1] / z[front]
        r2 = xn * xn + yn * yn
        radial = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3))
        xd = xn * radial + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn)
        yd = yn * radial + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn
        u = fx * xd + cx
        v = fy * yd + cy
        w, h = cam["width"], cam["height"]
        inside_frame = (front & (u >= 0) & (u < w) & (v >= 0) & (v < h))
        if not inside_frame.any():
            continue
        for d in dets:
            try:
                x1, y1, x2, y2 = d["box"][:4]
            except (KeyError, TypeError, ValueError):
                continue
            hit = (inside_frame & (u >= min(x1, x2)) & (u <= max(x1, x2))
                   & (v >= min(y1, y2)) & (v <= max(y1, y2)))
            idx = np.nonzero(hit)[0]
            if len(idx) == 0:
                continue
            label = str(d.get("label", ""))
            col = counts.get(label)
            if col is None:
                col = np.zeros(n, dtype=np.int64)
                counts[label] = col
                scores[label] = np.zeros(n, dtype=np.float64)
            col[idx] += 1
            try:
                sc = float(d.get("score", 1.0))
            except (TypeError, ValueError):
                sc = 1.0
            scores[label][idx] += sc
    labels = {}
    if counts:
        voted = np.zeros(n, dtype=bool)
        for col in counts.values():
            voted |= col > 0
        for i in np.nonzero(voted)[0]:
            i = int(i)
            winner = sorted(counts,
                            key=lambda l: (-counts[l][i],
                                           -scores[l][i], l))[0]
            labels[i] = {"label": winner, "votes": int(counts[winner][i]),
                         "counts": {l: int(counts[l][i]) for l in counts
                                    if counts[l][i]}}
    return labels

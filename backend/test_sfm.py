"""Unit tests for backend/sfm.py + the /api/sfm 503 path.

No COLMAP, torch, or GPU needed: all reconstruction math uses synthetic
cameras/points, and the HTTP test forces the "nothing installed" branch.

Run with either backend interpreter::

    .venv/bin/python backend/test_sfm.py
    .venv/bin/python -m pytest backend/test_sfm.py   # if pytest exists
"""

import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sfm  # noqa: E402


def _cam(model="SIMPLE_PINHOLE", params=(500.0, 320.0, 240.0)):
    return {"image": "a.jpg", "qvec": [1.0, 0.0, 0.0, 0.0],
            "tvec": [0.0, 0.0, 0.0], "width": 640, "height": 480,
            "model": model, "params": list(params)}


def test_project_center():
    cam = _cam()
    p = sfm.project_point([0.0, 0.0, 5.0], cam["qvec"], cam["tvec"],
                          cam["model"], cam["params"], 640, 480)
    assert p is not None, p
    u, v, d = p
    assert abs(u - 320.0) < 1e-6 and abs(v - 240.0) < 1e-6 and abs(d - 5) < 1e-9


def test_project_behind_camera_is_none():
    cam = _cam()
    assert sfm.project_point([0, 0, -5], cam["qvec"], cam["tvec"],
                             cam["model"], cam["params"], 640, 480) is None


def test_project_outside_frame_is_none():
    cam = _cam()
    assert sfm.project_point([50, 0, 5], cam["qvec"], cam["tvec"],
                             cam["model"], cam["params"], 640, 480) is None


def test_simple_radial_zero_equals_pinhole():
    a = sfm.project_point([1.0, 2.0, 10.0], [1, 0, 0, 0], [0, 0, 0],
                          "SIMPLE_RADIAL", [500.0, 320.0, 240.0, 0.0],
                          640, 480)
    b = sfm.project_point([1.0, 2.0, 10.0], [1, 0, 0, 0], [0, 0, 0],
                          "SIMPLE_PINHOLE", [500.0, 320.0, 240.0],
                          640, 480)
    assert a is not None and b is not None
    assert abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9


def test_simple_radial_distorts():
    # xn=0.1, r2=0.01, radial=1+0.1*0.01=1.001 -> u=500*0.1001+320
    p = sfm.project_point([1.0, 0.0, 10.0], [1, 0, 0, 0], [0, 0, 0],
                          "SIMPLE_RADIAL", [500.0, 320.0, 240.0, 0.1],
                          640, 480)
    assert p is not None and abs(p[0] - 370.05) < 1e-6, p
    assert abs(p[1] - 240.0) < 1e-9, p


def test_opencv_zero_equals_pinhole():
    a = sfm.project_point([1.0, 2.0, 10.0], [1, 0, 0, 0], [0, 0, 0],
                          "OPENCV", [500.0, 500.0, 320.0, 240.0,
                                     0, 0, 0, 0], 640, 480)
    b = sfm.project_point([1.0, 2.0, 10.0], [1, 0, 0, 0], [0, 0, 0],
                          "PINHOLE", [500.0, 500.0, 320.0, 240.0],
                          640, 480)
    assert a is not None and b is not None
    assert abs(a[0] - b[0]) < 1e-9 and abs(a[1] - b[1]) < 1e-9


def test_opencv_tangential():
    # p1=0.01 shifts y: yd=0.01*(0.01)+0 -> v=500*0.0001+240
    p = sfm.project_point([1.0, 0.0, 10.0], [1, 0, 0, 0], [0, 0, 0],
                          "OPENCV", [500.0, 500.0, 320.0, 240.0,
                                     0, 0, 0.01, 0], 640, 480)
    assert p is not None and abs(p[0] - 370.0) < 1e-6, p
    assert abs(p[1] - 240.05) < 1e-6, p


def test_unsupported_model_raises():
    try:
        sfm.project_point([0, 0, 5], [1, 0, 0, 0], [0, 0, 0],
                          "SPHERICAL", [500.0, 320.0, 240.0], 640, 480)
        raise AssertionError("expected ValueError")
    except ValueError as e:
        assert "SPHERICAL" in str(e)


def test_parse_keeps_radial_model():
    tmp = tempfile.mkdtemp(prefix="sfm-radial-")
    with open(os.path.join(tmp, "cameras.txt"), "w") as fh:
        fh.write("1 SIMPLE_RADIAL 640 480 500 320 240 0.05\n")
    with open(os.path.join(tmp, "images.txt"), "w") as fh:
        fh.write("1 1 0 0 0 0 0 0 1 a.jpg\n\n")
    with open(os.path.join(tmp, "points3D.txt"), "w") as fh:
        fh.write("")
    cameras, points, colors, warnings = sfm.parse_model(tmp)
    assert [c["image"] for c in cameras] == ["a.jpg"], (cameras, warnings)
    assert not warnings, warnings


def test_pinhole_model():
    cam = _cam(model="PINHOLE", params=(500.0, 600.0, 320.0, 240.0))
    p = sfm.project_point([0.0, 0.0, 5.0], cam["qvec"], cam["tvec"],
                          cam["model"], cam["params"], 640, 480)
    assert p is not None and abs(p[0] - 320.0) < 1e-6


def test_vote_labels_simple():
    cam = _cam()
    points = [[0.0, 0.0, 5.0], [50.0, 0.0, 5.0]]  # centered / far right
    dets = {"a.jpg": [{"label": "door", "box": [300, 220, 340, 260],
                       "score": 0.9}]}
    labels = sfm.vote_point_labels(points, [cam], dets)
    assert labels[0]["label"] == "door" and labels[0]["votes"] == 1, labels
    assert 1 not in labels, labels  # projects outside the box


def test_vote_labels_majority_and_basename():
    cam = _cam()
    cam2 = dict(cam, image="sub/b.jpg")
    points = [[0.0, 0.0, 5.0]]
    dets = {"b.jpg": [  # basename match for "sub/b.jpg"
        {"label": "door", "box": [0, 0, 640, 480], "score": 0.5},
        {"label": "bin", "box": [0, 0, 640, 480], "score": 0.9}],
        "a.jpg": [{"label": "door", "box": [0, 0, 640, 480]}]}
    labels = sfm.vote_point_labels(points, [cam, cam2], dets)
    assert labels[0]["label"] == "door", labels
    assert labels[0]["votes"] == 2, labels
    assert labels[0]["counts"] == {"door": 2, "bin": 1}, labels


def test_vote_labels_no_detections():
    assert sfm.vote_point_labels([[0, 0, 5]], [_cam()], {}) == {}


def test_ply_roundtrip():
    pts = [[1.5, -2.0, 3.25], [0.0, 0.0, 0.0]]
    cols = [[255, 0, 128], [1, 2, 3]]
    text = sfm.write_ply_ascii(pts, cols)
    assert text.startswith("ply\nformat ascii 1.0\n")
    p2, c2 = sfm.parse_ply_ascii(text)
    assert p2 == pts and c2 == cols, (p2, c2)


def test_downsample_cap():
    pts = [[float(i), 0.0, 1.0] for i in range(100)]
    cols = [[i % 256, 0, 0] for i in range(100)]
    p2, c2 = sfm.downsample(pts, cols, cap=10)
    assert len(p2) == 10 and len(c2) == 10
    assert p2[0] == pts[0]  # order kept, starts at first point


def test_parse_text_model():
    tmp = tempfile.mkdtemp(prefix="sfm-test-")
    with open(os.path.join(tmp, "cameras.txt"), "w") as fh:
        fh.write("# Camera list\n1 SIMPLE_PINHOLE 640 480 500 320 240\n"
                 "2 PINHOLE 640 480 500 600 320 240\n"
                 "3 SPHERICAL 640 480 500 320 240\n")
    with open(os.path.join(tmp, "images.txt"), "w") as fh:
        fh.write("1 1 0 0 0 0 0 0 1 a.jpg\n\n"
                 "2 1 0 0 0 0 0 0 2 b.jpg\n\n"
                 "3 1 0 0 0 0 0 0 3 c.jpg\n\n")
    with open(os.path.join(tmp, "points3D.txt"), "w") as fh:
        fh.write("7 1.0 2.0 3.0 255 0 0 0.5 1 0\n")
    cameras, points, colors, warnings = sfm.parse_model(tmp)
    assert {c["image"] for c in cameras} == {"a.jpg", "b.jpg"}, cameras
    assert any("SPHERICAL" in w for w in warnings), warnings
    assert points == [[1.0, 2.0, 3.0]] and colors == [[255, 0, 0]]
    pin = next(c for c in cameras if c["image"] == "b.jpg")
    assert pin["params"] == [500.0, 600.0, 320.0, 240.0]


def test_sfm_503_without_colmap():
    """POST /api/sfm with no COLMAP binary and no pycolmap -> HTTP 503."""
    import json
    import zipfile as _zip
    from PIL import Image  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402

    old_which, old_import = sfm.colmap_binary, sfm.pycolmap_available
    sfm.colmap_binary = lambda: None
    sfm.pycolmap_available = lambda: False
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import server  # noqa: E402
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            for name in ("a.jpg", "b.jpg"):
                buf = io.BytesIO()
                Image.new("RGB", (64, 48), (10, 100, 200)).save(buf, "JPEG")
                zf.writestr(name, buf.getvalue())
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")},
                   data={"detections": json.dumps({}), "use_gpu": "0"})
        assert r.status_code == 503, (r.status_code, r.text)
        assert "colmap" in r.json()["error"].lower(), r.text
    finally:
        sfm.colmap_binary, sfm.pycolmap_available = old_which, old_import


def _write(path, text):
    with open(path, "w") as fh:
        fh.write(text)


def _sfm_final_data(response):
    """/api/sfm streams NDJSON (log lines, then a result): the final
    result payload of a streamed reply."""
    import json
    assert response.status_code == 200, (response.status_code,
                                         response.text[:200])
    lines = [ln for ln in response.text.splitlines() if ln.strip()]
    assert lines, "empty stream"
    last = json.loads(lines[-1])
    assert last.get("type") == "result", last
    return last["data"]


_MIN_TEXT_MODEL = {
    "cameras.txt": "1 SIMPLE_PINHOLE 640 480 500 320 240\n",
    "images.txt": "1 1 0 0 0 0 0 0 1 a.jpg\n\n",
    "points3D.txt": "",
}


def test_pick_model_dir_largest():
    tmp = tempfile.mkdtemp(prefix="sfm-pick-")
    os.makedirs(os.path.join(tmp, "0"))
    os.makedirs(os.path.join(tmp, "1"))
    os.makedirs(os.path.join(tmp, "logs"))  # non-numeric ignored
    _write(os.path.join(tmp, "0", "points3D.txt"), "x\n" * 10)
    _write(os.path.join(tmp, "1", "points3D.bin"), "y" * 100)
    assert sfm._pick_model_dir(tmp) == os.path.join(tmp, "1")
    assert sfm._pick_model_dir(tempfile.mkdtemp(prefix="sfm-empty-")) is None


def test_ensure_text_model_skips_when_text():
    tmp = tempfile.mkdtemp(prefix="sfm-text-")
    for name, text in _MIN_TEXT_MODEL.items():
        _write(os.path.join(tmp, name), text)
    def _boom(cmd, warnings):
        raise AssertionError(f"converter must not run: {cmd}")
    sfm._ensure_text_model("colmap", tmp, [], runner=_boom)


def test_ensure_text_model_converts_bin():
    tmp = tempfile.mkdtemp(prefix="sfm-bin-")
    _write(os.path.join(tmp, "cameras.bin"), "fake-binary")
    calls, warnings = [], []
    def _fake_convert(cmd, warnings_):
        calls.append(cmd)
        assert cmd[1] == "model_converter", cmd
        assert cmd[cmd.index("--output_type") + 1] == "TXT", cmd
        for name, text in _MIN_TEXT_MODEL.items():
            _write(os.path.join(tmp, name), text)
    sfm._ensure_text_model("colmap", tmp, warnings, runner=_fake_convert)
    assert len(calls) == 1 and warnings, (calls, warnings)
    assert os.path.isfile(os.path.join(tmp, "cameras.txt"))


def test_ensure_text_model_empty_raises_helpful():
    tmp = tempfile.mkdtemp(prefix="sfm-empty-model-")
    try:
        sfm._ensure_text_model("colmap", tmp, [])
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "overlap" in str(e), e


def _fake_colmap_run(write_bins):
    """Stub sfm._run + sfm.colmap_binary simulating a mapper that leaves
    only binary files (or nothing when write_bins is False)."""
    state = {"calls": []}
    def _fake(cmd, warnings, emit=None):
        state["calls"].append(cmd[1])
        if cmd[1] == "mapper":
            out = cmd[cmd.index("--output_path") + 1]
            model = os.path.join(out, "0")
            os.makedirs(model, exist_ok=True)
            if write_bins:
                for fn in ("cameras.bin", "images.bin",
                           "points3D.bin"):
                    _write(os.path.join(model, fn), "fake-binary")
        elif cmd[1] == "model_converter":
            out = cmd[cmd.index("--output_path") + 1]
            for name, text in _MIN_TEXT_MODEL.items():
                _write(os.path.join(out, name), text)
    return state, _fake


def test_run_colmap_cli_converts_binary_model():
    tmp = tempfile.mkdtemp(prefix="sfm-cli-")
    state, fake = _fake_colmap_run(write_bins=True)
    old_run, old_bin = sfm._run, sfm.colmap_binary
    sfm._run, sfm.colmap_binary = fake, lambda: "colmap"
    try:
        model_dir, warnings = sfm.run_colmap_cli(
            tmp, os.path.join(tmp, "ws"), False)
    finally:
        sfm._run, sfm.colmap_binary = old_run, old_bin
    assert os.path.isfile(os.path.join(model_dir, "cameras.txt"))
    assert "model_converter" in state["calls"], state
    assert any("binary" in w for w in warnings), warnings


def test_run_colmap_cli_no_model_helpful():
    tmp = tempfile.mkdtemp(prefix="sfm-cli-empty-")
    _, fake = _fake_colmap_run(write_bins=False)
    old_run, old_bin = sfm._run, sfm.colmap_binary
    sfm._run, sfm.colmap_binary = fake, lambda: "colmap"
    try:
        try:
            sfm.run_colmap_cli(tmp, os.path.join(tmp, "ws"), False)
            raise AssertionError("expected RuntimeError")
        except RuntimeError as e:
            assert "no model" in str(e) and "overlap" in str(e), e
    finally:
        sfm._run, sfm.colmap_binary = old_run, old_bin


def test_sfm_concepts_label_without_depth():
    """POST /api/sfm with concepts: boxes detected server-side, depth
    never runs, labels land on the voted points."""
    import json
    import zipfile as _zip
    from PIL import Image  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402
    import server  # noqa: E402

    old_bin, old_recon = sfm.colmap_binary, sfm.reconstruct
    old_depth = server.get_depth
    old_mock = os.environ.get("MOCK_SAM")
    sfm.colmap_binary = lambda: "colmap"
    os.environ["MOCK_SAM"] = "1"
    def _boom(*a, **k):
        raise AssertionError("no depth pass may run on the SfM route")
    server.get_depth = _boom
    def _fake_reconstruct(img_dir, workspace_dir, gpu_used, emit=None):
        model = os.path.join(workspace_dir, "sparse", "0")
        os.makedirs(model, exist_ok=True)
        _write(os.path.join(model, "cameras.txt"),
               "1 SIMPLE_PINHOLE 64 48 50 32 24\n")
        _write(os.path.join(model, "images.txt"),
               "1 1 0 0 0 0 0 0 1 a.jpg\n\n"
               "2 1 0 0 0 0 0 0 1 b.jpg\n\n")
        _write(os.path.join(model, "points3D.txt"),
               "1 0.0 0.0 5.0 200 100 50 1.0 0 0\n")
        return model, []
    sfm.reconstruct = _fake_reconstruct
    try:
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            for name in ("a.jpg", "b.jpg"):
                buf = io.BytesIO()
                Image.new("RGB", (64, 48), (10, 100, 200)).save(buf, "JPEG")
                zf.writestr(name, buf.getvalue())
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")},
                   data={"concepts": json.dumps(["door"]),
                         "detector": "sam", "use_gpu": "0"})
        body = _sfm_final_data(r)
        assert "error" not in body, body
        assert body["point_labels"]["0"]["label"] == "door", body
        assert any("no depth pass" in w for w in body["warnings"]), body
    finally:
        sfm.colmap_binary, sfm.reconstruct = old_bin, old_recon
        server.get_depth = old_depth
        if old_mock is None:
            os.environ.pop("MOCK_SAM", None)
        else:
            os.environ["MOCK_SAM"] = old_mock


def test_detect_no_depth_reports_errors():
    from PIL import Image  # noqa: E402
    import server  # noqa: E402
    old = server.run_detections
    def _boom(pil, names, detector="sam"):
        raise RuntimeError("weights missing")
    server.run_detections = _boom
    try:
        img = Image.new("RGB", (64, 48), "white")
        dets, errors = server.detect_concepts_no_depth(
            {"a.jpg": img, "b.jpg": img}, ["door"])
        assert dets == {}, dets
        assert len(errors) == 2 and all(
            "weights missing" in e for e in errors), errors
    finally:
        server.run_detections = old


def test_sfm_concepts_failure_warns_unlabeled():
    """Detector blows up -> 200, empty labels, warning says why."""
    import json
    import zipfile as _zip
    from PIL import Image  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402
    import server  # noqa: E402

    old_bin, old_recon = sfm.colmap_binary, sfm.reconstruct
    old_run = server.run_detections
    sfm.colmap_binary = lambda: "colmap"
    server.run_detections = lambda p, n, detector="sam": (
        _ for _ in ()).throw(RuntimeError("weights missing"))
    def _fake_reconstruct(img_dir, workspace_dir, gpu_used, emit=None):
        model = os.path.join(workspace_dir, "sparse", "0")
        os.makedirs(model, exist_ok=True)
        _write(os.path.join(model, "cameras.txt"),
               "1 SIMPLE_PINHOLE 64 48 50 32 24\n")
        _write(os.path.join(model, "images.txt"),
               "1 1 0 0 0 0 0 0 1 a.jpg\n\n")
        _write(os.path.join(model, "points3D.txt"),
               "1 0.0 0.0 5.0 200 100 50 1.0 0 0\n")
        return model, []
    sfm.reconstruct = _fake_reconstruct
    try:
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            for name in ("a.jpg", "b.jpg"):
                buf = io.BytesIO()
                Image.new("RGB", (64, 48), (10, 100, 200)).save(buf, "JPEG")
                zf.writestr(name, buf.getvalue())
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")},
                   data={"concepts": json.dumps(["door"]),
                         "use_gpu": "0"})
        body = _sfm_final_data(r)
        assert "error" not in body, body
        assert body["point_labels"] == {}, body
        assert any("unlabeled" in w and "weights missing" in w
                   for w in body["warnings"]), body
    finally:
        sfm.colmap_binary, sfm.reconstruct = old_bin, old_recon
        server.run_detections = old_run


def test_pycolmap_prefers_new_api():
    """Fake new-style pycolmap: extraction_options + device win."""
    import sys
    import types
    calls = {}
    fake = types.ModuleType("pycolmap")

    class _Device:
        auto, cpu, cuda = "auto", "cpu", "cuda"
    fake.Device = _Device

    class _FE:
        def __init__(self):
            self.use_gpu = None
    fake.FeatureExtractionOptions = _FE

    def _extract(db, imgs, **kw):
        calls["extract"] = kw
    def _match(db):
        calls["match"] = True
    class _Recon:
        points3D = [1, 2, 3]
        def write_text(self, path):
            calls["wrote"] = path
            os.makedirs(path, exist_ok=True)
            for name, text in _MIN_TEXT_MODEL.items():
                _write(os.path.join(path, name), text)
    def _mapping(db, imgs, out):
        calls["mapping"] = True
        return {"0": _Recon()}
    fake.extract_features, fake.match_exhaustive = _extract, _match
    fake.incremental_mapping = _mapping
    old = sys.modules.get("pycolmap")
    sys.modules["pycolmap"] = fake
    ws = tempfile.mkdtemp(prefix="sfm-pycolmap-")
    try:
        model_dir, warnings = sfm.run_colmap_pycolmap("/imgs", ws, False)
    finally:
        if old is None:
            del sys.modules["pycolmap"]
        else:
            sys.modules["pycolmap"] = old
    assert "extraction_options" in calls.get("extract", {}), calls
    assert calls["extract"].get("device") == "cpu", calls
    assert calls.get("wrote") == os.path.join(ws, "sparse", "0"), calls
    assert os.path.isfile(os.path.join(model_dir, "cameras.txt"))
    assert any("pycolmap" in w for w in warnings), warnings


def test_sift_gpu_flags_both_spellings():
    tmp = tempfile.mkdtemp(prefix="sfm-flags-")
    new = os.path.join(tmp, "colmap-new")
    with open(new, "w") as fh:
        fh.write("#!/bin/sh\necho '--FeatureExtraction.use_gpu arg (=1)'\n")
    old = os.path.join(tmp, "colmap-old")
    with open(old, "w") as fh:
        fh.write("#!/bin/sh\necho 'no gpu flags here'\n")
    err = os.path.join(tmp, "colmap-err")
    with open(err, "w") as fh:
        fh.write("#!/bin/sh\necho '--FeatureExtraction.use_gpu arg (=1)' >&2\n")
    os.chmod(new, 0o755)
    os.chmod(old, 0o755)
    os.chmod(err, 0o755)
    ex, ma = sfm._sift_gpu_flags(new, True)
    assert ex == ["--FeatureExtraction.use_gpu", "1",
                  "--FeatureExtraction.gpu_index", "0"], ex
    assert ma == ["--FeatureMatching.use_gpu", "1",
                  "--FeatureMatching.gpu_index", "0"], ma
    ex, ma = sfm._sift_gpu_flags(new, False)
    assert ex == ["--FeatureExtraction.use_gpu", "0"], ex
    ex, ma = sfm._sift_gpu_flags(old, True)
    assert ex == ["--SiftExtraction.use_gpu", "1"], ex
    assert ma == ["--SiftMatching.use_gpu", "1"], ma
    ex, ma = sfm._sift_gpu_flags(err, True)  # --help on stderr (COLMAP 4.x)
    assert ex[0] == "--FeatureExtraction.use_gpu", ex
    ex, ma = sfm._sift_gpu_flags(os.path.join(tmp, "missing"), True)
    assert ex == ["--SiftExtraction.use_gpu", "1"], ex


def _min_cams():
    return [{"image": "a.jpg", "qvec": [1.0, 0.0, 0.0, 0.0],
             "tvec": [0.0, 0.0, 0.0], "width": 640, "height": 480,
             "model": "SIMPLE_PINHOLE", "params": [500.0, 320.0, 240.0]}]


def test_read_ply_binary():
    import struct
    tmp = tempfile.mkdtemp(prefix="sfm-plybin-")
    path = os.path.join(tmp, "fused.ply")
    header = ("ply\nformat binary_little_endian 1.0\n"
              "element vertex 2\n"
              "property float x\nproperty float y\nproperty float z\n"
              "property float nx\nproperty float ny\nproperty float nz\n"
              "property uchar red\nproperty uchar green\nproperty uchar blue\n"
              "end_header\n").encode("ascii")
    rows = struct.pack("<ffffffBBB", 1.0, 2.0, 3.0, 0, 0, 1,
                       255, 0, 128)
    rows += struct.pack("<ffffffBBB", 4.0, 5.0, 6.0, 0, 1, 0, 1, 2, 3)
    with open(path, "wb") as fh:
        fh.write(header + rows)
    pts, cols = sfm.read_ply_points(path)
    assert pts == [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], pts
    assert cols == [[255, 0, 128], [1, 2, 3]], cols


def test_read_ply_ascii_file():
    tmp = tempfile.mkdtemp(prefix="sfm-plyascii-")
    path = os.path.join(tmp, "a.ply")
    with open(path, "w") as fh:
        fh.write(sfm.write_ply_ascii([[1.0, 2.0, 3.0]], [[10, 20, 30]]))
    pts, cols = sfm.read_ply_points(path)
    assert pts == [[1.0, 2.0, 3.0]] and cols == [[10, 20, 30]]


def test_numpy_vote_matches_pure():
    cams = _min_cams()
    points = [[0.0, 0.0, 5.0], [50.0, 0.0, 5.0], [0.0, 0.0, -5.0]]
    dets = {"a.jpg": [{"label": "door", "box": [300, 220, 340, 260],
                       "score": 0.9},
                      {"label": "bin", "box": [0, 0, 640, 480],
                       "score": 0.1}]}
    pure = sfm.vote_point_labels(points, cams, dets)
    fast = sfm.vote_point_labels_numpy(points, cams, dets)
    assert fast == pure, (fast, pure)
    assert fast[0]["label"] == "door", fast
    assert 1 not in fast and 2 not in fast, fast  # outside frame / behind


def test_dense_gpu_flags_probe():
    tmp = tempfile.mkdtemp(prefix="sfm-denseflags-")
    both = os.path.join(tmp, "colmap-both")
    with open(both, "w") as fh:
        fh.write("#!/bin/sh\necho '--PatchMatchStereo.use_gpu arg (=1)'\n"
                 "echo '--PatchMatchStereo.gpu_index arg (=-1)'\n")
    idx = os.path.join(tmp, "colmap-idx")
    with open(idx, "w") as fh:
        fh.write("#!/bin/sh\necho '--PatchMatchStereo.gpu_index arg (=-1)' >&2\n")
    os.chmod(both, 0o755)
    os.chmod(idx, 0o755)
    assert sfm._dense_gpu_flags(both, True) == [
        "--PatchMatchStereo.use_gpu", "1",
        "--PatchMatchStereo.gpu_index", "0"]
    assert sfm._dense_gpu_flags(both, False) == [
        "--PatchMatchStereo.use_gpu", "0"]
    assert sfm._dense_gpu_flags(idx, False) == [
        "--PatchMatchStereo.gpu_index", "-1"]
    assert sfm._dense_gpu_flags(idx, True) == [
        "--PatchMatchStereo.gpu_index", "0"]


def test_run_dense_cli_failure():
    ws = _ws_with_sparse_model()
    old = sfm._run
    def _boom(cmd, warnings, emit=None):
        raise RuntimeError("colmap patch_match_stereo failed: no GPU")
    sfm._run = _boom
    try:
        try:
            sfm.run_dense_cli("colmap", ws, False)
            raise AssertionError("expected RuntimeError")
        except RuntimeError as e:
            assert "patch_match" in str(e) and "no GPU" in str(e), e
    finally:
        sfm._run = old


def _ws_with_sparse_model():
    ws = tempfile.mkdtemp(prefix="sfm-densews-")
    model = os.path.join(ws, "sparse", "0")
    os.makedirs(os.path.join(ws, "images"), exist_ok=True)
    os.makedirs(model, exist_ok=True)
    _write(os.path.join(model, "points3D.bin"), "fake-binary")
    return ws


def test_run_dense_cli_undistorts_first():
    """Dense runs undistort -> patch_match -> fusion on the MVS dir."""
    ws = _ws_with_sparse_model()
    calls = []
    old = sfm._run
    def _fake(cmd, warnings, emit=None):
        calls.append(cmd[1])
        if cmd[1] == "image_undistorter":
            assert cmd[cmd.index("--input_path") + 1].endswith(
                os.path.join("sparse", "0")), cmd
            assert cmd[cmd.index("--output_path") + 1].endswith("dense"), cmd
        if cmd[1] == "patch_match_stereo":
            assert cmd[cmd.index("--workspace_path") + 1].endswith("dense"), cmd
        if cmd[1] == "stereo_fusion":
            out = cmd[cmd.index("--output_path") + 1]
            _write(out, "fake-ply")
    sfm._run = _fake
    try:
        fused, warnings = sfm.run_dense_cli("colmap", ws, False)
    finally:
        sfm._run = old
    assert [c for c in calls] == ["image_undistorter", "patch_match_stereo",
                                  "stereo_fusion"], calls
    assert fused == os.path.join(ws, "fused.ply"), fused
    assert any("CPU" in w for w in warnings), warnings


def test_run_dense_cli_no_sparse_model_helpful():
    ws = tempfile.mkdtemp(prefix="sfm-denseempty-")
    try:
        sfm.run_dense_cli("colmap", ws, False)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "no sparse model" in str(e), e


def test_sfm_bad_zip_never_500():
    from fastapi.testclient import TestClient  # noqa: E402
    import server  # noqa: E402
    c = TestClient(server.app, raise_server_exceptions=False)
    r = c.post("/api/sfm",
               files={"zipfile": ("s.zip", b"not a zip",
                                   "application/zip")})
    assert r.status_code == 200, (r.status_code, r.text)
    assert "error" in r.json(), r.text


def _fake_pycolmap_with_gpu_check(gpu_usable, calls, maps_empty=False):
    """Fake pycolmap 4.x module emulating its extraction-options check.

    gpu_usable=False mimics a CPU-only wheel on a machine with a GPU:
    check() fails exactly when use_gpu is set, and extract() raises the
    same "Check failed: extraction_options.Check()" ValueError the real
    binding raises (backend/sfm.py must fall back to CPU instead).
    """
    import sys
    import types
    fake = types.ModuleType("pycolmap")

    class _Device:
        auto, cpu, cuda = "auto", "cpu", "cuda"
    fake.Device = _Device

    class _FE:
        def __init__(self):
            self.use_gpu = False

        def check(self):
            return gpu_usable or not self.use_gpu
    fake.FeatureExtractionOptions = _FE

    def _extract(db, imgs, **kw):
        opts = kw.get("extraction_options")
        if opts is not None and not opts.check():
            raise ValueError("[extract_features.cc:35] Check failed: "
                             "extraction_options.Check()")
        calls["extract"] = kw

    def _match(db):
        calls["match"] = True

    class _Recon:
        points3D = [1, 2, 3]

        def write_text(self, path):
            calls["wrote"] = path
            os.makedirs(path, exist_ok=True)
            for name, text in _MIN_TEXT_MODEL.items():
                _write(os.path.join(path, name), text)

    def _mapping(db, imgs, out):
        calls["mapping"] = True
        return {} if maps_empty else {"0": _Recon()}
    fake.extract_features, fake.match_exhaustive = _extract, _match
    fake.incremental_mapping = _mapping
    return fake


def _run_pycolmap_fake(gpu_usable, gpu_used, maps_empty=False, emit=None):
    import sys
    calls = {}
    fake = _fake_pycolmap_with_gpu_check(gpu_usable, calls,
                                         maps_empty=maps_empty)
    old = sys.modules.get("pycolmap")
    sys.modules["pycolmap"] = fake
    ws = tempfile.mkdtemp(prefix="sfm-gpufallback-")
    try:
        model_dir, warnings = sfm.run_colmap_pycolmap("/imgs", ws,
                                                      gpu_used, emit)
    finally:
        if old is None:
            del sys.modules["pycolmap"]
        else:
            sys.modules["pycolmap"] = old
    return calls, model_dir, warnings


def test_pycolmap_falls_back_to_cpu_when_gpu_unusable():
    """CPU-only pycolmap wheel + visible GPU must degrade, not 500."""
    calls, model_dir, warnings = _run_pycolmap_fake(gpu_usable=False,
                                                    gpu_used=True)
    opts = calls["extract"]["extraction_options"]
    assert opts.use_gpu is False, opts
    assert calls["extract"].get("device") == "cpu", calls
    assert any("cpu" in w.lower() for w in warnings), warnings
    assert os.path.isfile(os.path.join(model_dir, "cameras.txt"))


def test_pycolmap_keeps_gpu_when_usable():
    """A CUDA-capable pycolmap must still get use_gpu + cuda device."""
    calls, _, warnings = _run_pycolmap_fake(gpu_usable=True,
                                            gpu_used=True)
    opts = calls["extract"]["extraction_options"]
    assert opts.use_gpu is True, opts
    assert calls["extract"].get("device") == "cuda", calls
    assert not any("falling back" in w for w in warnings), warnings


def test_run_streams_tool_lines():
    """_run with emit forwards each stdout line as it arrives."""
    import sys
    seen = []
    sfm._run([sys.executable, "-c", "print('alpha'); print('beta')"],
             [], seen.append)
    assert seen == ["alpha", "beta"], seen


def test_run_stream_failure_keeps_tail():
    """Streaming failures still raise with the tool's log tail."""
    import sys
    try:
        sfm._run([sys.executable, "-c",
                  "import sys; print('oops'); sys.exit(3)"],
                 [], lambda s: None)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "oops" in str(e), e


def test_pycolmap_emit_announces_stages():
    """pycolmap path narrates extract/match/map into the log."""
    said = []
    _run_pycolmap_fake(gpu_usable=True, gpu_used=True, emit=said.append)
    joined = " ".join(said).lower()
    for word in ("extract", "match", "map"):
        assert word in joined, said


def test_pycolmap_failure_keeps_warnings():
    """A failed reconstruction still reports the warnings so far."""
    try:
        _run_pycolmap_fake(gpu_usable=False, gpu_used=True,
                           maps_empty=True)
        raise AssertionError("expected SfmError")
    except RuntimeError as e:
        assert "no model" in str(e), e
        assert isinstance(e, sfm.SfmError), type(e)
        assert any("falling back" in w for w in e.warnings), e.warnings
        assert any("pycolmap fallback" in w for w in e.warnings), e.warnings


def test_sfm_response_includes_detections():
    """POST /api/sfm echoes the per-image SAM boxes for the SAM box."""
    import io
    import json
    import zipfile as _zip
    from fastapi.testclient import TestClient  # noqa: E402
    from PIL import Image  # noqa: E402
    import server  # noqa: E402

    old_bin, old_recon = sfm.colmap_binary, sfm.reconstruct
    sfm.colmap_binary = lambda: "colmap"

    def _fake_reconstruct(img_dir, workspace_dir, gpu_used, emit=None):
        model = os.path.join(workspace_dir, "sparse", "0")
        os.makedirs(model, exist_ok=True)
        for name, text in _MIN_TEXT_MODEL.items():
            _write(os.path.join(model, name), text)
        return model, []
    sfm.reconstruct = _fake_reconstruct
    try:
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            for name in ("a.jpg", "b.jpg"):
                buf = io.BytesIO()
                Image.new("RGB", (64, 48), (10, 100, 200)).save(buf, "JPEG")
                zf.writestr(name, buf.getvalue())
        given = {"a.jpg": [{"label": "door", "box": [0, 0, 10, 10],
                            "score": 0.9}]}
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")},
                   data={"detections": json.dumps(given)})
        body = _sfm_final_data(r)
        assert "error" not in body, body
        assert body["detections"]["a.jpg"][0]["label"] == "door", body
        assert body["thumbnails"]["a.jpg"].startswith("data:image/jpeg"), body
        assert body["image_sizes"]["a.jpg"] == [64, 48], body
    finally:
        sfm.colmap_binary, sfm.reconstruct = old_bin, old_recon


def test_pycolmap_bumps_sift_features():
    """pycolmap extraction asks for a denser sparse cloud (guarded)."""
    import sys
    import types
    calls = {}
    fake = types.ModuleType("pycolmap")

    class _Device:
        auto, cpu, cuda = "auto", "cpu", "cuda"
    fake.Device = _Device

    class _Sift:
        max_num_features = 8192
    class _FE:
        def __init__(self):
            self.use_gpu = False
            self.sift = _Sift()

        def check(self):
            return True
    fake.FeatureExtractionOptions = _FE

    def _extract(db, imgs, **kw):
        calls["extract"] = kw
    def _match(db):
        pass

    class _Recon:
        points3D = [1]

        def write_text(self, path):
            calls["wrote"] = path
            os.makedirs(path, exist_ok=True)
            for name, text in _MIN_TEXT_MODEL.items():
                _write(os.path.join(path, name), text)

    def _mapping(db, imgs, out):
        return {"0": _Recon()}
    fake.extract_features, fake.match_exhaustive = _extract, _match
    fake.incremental_mapping = _mapping
    old = sys.modules.get("pycolmap")
    sys.modules["pycolmap"] = fake
    ws = tempfile.mkdtemp(prefix="sfm-siftbump-")
    try:
        sfm.run_colmap_pycolmap("/imgs", ws, False)
    finally:
        if old is None:
            del sys.modules["pycolmap"]
        else:
            sys.modules["pycolmap"] = old
    opts = calls["extract"]["extraction_options"]
    assert opts.sift.max_num_features == sfm.SPARSE_SIFT_MAX_FEATURES, opts


def test_sfm_streams_progress_log_then_result():
    """POST /api/sfm streams log lines before the final result."""
    import io
    import json
    import zipfile as _zip
    from fastapi.testclient import TestClient  # noqa: E402
    from PIL import Image  # noqa: E402
    import server  # noqa: E402

    old_bin = sfm.colmap_binary
    sfm.colmap_binary = lambda: None  # force the pycolmap path
    calls = {}
    fake = _fake_pycolmap_with_gpu_check(True, calls)
    old_pm = sys.modules.get("pycolmap")
    sys.modules["pycolmap"] = fake
    try:
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            for name in ("a.jpg", "b.jpg"):
                buf = io.BytesIO()
                Image.new("RGB", (64, 48), (10, 100, 200)).save(buf, "JPEG")
                zf.writestr(name, buf.getvalue())
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")},
                   data={"use_gpu": "0"})
        assert r.status_code == 200, (r.status_code, r.text[:200])
        assert "ndjson" in r.headers.get("content-type", ""), r.headers
        logs, finals = [], []
        for ln in r.text.splitlines():
            if not ln.strip():
                continue
            msg = json.loads(ln)
            if msg.get("type") == "log":
                logs.append(msg["line"])
            elif msg.get("type") == "result":
                finals.append(msg["data"])
        assert len(finals) == 1 and "error" not in finals[0], finals
        joined = " ".join(logs).lower()
        for word in ("extract", "match", "map"):
            assert word in joined, logs
    finally:
        sfm.colmap_binary = old_bin
        if old_pm is None:
            del sys.modules["pycolmap"]
        else:
            sys.modules["pycolmap"] = old_pm


def test_sfm_failure_response_keeps_backend_warnings():
    """POST /api/sfm failure replies carry the backend warnings."""
    import io
    import zipfile as _zip
    from fastapi.testclient import TestClient  # noqa: E402
    from PIL import Image  # noqa: E402
    import server  # noqa: E402

    old_bin, old_recon = sfm.colmap_binary, sfm.reconstruct
    sfm.colmap_binary = lambda: "colmap"

    def _boom(img_dir, workspace_dir, gpu_used, emit=None):
        raise sfm.SfmError("pycolmap produced no model",
                           ["GPU fallback note"])
    sfm.reconstruct = _boom
    try:
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            for name in ("a.jpg", "b.jpg"):
                buf = io.BytesIO()
                Image.new("RGB", (64, 48), (10, 100, 200)).save(buf, "JPEG")
                zf.writestr(name, buf.getvalue())
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")})
        body = _sfm_final_data(r)
        assert "produced no model" in body["error"], body
        assert "GPU fallback note" in body["warnings"], body
    finally:
        sfm.colmap_binary, sfm.reconstruct = old_bin, old_recon


def test_image_orientation_labels():
    assert sfm.image_orientation(640, 480) == "landscape"
    assert sfm.image_orientation(480, 640) == "portrait"
    assert sfm.image_orientation(500, 500) == "square"


def test_unique_image_name_keeps_first_and_renames_rest():
    taken = set()
    assert sfm.unique_image_name("a.jpg", taken) == "a.jpg"
    assert sfm.unique_image_name("a.jpg", taken) == "a__2.jpg"
    assert sfm.unique_image_name("a.jpg", taken) == "a__3.jpg"
    assert sfm.unique_image_name("b.png", taken) == "b.png"
    assert taken == {"a.jpg", "a__2.jpg", "a__3.jpg", "b.png"}


def test_camera_dimension_warnings():
    sizes = {"land.jpg": (640, 480), "port.jpg": (480, 640)}
    ok = [{"image": "land.jpg", "width": 640, "height": 480},
          {"image": "port.jpg", "width": 480, "height": 640}]
    assert sfm.camera_dimension_warnings(ok, sizes) == []
    swapped = [{"image": "port.jpg", "width": 640, "height": 480}]
    warns = sfm.camera_dimension_warnings(swapped, sizes)
    assert len(warns) == 1 and "port.jpg" in warns[0], warns
    assert "480x640" in warns[0] and "640x480" in warns[0], warns
    wrong = [{"image": "land.jpg", "width": 320, "height": 240}]
    assert len(sfm.camera_dimension_warnings(wrong, sizes)) == 1


def test_camera_per_image_args_both_spellings():
    tmp = tempfile.mkdtemp(prefix="sfm-camargs-")
    new = os.path.join(tmp, "colmap-new")
    with open(new, "w") as fh:
        fh.write("#!/bin/sh\necho '--ImageReader.single_camera arg (=0)'\n"
                 "echo '--ImageReader.single_camera_per_image arg (=0)'\n")
    old = os.path.join(tmp, "colmap-old")
    with open(old, "w") as fh:
        fh.write("#!/bin/sh\necho '--ImageReader.single_camera arg (=0)'\n")
    os.chmod(new, 0o755)
    os.chmod(old, 0o755)
    assert sfm._camera_per_image_args(new) == [
        "--ImageReader.single_camera_per_image", "1"]
    assert sfm._camera_per_image_args(old) == [
        "--ImageReader.single_camera", "0"]
    # Missing binary must not raise: safe per-image spelling.
    assert sfm._camera_per_image_args(
        os.path.join(tmp, "missing")) == [
        "--ImageReader.single_camera", "0"]


def test_pycolmap_forces_per_image_camera_mode():
    import sys
    import types
    calls = {}
    fake = _fake_pycolmap_with_gpu_check(True, calls)

    class _CameraMode:
        AUTO, SINGLE, PER_FOLDER, PER_IMAGE = (
            "auto", "single", "per_folder", "per_image")
    fake.CameraMode = _CameraMode
    old = sys.modules.get("pycolmap")
    sys.modules["pycolmap"] = fake
    ws = tempfile.mkdtemp(prefix="sfm-perimage-")
    try:
        sfm.run_colmap_pycolmap("/imgs", ws, False)
    finally:
        if old is None:
            del sys.modules["pycolmap"]
        else:
            sys.modules["pycolmap"] = old
    assert calls["extract"].get("camera_mode") == "per_image", calls


def test_sfm_zip_duplicate_basenames_and_portrait_upright():
    """Photos in subfolders sharing a filename must all reach COLMAP,
    and EXIF-portrait photos must arrive upright (480x640, not 640x480)."""
    import io
    import json
    import zipfile as _zip
    from fastapi.testclient import TestClient  # noqa: E402
    from PIL import Image  # noqa: E402
    import server  # noqa: E402

    captured = {}
    old_bin, old_recon = sfm.colmap_binary, sfm.reconstruct
    sfm.colmap_binary = lambda: "colmap"

    def _fake_reconstruct(img_dir, workspace_dir, gpu_used, emit=None):
        captured["sizes"] = {
            fn: Image.open(os.path.join(img_dir, fn)).size
            for fn in sorted(os.listdir(img_dir))}
        model = os.path.join(workspace_dir, "sparse", "0")
        os.makedirs(model, exist_ok=True)
        _write(os.path.join(model, "cameras.txt"),
               "1 SIMPLE_PINHOLE 64 48 50 32 24\n")
        _write(os.path.join(model, "images.txt"),
               "1 1 0 0 0 0 0 0 1 land.jpg\n\n")
        _write(os.path.join(model, "points3D.txt"),
               "1 0.0 0.0 5.0 200 100 50 1.0 0 0\n")
        return model, []
    sfm.reconstruct = _fake_reconstruct

    def _jpeg(w, h, orient):
        im = Image.new("RGB", (w, h), (10, 100, 200))
        ex = Image.Exif()
        ex[274] = orient
        buf = io.BytesIO()
        im.save(buf, "JPEG", exif=ex)
        return buf.getvalue()
    try:
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            # Same basename in two folders: one landscape, one portrait.
            zf.writestr("wide/dup.jpg", _jpeg(64, 48, 1))
            zf.writestr("tall/dup.jpg", _jpeg(64, 48, 6))
            zf.writestr("land.jpg", _jpeg(64, 48, 1))
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")},
                   data={"use_gpu": "0"})
        body = _sfm_final_data(r)
        assert "error" not in body, body
        sizes = captured["sizes"]
        assert len(sizes) == 3, sizes  # nothing silently overwritten
        assert sorted(sizes.values()) == [(48, 64), (64, 48), (64, 48)], sizes
        # Members sort by zip path, so tall/dup.jpg keeps the plain name.
        assert body["orientations"]["dup.jpg"] == "portrait", body
        assert body["orientations"]["dup__2.jpg"] == "landscape", body
        assert any("rotated upright" in w for w in body["warnings"]), body
        assert any("shared the filename" in w for w in body["warnings"]), body
        assert any("mixed" in w for w in body["warnings"]), body
    finally:
        sfm.colmap_binary, sfm.reconstruct = old_bin, old_recon


def test_sfm_swapped_camera_dimensions_warn():
    """A COLMAP camera whose W/H are the transpose of the upright photo
    (the landscape/portrait swap) must be reported, not silently used."""
    import io
    import zipfile as _zip
    from fastapi.testclient import TestClient  # noqa: E402
    from PIL import Image  # noqa: E402
    import server  # noqa: E402

    old_bin, old_recon = sfm.colmap_binary, sfm.reconstruct
    sfm.colmap_binary = lambda: "colmap"

    def _fake_reconstruct(img_dir, workspace_dir, gpu_used, emit=None):
        model = os.path.join(workspace_dir, "sparse", "0")
        os.makedirs(model, exist_ok=True)
        # Photo on disk is portrait 48x64; camera claims 64x48 (swapped).
        _write(os.path.join(model, "cameras.txt"),
               "1 SIMPLE_PINHOLE 64 48 50 32 24\n")
        _write(os.path.join(model, "images.txt"),
               "1 1 0 0 0 0 0 0 1 port.jpg\n\n")
        _write(os.path.join(model, "points3D.txt"),
               "1 0.0 0.0 5.0 200 100 50 1.0 0 0\n")
        return model, []
    sfm.reconstruct = _fake_reconstruct
    try:
        c = TestClient(server.app, raise_server_exceptions=False)
        zb = io.BytesIO()
        with _zip.ZipFile(zb, "w") as zf:
            for name in ("port.jpg", "land.jpg"):
                buf = io.BytesIO()
                im = Image.new("RGB", (48, 64), (10, 100, 200))
                im.save(buf, "JPEG")
                zf.writestr(name, buf.getvalue())
        r = c.post("/api/sfm",
                   files={"zipfile": ("s.zip", zb.getvalue(),
                                       "application/zip")},
                   data={"use_gpu": "0"})
        body = _sfm_final_data(r)
        assert "error" not in body, body
        assert any("port.jpg" in w and "swapped" in w
                   for w in body["warnings"]), body
    finally:
        sfm.colmap_binary, sfm.reconstruct = old_bin, old_recon


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"{name} OK")
    print("ALL SFM OK")

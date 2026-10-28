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
                 "3 OPENCV 640 480 500 600 320 240 0 0 0 0\n")
    with open(os.path.join(tmp, "images.txt"), "w") as fh:
        fh.write("1 1 0 0 0 0 0 0 1 a.jpg\n\n"
                 "2 1 0 0 0 0 0 0 2 b.jpg\n\n"
                 "3 1 0 0 0 0 0 0 3 c.jpg\n\n")
    with open(os.path.join(tmp, "points3D.txt"), "w") as fh:
        fh.write("7 1.0 2.0 3.0 255 0 0 0.5 1 0\n")
    cameras, points, colors, warnings = sfm.parse_model(tmp)
    assert {c["image"] for c in cameras} == {"a.jpg", "b.jpg"}, cameras
    assert any("OPENCV" in w for w in warnings), warnings
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
    def _fake(cmd, warnings):
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
    def _fake_reconstruct(img_dir, workspace_dir, gpu_used):
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
        assert r.status_code == 200, (r.status_code, r.text)
        body = r.json()
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
    def _fake_reconstruct(img_dir, workspace_dir, gpu_used):
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
        assert r.status_code == 200, (r.status_code, r.text)
        body = r.json()
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


def test_sfm_bad_zip_never_500():
    from fastapi.testclient import TestClient  # noqa: E402
    import server  # noqa: E402
    c = TestClient(server.app, raise_server_exceptions=False)
    r = c.post("/api/sfm",
               files={"zipfile": ("s.zip", b"not a zip",
                                   "application/zip")})
    assert r.status_code == 200, (r.status_code, r.text)
    assert "error" in r.json(), r.text


if __name__ == "__main__":
    for name, fn in sorted(list(globals().items())):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"{name} OK")
    print("ALL SFM OK")

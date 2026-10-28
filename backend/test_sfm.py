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

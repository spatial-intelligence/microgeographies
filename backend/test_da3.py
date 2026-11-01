"""Unit tests for the DA3 video workflow (backend/da3.py + /api/video-cloud).

Run with either backend interpreter::

    .venv/bin/python backend/test_da3.py
    .venv/bin/python -m pytest backend/test_da3.py   # if pytest exists

No GPU or model weights: the HTTP test uses MOCK_DA3=1 + MOCK_SAM=1.
Video fixtures need OpenCV; dependent tests skip when it is missing.
"""

import io
import math
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import da3  # noqa: E402


def _qvec_to_rotmat(qvec):
    import sfm
    return sfm.qvec_to_rotmat(qvec)


def test_qvec_roundtrip_identity_and_yaw():
    assert da3.rotmat_to_qvec([[1, 0, 0], [0, 1, 0], [0, 0, 1]]) == \
        (1.0, 0.0, 0.0, 0.0)
    a = math.radians(37.0)
    R = [[math.cos(a), 0, math.sin(a)], [0, 1, 0],
         [-math.sin(a), 0, math.cos(a)]]
    back = _qvec_to_rotmat(da3.rotmat_to_qvec(R))
    for r1, r2 in zip(R, back):
        for v1, v2 in zip(r1, r2):
            assert abs(v1 - v2) < 1e-5, (R, back)


def test_sample_frame_indices():
    assert da3.sample_frame_indices(0, 5) == []
    assert da3.sample_frame_indices(3, 5) == [0, 1, 2]
    idx = da3.sample_frame_indices(101, 11)
    assert idx[0] == 0 and idx[-1] == 100 and len(idx) == 11, idx


def test_enu_of_headings():
    # Heading north: forward (z) -> north, right (x) -> east.
    e, n, u = da3.enu_of([0.0, 0.0, 5.0], 0.0)
    assert (round(e, 3), round(n, 3), round(u, 3)) == (0.0, 5.0, 0.0)
    e, n, u = da3.enu_of([5.0, 0.0, 0.0], 0.0)
    assert (round(e, 3), round(n, 3)) == (5.0, 0.0)
    # Heading east: forward -> east.
    e, n, u = da3.enu_of([0.0, 0.0, 5.0], 90.0)
    assert (round(e, 3), round(n, 3)) == (5.0, 0.0)
    # Down (y+) is negative up.
    _, _, u = da3.enu_of([0.0, 2.0, 0.0], 0.0)
    assert round(u, 3) == -2.0


def test_cloud_features_point_and_line():
    # Points in first-camera frame straight ahead (north), 4 m out.
    pts = [[0.0, 0.0, 4.0], [1.0, 0.0, 4.0], [-1.0, 0.0, 4.0],
           [0.5, 0.0, 5.0]]
    labels = {i: {"label": "steps", "votes": 2} for i in range(4)}
    feats = da3.cloud_features(pts, labels, 51.5, -0.125, 0.0,
                               geoms={"steps": "line"})
    assert len(feats) == 1, feats
    f = feats[0]
    assert f["geom"] == "line" and len(f["endpoints"]) == 2, f
    # Centroid ~4.25 m north of start (~38 µdeg of latitude).
    assert abs(f["distance_m"] - 4.25) < 0.3, f
    assert f["lat"] > 51.5 and abs(f["lat"] - 51.5) < 0.0001, f
    # Endpoints span the 2 m-wide set.
    e0, e1 = f["endpoints"]
    assert math.hypot(e1["lat"] - e0["lat"],
                      e1["lon"] - e0["lon"]) > 0, f
    feats = da3.cloud_features(pts, labels, 51.5, -0.125, 0.0)
    assert feats[0]["geom"] == "point" and "endpoints" not in feats[0]


def _photo_bytes():
    from PIL import Image
    im = Image.new("RGB", (320, 240), (10, 100, 200))
    ex = im.getexif()
    g = ex.get_ifd(0x8825)
    g[1] = "N"
    g[2] = (51.0, 30.0, 0.0)   # 51.5 N
    g[3] = "W"
    g[4] = (0.0, 7.0, 30.0)    # 0.125 W
    g[0x0010] = "T"
    g[0x0011] = (90, 1)        # heading 90 deg (east)
    b = io.BytesIO()
    im.save(b, "JPEG", exif=ex)
    return b.getvalue()


def _video_bytes(frames=20, w=320, h=240):
    import cv2
    import numpy as np
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        wr = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"),
                             10, (w, h))
        if not wr.isOpened():
            return None
        for i in range(frames):
            img = np.zeros((h, w, 3), np.uint8)
            img[:, :] = (i * 12 % 255, 80, 160)
            cv2.rectangle(img, (40, 60), (w - 40, h - 40), (30, 30, 220), -1)
            wr.write(img)
        wr.release()
        with open(path, "rb") as fh:
            return fh.read()
    finally:
        os.unlink(path)


def test_extract_frames_roundtrip():
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("SKIP test_extract_frames_roundtrip (no cv2)")
        return
    data = _video_bytes()
    if data is None:
        print("SKIP test_extract_frames_roundtrip (no mp4 writer)")
        return
    import tempfile
    tmp = tempfile.mkdtemp()
    vp = os.path.join(tmp, "clip.mp4")
    with open(vp, "wb") as fh:
        fh.write(data)
    frames = da3.extract_frames(vp, tmp, max_frames=6)
    assert 1 < len(frames) <= 6, frames
    assert frames[0]["name"] == "frame_001.jpg"
    from PIL import Image
    assert Image.open(frames[0]["path"]).size[0] > 0


class _push_env:
    def __init__(self, **kw):
        self.kw = kw
        self.old = {}

    def __enter__(self):
        for k, v in self.kw.items():
            self.old[k] = os.environ.get(k)
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def __exit__(self, *exc):
        for k, v in self.old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _post_zip(c, members, **fields):
    zb = io.BytesIO()
    with zipfile.ZipFile(zb, "w") as zf:
        for name, blob in members:
            zf.writestr(name, blob)
    lines = []
    with c.stream("POST", "/api/video-cloud",
                  files={"zipfile": ("v.zip", zb.getvalue(),
                                     "application/zip")},
                  data=fields) as r:
        assert r.status_code == 200, r.status_code
        for line in r.iter_lines():
            if line.strip():
                lines.append(line)
    import json
    msgs = [json.loads(l) for l in lines]
    result = [m["data"] for m in msgs if m.get("type") == "result"]
    assert result, msgs
    return result[0]


def test_api_video_cloud_mock_e2e():
    try:
        from fastapi.testclient import TestClient
        import server
    except ImportError:
        print("SKIP test_api_video_cloud_mock_e2e (no fastapi)")
        return
    try:
        import cv2  # noqa: F401
    except ImportError:
        print("SKIP test_api_video_cloud_mock_e2e (no cv2)")
        return
    video = _video_bytes()
    if video is None:
        print("SKIP test_api_video_cloud_mock_e2e (no mp4 writer)")
        return
    c = TestClient(server.app)
    with _push_env(MOCK_DA3="1", MOCK_SAM="1"):
        bad = _post_zip(c, [("photo.jpg", _photo_bytes())],
                        concepts='["bin"]')
        assert "error" in bad and "no video" in bad["error"], bad
        data = _post_zip(c, [("photo.jpg", _photo_bytes()),
                             ("clip.mp4", video)],
                         concepts='["bin", "steps |line"]')
        assert "error" not in data, data
        assert data["mock"] is True and data["frames"] > 1, data
        assert data["total_points"] > 100, data["total_points"]
        assert data["ply"].startswith("ply"), data["ply"][:50]
        feats = data["features"]
        assert feats, data
        by_label = {f["label"]: f for f in feats}
        assert "bin" in by_label, by_label
        f = by_label["bin"]
        # Within ~25 m of the photo fix, somewhere plausible.
        assert abs(f["lat"] - 51.5) < 0.0003, f
        assert abs(f["lon"] - (-0.125)) < 0.0003, f
        if "steps" in by_label:
            s = by_label["steps"]
            assert s["geom"] == "line" and len(s["endpoints"]) == 2, s


TESTS = [v for k, v in sorted(globals().items())
         if k.startswith("test_") and callable(v)]


def main():
    failed = 0
    for t in TESTS:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"{len(TESTS) - failed}/{len(TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

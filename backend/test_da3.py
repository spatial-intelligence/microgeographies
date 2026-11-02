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
    assert da3.sample_frame_indices(101, 1) == [0]


def _plane_scene(homogeneous=False):
    import numpy as np
    from PIL import Image
    exts = np.repeat(np.eye(4)[None], 2, axis=0)
    # Camera two moves right one metre and forward half a metre.
    exts[1, :3, 3] = [-1, 0, -0.5]
    return {"depth": [np.full((3, 5), 4.), np.full((3, 5), 3.5)],
            "conf": [np.full((3, 5), 10.), np.full((3, 5), 10.)],
            "extrinsics": exts if homogeneous else exts[:, :3],
            "intrinsics": np.repeat(np.array([[[4., 0, 2], [0, 4., 1],
                                                [0, 0, 1]]]), 2, axis=0),
            "processed": [Image.new("RGB", (5, 3), (255, 0, 0)),
                          Image.new("RGB", (5, 3), (0, 255, 0))]}


def test_backprojection_aligns_translated_views_and_pose_shapes():
    import numpy as np
    for homogeneous in (False, True):
        scene = _plane_scene(homogeneous)
        points, colors = da3.build_cloud(scene, stride=1, cap=0)
        # Both camera planes must land on the SAME world surface.
        assert len(points) == 30
        assert np.allclose(np.array(points)[:, 2], 4.)
        assert points[7] == [0., 0., 4.]
        assert points[22] == [1., 0., 4.]
        assert colors[7] == [255, 0, 0] and colors[22] == [0, 255, 0]
        cameras = da3.da3_cameras(scene, ["a", "b"])
        assert cameras[1]["tvec"] == [-1., 0., -0.5]
        assert np.allclose(da3.to_first_camera(points, scene), points)


def test_backprojection_rotated_world_and_first_camera():
    import numpy as np
    scene = _plane_scene(True)
    a = math.radians(37.)
    R = np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0],
                  [-math.sin(a), 0, math.cos(a)]])
    # Change world basis without changing either camera's observations.
    scene["extrinsics"][:, :3, :3] = R
    scene["extrinsics"][:, :3, 3] += [2., 1., 3.]
    points, _ = da3.build_cloud(scene, stride=1)
    camera_points = np.array(da3.to_first_camera(points, scene))
    assert np.allclose(camera_points[:, 2], 4., atol=.001)
    assert np.allclose(camera_points[7], [0, 0, 4], atol=.001)


def test_scene_confidence_sky_and_invalid_pixels():
    import numpy as np
    scene = _plane_scene()
    scene["conf"][1][:] = 1.  # Whole second view is unreliable.
    scene["sky"] = np.zeros((2, 3, 5), dtype=bool)
    scene["sky"][0, 0, 0] = True
    scene["depth"][0][0, 1] = np.nan
    scene["conf"][0][0, 2] = np.nan
    stats = {}
    points, _ = da3.build_cloud(scene, stride=1, conf_pct=60, diagnostics=stats)
    assert len(points) == 12
    assert stats["points_per_frame"] == [12, 0]
    assert stats["confidence_threshold"] == 10.
    scene["conf"] = None
    assert len(da3.build_cloud(scene, stride=1)[0]) == 28


def test_cloud_cap_is_exact_and_preserves_point_colors():
    scene = _plane_scene()
    points, colors = da3.build_cloud(scene, stride=1, cap=17)
    assert len(points) == len(colors) == 17
    assert (points, colors) == da3.build_cloud(scene, stride=1, cap=17)


def test_unknown_video_length_samples_through_end():
    import numpy as np
    import tempfile
    from types import SimpleNamespace
    from unittest.mock import patch

    captures = []
    class Capture:
        def __init__(self, path):
            self.index = 0
            self.released = False
            captures.append(self)
        def isOpened(self):
            return True
        def get(self, prop):
            return 10 if prop == 2 else 0
        def read(self):
            if self.index == 101:
                return False, None
            self.index += 1
            return True, np.full((3, 5, 3), 80, dtype=np.uint8)
        def release(self):
            self.released = True
    cv2 = SimpleNamespace(VideoCapture=Capture, CAP_PROP_FRAME_COUNT=1,
                          CAP_PROP_FPS=2, imwrite=lambda path, frame: True)
    with patch.dict(sys.modules, cv2=cv2), tempfile.TemporaryDirectory() as tmp:
        frames = da3.extract_frames("unknown.mp4", tmp, max_frames=5)
    assert [f["frame_index"] for f in frames] == [0, 25, 50, 75, 100]
    assert frames[-1]["time_s"] == 10.
    assert len(captures) == 2 and all(c.released for c in captures)


def test_inference_reports_device_and_preserves_prediction_contract():
    import numpy as np
    from types import SimpleNamespace
    from unittest.mock import patch

    class Device:
        type = "cuda"
        def __str__(self):
            return "cuda:0"
    scene = _plane_scene(True)
    prediction = SimpleNamespace(
        depth=np.array(scene["depth"]), conf=None,
        extrinsics=scene["extrinsics"], intrinsics=scene["intrinsics"],
        processed_images=np.array([np.array(im) for im in scene["processed"]]),
        sky=np.zeros((2, 3, 5), dtype=bool), is_metric=1)
    calls = []
    def infer(paths, **kwargs):
        calls.append((paths, kwargs))
        return prediction
    model = SimpleNamespace(parameters=lambda: iter([SimpleNamespace(device=Device())]),
                            inference=infer)
    torch = SimpleNamespace(cuda=SimpleNamespace(get_device_name=lambda dev: "Test GPU"))
    logs = []
    with _push_env(MOCK_DA3=None), patch.object(da3, "_load_da3", return_value=model):
        with patch.dict(sys.modules, torch=torch):
            result = da3.estimate_scene([{"path": "a"}, {"path": "b"}], emit=logs.append)
    assert result["device"] == "cuda:0" and result["gpu_name"] == "Test GPU"
    assert "cuda:0 (Test GPU)" in logs[0]
    assert result["conf"] is None and result["is_metric"]
    assert result["extrinsics"].shape == (2, 3, 4)
    assert calls[0][1]["ref_view_strategy"] == "first"
    assert len(da3.build_cloud(result, stride=1)[0]) == 30


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
    assert frames[0]["name"] == "frame_001.png"
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


def test_api_video_cloud_camera_diagnostics_without_codec():
    from fastapi.testclient import TestClient
    from unittest.mock import patch
    from PIL import Image
    import server

    def extracted(video_path, out_dir, max_frames, **kwargs):
        assert max_frames == 24
        frames = []
        for i in range(2):
            path = os.path.join(out_dir, f"frame_{i}.png")
            Image.new("RGB", (32, 24), (100, 50, 25)).save(path)
            frames.append({"name": f"frame_{i}.png", "path": path})
        return frames

    with _push_env(MOCK_DA3="1", MOCK_SAM="1"):
        with patch.object(da3, "extract_frames", side_effect=extracted):
            data = _post_zip(TestClient(server.app),
                             [("photo.jpg", _photo_bytes()), ("clip.mp4", b"stub")],
                             max_frames="24", max_points="1000")
    assert "error" not in data, data
    assert len(data["cameras"]) == 2
    assert len(data["cameras"][0]["qvec"]) == 4
    assert len(data["cameras"][0]["tvec"]) == 3
    assert data["diagnostics"]["device"] == "mock"
    assert data["diagnostics"]["frame_limit"] == 24
    assert data["diagnostics"]["point_limit"] == 1000
    assert data["diagnostics"]["points_before_cap"] >= data["total_points"]


def test_cross_view_cleanup_removes_inconsistent_surface_not_single_view_regions():
    import numpy as np
    from PIL import Image
    scene = _plane_scene()
    scene["extrinsics"] = np.repeat(np.eye(4)[None, :3], 3, axis=0)
    scene["depth"] = [np.full((3, 5), z) for z in (4., 4., 6.)]
    scene["conf"] = [np.full((3, 5), 10.) for _ in range(3)]
    scene["intrinsics"] = np.repeat(scene["intrinsics"][:1], 3, axis=0)
    scene["processed"].append(Image.new("RGB", (5, 3), (0, 0, 255)))
    stats = {}
    pts, colors = da3.build_cloud(scene, consistency=True, diagnostics=stats)
    assert len(pts) == 30 and np.allclose(np.array(pts)[:, 2], 4.)
    assert stats["consistency_removed"] == 15
    assert [0, 0, 255] not in colors
    # When cameras do not overlap, preserve the unique region.
    scene["extrinsics"][2, 0, 3] = -100.
    pts, _ = da3.build_cloud(scene, consistency=True)
    assert len(pts) == 45


def test_black_filter_is_optional_and_cloud_sampling_is_full_resolution():
    from PIL import Image
    scene = _plane_scene()
    scene["processed"][0] = Image.new("RGB", (5, 3), (0, 0, 0))
    assert len(da3.build_cloud(scene)[0]) == 30
    assert len(da3.build_cloud(scene, filter_black=True)[0]) == 15


def test_demo_confidence_floor_removes_unreliable_pixels():
    scene = _plane_scene()
    scene["conf"][0][:] = 1.
    scene["conf"][1][:] = 2.
    stats = {}
    pts, _ = da3.build_cloud(scene, conf_pct=0, diagnostics=stats)
    assert len(pts) == 15
    assert stats["confidence_threshold"] == 1.05


def test_title_card_filter_distinguishes_dark_surfaces_from_black_end_cards():
    import numpy as np
    title = np.zeros((100, 140, 3), dtype=np.uint8)
    title[40:50, 40:100] = 255
    assert da3.is_black_title_frame(title)
    scene = title.copy()
    scene[:40] = 80  # Exposed sky/building above a dark car/road.
    assert not da3.is_black_title_frame(scene)


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

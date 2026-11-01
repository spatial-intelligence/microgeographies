"""Unit tests for the YOLO26-depth backend alt (backend/depth.py).

Run with either backend interpreter::

    .venv/bin/python backend/test_yolo_depth.py
    .venv/bin/python -m pytest backend/test_yolo_depth.py   # if pytest exists

No model weights or network: real YOLO inference (torch + ultralytics)
is never invoked — MOCK_DEPTH=1 covers the metric pipeline, and the
HTTP test reuses the mock loop. The server-dependent tests skip
gracefully when fastapi is unavailable.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from depth import (  # noqa: E402
    box_median_depth,
    estimate_depth_grid,
    is_yolo_model_id,
    metric_to_relative,
    mock_depth_grid,
    mock_metric_grid,
    resolve_depth_backend,
)


class _push_env:
    """Temporarily set/unset env vars (restored on exit)."""

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


def test_is_yolo_model_id():
    assert is_yolo_model_id("yolo26n-depth.pt")
    assert is_yolo_model_id("yolo26x-depth.onnx")
    assert is_yolo_model_id("YOLO26s-Depth.PT")
    assert is_yolo_model_id("my-yolo-depth-custom")
    assert not is_yolo_model_id("")
    assert not is_yolo_model_id(None)
    assert not is_yolo_model_id("LiheYoung/depth-anything-small-hf")
    assert not is_yolo_model_id("depth-anything/Depth-Anything-V2-Small-hf")
    assert not is_yolo_model_id("yolo26n.pt")  # detection weights, not depth


def test_resolve_backend_explicit_wins():
    assert resolve_depth_backend("yolo26n-depth.pt", "da") == "da"
    assert resolve_depth_backend("LiheYoung/depth-anything-small-hf",
                                 "yolo") == "yolo"
    assert resolve_depth_backend(None, "yolo26") == "yolo"
    assert resolve_depth_backend(None, "depth-anything") == "da"


def test_resolve_backend_auto_routes_on_model_name():
    with _push_env(DEPTH_BACKEND=None):
        assert resolve_depth_backend("yolo26n-depth.pt", None) == "yolo"
        assert resolve_depth_backend("LiheYoung/depth-anything-small-hf",
                                     None) == "da"
        assert resolve_depth_backend(None, None) == "da"
        assert resolve_depth_backend("", "") == "da"


def test_resolve_backend_env_default():
    with _push_env(DEPTH_BACKEND="yolo"):
        assert resolve_depth_backend(None, None) == "yolo"
    with _push_env(DEPTH_BACKEND="da"):
        assert resolve_depth_backend("yolo26n-depth.pt", None) == "da"


def test_metric_to_relative_endpoints():
    rel = metric_to_relative([[1.0, 5.0], [10.0, 20.0]])
    assert rel[0][0] == 1.0, rel  # nearest -> 1
    assert rel[1][1] == 0.0, rel  # farthest -> 0
    assert rel[0][0] > rel[0][1] > rel[1][0] > rel[1][1]


def test_metric_to_relative_flat_and_invalid():
    assert metric_to_relative([[5.0, 5.0], [5.0, 5.0]]) == [
        [0.5, 0.5], [0.5, 0.5]]
    rel = metric_to_relative([[2.0, 0.0], [float("nan"), -3.0]])
    assert rel[0][0] == 0.5, rel  # single valid value -> middle
    assert all(v == 0.5 for row in rel for v in row), rel
    assert metric_to_relative([]) == []


def test_mock_metric_grid_mirrors_relative():
    rel = mock_depth_grid(8, 6)
    met = mock_metric_grid(8, 6)
    assert len(met) == 6 and len(met[0]) == 8
    assert met[0][0] > met[-1][0]  # sky far (30 m), ground near (0.5 m)
    assert abs(met[0][0] - 30.0) < 1e-9 and abs(met[-1][0] - 0.5) < 1e-9
    back = metric_to_relative(met)
    for r in range(6):
        for c in range(8):
            assert abs(back[r][c] - rel[r][c]) < 1e-3, (r, c)


def test_mock_estimate_yolo_carries_metric():
    from PIL import Image
    with _push_env(MOCK_DEPTH="1", DEPTH_BACKEND=None):
        out = estimate_depth_grid(Image.new("RGB", (80, 40)),
                                  backend="yolo")
        assert out["mock"] is True and out["backend"] == "yolo"
        assert out["model"] == "yolo26n-depth.pt", out["model"]
        assert "metric_grid" in out
        assert len(out["metric_grid"]) == 60
        assert len(out["metric_grid"][0]) == 80
        auto = estimate_depth_grid(Image.new("RGB", (80, 40)),
                                   model_id="yolo26n-depth.pt")
        assert auto["backend"] == "yolo" and "metric_grid" in auto


def test_mock_estimate_da_unchanged():
    from PIL import Image
    with _push_env(MOCK_DEPTH="1", DEPTH_BACKEND=None):
        out = estimate_depth_grid(Image.new("RGB", (80, 40)))
        assert out["backend"] == "da", out
        assert "metric_grid" not in out
        assert out["model"] == "LiheYoung/depth-anything-small-hf"


def test_box_median_works_on_metric_grid():
    met = [[5.0] * 10 for _ in range(10)]
    for r in range(5, 10):
        for c in range(10):
            met[r][c] = 25.0
    assert box_median_depth(met, [0, 0, 100, 40], 100, 100) == 5.0
    assert box_median_depth(met, [0, 60, 100, 100], 100, 100) == 25.0


def _server_or_skip():
    try:
        from fastapi.testclient import TestClient  # noqa: F401
        import server  # noqa: F401
    except ImportError:
        return None
    import server
    return server


def test_project_boxes_uses_metric_when_present():
    server = _server_or_skip()
    if server is None:
        print("SKIP test_project_boxes_uses_metric_when_present (no fastapi)")
        return
    from PIL import Image
    pil = Image.new("RGB", (100, 100))
    rel = [[0.5] * 10 for _ in range(10)]  # would map to ~15 m
    met = [[5.0] * 10 for _ in range(10)]  # metric says 5 m
    dets = server.project_boxes(
        pil, [{"label": "bin", "box": [10, 10, 90, 90]}],
        {"lat": 51.5, "lon": -0.125}, "90", "60", "30",
        grid=rel, metric_grid=met)
    g = dets[0]["geo"]
    assert g["range_source"] == "metric", g
    assert abs(g["distance_m"] - 5.0) < 1e-9, g
    assert abs(g["depth_m_raw"] - 5.0) < 1e-9, g


def test_project_boxes_caps_metric_at_max_range():
    server = _server_or_skip()
    if server is None:
        print("SKIP test_project_boxes_caps_metric_at_max_range (no fastapi)")
        return
    from PIL import Image
    pil = Image.new("RGB", (100, 100))
    rel = [[0.1] * 10 for _ in range(10)]
    met = [[99.0] * 10 for _ in range(10)]
    dets = server.project_boxes(
        pil, [{"label": "bin", "box": [10, 10, 90, 90]}],
        {"lat": 51.5, "lon": -0.125}, "90", "60", "10",
        grid=rel, metric_grid=met)
    g = dets[0]["geo"]
    assert g["distance_m"] == 10.0, g  # capped ...
    assert g["depth_m_raw"] == 99.0, g  # ... but raw kept
    assert g["range_source"] == "metric"


def test_project_boxes_relative_path_unchanged():
    server = _server_or_skip()
    if server is None:
        print("SKIP test_project_boxes_relative_path_unchanged (no fastapi)")
        return
    from PIL import Image
    pil = Image.new("RGB", (100, 100))
    rel = [[1.0] * 10 for _ in range(10)]  # nearest -> min range
    dets = server.project_boxes(
        pil, [{"label": "bin", "box": [10, 10, 90, 90]}],
        {"lat": 51.5, "lon": -0.125}, "90", "60", "30", grid=rel)
    g = dets[0]["geo"]
    assert g["range_source"] == "relative", g
    assert abs(g["distance_m"] - 0.5) < 1e-9, g
    assert "depth_m_raw" not in g, g


def test_api_depth_yolo_mock_returns_metric():
    try:
        import io
        from PIL import Image
        from fastapi.testclient import TestClient
        import server
    except ImportError:
        print("SKIP test_api_depth_yolo_mock_returns_metric (no fastapi)")
        return
    with _push_env(MOCK_DEPTH="1", DEPTH_BACKEND=None):
        c = TestClient(server.app)
        buf = io.BytesIO()
        Image.new("RGB", (80, 40)).save(buf, "JPEG")
        data = buf.getvalue()
        r = c.post("/api/depth",
                   files={"image": ("t.jpg", data, "image/jpeg")},
                   data={"depth_backend": "yolo"})
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["depth_backend"] == "yolo", j
        assert "metric_grid" in j, sorted(j)
        assert j["metric_min_m"] < j["metric_max_m"]
        r2 = c.post("/api/depth",
                    files={"image": ("t.jpg", data, "image/jpeg")})
        j2 = r2.json()
        assert j2["depth_backend"] == "da", j2
        assert "metric_grid" not in j2, sorted(j2)


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

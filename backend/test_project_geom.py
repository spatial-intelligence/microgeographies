"""Unit tests for prompt geometry (points vs lines) in backend/server.py.

Run with either backend interpreter::

    .venv/bin/python backend/test_project_geom.py
    .venv/bin/python -m pytest backend/test_project_geom.py   # if pytest exists

No model weights or network: project_boxes runs on synthetic grids, and
the HTTP test reuses the mock loop. Server-dependent tests skip
gracefully when fastapi is unavailable.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _server_or_skip(name):
    try:
        from fastapi.testclient import TestClient  # noqa: F401
        import server  # noqa: F401
    except ImportError:
        print(f"SKIP {name} (no fastapi)")
        return None
    import server
    return server


def test_split_geom_suffixes():
    server = _server_or_skip("test_split_geom_suffixes")
    if server is None:
        return
    assert server.split_geom("steps |line") == ("steps", "line")
    assert server.split_geom("steps|lines") == ("steps", "line")
    assert server.split_geom("Steps | Line ") == ("Steps", "line")
    assert server.split_geom("bins") == ("bins", "point")
    assert server.split_geom("door |point") == ("door", "point")
    assert server.split_geom("wall |banana") == ("wall |banana", "point")
    assert server.split_geom("") == ("", "point")


def test_concepts_and_geoms_merge():
    server = _server_or_skip("test_concepts_and_geoms_merge")
    if server is None:
        return
    names, geoms = server.concepts_and_geoms("door, steps |line",
                                             '{"door": "line"}')
    assert names == ["door", "steps"], names  # prompts stay clean
    assert geoms == {"steps": "line", "door": "line"}, geoms
    names, geoms = server.concepts_and_geoms('["a |line"]', "not json")
    assert (names, geoms) == (["a"], {"a": "line"})
    names, geoms = server.concepts_and_geoms("", "")
    assert (names, geoms) == ([], {})


def test_project_boxes_line_endpoints():
    server = _server_or_skip("test_project_boxes_line_endpoints")
    if server is None:
        return
    from PIL import Image
    pil = Image.new("RGB", (100, 100))
    rel = [[0.5] * 10 for _ in range(10)]
    dets = server.project_boxes(
        pil, [{"label": "steps", "box": [10, 40, 90, 60]}],
        {"lat": 51.5, "lon": -0.125}, "90", "60", "30",
        grid=rel, geoms={"steps": "line"})
    d = dets[0]
    assert d["geom"] == "line", d
    ends = d["geo"]["endpoints"]
    assert len(ends) == 2, d["geo"]
    assert ends[0]["lon"] != ends[1]["lon"], ends  # spans the box width
    assert abs(ends[0]["lat"] - ends[1]["lat"]) < 0.001, ends


def test_project_boxes_point_default():
    server = _server_or_skip("test_project_boxes_point_default")
    if server is None:
        return
    from PIL import Image
    pil = Image.new("RGB", (100, 100))
    rel = [[0.5] * 10 for _ in range(10)]
    dets = server.project_boxes(
        pil, [{"label": "bin", "box": [10, 10, 90, 90]}],
        {"lat": 51.5, "lon": -0.125}, "90", "60", "30", grid=rel)
    assert dets[0]["geom"] == "point", dets[0]
    assert "endpoints" not in dets[0]["geo"], dets[0]["geo"]


def test_api_project_geoms_param():
    try:
        import io
        import json
        from PIL import Image
        from fastapi.testclient import TestClient
        import server
    except ImportError:
        print("SKIP test_api_project_geoms_param (no fastapi)")
        return
    old = os.environ.get("MOCK_DEPTH")
    os.environ["MOCK_DEPTH"] = "1"
    try:
        c = TestClient(server.app)
        buf = io.BytesIO()
        Image.new("RGB", (400, 300)).save(buf, "JPEG")
        r = c.post("/api/project",
                   files={"image": ("t.jpg", buf.getvalue(),
                                    "image/jpeg")},
                   data={"boxes": json.dumps([
                       {"box": [50, 100, 350, 200], "label": "steps"},
                       {"box": [50, 100, 350, 200], "label": "bin"}]),
                         "lat": "51.5", "lon": "-0.125", "heading": "90",
                         "geoms": '{"steps": "line"}'})
        assert r.status_code == 200, r.text
        body = r.json()
        by_label = {d["label"]: d for d in body["detections"]}
        assert by_label["steps"]["geom"] == "line", by_label
        assert len(by_label["steps"]["geo"]["endpoints"]) == 2
        assert by_label["bin"]["geom"] == "point", by_label
        assert isinstance(body["depth_grid"], list) and len(body["depth_grid"]) > 0
    finally:
        if old is None:
            os.environ.pop("MOCK_DEPTH", None)
        else:
            os.environ["MOCK_DEPTH"] = old


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

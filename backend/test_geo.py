"""Unit tests for backend/depth.py — stdlib only (+Pillow for EXIF stubs).

Run with either backend interpreter::

    .venv/bin/python backend/test_geo.py        # no pytest needed
    .venv/bin/python -m pytest backend/test_geo.py   # if pytest exists
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from depth import (  # noqa: E402
    SNAP_LABELS,
    box_center_frac,
    box_median_depth,
    destination_point,
    extract_exif_gps,
    haversine_m,
    mock_depth_grid,
    nearest_point_on_polygon,
    pixel_to_bearing,
    project_detection,
    relative_to_metric,
    resolve_location,
)


def test_destination_100m_north():
    lat, lon = destination_point(51.0, 0.0, 0.0, 100.0)
    assert abs(lat - 51.0008993) < 1e-4, lat
    assert abs(lon - 0.0) < 1e-9, lon
    assert abs(haversine_m(51.0, 0.0, lat, lon) - 100.0) < 0.5


def test_destination_east():
    lat, lon = destination_point(51.0, 0.0, 90.0, 100.0)
    assert abs(lat - 51.0) < 1e-6, lat
    assert abs(haversine_m(51.0, 0.0, lat, lon) - 100.0) < 0.5


def test_bearing_center_equals_heading():
    assert pixel_to_bearing(0.5, 123.0) == 123.0


def test_bearing_edges_symmetric():
    left = pixel_to_bearing(0.0, 0.0, 60.0)
    right = pixel_to_bearing(1.0, 0.0, 60.0)
    assert abs(left - 330.0) < 0.01, left   # -30 deg wrapped
    assert abs(right - 30.0) < 0.01, right
    assert abs((right - 0.0) + (left - 360.0)) < 0.01  # symmetric


def test_metric_endpoints():
    assert relative_to_metric(1.0, 30.0, 0.5) == 0.5    # nearest
    assert relative_to_metric(0.0, 30.0, 0.5) == 30.0   # farthest
    mid = relative_to_metric(0.5, 30.0, 0.5)
    assert abs(mid - 15.25) < 1e-9, mid
    assert relative_to_metric(99.0) == relative_to_metric(1.0)  # clamped


def test_box_center_frac():
    cx, cy = box_center_frac([10, 20, 30, 60], 100, 100)
    assert (cx, cy) == (0.2, 0.4)


def test_box_median_robust_to_edge():
    grid = [[0.1] * 10 for _ in range(10)]
    for r in range(5, 10):  # near half at bottom
        for c in range(10):
            grid[r][c] = 0.9
    med = box_median_depth(grid, [0, 0, 100, 100], 100, 100)
    assert abs(med - 0.5) < 1e-9, med  # even split -> middle of the two halves
    med_top = box_median_depth(grid, [0, 0, 100, 40], 100, 100)
    assert abs(med_top - 0.1) < 1e-9, med_top
    med_bottom = box_median_depth(grid, [0, 60, 100, 100], 100, 100)
    assert abs(med_bottom - 0.9) < 1e-9, med_bottom


def test_project_detection_roundtrip():
    g = project_detection(51.0, -0.1, 0.0, [40, 0, 60, 100], 100, 100,
                          depth_m=10.0, hfov_deg=60.0)
    assert g["bearing_deg"] == 0.0
    assert g["distance_m"] == 10.0
    assert abs(haversine_m(51.0, -0.1, g["lat"], g["lon"]) - 10.0) < 0.2


def test_project_pixel_center():
    g = project_detection(0.0, 0.0, 0.0, [40, 20, 60, 80], 100, 100,
                          depth_m=10.0)
    assert g["pixel"] == {"x": 50, "y": 50}, g["pixel"]


def test_project_enu_due_east_level():
    # Box centred horizontally and vertically, heading east: all range
    # goes into +x, z ~ 0 for a level ray.
    g = project_detection(0.0, 0.0, 90.0, [40, 40, 60, 60], 100, 100,
                          depth_m=10.0)
    assert abs(g["enu_m"]["x"] - 10.0) < 0.01, g["enu_m"]
    assert abs(g["enu_m"]["y"]) < 0.01, g["enu_m"]
    assert abs(g["enu_m"]["z"]) < 0.01, g["enu_m"]


def test_project_enu_below_horizon_is_negative_z():
    # Box centre in the lower half looks downward -> z below the camera.
    g = project_detection(0.0, 0.0, 0.0, [40, 70, 60, 90], 100, 100,
                          depth_m=10.0)
    assert g["enu_m"]["z"] < -0.5, g["enu_m"]
    # Horizontal range shrinks accordingly: x^2 + y^2 + z^2 == d^2.
    e = g["enu_m"]
    assert abs(math.hypot(e["x"], e["y"], e["z"]) - 10.0) < 0.01, e


def test_turbo_endpoints():
    from depth import _turbo_rgb
    far = _turbo_rgb(0.2)   # blue zone
    near = _turbo_rgb(0.9)  # red zone
    assert far[2] > far[0] and near[0] > near[2], (far, near)


def test_depth_data_url_png():
    from depth import depth_data_url
    try:
        from PIL import Image  # noqa: F401
    except ImportError:
        return  # visualization optional without Pillow
    import base64
    import io as _io
    url = depth_data_url(mock_depth_grid(8, 6), out_w=48)
    assert url.startswith("data:image/png;base64,"), url[:30]
    raw = base64.b64decode(url.split(",", 1)[1])
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    im = Image.open(_io.BytesIO(raw))
    assert im.size == (48, 36), im.size
    assert depth_data_url([]) is None


class _FakeExif(dict):
    def __init__(self, gps):
        super().__init__({271: "FakeMake"})  # non-empty: real Exif is truthy
        self._gps = gps

    def get_ifd(self, _tag):
        return self._gps


class _FakeImg:
    def __init__(self, gps):
        self._gps = gps

    def getexif(self):
        return _FakeExif(self._gps) if self._gps is not None else {}


def _gps_ifd(lat_ref, lat, lon_ref, lon):
    return {1: lat_ref, 2: lat, 3: lon_ref, 4: lon}


def test_exif_gps_london():
    gps = _gps_ifd("N", (51, 30, 0), "W", (0, 7, 30))
    out = extract_exif_gps(_FakeImg(gps))
    assert out is not None
    assert abs(out["lat"] - 51.5) < 1e-6, out
    assert abs(out["lon"] - (-0.125)) < 1e-6, out


def test_exif_south_real_rational_shape():
    class R:
        def __init__(self, n, d):
            self.numerator, self.denominator = n, d

    gps = {1: "S", 2: (R(33, 1), R(51, 1), R(0, 1)),
           3: "E", 4: (R(151, 1), R(12, 1), R(0, 1))}
    out = extract_exif_gps(_FakeImg(gps))
    assert out is not None
    assert abs(out["lat"] - (-33.85)) < 1e-6, out
    assert abs(out["lon"] - 151.2) < 1e-6, out


def test_exif_missing_is_none():
    assert extract_exif_gps(_FakeImg(None)) is None
    assert extract_exif_gps(_FakeImg({})) is None


def test_resolve_location_priority():
    # The photo's own EXIF beats wherever this computer is now.
    img = _FakeImg(_gps_ifd("N", (51, 30, 0), "E", (0, 0, 0)))
    loc, src = resolve_location("52.0", "1.0", img)
    assert src == "exif" and abs(loc["lat"] - 51.5) < 1e-6, (loc, src)
    loc, src = resolve_location("52.0", "1.0", _FakeImg(None))
    assert (loc, src) == ({"lat": 52.0, "lon": 1.0}, "live")
    loc, src = resolve_location("", "", _FakeImg(None))
    assert (loc, src) == (None, "none")


def test_exif_heading_true_north():
    from depth import extract_exif_heading
    img = _FakeImg({0x0010: "T", 0x0011: (123, 1)})
    assert extract_exif_heading(img) == 123.0


def test_exif_heading_magnetic_ignored():
    from depth import extract_exif_heading
    img = _FakeImg({0x0010: "M", 0x0011: (123, 1)})
    assert extract_exif_heading(img) is None
    assert extract_exif_heading(_FakeImg(None)) is None


def test_resolve_heading_priority():
    from depth import resolve_heading
    img = _FakeImg({0x0010: "T", 0x0011: (123, 1)})
    # Deliberate manual heading beats the photo's own direction.
    assert resolve_heading("90", img) == (90.0, "manual")
    assert resolve_heading("", img) == (123.0, "exif")
    assert resolve_heading("", _FakeImg(None)) == (None, "none")


def test_mock_grid_shape_and_direction():
    g = mock_depth_grid(80, 60)
    assert len(g) == 60 and len(g[0]) == 80
    assert g[0][0] < g[-1][0]  # top far (0), bottom near (1)


def test_nearest_point_on_square():
    ring = [(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)]  # 1x1 deg square
    plat, plon, d = nearest_point_on_polygon(0.5, -0.5, ring)
    assert abs(plat - 0.5) < 1e-9 and abs(plon - 0.0) < 1e-9, (plat, plon)
    assert abs(d - haversine_m(0.5, -0.5, 0.5, 0.0)) < 1.0, d


def test_snap_labels_cover_brief():
    for label in ("door", "window", "bin", "step"):
        if label in ("door", "window"):
            assert label in SNAP_LABELS
        else:
            assert label not in SNAP_LABELS  # bins/steps keep raw projection


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

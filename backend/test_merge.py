"""Unit tests for backend/merge.py — Pillow only, no model, no network.

Run: .venv/bin/python backend/test_merge.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw  # noqa: E402

from merge import (  # noqa: E402
    box_iou,
    cluster,
    cosine,
    crop_vector,
    dedupe_same_image,
)


def striped(offset=0):
    im = Image.new("RGB", (100, 100), "white")
    d = ImageDraw.Draw(im)
    for x in range(0, 100, 10):
        d.rectangle([x + offset, 0, x + 4 + offset, 100], fill="black")
    return im


def test_iou():
    assert box_iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert box_iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0
    assert abs(box_iou([0, 0, 10, 10], [5, 0, 15, 10]) - 1 / 3) < 1e-9


def test_dedupe_keeps_best_score():
    dets = [
        {"label": "bin", "box": [0, 0, 50, 50], "score": 0.4},
        {"label": "bin", "box": [5, 5, 55, 55], "score": 0.9},
        {"label": "door", "box": [5, 5, 55, 55], "score": 0.9},
    ]
    out = dedupe_same_image(dets)
    assert len(out) == 2, out
    assert [d for d in out if d["label"] == "bin"][0]["score"] == 0.9


def test_crop_similarity_same_vs_different():
    a = striped(0)
    v1 = crop_vector(a, [0, 0, 100, 100])
    v2 = crop_vector(a, [0, 0, 100, 100])
    assert cosine(v1, v2) > 0.99
    b = Image.new("RGB", (100, 100), (200, 30, 30))
    v3 = crop_vector(b, [0, 0, 100, 100])
    assert cosine(v1, v3) < 0.5, cosine(v1, v3)
    flat = Image.new("RGB", (100, 100), "gray")
    assert crop_vector(flat, [0, 0, 100, 100]) is None  # abstains
    assert cosine(None, v1) == 0.0


def rec(label, lat, lon, img, vec):
    return {"label": label, "lat": lat, "lon": lon, "image": img,
            "vec": vec, "detail": {}}


def test_cluster_merges_repeat():
    v = [1.0, 0.0, 0.0]
    rs = [rec("bin", 51.0, 0.0, "a.jpg", v),
          rec("bin", 51.00002, 0.00002, "b.jpg", v)]  # ~3 m apart
    cs = cluster(rs, radius_m=8.0, sim_min=0.75)
    assert len(cs) == 1 and cs[0]["count"] == 2, cs


def test_cluster_keeps_distinct_neighbours():
    v = [1.0, 0.0, 0.0]
    w = [0.0, 1.0, 0.0]
    rs = [rec("bin", 51.0, 0.0, "a.jpg", v),
          rec("bin", 51.00002, 0.00002, "b.jpg", w)]  # close, looks different
    cs = cluster(rs, radius_m=8.0, sim_min=0.75)
    assert len(cs) == 2, cs
    far = [rec("bin", 51.0, 0.0, "a.jpg", v),
           rec("bin", 51.01, 0.01, "b.jpg", v)]  # ~1.3 km apart
    assert len(cluster(far)) == 2
    other = [rec("bin", 51.0, 0.0, "a.jpg", v),
             rec("door", 51.0, 0.0, "a.jpg", v)]  # different labels
    assert len(cluster(other)) == 2


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

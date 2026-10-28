"""Unit tests for backend/clip_detect.py — no weights (injected scorer).

Run: .venv/bin/python backend/test_clip.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image  # noqa: E402

from clip_detect import (  # noqa: E402
    detect_clip,
    pick_boxes,
    propose_windows,
)


def test_proposals_cover_and_fit():
    ws = propose_windows(400, 300)
    assert len(ws) > 50, len(ws)
    assert all(0 <= x1 < x2 <= 400 and 0 <= y1 < y2 <= 300 for x1, y1, x2, y2 in ws)
    xs = [x1 for x1, _, _, _ in ws] + [x2 for _, _, x2, _ in ws]
    assert min(xs) == 0 and max(xs) == 400  # edge to edge


def test_pick_threshold_topk_nms():
    boxes = [[0, 0, 100, 100], [10, 10, 110, 110], [200, 200, 300, 300]]
    sims = [[0.9, 0.1], [0.8, 0.1], [0.3, 0.95]]
    out = pick_boxes(boxes, sims, ["a", "b"], score_min=0.5, top_k=5)
    labels = [(d["label"], d["score"]) for d in out]
    # first two overlap (NMS) -> only 0.9 kept for "a"; "b" keeps third
    assert labels == [("a", 0.9), ("b", 0.95)], labels
    out2 = pick_boxes(boxes, sims, ["a"], score_min=0.85, top_k=1)
    assert len(out2) == 1 and out2[0]["score"] == 0.9


def test_detect_clip_uses_scorer():
    img = Image.new("RGB", (200, 150), "white")
    calls = []

    def scorer(crops, concepts):
        calls.append((len(crops), list(concepts)))
        return [[0.99 if i == 0 else 0.0 for _ in concepts]
                for i in range(len(crops))]

    dets = detect_clip(img, ["door"], scorer=scorer, score_min=0.5)
    assert calls and calls[0][1] == ["door"]
    assert len(dets) == 1 and dets[0]["label"] == "door", dets
    assert dets[0]["box"][2] <= 200 and dets[0]["box"][3] <= 150


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

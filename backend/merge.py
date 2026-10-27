"""Cross-photo feature merging for batch captures.

Two detections of the same label merge into one map feature only when
both gates pass:

1. **Spatial gate** — haversine distance under ``radius_m`` (default 8 m,
   i.e. plausible GPS + depth error, not a genuinely separate neighbour).
2. **Visual gate** — normalized cross-correlation of the two box crops
   (32×32 grayscale) at or above ``sim_min`` (default 0.75), so two
   different bins standing near each other stay separate.

Same-image duplicates (overlapping SAM boxes) are deduped first by IoU.
Stdlib + Pillow only.
"""

import math

import depth as geo

CROP_SIZE = 32


def box_iou(a, b):
    """Intersection-over-union of two xyxy boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area = max(0.0, (a[2] - a[0]) * (a[3] - a[1]))
    area_b = max(0.0, (b[2] - b[0]) * (b[3] - b[1]))
    union = area + area_b - inter
    return inter / union if union > 0 else 0.0


def dedupe_same_image(dets, iou_min=0.5):
    """Drop same-label overlaps, keeping the higher score (first on ties)."""
    kept = []
    for d in dets:
        dup = False
        for k in kept:
            if (str(k.get("label", "")).lower()
                    != str(d.get("label", "")).lower()):
                continue
            if box_iou(k["box"], d["box"]) < iou_min:
                continue
            ks = k.get("score")
            ds = d.get("score")
            if ds is not None and (ks is None or ds > ks):
                kept[kept.index(k)] = d
            dup = True
            break
        if not dup:
            kept.append(d)
    return kept


def crop_vector(pil_image, box, size=CROP_SIZE):
    """Zero-mean, unit-norm grayscale vector of a box crop.

    Returns ``None`` when the crop is degenerate (empty or perfectly
    flat — similarity abstains instead of guessing).
    """
    try:
        w, h = pil_image.size
        x1, y1, x2, y2 = [int(round(v)) for v in box]
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        if x2 - x1 < 4 or y2 - y1 < 4:
            return None
        crop = pil_image.crop((x1, y1, x2, y2)).convert("L").resize((size, size))
        vals = [float(v) for v in crop.getdata()]
        mean = sum(vals) / len(vals)
        centered = [v - mean for v in vals]
        norm = math.sqrt(sum(v * v for v in centered))
        if norm < 1e-6:
            return None
        return [v / norm for v in centered]
    except Exception:
        return None


def cosine(u, v):
    """Cosine similarity; 0.0 when either side abstained (None)."""
    if u is None or v is None:
        return 0.0
    return max(-1.0, min(1.0, sum(a * b for a, b in zip(u, v))))


def cluster(records, radius_m=8.0, sim_min=0.75):
    """Group per-image projected detections into shared map features.

    ``records``: ``{label, lat, lon, image, vec, detail}`` with ``vec``
    from :func:`crop_vector` (or ``None``). Returns cluster list
    ``{label, lat, lon, count, members}`` with centroid means.
    Greedy single-link against the cluster seed: a record joins when it
    shares the label, sits within ``radius_m`` of the seed, and looks
    like it (``cosine >= sim_min``).
    """
    clusters = []
    for r in records:
        placed = False
        for c in clusters:
            if c["label"].lower() != str(r["label"]).lower():
                continue
            if geo.haversine_m(c["lat"], c["lon"], r["lat"], r["lon"]) > radius_m:
                continue
            if cosine(c["vec"], r["vec"]) < sim_min:
                continue
            c["members"].append(r)
            n = len(c["members"])
            c["lat"] = sum(m["lat"] for m in c["members"]) / n
            c["lon"] = sum(m["lon"] for m in c["members"]) / n
            placed = True
            break
        if not placed:
            clusters.append({"label": r["label"], "lat": r["lat"], "lon": r["lon"],
                             "vec": r["vec"], "members": [r]})
    for c in clusters:
        c["count"] = len(c["members"])
        del c["vec"]
    return clusters


def merged_feature_collection(clusters):
    """Clusters as a GeoJSON FeatureCollection of mean-position pins."""
    feats = []
    for c in clusters:
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [c["lon"], c["lat"]]},
            "properties": {
                "label": c["label"],
                "count": c["count"],
                "merged_from": [
                    {"image": m["image"], "lat": m["lat"], "lon": m["lon"],
                     "distance_m": m["detail"].get("distance_m"),
                     "bearing_deg": m["detail"].get("bearing_deg")}
                    for m in c["members"]
                ],
            },
        })
    return {"type": "FeatureCollection", "features": feats}

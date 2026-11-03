"""GPS-to-reconstruction similarity fits. Geometry stays in its native frame."""
import itertools
import math

EARTH_R = 6371000.0


def fit_photo_gps(cameras, locations):
    """Robustly fit local camera centres to EXIF ENU metres using Umeyama.

    Three non-collinear registered GPS photos are the minimum. Missing
    altitudes assume a level camera path; this is reported in the result.
    Stationary, collinear or inconsistent GPS never produces a map overlay.
    """
    import numpy as np
    from sfm import qvec_to_rotmat
    pairs = []
    for camera in cameras:
        name = camera.get("image", "")
        gps = locations.get(name) or locations.get(name.split("/")[-1])
        if not gps or not all(math.isfinite(gps.get(k, float("nan"))) for k in ("lat", "lon")):
            continue
        if abs(gps["lat"]) > 85 or abs(gps["lon"]) > 180:
            continue
        r = np.asarray(qvec_to_rotmat(camera["qvec"]))
        center = -r.T @ np.asarray(camera["tvec"])
        if np.isfinite(center).all():
            pairs.append((name, center, gps))
    failure = {"available": False, "reason": "Map alignment needs at least three registered photos with distinct, non-collinear EXIF GPS positions."}
    if len(pairs) < 3:
        return failure
    lat0 = float(np.mean([p[2]["lat"] for p in pairs]))
    lon0 = float(np.mean([p[2]["lon"] for p in pairs]))
    has_altitude = all(math.isfinite(p[2].get("altitude_m", float("nan"))) for p in pairs)
    altitude = float(np.mean([p[2]["altitude_m"] for p in pairs])) if has_altitude else 0.
    x = np.array([p[1] for p in pairs])
    y = np.array([[math.radians(p[2]["lon"]-lon0)*EARTH_R*math.cos(math.radians(lat0)),
                   math.radians(p[2]["lat"]-lat0)*EARTH_R,
                   p[2]["altitude_m"]-altitude if has_altitude else 0.] for p in pairs])
    def fit(ids):
        a, b = x[ids], y[ids]
        ac, bc = a-a.mean(0), b-b.mean(0)
        sa, sb = np.linalg.svd(ac, compute_uv=False), np.linalg.svd(bc, compute_uv=False)
        if sa[0] < 1e-8 or sa[1] < sa[0]*.02 or sb[0] < 2 or sb[1] < max(.5, sb[0]*.02):
            return None
        u, d, vt = np.linalg.svd(bc.T @ ac / len(ids))
        sign = np.ones(3); sign[-1] = np.linalg.det(u @ vt)
        rotation = (u*sign) @ vt
        scale = float(np.sum(d*sign)/(np.sum(ac*ac)/len(ids)))
        translation = b.mean(0)-scale*rotation@a.mean(0)
        if not math.isfinite(scale) or scale <= 0:
            return None
        return scale, rotation, translation
    # Deterministic bounded RANSAC, including a fit over every observation.
    samples = [list(range(len(pairs)))]
    combinations = list(itertools.combinations(range(len(pairs)), 3))
    step = max(1, math.ceil(len(combinations)/128))
    samples.extend([list(c) for c in combinations[::step]])
    threshold = max(2., min(8., float(np.ptp(y[:, :2], axis=0).max())*.1))
    best = None
    for ids in samples:
        candidate = fit(ids)
        if candidate is None:
            continue
        scale, rotation, translation = candidate
        errors = np.linalg.norm(x @ rotation.T*scale+translation-y, axis=1)
        inliers = np.flatnonzero(errors <= threshold)
        if len(inliers) < max(3, math.ceil(len(pairs)*.6)):
            continue
        score = (len(inliers), -float(np.mean(errors[inliers])))
        if best is None or score > best[0]:
            best = (score, inliers)
    if best is None:
        return {**failure, "reason": "GPS positions are stationary, collinear or inconsistent with the reconstructed cameras; the cloud remains in local coordinates."}
    ids = best[1]; result = fit(ids)
    if result is None:
        return failure
    scale, rotation, translation = result
    errors = np.linalg.norm(x[ids] @ rotation.T*scale+translation-y[ids], axis=1)
    if float(errors.max()) > threshold:
        return {**failure, "reason": "GPS fit residuals are too large for a map overlay."}
    return {"available": True, "origin": {"lat": lat0, "lon": lon0, "altitude_m": altitude},
            "matrix": (rotation*scale).tolist(), "translation": translation.tolist(),
            "scale_m_per_unit": scale, "rms_m": float(np.sqrt(np.mean(errors**2))),
            "photos_used": [pairs[i][0] for i in ids], "photos_rejected": len(pairs)-len(ids),
            "method": "EXIF GPS similarity fit", "altitude_assumed_level": not has_altitude}


def video_reference(scene, location, heading):
    """Metric world -> first camera -> ENU, assuming a level first view."""
    import numpy as np
    if not location or heading is None or not scene.get("is_metric") or abs(location["lat"]) > 85:
        return {"available": False, "reason": "Map overlay needs photo EXIF GPS, true-north heading and metric DA3 depth."}
    h = math.radians(heading)
    enu = np.array([[math.cos(h), 0, math.sin(h)], [-math.sin(h), 0, math.cos(h)], [0, -1, 0]])
    pose = np.asarray(scene["extrinsics"][0])[:3, :4]
    return {"available": True, "origin": {**location, "altitude_m": location.get("altitude_m", 0)},
            "matrix": (enu @ pose[:, :3]).tolist(), "translation": (enu @ pose[:, 3]).tolist(),
            "scale_m_per_unit": 1., "method": "Metric DA3 + photo GPS and heading; first view assumed level",
            "altitude_assumed_level": True}

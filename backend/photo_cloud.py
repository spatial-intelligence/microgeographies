"""DA3 photo-set reconstruction using the same response contract as COLMAP."""
import os

MODELS = {"da3-small": "depth-anything/DA3-SMALL",
          "da3-giant": "depth-anything/DA3-GIANT-1.1"}


def reconstruct(engine, image_dir, images, locations, thumbnails, orientations,
                concepts, label_objects, detector, token, detect, emit,
                warnings=None, detections=None, force_cpu=False):
    import da3
    import sfm
    import numpy as np
    from PIL import Image
    from georeference import fit_photo_gps

    warnings = list(warnings or [])
    names = sorted(images)
    frames = [{"name": name, "path": os.path.join(image_dir, name)} for name in names]
    emit(f"Running {MODELS[engine]} on {len(frames)} photos")
    scene = da3.estimate_scene(frames, model_id=MODELS[engine], force_cpu=force_cpu, emit=emit)
    diagnostics = {}
    points, colors = da3.build_cloud(scene, diagnostics=diagnostics, consistency=True)
    if not points:
        raise RuntimeError("DA3 returned no usable geometry; try more overlapping photos")
    cameras = da3.da3_cameras(scene, names)
    # Detectors receive the full upright image copies. Convert processed-image
    # intrinsics back to that pixel frame before projection/voting.
    for camera in cameras:
        width, height = images[camera["image"]].size
        sx, sy = width/camera["width"], height/camera["height"]
        fx, fy, cx, cy = camera["params"][:4]
        camera.update(width=width, height=height, params=[fx*sx, fy*sy, cx*sx, cy*sy])
    georeference = fit_photo_gps(cameras, locations)
    if not scene.get("is_metric") and not georeference["available"]:
        warnings.append("DA3 Small/Giant has relative scale. A reliable multi-photo EXIF GPS fit is required for geographic features.")
    dets = dict(detections or {}) if label_objects else {}
    if label_objects and concepts:
        emit("Labelling copies of source photos after reconstruction")
        auto, errors = detect({name: image.copy() for name, image in images.items() if name not in dets},
                              concepts, detector, **({"api_token": token} if detector == "api" else {}))
        dets.update(auto or {})
        warnings.extend(str(error) for error in errors)
        if detector == "sam" and os.environ.get("MOCK_SAM") == "1":
            warnings.append("MOCK_SAM is enabled: object labels are demonstration boxes.")
    labels = sfm.vote_point_labels_numpy(points, cameras, dets) if dets else {}
    diagnostics.update(input_images=len(names), device=scene.get("device", "mock"),
                       model=scene.get("model", MODELS[engine]), camera_count=len(cameras))
    source_frames = []
    for i, name in enumerate(names):
        if name not in thumbnails:
            continue
        depth = Image.fromarray(np.asarray(scene["depth"][i], dtype=np.float32))
        depth = np.asarray(depth.resize((32, 32), Image.Resampling.NEAREST))
        depth = np.where(np.isfinite(depth) & (depth > 0), np.round(depth, 3), 0)
        source_frames.append({"image": name, "url": thumbnails[name],
                              "depth": depth.ravel().tolist()})
    return {"ply": sfm.write_ply_ascii(points, colors), "point_count": len(points),
            "total_points": len(points), "cameras": cameras,
            "registered": names, "unregistered": [], "photo_locations": locations,
            "georeference": georeference, "coordinate_frame": "local-sfm",
            "point_labels": {str(k): value for k, value in labels.items()},
            "label_objects": label_objects, "colmap_inputs_annotated": False,
            "detections": dets, "thumbnails": thumbnails, "orientations": orientations,
            "source_frames": source_frames,
            "image_sizes": {name: list(image.size) for name, image in images.items()},
            "dense_ply": None, "dense_labels": {}, "warnings": warnings,
            "diagnostics": diagnostics, "gpu_used": str(scene.get("device", "")).startswith("cuda"),
            "engine": engine, "model": scene.get("model", MODELS[engine]),
            "mock": bool(scene.get("mock"))}

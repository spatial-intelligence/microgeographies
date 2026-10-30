"""COLMAP must see clean pixels whether labelling is enabled or disabled."""
import base64
import hashlib
import io
import json
from pathlib import Path
import zipfile

from fastapi.testclient import TestClient
from PIL import Image
import pytest

import server
import sfm


@pytest.mark.parametrize("setting", [None, "0", "1"])
def test_clean_colmap_inputs_and_opt_in_labelling(monkeypatch, setting):
    events, input_hashes, paths = [], {}, {}
    colour = (10, 100, 200)
    monkeypatch.setattr(sfm, "sfm_backend_available", lambda: True)
    monkeypatch.setattr(sfm, "colmap_binary", lambda: "colmap-stub")
    monkeypatch.setattr(sfm, "gpu_available", lambda: True)

    def reconstruct(image_dir, workspace, gpu_used, emit=None):
        events.append("geometry")
        for path in Path(image_dir).iterdir():
            paths[path.name] = path
            input_hashes[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
            with Image.open(path) as photo:
                assert photo.getpixel((20, 20)) == colour
        model = Path(workspace) / "sparse" / "0"
        model.mkdir(parents=True)
        (model / "cameras.txt").write_text("1 SIMPLE_PINHOLE 64 48 50 32 24\n")
        (model / "images.txt").write_text(
            "1 1 0 0 0 0 0 0 1 a.png\n\n2 1 0 0 0 0 0 0 1 b.png\n\n")
        (model / "points3D.txt").write_text("1 0 0 5 10 100 200 0.1 1 0 2 0\n")
        return str(model), []

    def dense(binary, workspace, gpu_used, emit=None):
        assert events == ["geometry"]
        events.append("dense")
        ply = Path(workspace) / "fused.ply"
        ply.write_text(sfm.write_ply_ascii([[0, 0, 5]], [list(colour)]))
        return str(ply), []

    def annotate(copies, concepts, detector="sam", api_token=""):
        assert setting == "1", "Detector must not run without explicit opt-in"
        assert events == ["geometry", "dense"]
        events.append("labels")
        assert api_token == "test-key"
        for name, copy in copies.items():
            # Simulate a detector painting directly on its input. Neither
            # COLMAP files nor the returned clean previews may change.
            copy.paste((255, 0, 0), (0, 0, copy.width, copy.height))
            assert hashlib.sha256(paths[name].read_bytes()).hexdigest() == input_hashes[name]
        return {name: [{"label": "door", "box": [0, 0, 64, 48], "score": 1}]
                for name in copies}, []

    monkeypatch.setattr(sfm, "reconstruct", reconstruct)
    monkeypatch.setattr(sfm, "run_dense_cli", dense)
    monkeypatch.setattr(server, "detect_concepts_no_depth", annotate)
    if setting != "1":
        def forbidden(*args, **kwargs):
            raise AssertionError("Label voting must also be skipped")
        monkeypatch.setattr(sfm, "vote_point_labels", forbidden)
        monkeypatch.setattr(sfm, "vote_point_labels_numpy", forbidden)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as z:
        for name in ("a.png", "b.png"):
            photo = io.BytesIO()
            Image.new("RGB", (64, 48), colour).save(photo, "PNG")
            z.writestr(name, photo.getvalue())
    data = {"concepts": '["door"]', "detector": "api", "dense": "1", "use_gpu": "1",
            "sam_token": "test-key"}
    if setting is not None:
        data["label_objects"] = setting
    if setting != "1":
        data["detections"] = '{"a.png":[{"label":"ignored","box":[0,0,64,48]}]}'
    with TestClient(server.app) as client:
        response = client.post("/api/sfm", data=data,
            files={"zipfile": ("images.zip", archive.getvalue(), "application/zip")})
    result = next(json.loads(line)["data"] for line in response.text.splitlines()
                  if json.loads(line).get("type") == "result")
    assert "error" not in result, result
    assert result["label_objects"] is (setting == "1")
    assert result["colmap_inputs_annotated"] is False
    assert events == (["geometry", "dense", "labels"] if setting == "1" else ["geometry", "dense"])
    assert bool(result["point_labels"]) is (setting == "1")
    assert bool(result["dense_labels"]) is (setting == "1")
    assert bool(result["detections"]) is (setting == "1")
    assert "test-key" not in response.text
    for url in result["thumbnails"].values():
        with Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))) as thumb:
            r, g, b = thumb.getpixel((20, 20))
            assert r < 20 and 90 < g < 110 and b > 190

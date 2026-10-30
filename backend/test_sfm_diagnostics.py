"""Calibration and match diagnostics use full models before downsampling."""
import sqlite3
from types import SimpleNamespace
from unittest.mock import patch

import sfm


def test_diagnostics_reports_shared_cameras_tracks_and_missing_pairs(tmp_path):
    (tmp_path / "points3D.txt").write_text(
        "1 0 0 5 10 20 30 0.5 1 0 2 0 3 0\n"
        "2 1 0 5 10 20 30 1.5 1 1 2 1\n")
    db_path = tmp_path / "sfm.db"
    with sqlite3.connect(db_path) as db:
        db.executescript("CREATE TABLE images (image_id INTEGER, name TEXT);"
                         "CREATE TABLE two_view_geometries (pair_id INTEGER, rows INTEGER, config INTEGER);")
        db.executemany("INSERT INTO images VALUES (?, ?)", [(1, "a.jpg"), (2, "b.jpg"), (3, "c.jpg")])
        db.execute("INSERT INTO two_view_geometries VALUES (?, 42, 2)", (2147483647 + 2,))
    cameras = [{"image": name, "camera_id": 1, "model": "SIMPLE_RADIAL", "width": 640,
                "height": 480, "params": [500, 320, 240, 0]} for name in ("a.jpg", "b.jpg", "c.jpg")]
    report = sfm.reconstruction_diagnostics(str(tmp_path), str(db_path), cameras)
    assert report["camera_count"] == 1
    assert report["registered_images"] == 3
    assert report["mean_reprojection_error_px"] == 1.0
    assert report["mean_track_length"] == 2.5
    assert report["points_seen_in_3plus_images"] == 1
    assert [p["verified_matches"] for p in report["pairs"]] == [42, 0, 0]
    assert 60 < report["intrinsics"][0]["hfov_deg"] < 70


def test_quality_options_support_old_and_new_matcher_names():
    for flag in ("SiftMatching.guided_matching", "FeatureMatching.guided_matching"):
        with patch.object(sfm, "_feature_extractor_help", return_value="SiftExtraction.max_num_features"), \
             patch.object(sfm.subprocess, "run", return_value=SimpleNamespace(stdout="", stderr=flag)):
            extract, match = sfm._quality_args("colmap")
        assert extract == ["--SiftExtraction.max_num_features", "16384"]
        assert match == ["--" + flag, "1"]


def test_quality_options_do_not_guess_unsupported_flags():
    with patch.object(sfm, "_feature_extractor_help", return_value=""), \
         patch.object(sfm.subprocess, "run", side_effect=OSError("unavailable")):
        assert sfm._quality_args("missing") == ([], [])


def test_model_selection_prefers_registered_photos_over_points_file_size(tmp_path):
    import struct
    for name, images, point_size in (("0", 2, 1000), ("1", 3, 100)):
        model = tmp_path / name
        model.mkdir()
        (model / "points3D.bin").write_bytes(b"x" * point_size)
        (model / "images.bin").write_bytes(struct.pack("<Q", images))
    assert sfm._pick_model_dir(str(tmp_path)) == str(tmp_path / "1")


def test_model_selection_reads_text_models_with_spaces_in_photo_names(tmp_path):
    for name, images in (("0", 2), ("1", 3)):
        model = tmp_path / name
        model.mkdir()
        (model / "points3D.txt").write_text("1 0 0 1 0 0 0 0\n")
        (model / "images.txt").write_text("".join(
            f"{i} 1 0 0 0 0 0 0 1 photo {i}.jpg\n\n" for i in range(1, images + 1)))
    assert sfm._pick_model_dir(str(tmp_path)) == str(tmp_path / "1")

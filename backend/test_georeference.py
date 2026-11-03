import math
import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
from georeference import fit_photo_gps, video_reference, EARTH_R
from da3 import serialize_gaussians


def fixture(outlier=False, collinear=False, altitude=True):
    angle = .7
    rotation = np.array([[math.cos(angle), -math.sin(angle), 0],
                         [math.sin(angle), math.cos(angle), 0], [0, 0, 1.]])
    translation = np.array([12., -8., 3.])
    centers = np.array([[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0], [5, 7, 0.]])
    if collinear:
        centers[:, 1] = 0
    enu = centers @ rotation.T * 2.5 + translation
    cameras, locations = [], {}
    for i, (center, point) in enumerate(zip(centers, enu)):
        name = f"photo{i}.jpg"
        cameras.append({"image": name, "qvec": [1, 0, 0, 0], "tvec": (-center).tolist()})
        locations[name] = {"lat": 51.5 + point[1]/EARTH_R*180/math.pi,
                           "lon": -.125 + point[0]/(EARTH_R*math.cos(math.radians(51.5)))*180/math.pi}
        if altitude:
            locations[name]["altitude_m"] = point[2]+50
    if outlier:
        locations["photo4.jpg"]["lat"] += .003
    return cameras, locations


def test_similarity_recovers_scale_rotation_and_camera_locations():
    cameras, locations = fixture()
    fit = fit_photo_gps(cameras, locations)
    assert fit["available"]
    assert fit["scale_m_per_unit"] == pytest.approx(2.5, rel=1e-5)
    assert fit["rms_m"] < .001
    assert len(fit["photos_used"]) == 5
    assert not fit["altitude_assumed_level"]


def test_rejects_gps_outlier_but_retains_consistent_cameras():
    cameras, locations = fixture(outlier=True)
    fit = fit_photo_gps(cameras, locations)
    assert fit["available"] and fit["photos_rejected"] == 1
    assert "photo4.jpg" not in fit["photos_used"]
    assert fit["rms_m"] < .001


def test_reports_assumed_level_when_altitude_is_missing():
    cameras, locations = fixture(altitude=False)
    assert fit_photo_gps(cameras, locations)["altitude_assumed_level"]


def test_degenerate_and_insufficient_gps_does_not_fabricate_alignment():
    cameras, locations = fixture(collinear=True)
    assert not fit_photo_gps(cameras, locations)["available"]
    cameras, locations = fixture()
    assert not fit_photo_gps(cameras[:2], locations)["available"]
    for gps in locations.values():
        gps.update(lat=51.5, lon=-.125)
    assert not fit_photo_gps(cameras, locations)["available"]


def test_video_world_frame_is_converted_through_first_camera():
    scene = {"is_metric": True, "extrinsics": np.array([[[1,0,0,-2], [0,1,0,0], [0,0,1,0]]])}
    fit = video_reference(scene, {"lat":51.5,"lon":-.125}, 90)
    point = np.array(fit["matrix"]) @ np.array([2,0,5]) + fit["translation"]
    assert np.allclose(point, [5,0,0])
    assert not video_reference(scene, None, 90)["available"]
    assert not video_reference(scene, {"lat":51.5,"lon":-.125}, None)["available"]


def test_real_gaussian_serialization_filters_nonfinite_and_caps_payload():
    data = SimpleNamespace(means=np.array([[[0,0,1],[1,0,2],[np.nan,0,3]]]),
        scales=np.ones((1,3,3))*.1, rotations=np.array([[[1,0,0,0]]*3]),
        harmonics=np.zeros((1,3,3,1)), opacities=np.array([[.8,.7,.6]]))
    result = serialize_gaussians(data, cap=1)
    assert len(result["means"]) == 1 and result["total"] == 2
    assert result["colors"] == [[.5,.5,.5]]


def test_video_gaussian_request_reaches_inference_and_returns_parameters():
    from unittest.mock import patch
    from fastapi.testclient import TestClient
    import da3
    import server
    from PIL import Image
    from test_da3 import _push_env, _post_zip, _photo_bytes

    def frames(_path, directory, max_frames, **kwargs):
        output = []
        for i in range(2):
            path = os.path.join(directory, f"frame{i}.png")
            Image.new("RGB",(32,24),(120,80,40)).save(path)
            output.append({"name":f"frame{i}.png","path":path})
        return output
    with _push_env(MOCK_DA3="1", MOCK_SAM="1"), patch.object(da3, "extract_frames", side_effect=frames):
        data = _post_zip(TestClient(server.app), [("photo.jpg",_photo_bytes()),("clip.mp4",b"stub")],
                         gaussians="1", max_points="1000")
    assert "error" not in data, data
    assert data["gaussians"]["mock"]
    assert len(data["gaussians"]["means"]) > 0
    assert data["georeference"]["available"]

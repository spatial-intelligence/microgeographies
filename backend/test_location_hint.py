import io
import json
import os
import sys
from types import SimpleNamespace
import zipfile
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest
import location_hint
from test_survey_review import batch_payload


def test_one_image_location_request_and_coordinate_validation():
    payload = {"token": "test-key", "image": batch_payload(1)["groups"][0]["images"][0]["url"]}
    candidate = {"name": "Possible town", "lat": 51.5, "lon": -.1, "confidence": "low", "reason": "Visible street name"}
    def provider(messages, schema, template, token):
        assert token == "test-key"
        assert schema["properties"]["candidates"]["maxItems"] == 3
        assert sum(block["type"] == "image_url" for block in messages[1]["content"]) == 1
        return {"answer": {"candidates": [candidate]}, "usage": {"total_tokens": 123}}
    with patch.object(location_hint, "complete_json", provider):
        result = location_hint.suggest(payload)
        assert result["candidates"] == [candidate]
        assert result["needs_choice"] is True
    with patch.object(location_hint, "complete_json", return_value={"answer": {"candidates": [{**candidate, "lat": 100}]}, "usage": {}}):
        with pytest.raises(RuntimeError, match="coordinates"):
            location_hint.suggest(payload)


def test_lookup_failure_is_separate_from_reconstruction():
    app = FastAPI()
    app.include_router(location_hint.router)
    with patch.object(location_hint, "suggest", side_effect=RuntimeError("Meta API HTTP 429")):
        response = TestClient(app).post("/api/location-hint", json={"image": "unused", "token": "test-key"})
    assert response.status_code == 502 and "429" in response.json()["detail"]


def test_no_gps_emits_one_frame_before_da3_and_gps_skips_lookup():
    import da3
    import server
    client = TestClient(server.app)
    emitted = []
    def extract(_video, folder, **_options):
        result = []
        for i in range(2):
            path = os.path.join(folder, f"{i}.jpg")
            Image.new("RGB", (64, 48), (50, 120, 180)).save(path)
            result.append({"name": f"{i}.jpg", "path": path, "time_s": i})
        return result
    def prepare(_path):
        assert _path.endswith("1.jpg"), 'seek fallback should choose the frame closest to one second'
        emitted.append("frame")
        return {"url": batch_payload(1)["groups"][0]["images"][0]["url"]}
    original = da3.estimate_scene
    def infer(*args, **kwargs):
        if not kwargs.pop("has_gps", False):
            assert emitted == ["frame"]
        return original(*args, **kwargs)
    with patch.dict(os.environ, MOCK_DA3="1", MOCK_SAM="1"), patch.object(da3, "extract_frames", extract), patch.object(location_hint, "frame_payload", prepare), patch.object(location_hint, "video_frame_payload", side_effect=RuntimeError("codec seek unavailable")), patch.object(da3, "estimate_scene", infer):
        response = client.post("/api/video-cloud", files={"video": ("scene.mp4", b"stub", "video/mp4")},
                               data={"locate_hint": "1", "max_frames": "2", "max_points": "1000"})
        messages = [json.loads(line) for line in response.text.splitlines()]
        frames = [message for message in messages if message["type"] == "location_hint_frame"]
        assert len(frames) == 1
        assert frames[0]["data"]["time_s"] == 1
        result = [message["data"] for message in messages if message["type"] == "result"][0]
        assert "error" not in result, result
        assert not result["georeference"]["available"], 'a suggestion must not become a real reference'
        emitted.clear()
        from test_da3 import _photo_bytes
        packed = io.BytesIO()
        with zipfile.ZipFile(packed, "w") as archive:
            archive.writestr("photo.jpg", _photo_bytes())
            archive.writestr("clip.mp4", b"stub")
        with patch.object(da3, "estimate_scene", original):
            response = client.post("/api/video-cloud", files={"zipfile": ("scene.zip", packed.getvalue(), "application/zip")},
                                   data={"locate_hint": "1", "max_frames": "2", "max_points": "1000"})
        assert emitted == []
        assert "location_hint_frame" not in response.text


def test_location_frame_seeks_one_second_and_clamps_short_video():
    import numpy as np
    class Capture:
        total = 90
        def __init__(self): self.calls = []; self.released = False
        def isOpened(self): return True
        def get(self, prop): return 30 if prop == 1 else self.total
        def set(self, prop, value): self.calls.append((prop, value))
        def read(self): return True, np.zeros((20, 30, 3), dtype=np.uint8)
        def release(self): self.released = True
    cap = Capture()
    cv2 = SimpleNamespace(VideoCapture=lambda _path: cap, CAP_PROP_FPS=1, CAP_PROP_FRAME_COUNT=2,
                          CAP_PROP_POS_FRAMES=3, CAP_PROP_POS_MSEC=4, COLOR_BGR2RGB=5,
                          cvtColor=lambda frame, _conversion: frame)
    with patch.dict(sys.modules, cv2=cv2):
        payload = location_hint.video_frame_payload('scene.mp4')
        assert cap.calls == [(3, 30)]
        assert payload["time_s"] == 1.0 and cap.released
        cap.calls.clear(); cap.total = 10
        payload = location_hint.video_frame_payload('short.mp4')
        assert cap.calls == [(3, 9)]
        assert payload["time_s"] == .3


def test_next_ten_seconds_preview_and_end_of_video():
    with patch.object(location_hint, "video_frame_payload", side_effect=lambda path, seconds: {"url": "frame", "time_s": seconds}):
        frames = location_hint.next_frame_previews("video.mp4", 1)
        assert [frame["time_s"] for frame in frames] == list(range(2, 12))
    with patch.object(location_hint, "video_frame_payload", side_effect=lambda path, seconds: {"url": "frame", "time_s": min(seconds, 4)}):
        frames = location_hint.next_frame_previews("short.mp4", 1)
        assert [frame["time_s"] for frame in frames] == [2, 3, 4]


def test_preview_endpoint_does_not_call_meta_and_removes_uploaded_video():
    paths = []
    def previews(path, seconds):
        paths.append(path)
        assert os.path.exists(path) and seconds == 1
        return [{"url": "frame", "time_s": 2}]
    app = FastAPI(); app.include_router(location_hint.router)
    with patch.object(location_hint, "next_frame_previews", previews), patch.object(location_hint, "complete_json") as paid:
        response = TestClient(app).post("/api/location-frames", files={"video": ("scene.mp4", b"video")}, data={"after_seconds": "1"})
        assert response.status_code == 200 and response.json()["frames"][0]["time_s"] == 2
        paid.assert_not_called()
    assert not os.path.exists(paths[0])

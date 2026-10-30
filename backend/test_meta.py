"""Exercise Meta payload, original-pixel box scaling and error handling offline."""
import io
import json
import urllib.error
from unittest.mock import patch

from PIL import Image
import meta


def test_meta_boxes_scale_back_to_upright_portrait():
    def reply(req, timeout):
        assert req.full_url == meta.ENDPOINT
        assert req.headers["Authorization"] == "Bearer test-key"
        body = json.loads(req.data)
        assert body["model"] == "sam-3.1"
        assert body["input"][0]["content"][0]["text"] == "door"
        return io.BytesIO(json.dumps({"output": [{"content": [{
            "type": "output_text", "text": "<|box;x1=100;y1=200;x2=400;y2=600|><|mask;data=1,1,x|>"
        }]}]}).encode())
    with patch("urllib.request.urlopen", reply):
        found = meta.detect(Image.new("RGB", (1600, 3200)), ["door"], "test-key")
    assert found[0]["box"] == [200, 400, 800, 1200]
    assert found[0]["label"] == "door"


def test_meta_error_does_not_echo_credentials_or_response():
    with patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError(
            meta.ENDPOINT, 401, "secret provider detail", {}, None)):
        try:
            meta.detect(Image.new("RGB", (20, 20)), ["door"], "test-key")
        except RuntimeError as exc:
            assert str(exc) == "Meta API HTTP 401"
        else:
            raise AssertionError("expected API failure")

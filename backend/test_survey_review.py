"""No real paid requests: validate caps, payloads, JSON and streamed results."""
import base64
import io
import json
import urllib.error
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
import pytest
import survey_review as review


def batch_payload(count=2):
    buffer = io.BytesIO()
    Image.new("RGB", (30, 20)).save(buffer, "JPEG")
    image = {"url": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode(), "u": .5, "v": .5}
    return {"token": "test-key", "question": "Does the entrance have visible issues?",
            "template": {"wheelchair": None, "wheelchairreason": "", "visualimp": None, "visualimpreason": ""},
            "max_requests": count, "groups": [{"id": f"door:{i}", "label": "door", "images": [image]} for i in range(count)]}


def test_schema_and_hard_limits():
    payload = batch_payload()
    batch = review.validate_batch(payload)
    assert batch["schema"]["properties"]["wheelchair"]["type"] == ["boolean", "null"]
    assert batch["schema"]["additionalProperties"] is False
    payload["max_requests"] = 1
    with pytest.raises(ValueError, match="maximum requests"):
        review.validate_batch(payload)
    payload["max_requests"] = 21
    with pytest.raises(ValueError, match="between 1 and 20"):
        review.validate_batch(payload)
    payload = batch_payload(1)
    payload["groups"][0]["images"] *= 4
    with pytest.raises(ValueError, match="1–3"):
        review.validate_batch(payload)


def test_payload_uses_contributor_images_and_strict_json_without_coordinates():
    batch = review.validate_batch(batch_payload(1))
    answer = {"wheelchair": True, "wheelchairreason": "Steps visible", "visualimp": None, "visualimpreason": "Cannot tell"}
    def provider(request, timeout):
        body = json.loads(request.data)
        assert request.full_url == review.ENDPOINT
        assert body["model"] == "muse-spark-1.3-contributor"
        assert body["max_completion_tokens"] == 1024
        assert body["response_format"]["json_schema"]["strict"] is True
        assert request.headers["Authorization"] == "Bearer test-key"
        blocks = body["messages"][1]["content"]
        assert blocks[-1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
        assert "x=0.500" in blocks[-2]["text"]
        return io.BytesIO(json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(answer)}}],
                                     "usage": {"total_tokens": 100}}).encode())
    with patch("urllib.request.urlopen", provider):
        result = review.ask_group(batch["groups"][0], batch)
    assert result["answer"] == answer
    assert result["usage"]["total_tokens"] == 100


def test_provider_failure_never_retries_or_exposes_credentials():
    batch = review.validate_batch(batch_payload(1))
    with patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError(
            review.ENDPOINT, 401, "sensitive provider response", {}, None)) as network:
        with pytest.raises(RuntimeError, match="HTTP 401") as error:
            review.ask_group(batch["groups"][0], batch)
        assert network.call_count == 1
        assert "test-key" not in str(error.value)
        assert "sensitive" not in str(error.value)


def test_rejects_malformed_answer_and_remote_image_urls():
    batch = review.validate_batch(batch_payload(1))
    provider_reply = {"choices": [{"finish_reason": "stop", "message": {"content": '{"wheelchair":"yes"}'}}]}
    with patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(provider_reply).encode())):
        with pytest.raises(RuntimeError, match="matching the template"):
            review.ask_group(batch["groups"][0], batch)
    payload = batch_payload(1)
    payload["groups"][0]["images"][0]["url"] = "http://127.0.0.1/private"
    with pytest.raises(ValueError, match="data URLs"):
        review.validate_batch(payload)


def test_stream_counts_one_call_per_group_and_preserves_partial_success():
    app = FastAPI()
    app.include_router(review.router)
    client = TestClient(app)
    answer = {"wheelchair": None, "wheelchairreason": "Unknown", "visualimp": False, "visualimpreason": "No visible issue"}
    with patch.object(review, "ask_group", side_effect=[{"answer": answer, "usage": {}}, RuntimeError("Meta API HTTP 429")]) as network:
        response = client.post("/api/survey-review", json=batch_payload())
    assert response.status_code == 200
    lines = [json.loads(line) for line in response.text.splitlines()]
    assert [item["attempt"] for item in lines if item["type"] == "start"] == [1, 2]
    results = [item for item in lines if item["type"] == "result"]
    assert results[0]["answer"] == answer and "error" in results[1]
    assert network.call_count == 2
    payload = batch_payload()
    payload["max_requests"] = 1
    with patch.object(review, "ask_group") as network:
        assert client.post("/api/survey-review", json=payload).status_code == 422
        network.assert_not_called()


def test_authentication_or_rate_limit_stops_further_requests():
    app = FastAPI()
    app.include_router(review.router)
    with patch.object(review, "ask_group", side_effect=review.ProviderError("Meta API HTTP 401", fatal=True)) as network:
        result = TestClient(app).post("/api/survey-review", json=batch_payload(3))
        assert network.call_count == 1
        assert "HTTP 401" in result.text


def test_one_batch_supports_different_questions_and_templates_per_class():
    payload = batch_payload(2)
    del payload["question"], payload["template"]
    payload["groups"][0].update(question="Any access issues?", template={"wheelchair": None})
    payload["groups"][1].update(label="steps", question="How many steps?", template={"stepcount": 0})
    seen = []
    def complete(messages, schema, template, token):
        seen.append(messages[1]["content"][0]["text"])
        return {"answer": {"wheelchair": True} if "wheelchair" in template else {"stepcount": 3}, "usage": {}}
    app = FastAPI(); app.include_router(review.router)
    with patch.object(review, "complete_json", complete):
        response = TestClient(app).post("/api/survey-review", json=payload)
    answers = [json.loads(line)["answer"] for line in response.text.splitlines() if json.loads(line)["type"] == "result"]
    assert answers == [{"wheelchair": True}, {"stepcount": 3}]
    assert "Any access issues?" in seen[0] and "How many steps?" in seen[1]

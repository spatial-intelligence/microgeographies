"""Meta SAM requests for ZIP processing. Tokens live only in the request."""
import base64
import io
import json
import math
import re
import urllib.error
import urllib.request

ENDPOINT = "https://api.meta.ai/v1/responses"


def detect(pil, concepts, token):
    if not token.strip():
        raise ValueError("Meta API token is required for API SAM 3.1")
    image = pil.copy()
    image.thumbnail((1600, 1600))
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=90)
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    sx, sy = pil.width / image.width, pil.height / image.height
    detections = []
    for concept in concepts:
        body = {"model": "sam-3.1", "stream": False, "input": [{
            "type": "message", "role": "user", "content": [
                {"type": "input_text", "text": concept},
                {"type": "input_image", "image_url": url}]}]}
        req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), headers={
            "Authorization": "Bearer " + token.strip(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                data = json.load(response)
        except urllib.error.HTTPError as exc:
            # Do not put request headers or provider responses in job logs.
            raise RuntimeError(f"Meta API HTTP {exc.code}") from None
        except (urllib.error.URLError, TimeoutError):
            raise RuntimeError("Meta API could not be reached") from None
        text = data.get("output_text")
        if not isinstance(text, str):
            text = "".join(c.get("text", "") for item in data.get("output", [])
                           for c in item.get("content", []) if c.get("type") == "output_text")
        for raw in re.findall(r"<\|box;(.*?)\|>", text, re.S):
            values = dict(re.findall(r"(x1|y1|x2|y2)=([^;|]+)", raw))
            try:
                box = [float(values[k]) for k in ("x1", "y1", "x2", "y2")]
            except (KeyError, ValueError):
                continue
            if not all(math.isfinite(v) for v in box):
                continue
            detections.append({"label": concept, "score": 1.0,
                               "box": [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]})
    return detections

import io
import os
import sys

sys.path.insert(0, "backend")
os.environ["MOCK_SAM"] = "1"
os.environ["MOCK_DEPTH"] = "1"

from PIL import Image  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from server import app  # noqa: E402

c = TestClient(app)

img = Image.new("RGB", (400, 300), (10, 100, 200))
buf = io.BytesIO()
img.save(buf, "JPEG")
data = buf.getvalue()

# 1. detect with live GPS + heading -> geo attached
r = c.post("/api/detect",
           files={"image": ("t.jpg", data, "image/jpeg")},
           data={"concepts": '["door", "bin"]', "lat": "51.5",
                 "lon": "-0.125", "heading": "90"})
assert r.status_code == 200, r.text
j = r.json()
assert j["gps_source"] == "live", j
for d in j["detections"]:
    print(d.get("label"), d.get("geo"), d.get("snapped"),
          d.get("geo_error"))
assert all("geo" in d for d in j["detections"]), j
door = [d for d in j["detections"] if d["label"] == "door"][0]
assert door["geo"]["distance_m"] > 0
print("detect+project OK; gps_source:", j["gps_source"])

# 2. no gps, no heading -> boxes pass through untouched
r2 = c.post("/api/detect",
            files={"image": ("t.jpg", data, "image/jpeg")},
            data={"concepts": '["door"]'})
j2 = r2.json()
assert j2["gps_source"] == "none" and "geo" not in j2["detections"][0], j2
print("no-location passthrough OK")

# 3. project with externally produced (Meta-style) boxes
r3 = c.post("/api/project",
            files={"image": ("t.jpg", data, "image/jpeg")},
            data={"boxes": '[{"box": [150, 100, 250, 250],'
                           ' "label": "door"}]',
                  "lat": "51.5", "lon": "-0.125", "heading": "90"})
j3 = r3.json()
print("project:", j3["detections"][0].get("geo"))
assert "geo" in j3["detections"][0], j3

# 4. depth grid
r4 = c.post("/api/depth", files={"image": ("t.jpg", data, "image/jpeg")})
j4 = r4.json()
print("depth:", j4["grid_w"], j4["grid_h"], j4["depth_min"],
      j4["depth_max"], j4["mock"], j4["exif_gps"])
assert j4["mock"] is True and j4["exif_gps"] is None
assert j4["grid_w"] == 80 and j4["grid_h"] == 60

# 5. EXIF GPS round trip through a real JPEG
img2 = Image.new("RGB", (400, 300), "green")
ex = img2.getexif()
g = ex.get_ifd(0x8825)
g[1] = "N"
g[2] = (51.0, 30.0, 0.0)
g[3] = "W"
g[4] = (0.0, 7.0, 30.0)
buf2 = io.BytesIO()
img2.save(buf2, "JPEG", exif=ex)
data2 = buf2.getvalue()
r5 = c.post("/api/detect",
            files={"image": ("t.jpg", data2, "image/jpeg")},
            data={"concepts": '["door"]', "heading": "0"})
j5 = r5.json()
print("exif detect:", j5["gps_source"], j5["location"],
      j5["detections"][0].get("geo"))
assert j5["gps_source"] == "exif", j5
assert abs(j5["location"]["lat"] - 51.5) < 1e-4, j5
assert "geo" in j5["detections"][0], j5

print("ALL E2E OK")

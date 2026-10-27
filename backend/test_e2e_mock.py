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

# 6. single-origin page serving: API routes keep precedence over static
r6 = c.get("/")
assert r6.status_code == 200 and "<title>MicroGeo Capture Tool" in r6.text, r6.status_code
r7 = c.get("/app.js")
assert r7.status_code == 200 and "renderMap" in r7.text
print("static page serving OK (API precedence intact: see sections 1-5)")

# 7. depth visualization + 3D fields ride along on every endpoint
assert str(j.get("depth_png", "")).startswith("data:image/png;base64,"), "detect depth_png"
assert str(j3.get("depth_png", "")).startswith("data:image/png;base64,"), "project depth_png"
assert str(j4.get("depth_png", "")).startswith("data:image/png;base64,"), "depth depth_png"
enu = door["geo"]["enu_m"]
assert set(enu) == {"x", "y", "z"}, enu
assert door["geo"]["pixel"] == {"x": 200, "y": 150}, door["geo"]
print("depth_png + enu_m + pixel OK")

# 8. batch zip: two same-spot photos fuse, a far one stays separate
import zipfile as _zip


def _exif_jpg(lat_dms, lon_ref, lon_dms, direction=None):
    from PIL import ImageDraw
    im = Image.new("RGB", (400, 300), (10, 100, 200))
    d = ImageDraw.Draw(im)  # texture so box crops carry visual signal
    for x in range(0, 400, 20):
        d.rectangle([x, 0, x + 9, 300], fill=(200, 30, 30))
    ex = im.getexif()
    g = ex.get_ifd(0x8825)
    g[1] = "N"
    g[2] = lat_dms
    g[3] = lon_ref
    g[4] = lon_dms
    if direction is not None:
        g[0x0010] = "T"
        g[0x0011] = direction
    b = io.BytesIO()
    im.save(b, "JPEG", exif=ex)
    return b.getvalue()


zb = io.BytesIO()
with _zip.ZipFile(zb, "w") as zf:
    zf.writestr("a.jpg", _exif_jpg((51.0, 30.0, 0.0), "W", (0.0, 7.0, 30.0), (90, 1)))
    zf.writestr("b.jpg", _exif_jpg((51.0, 30.0, 0.0), "W", (0.0, 7.0, 30.0), (90, 1)))
    zf.writestr("far.jpg", _exif_jpg((52.0, 0.0, 0.0), "E", (1.0, 0.0, 0.0), (90, 1)))
    zf.writestr("notes.txt", b"not an image")
r8 = c.post("/api/batch",
            files={"zipfile": ("batch.zip", zb.getvalue(), "application/zip")},
            data={"concepts": '["door"]'})
j8 = r8.json()
assert len(j8["images"]) == 3, j8
assert all(i["thumbnail"].startswith("data:image/jpeg;base64,")
           for i in j8["images"])
assert all(i["gps_source"] == "exif" for i in j8["images"]), j8
feats = j8["merged"]["features"]
assert len(feats) == 2, feats  # a+b fused, far separate
fused = [f for f in feats if f["properties"]["count"] == 2][0]
assert {m["image"] for m in fused["properties"]["merged_from"]} == {"a.jpg", "b.jpg"}
print("batch + merge OK:", [(f["properties"]["label"], f["properties"]["count"])
                            for f in feats])

# 9. prefer=manual: typed correction beats EXIF
r9 = c.post("/api/detect",
            files={"image": ("a.jpg", _exif_jpg((51.0, 30.0, 0.0), "W",
                                                (0.0, 7.0, 30.0), (90, 1)),
                             "image/jpeg")},
            data={"concepts": '["door"]', "lat": "52.0", "lon": "1.0",
                  "heading": "90", "prefer": "manual"})
j9 = r9.json()
assert j9["gps_source"] == "manual", j9
assert (j9["location"]["lat"], j9["location"]["lon"]) == (52.0, 1.0), j9
print("manual prefer OK:", j9["gps_source"], j9["location"])

print("ALL E2E OK")

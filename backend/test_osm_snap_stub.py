"""Wiring test: Overpass fetch -> outline snap -> /api/project attach.

Uses a LOCAL stub HTTP server returning a canned, clearly synthetic
building ring (sandbox egress to overpass-api.de is filtered, so live
OSM is unreachable here). Proves the code path production uses against
real OSM: fetch_buildings_near parses the ring, snap_to_building_outline
picks the nearest outline point, and /api/project attaches `snapped`
to door/window detections only.

Run: .venv/bin/python backend/test_osm_snap_stub.py
"""

import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import depth  # noqa: E402

# Synthetic ring (NOT OpenStreetMap data): rectangle just east of the
# projected door pin (~51.50740, -0.12747).
RING = [(51.50742, -0.12755), (51.50742, -0.12740),
        (51.50750, -0.12740), (51.50750, -0.12755),
        (51.50742, -0.12755)]


class StubOverpass(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        self.rfile.read(length)
        body = {"elements": [{"type": "way", "id": 424242,
                              "geometry": [{"lat": la, "lon": lo}
                                           for la, lo in RING]}]}
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


def main():
    # Keep localhost off any egress proxy (sandbox sets http_proxy).
    os.environ["no_proxy"] = "127.0.0.1,localhost"
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    server = HTTPServer(("127.0.0.1", 0), StubOverpass)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    depth.OVERPASS_URL = f"http://127.0.0.1:{port}/api/interpreter"

    # 1. fetch parses the stub ring
    buildings = depth.fetch_buildings_near(51.5074, -0.1278)
    assert len(buildings) == 1 and buildings[0]["id"] == 424242, buildings
    print("fetch OK:", buildings[0]["id"], len(buildings[0]["ring"]), "nodes")

    # 2. snap lands on the outline, close to the query point
    snap = depth.snap_to_building_outline(51.50740, -0.12747)
    assert snap and snap["building_id"] == 424242, snap
    assert snap["snap_m"] < 15.0, snap
    print("snap OK:", snap)

    # 3. full /api/project attach: door gains `snapped`, bin does not
    os.environ["MOCK_SAM"] = "1"
    os.environ["MOCK_DEPTH"] = "1"
    from fastapi.testclient import TestClient
    import server as srv
    from PIL import Image
    img = Image.new("RGB", (400, 300), (10, 100, 200))
    buf = io.BytesIO()
    img.save(buf, "JPEG")
    c = TestClient(srv.app)
    r = c.post("/api/project",
               files={"image": ("t.jpg", buf.getvalue(), "image/jpeg")},
               data={"boxes": json.dumps([
                   {"box": [150, 100, 250, 250], "label": "door"},
                   {"box": [10, 10, 50, 50], "label": "bin"}]),
                   "lat": "51.5074", "lon": "-0.1278", "heading": "90"})
    dets = r.json()["detections"]
    door = next(d for d in dets if d["label"] == "door")
    binit = next(d for d in dets if d["label"] == "bin")
    assert door.get("snapped", {}).get("building_id") == 424242, door
    assert "snapped" not in binit, binit  # bins keep the raw projection
    print("project attach OK:")
    print("  door:", json.dumps(door["geo"]), json.dumps(door["snapped"]))
    print("  bin: ", json.dumps(binit["geo"]), "(no snap, as designed)")
    server.shutdown()
    print("ALL SNAP WIRING OK")


if __name__ == "__main__":
    sys.exit(main() or 0)

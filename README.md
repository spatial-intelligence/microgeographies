# Microgeographies — SAM test PWA

Test page: upload a photo (or use the phone camera), type object prompts
(`door, steps`), grab GPS, send to SAM 3.1, draw the returned bounding
boxes, export GeoJSON for mapping later, and download a
full-resolution PNG of the annotated photo.

## Try it locally

```sh
./run.sh
```

Open http://localhost:8000 in a browser. (`localhost` counts as a secure
context, so GPS works without HTTPS.) One server delivers both the page
and the API, so depth maps, 3D pins, and the map view work on every
path. Every Send goes to the real configured endpoint — there is no
mock mode. Results show a turbo-colorized depth map, per-box
pixel → ENU (x/y/z metres from the camera), and a map with the camera
fix plus one marker per pin (label, distance, azimuth).

## Point it at SAM 3.1 (Meta)

The page now defaults to `https://api.meta.ai/v1/responses`. Check the
**Model** field (default `sam-3.1` — correct it if Meta's catalogue names
it differently), and paste your Meta API key into the **Token** field.
The token stays in that browser's `localStorage` — it is never written
to this repo.

The request matches the proven Colab shape: one POST per concept with
`{"model": "sam-3.1", "stream": false, "input": [{"type": "message",
"role": "user", "content": [{"type": "input_text", "text": "<concept>"},
{"type": "input_image", "image_url": "data:..."}]}]}`. Boxes are pulled
from each reply and drawn scaled to the displayed image.

The photo is downscaled to max 1600px on the long edge and sent as JPEG
(phone originals are too large and sometimes an unaccepted format).
Each reply's `output[].content[]` text carries tokens like
`<|box;x1=..;y1=..;x2=..;y2=..|><|mask;…;data=H,W,payload|>` with boxes
in sent-image pixels. The mask `payload` is kept on each result (and
in the GeoJSON export as `maskH`/`maskW`/`maskPayload`) for later
decoding — e.g. with `meta_sam_parser.decode_mask_to_raster` as in the
Colab prototype — but masks are not drawn on the page yet.

## From photo to map pin (depth + heading + OSM)

The collection pipeline turns each detection into an approximate map
location for robot delivery-point microgeography:

1. **Photo + location.** The photo's own EXIF GPS wins when present —
   a saved photo was taken somewhere else, so its metadata beats
   wherever this computer is now. Otherwise the live phone GPS is used
   (`gps_source` in every reply is `exif`, `live`, or `none`).
2. **Heading.** A typed/captured bearing wins; otherwise the photo's
   EXIF direction (`GPSImgDirection`, true-north only — magnetic is
   ignored) is used (`heading_source` is `manual`, `exif`, or `none`).
   Each box gets a true bearing via a pinhole camera model
   (`pixel_to_bearing`, default 60° HFOV, adjustable).
3. **Monocular depth.** `backend/depth.py` runs Depth Anything Small
   (`LiheYoung/depth-anything-small-hf`, ~100 MB first download) to get
   relative depth; the median over each box is mapped linearly to
   metres (`relative_to_metric`, far end = `max_range`, default 30 m).
   Single-image depth is scale-ambiguous, so treat pins as approximate.
   Every reply also carries `depth_png`: the depth map colorized
   turbo-style (blue far → red near, like Depth Anything V3 outdoor
   visualizations), shown under Results.
4. **Projection.** Bearing + range from the camera fix gives an approx
   3D point per box: lat/lon (`destination_point` haversine) plus
   `enu_m` metres east/north/up from the camera (level-camera
   assumption) and the `pixel` box centre it came from — all listed
   per detection and exported in the GeoJSON.
5. **OSM snap.** `door`/`window`/`entrance`-like pins are snapped to the
   nearest OpenStreetMap building outline via Overpass (`snapped` carries
   `building_id` + `snap_m`); bins, steps, etc. keep the raw projection.

Endpoints (all multipart, all degrade gracefully — a failed depth model
or OSM lookup yields partial geo, never a 500):

| endpoint       | input | output |
|----------------|-------|--------|
| `/api/detect`  | `image`, `concepts`, `lat`, `lon`, `heading`, `hfov`, `max_range`, `project` | boxes + `geo`/`snapped` per detection, `location`, `gps_source` |
| `/api/project` | `image`, `boxes` (Meta SAM-3.1 xyxy JSON), same geo fields | projected detections (used by the page for Meta-direct boxes) |
| `/api/depth`   | `image` | 80×60 relative-depth grid (0 = far, 1 = near) + `exif_gps` |

Pure geometry/EXIF helpers have unit tests with no model or network:

```sh
.venv/bin/python backend/test_geo.py             # pure geometry/EXIF, no deps beyond Pillow
.venv/bin/python backend/test_e2e_mock.py        # full HTTP loop, mock SAM + mock depth
```

Run the backend with `MOCK_SAM=1 MOCK_DEPTH=1` for offline development
(deterministic boxes + gradient depth, no downloads).

If the browser blocks the direct call (CORS), switch the endpoint to the
relative `/api/sam` and run the proxy with your Meta key server-side:

```sh
SAM_UPSTREAM_URL=https://api.meta.ai/v1/responses SAM_TOKEN=xxxx PORT=3001 node server/proxy.mjs
```

The proxy forwards the JSON body untouched, so no page changes are needed.

## Point it at another detector backend

Any other endpoint gets `multipart/form-data` (see table below).

The page sends `multipart/form-data`:

| field    | value                        |
|----------|------------------------------|
| `image`  | the photo file               |
| `prompts`| JSON array, e.g. `["door"]`  |
| `lat`    | GPS latitude (if captured)   |
| `lon`    | GPS longitude (if captured)  |

The box parser accepts several reply shapes (`results`, `detections`,
`predictions`, `boxes`+`labels`+`scores`, bare arrays, HF
`{xmin…}` in 0..1 or 0..1000), in `xyxy` or `xywh`, normalized or pixels.
An explicit per-item `format: "xyxy" | "xywh"` always wins.

## Host on nginx with HTTPS (GPS needs it)

1. Copy this folder to `/var/www/microgeographies`.
2. Copy [nginx-microgeographies.conf](nginx-microgeographies.conf) to
   `/etc/nginx/sites-enabled/`, set `server_name` and `root`.
3. `certbot --nginx` (or install your cert) so port 443 serves HTTPS.
   Geolocation only works in secure contexts — plain `http://` on a real
   host will silently refuse GPS.
4. Run the token-hiding proxy and point nginx at it:
   ```sh
   SAM_UPSTREAM_URL=https://your-sam-endpoint SAM_TOKEN=xxxx PORT=3001 node server/proxy.mjs
   ```
   Needs Node 18+. No `npm install` — stdlib only.

## Files

- `index.html`, `styles.css`, `app.js` — the page
- `config.js` — public defaults (endpoint, prompts, mock on/off)
- `manifest.webmanifest`, `sw.js`, `icon.svg` — PWA install + offline shell
- `server/proxy.mjs` — injects the API token server-side, streams to SAM
- `nginx-microgeographies.conf` — HTTPS site + `/api/sam` proxy example

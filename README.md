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

## Run in Docker (COLMAP + GPU)

`Dockerfile` + `docker-compose.yml` pack the page, the API, and a
GPU-built COLMAP 3.9.1 (Ceres 2.2.0, CUDA 12.6) into one image, so
`/api/sfm` works instead of returning 503.

Host needs: an NVIDIA driver, Docker, and the NVIDIA Container Toolkit.
Then:

```sh
docker compose up --build
```

Open http://localhost:8000 in a browser. The first build compiles Ceres
+ COLMAP from source (~30–60 min, mostly unattended); later starts reuse
the image and the `hf-cache` volume (model weights persist). To compile
faster, narrow `CUDA_ARCHS` in `docker-compose.yml` to your card
(`86` Ampere, `89` Ada, `90` Hopper).

Check the GPU made it through:

```sh
docker exec hackathon2026-microgeo-1 nvidia-smi -L
```

`/api/sfm` replies carry `gpu_used: true` when COLMAP ran on CUDA.
Without a GPU the same compose file still works (remove the
`deploy.resources.reservations.devices` block): the entrypoint says so
at startup and COLMAP runs on CPU with a warning. `MOCK_SAM=1` stays the
default, as in `./run.sh`; unset it for real SAM 3.

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
.venv/bin/python backend/test_merge.py           # IoU dedupe, crop similarity, clustering
.venv/bin/python backend/test_clip.py            # proposals, CLIP pick top-k/NMS (injected scorer)
.venv/bin/python backend/test_e2e_mock.py        # full HTTP loop, mock SAM + mock depth
.venv/bin/python backend/test_osm_snap_stub.py   # OSM snap wiring via a local stub
.venv/bin/python backend/test_sfm.py             # SfM helpers + /api/sfm 503 path, no COLMAP/GPU needed
```

## COLMAP SfM backend (optional 3D reconstruction)

`POST /api/sfm` takes a multipart `zipfile` (same photo filter and
20-image/200 MB caps as `/api/batch`), an optional `detections` JSON
string mapping image filename to `[{label, box: [x1,y1,x2,y2], score}]`
in original pixels (same convention as `/api/project`), an optional
`concepts` array (or comma string) plus `detector` (`"sam"` | `"clip"`,
server-side only) to detect per-image boxes for images missing from
`detections`, and an optional `use_gpu` flag (default `"1"`). The reply
streams NDJSON: `{type: "log", line}` progress lines while COLMAP runs,
then one `{type: "result", data}` with the payload below.

No depth pass runs on this route: detection is boxes-only
(`detect_concepts_no_depth`), so uploading a zip for 3D never triggers
the monocular-depth model. Explicit `detections` win per image;
concepts fill the rest; empty concepts means an unlabeled cloud.

Photos are normalised for COLMAP before extraction. COLMAP reads
stored pixels and stored dimensions verbatim and ignores the EXIF
orientation tag, so portrait phone photos (stored landscape, tagged
rotated) are physically rotated upright and saved without the tag —
each photo then gets its own COLMAP camera (forced on both the CLI and
pycolmap paths), so a landscape frame's width/height and principal
point can never be applied to a portrait photo. Zip entries sharing a
filename in different folders are renamed (`name__2.jpg`, …) instead of
overwriting each other, and the reply gains per-photo `orientations`.
After parsing, every COLMAP camera is checked against the upright
photo it claims to describe: a swapped or mismatched width/height adds
an explicit warning rather than returning a silently warped cloud.

The server unzips to a temp dir and runs COLMAP — CLI preferred
(feature extraction + exhaustive matching + mapping), pycolmap fallback
when the binary is missing. GPU choice is automatic: CUDA is used only
when `torch.cuda` or `nvidia-smi` reports a real GPU, otherwise CPU
flags are passed; `use_gpu=0` forces CPU. The sparse model
(`SIMPLE_PINHOLE`, `PINHOLE`, `SIMPLE_RADIAL`, `RADIAL`, `OPENCV`,
and `FULL_OPENCV` supported, distortion applied when voting labels)
is parsed, downsampled to at
most ~50000 points, and returned as inline ASCII PLY text plus
`cameras` (`[{image, qvec, tvec, width, height, model, params}]`) and
`point_labels` (`{point_index: {label, votes}}`). Label voting projects
each 3D point into every registered image via its pose + camera model
and votes the label of each detection box the projection lands in
(majority wins). `gpu_used` and `warnings` ride along; `registered` /
`unregistered` list which photos COLMAP could place.

Without the COLMAP CLI *and* pycolmap the endpoint returns HTTP 503
with a JSON error (never 500) — every other endpoint keeps working.

## Processing routes (mode switch)

The page opens with "What are you processing?": **Single photo**
(detect, depth, map pin), **Photo set → pins** (zip in, depth +
merged pins per photo), or **Photo set → 3D** (zip in, COLMAP cloud
with labels). Each mode shows only its sections, renumbered in place,
and the choice persists in `localStorage`.

Both set modes share one upload: a drag-and-drop `.zip` zone
(click-to-browse fallback is the original file input) plus a concepts
field and a server-detector select (SAM 3 / CLIP windows; browser
detectors are single-photo only). Upload once, then run either route —
or both — without re-uploading.

Depth runs only where pins need range (single photo, batch). The 3D
route is COLMAP geometry plus depth-free server-side labels: leave the
concepts empty for a fast unlabeled cloud.

## 3D reconstruction in the page (set → 3D mode)

The "Reconstruct 3D" button sends the shared zip to `POST /api/sfm`
with the set concepts and detector (plus a force-CPU checkbox mapping
to `use_gpu=0`), so points are label-voted without any depth pass.

Results render as two side-by-side three.js viewers (pinned
`three@0.186.1` import map, `sfm3d.js`): the raw cloud in its own
colors and the labeled cloud in per-class colors. Drag orbits, scroll
or pinch zooms, and clicking a point pops a bubble with its feature
class (+ votes/score when the server sent them). three.js loads lazily
only after data arrives, so the page opens with no console errors
offline; when the server 503s (no COLMAP) the section says so plainly
instead of rendering.

## Offline browser SAM (INT8, no internet after setup)

Section 4 offers four detectors: API SAM 3.1, Browser SAM3-INT8,
(`rusen/sam3-browser-int8`: dynamic-INT8-quantized SAM3 splits run
under ONNX Runtime Web — 466 MB image encoder, 387 MB language
encoder, 35 MB decoder). The weights download once (~930 MB with
progress) into Cache Storage and are pinned there across service-worker
updates; the ONNX runtime itself is cached the same way. After that the
detector runs fully offline — depth + map pins still come from the
local backend, which is also offline-capable.

Practical notes: WebGPU is strongly recommended (the quantized ops take
~6–18 s there versus minutes on WASM, which the page falls back to
automatically with a warning — including a mid-run retry if WebGPU
rejects a quantized op such as GatherND on int64). The tokenizer port
in `sam3local.js` is byte-identical to the Python reference on the
checked words; the model math itself was validated end to end with
onnxruntime CPU (a "door" prompt on the test facade returned
`[510.8, 421.6, 689.8, 698.8]` at 0.772 against a
`[520, 430, 680, 700]` ground truth).

## Browser MobileNet objects (fourth option, known kinds)

Section 4 also offers Browser MobileNet objects: `mobilenet.js` loads
TensorFlow.js plus the coco-ssd detector (MobileNetV2 backbone, a few
MB once, then offline via the service-worker vendor cache) and finds
~80 known COCO kinds (person, car, chair, bottle, dog, …) with boxes —
no prompts needed, so the prompts field is ignored in this mode. Boxes
flow through the same depth + pins + map path as the other direct
detectors. It is the fastest in-browser option and a good first try
before the heavier SAM/CLIP downloads.

## Offline CLIP detector (third option, coarse boxes)

Section 4 also offers Local CLIP windows: `backend/clip_detect.py`
scores multi-scale sliding windows against each prompt with
`openai/clip-vit-base-patch32` (~350 MB once, then offline) and keeps
the best after threshold (0.22), top-5 per concept, and NMS. Select it
and the page posts to same-origin `/api/detect` with `detector=clip`
(any detector also works on `/api/batch`). Boxes are window-aligned and
coarse — on the test facade "door" scored `[300, 338, 900, 788]` at
0.287, containing the true door — but every kept box earned its score
against the pixels, and downstream depth, pins, map, and merging work
unchanged.

## Batch + merged map

Batch → pins mode takes the shared zip (up to 20 photos): each image runs the full
pipeline with its own EXIF location/direction (live fix as fallback)
and returns a preview, its pins, and a per-image JSON download.
`POST /api/batch` also returns one merged GeoJSON: same-type pins fuse
only when within `merge_radius_m` (default 8 m) *and* their box crops
look alike (similarity ≥ `sim_min`, default 0.75) — repeat sightings of
one bin collapse to a mean pin, while two genuinely separate bins stay
distinct. Merged pins draw on the map as red circles.

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

- `index.html`, `styles.css`, `app.js` — the page (`sam3local.js`, `mobilenet.js` — in-browser detectors)
- `config.js` — public defaults (endpoint, prompts, mock on/off)
- `manifest.webmanifest`, `sw.js`, `icon.svg` — PWA install + offline shell
- `server/proxy.mjs` — injects the API token server-side, streams to SAM
- `nginx-microgeographies.conf` — HTTPS site + `/api/sam` proxy example

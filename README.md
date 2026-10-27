# Microgeographies — SAM test PWA

Test page: upload a photo (or use the phone camera), type object prompts
(`door, steps`), grab GPS, send to SAM 3.1, draw the returned bounding
boxes, export GeoJSON for mapping later, and download a
full-resolution PNG of the annotated photo.

## Try it locally

```sh
python3 -m http.server 8000
```

Open http://localhost:8000 in a browser. (`localhost` counts as a secure
context, so GPS works without HTTPS.) Every Send goes to the real
configured endpoint — there is no mock mode.

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

# DA3 comparison and fixes — 1 November 2026

The official Hugging Face Space was compared with our code using the local
mvtest.zip. Its video has 581 frames at approximately 30 fps (19.4 seconds),
1920 × 1440 pixels. CUDA and an NVIDIA RTX 4080 were verified inside the app
container.

## Confirmed causes

- The clip ends with a black Spectacles / Specs Starter title card. The
  12-frame batch includes it at indices 527 and 580. Cached predictions
  reconstruct its text and logo as a floating black surface. It also gives
  automatic reference selection an unrelated view to choose.
- Twelve frames span the entire clip: roughly 1.8 seconds between views.
  The Space defaults to 10 frames per second.
- We sampled only every second pixel in each axis, then capped the cloud
  at 200,000 points (originally 50,000). The Space exports full pixels with
  a default cap of one million.
- The old filter was percentile-only. In this clip's 12-frame prediction,
  the 10th and 40th confidence percentiles are both 1.0. Many unreliable
  pixels survived. The Space additionally clamps a base threshold of 1.05
  between percentile bounds.
- Camera poses were not drawn, despite being returned. Fixed two-pixel
  points also looked coarse beside the denser reference cloud.

Correction to the initial review: the Space also concatenates back-projected
clouds. Its point-cloud export has no hidden TSDF fusion or bundle adjustment.
Missing fusion alone does not explain the difference. Its older API also
lacks the automatic reference selection used by our installed version.

## Implemented changes

- Exclude black title/blank frames before inference, using a mostly-black
  image plus an almost entirely black outer border. The UI can disable this
  for night footage. Excluded indices are reported.
- Target 10 fps within a default 16-frame GPU budget, configurable up to 120.
  Spread the budget over the complete clip and report the effective FPS.
  The 28/48-frame tests approached the 4080's VRAM limit and ran slowly;
  they were stopped rather than making that the default on a 16 GB GPU.
- Save lossless PNG frames and explicitly use the first usable scene frame
  as reference. Standard/high detail mirror the Space's 504-pixel long-edge
  and short-edge resize methods.
- Back-project every valid pixel, with a default one-million-point budget
  adjustable up to two million. Follow the Space's confidence threshold
  logic and exclude predicted sky when supplied by the model.
- Offer cross-view cleanup against four neighboring frames: reject depth
  disagreement beyond 3% (minimum 3 cm) where reliable other views observe
  the point. Preserve regions outside the other views. This may remove
  occluded/single-view detail, so it is switchable. It rejects points and
  does not optimize camera poses.
- Offer near-black-pixel filtering separately, disabled by default because
  real car windows and other dark surfaces contain useful geometry.
- Draw colored wireframe camera frustums and a trajectory from the actual
  world-to-camera poses. No opaque camera boxes are added.
- Add camera visibility, point size, PLY download and diagnostics download.
  Frame the useful 2nd–98th percentile cloud extent to resist distant outliers.
- Serialize inference to prevent concurrent GPU batches. Report actual
  device/GPU, sample times, settings and retained points per frame. CUDA
  memory exhaustion returns an actionable error.

There is still no application-level pose refinement, loop closure or TSDF
fusion. Long sequences need overlapping-window alignment or a streaming/SLAM
pipeline. The photo only anchors GPS/heading; it is not a matched DA3 input.
Semantic voting uses bounding boxes and has no depth-aware occlusion test.

## Validation

Regression checks cover camera transforms, 3×4/4×4 poses, unknown-length
sampling, title cards, confidence, cross-view ghost rejection, preservation
of non-overlapping regions, optional black filtering, exact point capping,
API contracts and device reporting. Three.js tests check camera-center/path
coordinates, wireframe geometry, visibility, orientation and UI layout.

Real-video comparison predictions and local QA scripts are kept under
tmp-probe and excluded from Git and the Docker build context. The comparison
uses the same video locally; no input was uploaded to Hugging Face.

## Reference implementation

- [Inference](https://huggingface.co/spaces/depth-anything/depth-anything-3/blob/main/depth_anything_3/app/modules/model_inference.py)
- [Frame sampling](https://huggingface.co/spaces/depth-anything/depth-anything-3/blob/main/depth_anything_3/app/modules/file_handlers.py)
- [UI defaults](https://huggingface.co/spaces/depth-anything/depth-anything-3/blob/main/depth_anything_3/app/modules/ui_components.py)
- [Point-cloud exporter](https://huggingface.co/spaces/depth-anything/depth-anything-3/blob/main/depth_anything_3/utils/export/glb.py)

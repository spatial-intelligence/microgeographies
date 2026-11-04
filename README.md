##Micro-Geography Mapping Tool

A micro-geography mapping tool, developed from scratch during the 10-day hackathon (26 October – 4 November 2026).

The tool is designed to capture and map small-scale features that are often missing from conventional maps. Examples include door and entrance locations, missing post boxes, bicycle sheds, and indoor features such as office locations, recycling bins and fire extinguishers. This information has applications in emergency service response, robot delivery (identifying building entrances) and autonomous vehicles (identifying suitable pick-up and drop-off locations).

Users can upload a single image, a collection of images or a video. Where GNSS coordinates are available in the image EXIF metadata, these are used to establish the location. Otherwise, the tool attempts to identify the location by submitting selected image samples to the Meta Spark 1.3 API. Where plausible location candidates are identified, these are displayed on a map for the user to confirm. Users can also select alternative image samples for analysis or manually specify the location by clicking on the map.

For georeferenced image collections or videos, a 3D model is constructed that users can explore to identify and tag individual features. These features are then positioned in real-world coordinates. SAM3.1 can also be used to automatically identify and tag features.

Tagged features can subsequently be submitted to the Meta Spark 1.3 API for image analysis and to answer feature-specific questions (e.g. Is this entrance accessible? What colour is the door? What type of bin is shown?). Results are returned in a user-defined JSON structure, with a separate template for each feature class. This ensures that extracted information is consistently structured and can be integrated into downstream mapping workflows.

The resulting 3D models and mapped features (points or lines) can be exported for use in other GIS software and spatial databases.



Containerisation: Runs in Docker and requires NVIDIA Container Toolkit support
Hardware requirements: An NVIDIA GPU with CUDA support is required for 3D reconstruction
Access from http://localhost:9500

-----

1. FRONTEND LIBRARIES

Library                                  Version       Licence
--------------------------------------------------------------------------
Three.js, including OrbitControls        r180          MIT
Leaflet                                  1.9.4         BSD-2-Clause
osmtogeojson                             Bundled       MIT
Delaunator                               5.0.1         ISC
robust-predicates (inside Delaunator)     Bundled       Unlicense/public domain
TensorFlow.js                            4.17.0        Apache-2.0
TensorFlow COCO-SSD                       2.2.3         Apache-2.0
ONNX Runtime Web                         1.22.0        MIT
Space Grotesk font                       Google Fonts  SIL OFL 1.1
Space Mono font                          Google Fonts  SIL OFL 1.1

Bundled licence notices:
  vendor/LICENSE-THREE.txt
  vendor/leaflet-LICENSE.txt
  vendor/LICENSE-OSMTOGEOJSON.txt
  vendor/LICENSE-DELAUNATOR.txt
  vendor/LICENSE-ROBUST-PREDICATES.txt

osmtogeojson also bundles dependencies, including a Lodash custom build,
@mapbox/geojson-rewind and osm-polygon-features. Their individual notices
should be included in a complete redistribution inventory; the MIT entry
above describes osmtogeojson itself.

2. BACKEND AND TESTING LIBRARIES

Library                                  Licence
--------------------------------------------------------------------------
FastAPI                                  MIT
Uvicorn                                  BSD-3-Clause
python-multipart                         Apache-2.0
Pillow                                   MIT-CMU
NumPy                                    BSD-3-Clause, plus bundled licences
PyTorch (torch)                          BSD-style core, plus bundled licences
Torchvision                              BSD-3-Clause
Hugging Face Transformers                Apache-2.0
Ultralytics                              AGPL-3.0 or Enterprise licence
OpenCV / opencv-python-headless           Apache-2.0 for current OpenCV;
                                         additional wheel component notices
Depth Anything 3 code                    Apache-2.0
addict                                   MIT
pycolmap (optional fallback)              BSD-3-Clause
pytest                                   MIT
Playwright (browser testing)              Apache-2.0

Uvicorn's standard extras have their own licences. PyTorch's locally
installed wheel declares Apache-2.0, Apache-2.0 WITH LLVM-exception,
BSD-2-Clause, BSD-3-Clause, BSL-1.0 and MIT for its combined contents.
The locally installed NumPy metadata declares BSD-3-Clause, 0BSD, MIT,
Zlib and CC0-1.0. Preserve the notices supplied with the actual wheels.

3. AI MODELS AND WEIGHTS

Model                                    Licence
--------------------------------------------------------------------------
Depth Anything V1 Small                   Apache-2.0
  LiheYoung/depth-anything-small-hf
DA3 Small                                Apache-2.0
  depth-anything/DA3-SMALL
DA3 Giant 1.1                            CC-BY-NC-4.0 (non-commercial)
  depth-anything/DA3-GIANT-1.1
DA3 Nested Giant-Large 1.1                CC-BY-NC-4.0 (non-commercial)
  depth-anything/DA3NESTED-GIANT-LARGE-1.1
YOLO26 depth                             Ultralytics AGPL-3.0 / Enterprise terms
  yolo26n-depth.pt
CLIP                                     MIT
  openai/clip-vit-base-patch32
SAM 3                                    Custom Meta SAM License
  facebook/sam3
Browser SAM 3 conversion                 Model card declares Apache-2.0;
  rusen/sam3-browser-int8                 upstream SAM terms need checking

DA3 code and DA3 weights do not all share one licence. The default video
model and Giant 1.1 weights have non-commercial terms even though the
DA3 code is Apache-2.0. SAM 3 uses Meta's custom licence. The browser
conversion's Apache label should not be treated as proof that upstream
model obligations have been removed.

4. DOCKER AND RECONSTRUCTION COMPONENTS

Component                                Licence / qualification
--------------------------------------------------------------------------
COLMAP 3.9.1                             BSD-3-Clause for COLMAP itself
Ceres Solver 2.2.0                       BSD-3-Clause, plus third-party notices
SiftGPU bundled with COLMAP              Custom educational, research and
                                         non-profit licence
LSD bundled with COLMAP                  AGPL-3.0
CGAL                                    GPL/LGPL or commercial, by component
FreeImage                               FreeImage Public License or GPL
NVIDIA CUDA                             NVIDIA proprietary licence terms

COLMAP's BSD licence does not cover all its dependencies. The SiftGPU
licence is especially relevant to the CUDA-enabled Docker build.
The Dockerfile also installs Boost, Eigen, FLANN, METIS, glog, gflags,
GoogleTest/GoogleMock, SQLite, GLEW, ATLAS and SuiteSparse, alongside
build tools and Ubuntu packages. Their exact package versions and
component licences require a separate inventory of the built image.

5. MAP DATA AND HOSTED SERVICES

OpenStreetMap data: Open Database License (ODbL), with attribution and
other applicable database obligations. Tile-service usage policies apply
separately from the data licence.

Esri World Imagery: Esri and imagery-provider terms and attribution apply.
It should not be treated as openly licensed imagery merely because the
application can display it.

Meta API (SAM 3.1 / Spark): hosted-service terms apply separately from
the licences of locally installed libraries and model weights.

6. PRACTICAL READING GUIDE

MIT, BSD and ISC: generally permissive; retain the applicable copyright,
licence and disclaimer notices when redistributing.

Apache-2.0: generally permissive, with notice, attribution and other
conditions, including provisions concerning patents and modifications.

Unlicense/public domain: broad reuse permission under its stated terms.

AGPL-3.0: a copyleft licence with source-availability obligations in
applicable distribution and network-use situations. Ultralytics offers
separate Enterprise terms.

CC-BY-NC-4.0: attribution and non-commercial conditions apply.

SIL OFL 1.1: permits font use and redistribution subject to its conditions.

Custom licences: read the actual terms, particularly for Meta SAM,
SiftGPU, NVIDIA CUDA and hosted services.

This is a technical inventory and introductory guide, not a determination
that a particular deployment or redistribution satisfies every licence.

7. REFERENCE SOURCES

Local evidence:
  backend/requirements.txt
  Dockerfile
  vendor/ licence files listed above
  mobilenet.js, sam3local.js, map-basemaps.js and index.html
  backend model-loading code and local Python package metadata

Frontend:
  https://github.com/tensorflow/tfjs/blob/master/LICENSE
  https://github.com/tensorflow/tfjs-models/blob/master/LICENSE
  https://github.com/microsoft/onnxruntime/blob/main/LICENSE
  https://github.com/google/fonts/blob/main/ofl/spacegrotesk/OFL.txt
  https://github.com/google/fonts/blob/main/ofl/spacemono/OFL.txt

Backend and testing:
  https://github.com/pytorch/pytorch/blob/main/LICENSE
  https://github.com/huggingface/transformers/blob/main/LICENSE
  https://github.com/opencv/opencv-python/blob/4.x/LICENSE.txt
  https://www.ultralytics.com/license
  https://github.com/microsoft/playwright/blob/main/LICENSE

Models:
  https://huggingface.co/LiheYoung/depth-anything-small-hf/blob/main/README.md
  https://github.com/ByteDance-Seed/Depth-Anything-3
  https://github.com/openai/CLIP/blob/main/LICENSE
  https://huggingface.co/facebook/sam3/blob/main/LICENSE
  https://huggingface.co/rusen/sam3-browser-int8

Reconstruction and data:
  https://github.com/colmap/colmap/blob/main/doc/license.rst
  https://github.com/ceres-solver/ceres-solver/blob/2.2.0/LICENSE
  https://raw.githubusercontent.com/colmap/colmap/3.9.1/src/thirdparty/SiftGPU/LICENSE
  https://raw.githubusercontent.com/colmap/colmap/3.9.1/src/thirdparty/LSD/LICENSE
  https://www.cgal.org/license.html
  https://freeimage.sourceforge.io/license.html
  https://www.openstreetmap.org/copyright



----------------------




### Version 0.42 - item-specific answers and reusable location popup

Every labelled item now receives a persistent item ID. Process Classes sends each item independently and Identify displays only that item's answers. IDs and memberships survive project saving and appear in GeoJSON. Existing answers are linked only when their recorded point membership identifies one item; ambiguous legacy answers remain saved but must be reprocessed to attach safely.

Spark location suggestions now appear in a closable popup, reopened with **Location hints** without another request. **Choose another frame** previews one frame per second over the following ten seconds from the survey video; select a thumbnail then explicitly send it to Spark (one request). Previewing, closing and reopening make no Meta requests. The latest frame, candidates and selection are saved with the project; reselect the original video after loading a project to generate further previews. Suggestions remain starting points for manual georeferencing.

### Version 0.41 - Process Classes table, local processing and linked cameras

**Process Classes** replaces Ask Spark about classes and stays disabled until user tags or detected labels exist. Its larger popup contains a **Class / Request / Template** table with add/remove rows. Different classes and questions are submitted in one batch; the shared request limit still caps the total upstream Meta requests across every row. Each object/question uses its own template. Existing saved one-question settings migrate into the first row.

Georeferencing is optional for processing and local user tags. Registered clouds group in metres; unregistered clouds default to **500 CSS pixels in the current main 3D view**, adjustable from 1 to 10000. Only projected points in that view are considered; this is a view-dependent grouping heuristic, not a physical distance. The preview freezes its groups and chosen images. Answers and user tags can export before registration, with `geometry: null` and `local_xyz` rather than fabricated map coordinates. Later registration supplies WGS84 locations without another Spark request. Projects retain questions, answers, local coordinates and point membership.

Identify in either survey view now shows the class, an exact-point user tag where present and matching saved Spark questions/JSON answers. Point membership prevents metadata for distant same-class objects being mixed. The second 3D view shows the main camera as a small **M** marker, an orange direction indicator and a cyan up/roll tick. Drag M to translate the main camera in the second view's plane, preserving its look direction; drag the direction handle to aim it. Off-screen cameras appear as dashed edge markers. The second view's own navigation pauses only during the handle drag and resumes afterwards.

### Version 0.40.1 - one-second location frame and uncertain candidates

Spark location lookup now seeks directly to about 1.0 seconds into the original video, independently of reconstruction sampling. Very short clips use their last frame; if seeking is unsupported, the closest decoded survey frame is used and its timestamp is reported. If Spark cannot confidently pinpoint the location, it returns up to three evidence-supported candidate places/areas, shown as map markers and explicit user choices with confidence and reasons. Generic scenes with no supporting evidence still return no candidates rather than fabricated places. The lookup remains one request in parallel with reconstruction and never supplies control points or registers the cloud automatically.

### Version 0.40 - MicroGeog Mapper and class image questions

The visible app and installed-app name are now **MicroGeog Mapper**. In **Video survey → Ask Spark about classes**, enter classes, a question and a valid JSON template. The default door accessibility example uses `wheelchair` and `visualimp` as visible-issue flags (`true`, `false` or `null` when unclear), plus short reasons. Register the cloud first: same-class samples are grouped using the registered 3D distance in metres (default 5 m), so doors 100 m apart remain separate. Fixed group anchors prevent distant items merging through a chain of neighbours; manually tagged floor levels stay separate.

The home page has a separate faint-orange preparation-tools row for **Region GeoJSON** and **Resize image ZIP**. The resizer processes JPEG, PNG and WebP photos sequentially and downloads `<original>_resize.zip`, keeping image filenames, folders and EXIF GPS/heading metadata where present. Set the longest edge (default 1280 px) and JPEG/WebP quality (default 85); small images are copied unchanged and images are never enlarged. Unsupported/extra files are skipped and reported. Limits are 1 GB uploaded/uncompressed archive data, 2000 entries and 80 megapixels per image. Image resizing reduces upload size and image-loading RAM; DA3 already resizes inputs internally, so it may not increase the GPU frame budget.

Video survey also offers **Suggest a map starting point from one frame when GPS is missing** (enabled by default). After frame extraction, the backend emits one image only if no photo GPS is available. The browser launches a separate one-image `muse-spark-1.3-contributor` lookup while DA3 continues, using the existing Meta key. This is one additional API request per reconstruction run, with no retries. The model can return up to three candidates or no suggestion when there is insufficient evidence. Multiple candidates appear as map markers and a choice list; selecting a candidate zooms to it. A single suggestion centres the map, unless an existing registration or map drag should be preserved. Hints and the selected candidate are saved with the project, separately from its true georeference. Choosing a suggestion never registers/scales the cloud or supplies control pairs. Missing credentials or a failed lookup do not stop reconstruction. Contributor images may be used for training.

Preview the groups, positions, selected source images and request count before sending. The defaults are two images per item and five requests per run; hard caps are three images and twenty requests. One Meta `muse-spark-1.3-contributor` request is sent per group, sequentially, without automatic retries. The existing Meta API key in Settings is used only for the request. Contributor prompts/images may be used by Meta for training. Images are resized to at most 960 px and output is capped at 1024 tokens. Frame detections are retained for new surveys to match samples to the class and projected target; older projects use projected cloud labels, identified in the preview. Manual tags use visible source frames.

Successful answers appear on the map and are included in **Export survey**, **Download answers GeoJSON**, and saved projects. Each answer retains its own location, class, question, original JSON answer, grouping distance, source frame names/target positions, review time and token usage. JSON answer fields are also exposed as GeoJSON properties for GIS tools. Previously answered groups are skipped by default; changing the question/template/grouping/registration produces a new review. Re-registering keeps previous answers but marks their registration as changed in GeoJSON. Stop prevents subsequent requests; an already-sent request may complete and be charged. Build a new cloud or restore a project to stop an old review and load that project's saved answers. API keys and duplicated image bytes are excluded from the review snapshot.

### Version 0.39 - clear backend GPU memory in Settings

**Settings → Clear GPU memory** unloads cached DA3, SAM, depth, YOLO and CLIP models, collects unused objects and releases unused PyTorch CUDA allocations. It reports the released and remaining reserved memory. Processing requests and background workers prevent cleanup while a job is active; new requests are rejected until cleanup finishes. Saved projects, results already displayed and downloaded weights remain available. Models reload on the next run. This clears backend allocations without restarting the server; GPU memory used by the browser or other applications remains allocated.

### Version 0.38 - complete mapped region features

Region GeoJSON now requests all OpenStreetMap nodes, ways and relations in the selected region, including buildings, mapped doors and entrances, amenities, shops, barriers, roads and paths. The export preserves original tags as flat properties for Single photo matching, and uses osmtogeojson 3.0.0-beta.5 (MIT, vendored with its license) to preserve building polygons, multipolygon courtyards and route lines. Click preview features to inspect their tags. Doors and indoor details are included only where recorded in OpenStreetMap; geometry marked `tainted` is reported as incomplete. Large regions may require a closer zoom. Complete ways and relations can extend beyond the view. The visible app and offline cache are v0.38.

### Version 0.37 - download region roads and paths as GeoJSON

Home now includes **Download region GeoJSON**. Pan and zoom the map (or enter latitude/longitude), then load roads and paths in the visible region. The tool queries OpenStreetMap via Overpass, previews the results and downloads a tagged GeoJSON FeatureCollection. Complete ways may extend outside the selected bounds. Select a region less than 20 km across in each direction; loading needs internet access.

Use **Download GeoJSON** to save a reusable file, or **Use in Single photo** to load the roads directly and enable snapping. For saved files, open **Single photo → Map match → OSM area GeoJSON**, upload the file and enable **Snap to path**. Exports retain highway tags for roads, footpaths, cycleways, tracks and steps, along with OpenStreetMap attribution. The app and offline shell cache are v0.37.

### Version 0.36 - synthetic density multipliers to x1000

Synthetic densification now uses an added-point multiplier from x0 (off) to x1000, rather than percentages. x1 requests one added point per original, x10 requests ten, and x1000 requests a thousand. The boundary-aware generator still caps each preview at 2 million additions, and may reject unsupported gaps; the UI shows the actual added density and announces the cap. Existing saved projects migrate their percentage settings to equivalent multipliers on load, preserving their previous appearance.

### Version 0.35 - compact viewer tools and adjustable ground barrier

The second 3D view starts collapsed behind the 2nd 3D button. It opens only as a draggable, resizable window, and Close hides it back to the button. The main and secondary viewers each have a single bottom tool strip with icons: Camera & depth, Identify, Measure, Photos and Tag (survey mode). Georeference and Export survey remain above the views. The duplicate survey viewing controls have been removed.

Ground barrier now has a visible Ground level adjustment and Auto floor. Auto floor uses the second elevation percentile to reduce the effect of isolated low outliers; the manual level is a height above the cloud minimum, shown in metres when registered or metric. It is a flat barrier, not terrain collision detection. Each camera saves its own level and checkbox with the project.

### Version 0.34 - floating view bookmarks

The photo-set and video 3D workspaces now open their bookmarks with a compact View bookmarks button. The movable, resizable popup provides editable View1, View2 labels and a small [x] delete control on the left of each row. Saved camera poses, playback and ordering remain available. Closing the popup stops playback; reopening retains the bookmarks.

### Version 0.33 - ground barrier and directional densification

Camera & depth now includes a Ground barrier checkbox in each 3D view. It keeps the camera above the cloud minimum along the registered elevation axis (or the initial reconstruction up axis before registration), for orbit, walk, presets and bookmark flights. Each camera saves its own setting with the project. This is a flat minimum-elevation plane, not terrain collision detection.

Synthetic densification now ranges from 0 to 1000% (up to ten added points per source point, capped at 2 million additions). A k-d tree searches local neighbours, fits a local surface plane and selects the nearest geometry in eight directional sectors. Supported triangles are checked against colour discontinuities, local spacing and off-plane depth. The algorithm favours larger unfilled patches and chooses the best-spaced of four seeded random candidates per point. Thin structures use supported line segments. Colour comes from the nearest original sample and follows the selected display palette; original photo colours determine boundary rejection. Unsupported regions can produce fewer points than the percentage target. Synthetic points remain preview-only and do not add recovered detail or change original picking/exports.

### Version 0.32 - basemap selection in every map viewer

Each map has a Basemap menu: Streets, Esri aerial, Light gray and Dark gray. The gray styles use monochrome OpenStreetMap tiles with labels. Choices are remembered per map in this browser and remain available in expanded views. Switching preserves tags, registration points and the current map position. Aerial imagery retains its original colors in either app theme. App version and offline shell cache are v0.32.

### Version 0.31 - workflow titles in the app bar

All five workflows show their unnumbered title in the app bar immediately
before Home and Settings. Section headings use plain names rather than
step numbers. Video workflows no longer repeat a large page heading above
the workspace. The header title follows route changes and is hidden on
Home. The compact project controls remain in the middle of the header;
narrow screens reflow the title without horizontal scrolling. The visible
version and offline cache are both 0.31.

### Version 0.30 - compact projects, floating overview and main-view tools

Synthetic densification now accepts **0-500%** and uses seeded random
positions within local neighbour triangles, falling back to random edge
positions for collinear data. Samples remain on the local surface and copy
the nearest original point's colour. Increasing density preserves existing
random samples; reloading a project reproduces them. The preview budget is
now two million additional points. Picking and exports retain original data.

The overview's **Float** button opens the same live canvas in a movable,
resizable window. **Close** or **Dock** returns it to the inset without
resetting the camera. Its detached state and window size/position are saved
with the project. Project controls have moved into the header: **Save**
prompts for a name, and the project dropdown loads by name, renames, deletes
with a per-row cross, and offers Save as new. This replaces the large project
form above the workspace. Projects remain local to this browser.

An expandable **Classes** legend in the main viewer lists detected labels,
original point counts and their actual class colours. Its open/closed state
is saved with the view. **Identify** shows a clicked original sample's class,
including Unclassified. Identify, Measure and Photos have direct controls on
the video canvases as well as the survey toolbar. Measurements display both
endpoints and the distance in both views. Main-view picking now also snaps
synthetic points, TIN triangles and photo cutouts to the nearest original
visible sample, so these tools work across representations rather than only
near a visible original point. The shared photo-set viewer also supports
standalone measurement and identification.

TIN previews now retain up to **300,000 source vertices**, with a higher
base density and a larger spatial sampling budget. Smaller Point Size gives
a finer mesh, bounded by the available source points. No extra measured
surface detail is invented.

The visible version and offline cache are both 0.30. Browser checks cover
500% random density, the compact project menu/name prompt, floating/docking,
legend persistence, and main-view measurement/photo/identify picks on points,
synthetic density, TIN and photo mosaic.

### Version 0.29 - cloud densification, photo mosaic and TIN

The visible app and offline cache are both **0.29**. Video and photo-set
3D viewers now offer Point cloud, Photo mosaic / cutouts, and TIN triangle
mesh in the View menu. The overview can choose its own representation in
Camera & depth. Existing Gaussian output remains available where supplied.

**Synthetic densification** ranges from 0 to 100%. It inserts up to four
interpolated samples on unique nearest-neighbour pairs, with an additional
400,000-point display budget. Each added sample copies its nearest original
endpoint's current colour. Coincident samples and unusually long local gaps
are skipped. The displayed count separates original and synthetic points.
This improves display density without adding measured detail: georeference
picks, tags, measurements, map overlays and cloud exports still use original
reconstruction samples. Interpolation is displayed in Point cloud mode.

**TIN triangle mesh** triangulates local principal-plane patches of spatially
thinned original samples. The same Point Size slider controls spacing:
smaller values produce finer meshes; larger values make coarser meshes.
The display budget is 60,000 mesh vertices. Long unsupported edges and
near-collinear faces are rejected; this is a surface preview and may retain
holes or seams around complex geometry. It does not produce a watertight
reconstruction. RGB, class, height and distance colours work on the mesh;
Camera & depth also offers a wireframe toggle. Triangulation uses the bundled
[Delaunator 5.0.1](https://github.com/mapbox/delaunator), with its ISC license
and the bundled robust-predicates public-domain notice in `vendor/`.

**Photo mosaic / cutouts** places source photos with the recovered camera
orientations and intrinsics. DA3 depth maps create textured cutouts with
holes at invalid depth and sharp depth discontinuities. Photo sets without
depth images use projected cloud samples; very sparse coverage falls back
to a labelled median-depth image plane. Source RGB is retained. Camera &
depth controls photo opacity and a photo budget (64 by default, up to 250),
with even sampling across the sequence. Preview textures are capped at a
512-pixel long edge. The original sampled photos remain available in the
photo browser and project. These are overlapping photo surfaces rather than
a fused texture atlas or Gaussian reconstruction.

Preview generation runs in a module worker to keep navigation responsive.
Representation, densification, TIN wireframe and mosaic settings are saved
with each project's independent camera views. Camera FOV/depth clipping,
orbit/walk controls and original-point survey tools remain available.

Checks include exact nearest-neighbour comparisons, endpoint colours,
horizontal and vertical mesh area, gap rejection, mesh density changes,
camera/depth photo placement and real WebGL/worker browser checks:
`node tests/cloud-representations.browser.cjs`. The existing workflow and
project browser checks also cover these additions and project reloads.

### Version 0.28 - survey workspace and projects

The visible app version and offline shell cache are both 0.28. For each
release, update the title/header in `index.html` and `CACHE` in `sw.js`
together. Browser checks verify the visible release version.

All workflows expose SAM 3.1 API object tagging with the shared Settings
key. Video-only tagging is optional; detected cloud label centroids become
map tags after manual registration. The video frame budget now accepts up
to **250** in both UI and backend; the default stays 16. Real GPU memory
requirements increase with frame count.

The video survey uses the page width, a large main cloud view and a smaller
resizable overview. Drag the divider to resize the cloud/map split. Each
survey tool opens a movable, resizable nonmodal window, and source photos
appear in a viewport-bound window with comma/period browsing. The main
viewer and overview have independent Camera & depth controls: ORBIT mode
pans with a plain drag and spins with Ctrl + drag; WALK mode drags to look
from the current camera position, with WASD movement. FOV ranges from 25 to
110 degrees. Camera-depth clipping has a minimum slider above the range
line and maximum slider below; bounds remain at least one metre/unit apart.
Clipped points cannot be selected. Camera presets follow the first camera's
axes; the existing level-camera registration assumption still applies.

Save, Save as new, Load, Rename and Delete manage projects in this browser's
IndexedDB. Saved projects contain reconstruction results, sampled source
photos, labels, control pairs, tags, registration, camera poses, camera
filters and tool-window positions. They exclude API keys and the original
video. Load works after reloading the page. Clearing site storage removes
these local projects; they are not synchronized to a server.

Map POINT tags can be edited by clicking them: name, latitude/longitude,
indoor/outdoor and floor. Survey map tags can also be dragged. Changes are
reflected in GeoJSON exports. Dragging numbered georeference markers
re-registers automatically by default, updating the cloud overlay and tag
world coordinates; the registration window has a toggle for manual-only
refinement. Source data remains in reconstruction coordinates.

### Video-only registered survey

Control points can be corrected individually with **Move 3D**, **Move map**,
or **Delete** in the numbered list. Click a numbered cloud marker to select
it for repositioning, then click its corrected cloud position; either 3D
view can supply that position. Map markers are draggable, or use Move map
and click the corrected position. Escape or Cancel point edit abandons an
unfinished edit. Edits clear the old registration overlay and disable
survey export until **Register cloud on map** is run again; tags then use
the updated transform. Deleting control point 1 clears its elevation input.

The survey has two independent 3D views showing the same geometry, control
points, tags and measurements. The second view supports free orbit plus
Top/down, Bottom/up, Left, Right, Front, Back and Perspective presets in
the first camera's coordinate frame. **Copy main angle** copies the main
camera into the second view. Changing either camera leaves the other in
place. Both views share the colour, brightness, size and camera-overlay
controls; the second view displays cloud points for precise picking.

Choose **Video to registered 3D survey** (or `?workflow=video-survey`) and upload a video directly. It uses the existing nested DA3 Giant-Large 1.1 pipeline without a reference photo or semantic API key. Match three or more non-collinear cloud/map points, then register; the map displays the transformed cloud and the fit reports horizontal RMS and per-pair residuals. Undo pairs to correct mistakes.

The horizontal similarity fit assumes the first camera was level. Elevation is relative to control point 1 unless its surveyed elevation is supplied. Measurements use the fitted scale after registration. TAG creates individual world-coordinate POINT features with a name, indoor/outdoor flag and indoor floor level. Export survey downloads GeoJSON tags plus the registration and control pairs; PLY retains original reconstruction coordinates. Edits are held in this browser tab until exported.

Photos / region finds sampled video frames by projection and coarse depth visibility, marks the chosen location, and supports previous/next buttons and comma/period or angle-bracket keys. A nonzero radius searches a surrounding region; candidate visibility is approximate. Only the frames sampled for reconstruction are available.

# MicroGeo Tool — SAM test PWA

### Reconstruction and viewer update

Version **0.27** gives both photo-ZIP workflows the single-photo console
layout: upload, objects, processing and results above a large model/map
stage, with the final export bar always accessible on desktop. Choose
**COLMAP Dense**, **DA3 Small**, or **DA3 Giant 1.1** for reconstruction;
SAM object labelling starts enabled for every choice. **Map photo features**
can also run from the same ZIP; the map tabs select which mapped results
the GeoJSON button exports. Point clouds download separately as PLY/XYZ,
with 100% of the displayed cloud selected by default.

DA3 photo reconstruction uses the official
[Small](https://huggingface.co/depth-anything/DA3-SMALL) and
[Giant 1.1](https://huggingface.co/depth-anything/DA3-GIANT-1.1) checkpoints.
These have relative scale; geographic exports require a reliable multi-photo
EXIF GPS fit. The video route retains its metric nested Giant-Large model.
All engines build from clean photos and label disposable copies afterwards.
The `/api/sfm` field `reconstruction_engine` selects `colmap` (default),
`da3-small`, or `da3-giant`. Existing API callers retain the explicit
`label_objects=1` opt-in; the UI now sends that by default.

Both 3D viewers add **Height above lowest point**, alongside RGB, class
and camera-distance colours. Height uses the fitted geographic vertical
where available, otherwise the initial viewer vertical, and stays fixed
while navigating. Video Gaussian views support height/distance colouring;
class colours use the labelled point-cloud view.

Reconstructed GeoJSON features are per-label centroid points (or principal
axis lines for `|line` prompts), not one feature per cloud point. They
summarise all geometry carrying a label rather than identifying separate
instances of the same object type. Unaligned clouds remain exportable as
PLY/XYZ, while mapped-feature export waits for GPS alignment and labels.

Validation includes mocked DA3 photo requests with both model choices,
pixel-frame conversion for original-photo labels, clean geometry inputs,
height invariance during navigation, responsive console layouts and both
export types. Real model-weight/GPU execution still needs target-host QA.

Version **0.26** compacts the home page and adds small **Home** and
**Settings** controls in the title bar. All routes share the SAM 3.1 API
key in Settings and finish with GeoJSON export. Photos use uploaded EXIF
or manually entered locations; live GPS/compass capture is removed.
Each workflow has a map and an **Expand map** dialog. Leaflet is bundled
locally; base-map tiles still need internet access.

The 3D viewers support **WASD** movement, **Q/E** yaw, **Z/C** roll,
**R/F** rise/lower, **Home** fit, and brightness and point-size controls.
Click the canvas to use the keys; Shift moves faster. Camera bookmarks
can be renamed, reordered, deleted or played with 1.4-second glides and
0.1-second pauses. Only camera poses are stored in browser storage, keyed
to the loaded cloud, and can be restored when the same cloud is loaded.

Photo-set clouds are aligned to the map with a robust similarity fit
between registered camera centres and EXIF GPS. At least three distinct,
non-collinear positions are required; the UI reports the fit RMS and
whether camera heights were assumed level. Invalid GPS fits leave the
cloud local. Maps show a sampled top-down cloud overlay (up to 20,000
points). GeoJSON uses WGS84 after alignment; unaligned points have null
geometry and retain their local XYZ in properties, avoiding false map
coordinates. PLY/XYZ retain reconstruction coordinates.

Video retains **DA3NESTED-GIANT-LARGE-1.1** by default. Select
**Point cloud + Gaussian splatting** before processing to request DA3's
Gaussian branch, then switch display modes without rebuilding. The web
renderer uses anisotropic scales, rotations, opacity, depth sorting and
DC spherical harmonic colour, capped at 100,000 Gaussians. It does not
evaluate higher-order view-dependent harmonics. This follows the
[official DA3 inference contract](https://github.com/ByteDance-Seed/Depth-Anything-3/blob/main/docs/API.md).
The backend must have a recent DA3 installation with Gaussian support
and enough GPU memory. Mock inference tests exercise the payload and
renderer; real GPU inference still needs validation on the target host.

Checks: `node --test tests/*.test.mjs`; `.venv-win/Scripts/python -m
pytest backend/test_georeference.py backend/test_da3.py backend/test_geo.py
backend/test_sfm_image_isolation.py backend/test_sfm_diagnostics.py -q`.
With Playwright installed and a static server running on port 9517,
`node tests/workflows.browser.cjs` exercises all routes, maps, exports,
keyboard movement, bookmarks and Gaussian rendering with mocked inference.
Set `BROWSER_CHANNEL=msedge` to use an installed Edge browser.

Version **0.25** renames the app to **MicroGeo Tool** and refines the
starting page with a larger, centered blue donut menu, finer dotted
outlines, a central brand mark, and clearer workflow descriptions.
The responsive layout supports both light and dark themes.

Version **0.24** adds a landing page: a four-quadrant donut where each
quadrant opens its workflow sub-page (single photo, photo set → pins,
photo set → 3D, photo + video → DA3 cloud), replacing the top-of-page
mode picker. Deep links work via `?workflow=<name>`.

Version **0.23** adds a fourth workflow, **Photo + video → DA3 cloud**
(the mode picker now offers single photo, photo-set points, photo-set
3D, and photo + video). Upload a zip with ONE photo (EXIF GPS + heading
locates the start) and a short video: the server samples frames, runs
Depth Anything 3 (`DA3NESTED-GIANT-LARGE-1.1`, metric metres) to build
a point cloud, tags points with the same concept detectors (SAM 3 /
CLIP / Meta SAM 3.1 per frame), and projects per-label features onto
the map — centroid pins, or PCA-endpoint lines for `|line` labels —
with optional OSM building-outline snap. Assumes the video starts
where the photo was taken, looking the same way. Real inference needs
a CUDA GPU (weights ~6.8 GB, CC BY-NC 4.0; downloaded once into the
/hf-cache volume). Docker installs `depth-anything-3` at build time
(verified live on an RTX 4080); elsewhere use `pip install
git+https://github.com/ByteDance-Seed/depth-anything-3.git addict`, or
`MOCK_DA3=1` for an offline synthetic pass.
Existing routes are untouched; the cloud renders in the shared SfM
viewer stack.

DA3 defaults to a one-million-point budget, full-pixel back-projection
and a 16-frame GPU budget, configurable in the page. Sampling targets 10 fps
within that budget and covers the complete clip, including codecs with no
frame count. Black title/blank frames are excluded before inference; the
first usable scene frame is the reference. Disable title filtering for
genuinely dark footage.

Confidence filtering follows the official Space's threshold logic. Optional
cross-view cleanup rejects unsupported depths; near-black-pixel filtering is
separate and disabled by default. Standard/high detail mirror the Space's
504-pixel long/short-edge resize options. Higher frame counts/resolution use
more GPU memory. Colored wireframe cameras/path, point-size adjustment,
PLY download and diagnostics download are available below the controls.

The app reports the actual inference device/GPU name. It still has no pose
refinement, loop closure or TSDF fusion; longer sequences need a streaming
or SLAM pipeline. The photo supplies GPS/heading only and is not a matched
DA3 input view. See [the DA3 comparison and fixes](DA3_REVIEW.md) for details.

Version **0.22** declutters the console strip: detector + depth setup
moves to a one-time **Config** dialog, location & heading to a popup on
the Photo card (only needed without EXIF), Send to SAM sits with the
Objects card, and the two download buttons shrink to one **Export**
menu. Prompts take `|line` (`steps |line`) to draw a feature as a map
polyline instead of a point pin. A new **Map match** card uploads an
OSM-area GeoJSON, marks its points of interest on the map, matches each
detection to nearby same-kind features (known entrances included), and
offers **Snap to path**, which moves pins onto the nearest OSM
path/road within tolerance — matching, map, and exports all use the
moved positions. The map gains Esri aerial + Stamen B&W base layers
(layer switcher, top right), zoom to 22, a metre measure tool with 5 m
ticks, and hover readouts (class over the photo, metres over depth).
(Stamen tiles come from Stadia Maps; heavy use needs a free API key.)
YOLO26-depth is now bundled in Docker (weights baked in, no download).

Version **0.21** turns single-photo mode into a fixed console: the five
workflow cards sit in a top strip (~1/4 of the height) while photo +
depth (left) and the map (right) fill the stage below (~3/4), with no
page scrolling on desktop — narrow screens keep the stacked layout.
Picking a new photo now clears the previous photo's manual location
override, so a drag-correction can no longer hijack the new photo's
EXIF on Send or Re-project.

Version **0.20** turns Expand viewer into a YouTube-style theatre mode:
the stage widens toward full viewport width but stays in the page flow,
so the page scrolls normally instead of a fullscreen takeover.

Version **0.19** caps the SAM labels list at a scrollable box so a long
detection list no longer pushes the 3D view down the page.

Version **0.18** moves the Display, minimap / telemetry, and icon toolbar
out of the 3D viewport into a static side console beside it (stacked
below it on narrow screens), so nothing covers the point cloud. The
blueprint styling is unchanged; the empty-state note now centres on the
viewport itself.

Version **0.17** restyles the app with a "spatial computing / blueprint"
aesthetic (dark default): navy grid backdrop, glass HUD panels with
corner brackets, Space Grotesk/Mono type, floating display + minimap /
telemetry panels over a full-bleed 3D viewport, bottom-centre icon
toolbar driving the existing viewer actions, and a segmented progress
bar. Functionality is unchanged; the light theme stays available via
the header toggle.

Version **0.16** restyles the UI (app bar, theme-token surfaces) and adds
a light/dark mode toggle in the header, persisted in `localStorage`
(`mg.theme`), defaulting to the OS scheme.

Version **0.15** replaces the previous viewer with a port of the main
viewer in `E:\Data\Agents\Codex_workspace\SLAM\SLAM-image-1`.
`view-navigation.js`, `view-roll.js`, `point-identify.js`,
`viewer-annotations.js`, and the Three.js r180/OrbitControls files are
copied from that app. `slam-viewer.js` adapts this app's point/color/label
arrays to its camera, material, fit/top and render loop. Assets are served
locally. The old custom framing, projection switching and drag-strip code
have been removed. Fit view, Top, Reset roll and Expand viewer are available.

Version **0.14** adds **Fit bounding box**, **Top**, **Photo view**,
**Reset roll**, and zoom buttons. Fit uses all eight bounding-box corners
and the viewport aspect ratio in both perspective and orthographic modes.
Navigation defaults to Orbit. View roll is separate from OrbitControls'
up direction, and points use a constant screen size with depth testing.
While the canvas is focused, F fits the cloud, R resets roll, and +/− zoom.

Version **0.13** adds an explicit **Use SAM / object labelling after
reconstruction** checkbox, off by default. Geometry always uses clean,
upright photos. Optional detection runs only after sparse/dense reconstruction
and receives separate in-memory image copies. Clean input previews are read
from the actual COLMAP files; browser annotations are drawn on separate
canvases. The `/api/sfm` field `label_objects=1` enables labelling; its default
is `0`, which ignores concepts and supplied detections and skips all label voting.

The 3D viewer now uses a narrower 40° perspective lens, fits the cloud
to the viewport aspect ratio, and offers an orthographic projection.
The photo-location map beside it shows EXIF GPS, with registered photos
in dark blue and unregistered photos in amber. The cloud remains in COLMAP's
local frame: it is not aligned to north or calibrated to geographic metres.

Upright photos retain their focal-length and GPS EXIF when written for
COLMAP, with orientation removed and pixel dimensions corrected. Dense
stereo explicitly enables geometric consistency and fuses the geometric
depth maps. Dense processing needs CUDA; CPU requests return sparse geometry.

Both ZIP routes now offer **Meta API · SAM 3.1**, using the entered token
via the backend and the existing Meta Responses request format. Requests
are sent to `https://api.meta.ai/v1/responses`; tokens are not included in
results or logs. Original-pixel boxes are restored after API image resizing.
This is box-based point labelling; pixel masks and occlusion-aware semantic
fusion are not implemented. Server SAM remains available separately and
`MOCK_SAM=1` produces demo boxes, identified in reconstruction notes.

The monocular routes default to `LiheYoung/depth-anything-small-hf`
(Depth Anything **V1** Small), not Depth Anything V3. Their displayed
metres are heuristic estimates, not metric calibration. A metric
alternative exists — YOLO26-depth (`yolo26n-depth.pt`, needs
`pip install "ultralytics>=8.4.104"`) — selected per request with
`depth_backend=yolo` or server-wide with `DEPTH_BACKEND=yolo`.

Rebuild/restart Docker with `docker compose up --build -d` to use the changes.
Real photo reconstruction and a live Meta request need validation on the
Docker GPU host with your images and API key.

Test page: upload a photo (or use the phone camera), type object prompts
(`door, steps`), grab GPS, send to SAM 3.1, draw the returned bounding
boxes, export GeoJSON for mapping later, and download a
full-resolution PNG of the annotated photo.


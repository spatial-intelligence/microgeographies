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
3. **Monocular depth.** `backend/depth.py` runs Depth Anything V1
   Small (`LiheYoung/depth-anything-small-hf`, ~100 MB first download)
   to get relative depth; the median over each box is mapped linearly
   to metres (`relative_to_metric`, far end = `max_range`, default
   30 m). Single-image depth is scale-ambiguous, so treat pins as
   approximate. The alternative YOLO26-depth backend (`yolo26n-depth.pt`)
   predicts metric metres directly, so the box median is used as the
   range with `max_range` acting only as a ceiling; each `geo` carries
   `range_source` (`"relative"` | `"metric"`) so you can tell which.
   Every reply also carries `depth_png`: the depth map colorized
   turbo-style (blue far → red near, like Depth Anything V3 outdoor
   visualizations), shown under Results, plus `depth_backend` /
   `depth_model` naming what produced it.
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
| `/api/detect`  | `image`, `concepts`, `lat`, `lon`, `heading`, `hfov`, `max_range`, `project`, `depth_backend`, `model` | boxes + `geo`/`snapped` per detection, `location`, `gps_source` |
| `/api/project` | `image`, `boxes` (Meta SAM-3.1 xyxy JSON), same geo fields | projected detections (used by the page for Meta-direct boxes) |
| `/api/depth`   | `image`, `depth_backend`, `model` | 80×60 relative-depth grid (0 = far, 1 = near) + `exif_gps` (+ `metric_grid` on the YOLO backend) |

Pure geometry/EXIF helpers have unit tests with no model or network:

```sh
.venv/bin/python backend/test_geo.py             # pure geometry/EXIF, no deps beyond Pillow
.venv/bin/python backend/test_yolo_depth.py       # depth-backend routing + metric pipeline (mock weights)
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
COLMAP automatically shares calibration for matching EXIF camera/focal
metadata and pixel dimensions, on both the CLI and pycolmap paths.
Different portrait/landscape dimensions stay separate, while photos
from the same camera can constrain one focal/distortion estimate.
Zip entries sharing a
filename in different folders are renamed (`name__2.jpg`, …) instead of
overwriting each other, and the reply gains per-photo `orientations`.
After parsing, every COLMAP camera is checked against the upright
photo it claims to describe: a swapped or mismatched width/height adds
an explicit warning rather than returning a silently warped cloud.

The viewer initially faces the scene using the first registered camera's
orientation. Dense stereo is bounded to 1600 pixels and fusion uses a
minimum support count of 3, matching the comparison SLAM-image-1 app's
defaults. Connected models are selected by registered-photo count before
point count/size. Download diagnostics after a reconstruction to inspect
camera calibration groups, focal/FOV estimates, sparse reprojection error,
track lengths, and verified matches for every image pair. These diagnostics
describe internal consistency; they do not certify geometric accuracy.

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

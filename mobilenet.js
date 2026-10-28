/* MicroGeo in-browser MobileNet object detection (coco-ssd, MobileNetV2
 * backbone, via TensorFlow.js). ES2019 only (no ?? or ?.) so the pure
 * parts run under old test runners.
 *
 * Unlike SAM/CLIP this finds a fixed vocabulary (~80 COCO kinds:
 * person, car, chair, bottle, dog, ...) with boxes — no text prompts.
 * The scripts (~600 KB) and model weights (~7 MB) download once, then
 * the browser HTTP cache serves them offline; detection itself runs
 * locally with WebGL acceleration when available.
 *
 * window.MG_MOBILE = { ensureModel(onProgress), detect(source),
 *   toDetections(preds) }
 */
(function () {
  "use strict";

  var TF_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js";
  var COCO_URL = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";
  var SCORE_MIN = 0.3;
  var BOX_MAX = 20;

  var model = null;
  var loading = null;

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("could not load " + url + " (internet needed once)")); };
      document.head.appendChild(s);
    });
  }

  // Download (once) + compile the detector. onProgress(label, frac).
  function ensureModel(onProgress) {
    onProgress = onProgress || function () {};
    if (model) return Promise.resolve({ model: model, cached: true });
    if (loading) return loading;
    loading = Promise.resolve()
      .then(function () {
        onProgress("mobilenet", 0);
        if (!window.tf) return loadScript(TF_URL);
      })
      .then(function () {
        onProgress("mobilenet", 0.3);
        if (!window.cocoSsd) return loadScript(COCO_URL);
      })
      .then(function () {
        onProgress("mobilenet", 0.6);
        // mobilenet_v2 base: smallest, fastest in the browser.
        return window.cocoSsd.load({ base: "mobilenet_v2" });
      })
      .then(function (m) {
        model = m;
        onProgress("mobilenet", 1);
        return { model: model, cached: false };
      })
      .then(null, function (e) {
        loading = null; // let a later attempt retry
        throw e;
      });
    return loading;
  }

  // preds from model.detect(): [{bbox: [x,y,w,h], class, score}] in
  // source pixels -> app.js box shape (xyxy pixels, like other paths).
  function toDetections(preds) {
    var out = [];
    var sorted = (preds || []).slice().sort(function (a, b) { return b.score - a.score; });
    for (var i = 0; i < sorted.length && out.length < BOX_MAX; i++) {
      var p = sorted[i];
      if (!(p.score >= SCORE_MIN)) continue;
      var bb = p.bbox || [];
      var x = Number(bb[0]), y = Number(bb[1]);
      var w = Number(bb[2]), h = Number(bb[3]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) continue;
      if (w <= 0 || h <= 0) continue;
      out.push({ label: p.class || "object",
        box: [x, y, x + w, y + h],
        score: p.score, format: "xyxy", mobilenet: true });
    }
    return out;
  }

  // source: image/canvas/video element. Returns app-shaped detections.
  function detect(source) {
    if (!model) throw new Error("model not loaded — call ensureModel first");
    return model.detect(source).then(toDetections);
  }

  window.MG_MOBILE = {
    ensureModel: ensureModel,
    detect: detect,
    toDetections: toDetections,
    SCORE_MIN: SCORE_MIN
  };
})();

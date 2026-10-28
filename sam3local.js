/* MicroGeo in-browser SAM3 INT8 (rusen/sam3-browser-int8 via ONNX Runtime Web).
 * ES2019 only (no ?? or ?.) so the pure parts run under old test runners.
 * Needs ort (onnxruntime-web) loaded; needs WebGPU for practical speed
 * (WASM fallback works but is ~10x slower). ~930 MB downloads once into
 * Cache Storage, then runs fully offline.
 *
 * window.MG_SAM3 = { MODELS, loadTokenizerData, encodeText,
 *   ensureSessions(onProgress), encodeImage(pixels1008), detect(feats, concept) }
 */
(function () {
  "use strict";

  var HF = "https://huggingface.co/rusen/sam3-browser-int8/resolve/main/";
  var MODELS = [
    { key: "image", url: HF + "sam3_image_encoder.onnx", bytes: 488260684 },
    { key: "language", url: HF + "sam3_language_encoder.onnx", bytes: 406087074 },
    { key: "decoder", url: HF + "sam3_decoder.onnx", bytes: 36369646 },
    { key: "tokenizer", url: HF + "clip_tokenizer.json", bytes: 1487431 }
  ];
  var CACHE = "microgeo-sam3";
  var BOX_SCORE_MIN = 0.5;
  var BOX_MAX_PER_CONCEPT = 5;

  var sessions = null;
  var tokData = null;
  var providers = null;
  var fellBack = false;
  var pendingFiles = null;

  function loadTokenizerData(obj) {
    var byteEnc = {};
    Object.keys(obj.byte_encoder).forEach(function (k) { byteEnc[parseInt(k, 10)] = obj.byte_encoder[k]; });
    var rank = {};
    obj.merges.forEach(function (m, i) {
      var p = m.split(" ");
      rank[p[0] + "\u0000" + p[1]] = i;
    });
    tokData = { encoder: obj.encoder, byteEnc: byteEnc, rank: rank };
    return tokData;
  }

  function bpe(word, rank) {
    function pairs(w) {
      var s = [], prev = w[0], i, ch;
      for (i = 1; i < w.length; i++) {
        ch = w[i];
        s.push(prev + "\u0000" + ch);
        prev = ch;
      }
      return s;
    }
    var ps = pairs(word);
    while (ps.length) {
      var best = null, bestRank = Infinity, i;
      for (i = 0; i < ps.length; i++) {
        var r = (ps[i] in rank) ? rank[ps[i]] : Infinity;
        if (r < bestRank) { bestRank = r; best = ps[i]; }
      }
      if (best === null || bestRank === Infinity) break;
      var parts = best.split("\u0000");
      var first = parts[0], second = parts[1];
      var nw = [], idx = 0;
      while (idx < word.length) {
        var j = word.indexOf(first, idx);
        if (j < 0) { nw = nw.concat(word.slice(idx)); break; }
        nw = nw.concat(word.slice(idx, j));
        idx = j;
        if (idx < word.length - 1 && word[idx + 1] === second) { nw.push(first + second); idx += 2; }
        else { nw.push(word[idx]); idx += 1; }
      }
      word = nw;
      if (word.length === 1) break;
      ps = pairs(word);
    }
    return word;
  }

  // CLIP BPE encode -> array of token ids (without START/END).
  function encodeText(text) {
    if (!tokData) throw new Error("tokenizer not loaded");
    var ids = [];
    text.toLowerCase().split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      var bytes = [];
      for (var i = 0; i < tok.length; i++) {
        var code = tok.charCodeAt(i);
        // ASCII fast path; astral-plane chars via surrogate pair encode
        if (code >= 0xD800 && code <= 0xDBFF && i + 1 < tok.length) {
          var lo = tok.charCodeAt(i + 1);
          bytes.push.apply(bytes, Array.from(
            String.fromCharCode(code, lo)).map(function (c) { return c.charCodeAt(0); }));
          i++;
        } else {
          // UTF-8 encode this code point
          var s = String.fromCharCode(code);
          for (var k = 0; k < s.length; k++) {
            var c2 = s.charCodeAt(k);
            if (c2 < 128) bytes.push(c2);
            else if (c2 < 2048) bytes.push(192 | (c2 >> 6), 128 | (c2 & 63));
            else bytes.push(224 | (c2 >> 12), 128 | ((c2 >> 6) & 63), 128 | (c2 & 63));
          }
        }
      }
      var chars = bytes.map(function (b) { return tokData.byteEnc[b]; });
      chars[chars.length - 1] += "</w>";
      bpe(chars, tokData.rank).forEach(function (piece) {
        if (piece in tokData.encoder) ids.push(tokData.encoder[piece]);
      });
    });
    return ids;
  }

  function tokens32(concept) {
    var t = [49406].concat(encodeText(concept)).concat([49407]);
    while (t.length < 32) t.push(0);
    return t.slice(0, 32);
  }

  function fetchCached(url, onProgress, label, total) {
    return caches.open(CACHE).then(function (cache) {
      return cache.match(url).then(function (hit) {
        if (hit) {
          onProgress(label, 1);
          return hit.arrayBuffer();
        }
        return fetch(url).then(function (res) {
          if (!res.ok) throw new Error("download failed: " + url);
          var loaded = 0;
          var reader = res.body.getReader();
          var chunks = [];
          function pump() {
            return reader.read().then(function (r) {
              if (r.done) return;
              chunks.push(r.value);
              loaded += r.value.length;
              onProgress(label, total ? loaded / total : 0);
              return pump();
            });
          }
          return pump().then(function () {
            var buf = new Uint8Array(loaded);
            var off = 0;
            chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
            cache.put(url, new Response(buf.slice(0), { headers: { "content-type": res.headers.get("content-type") || "application/octet-stream" } }));
            onProgress(label, 1);
            return buf.buffer;
          });
        });
      });
    });
  }

  function loadOrt() {
    if (window.ort) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js";
      s.onload = resolve;
      s.onerror = function () { reject(new Error("could not load onnxruntime-web (internet needed once)")); };
      document.head.appendChild(s);
    });
  }

  function provider() {
    return (navigator.gpu ? ["webgpu", "wasm"] : ["wasm"]);
  }

  function makeSessions(p) {
    providers = p;
    function make(buf) { return window.ort.InferenceSession.create(buf, { executionProviders: p }); }
    return Promise.all([make(pendingFiles.image), make(pendingFiles.language), make(pendingFiles.decoder)])
      .then(function (ss) {
        sessions = { image: ss[0], language: ss[1], decoder: ss[2] };
        return sessions;
      });
  }

  // Run through runFn; when WebGPU chokes on a quantized op mid-run
  // (e.g. GatherND on int64), rebuild everything on WASM and retry once.
  function runWithFallback(runFn) {
    return runFn().then(null, function (e) {
      if (providers && providers[0] === "webgpu" && !fellBack) {
        fellBack = true;
        return makeSessions(["wasm"]).then(runFn);
      }
      throw e;
    });
  }

  // Download (once) + compile the 3 sessions + tokenizer. onProgress(label, frac).
  function ensureSessions(onProgress) {
    onProgress = onProgress || function () {};
    if (sessions && tokData) return Promise.resolve({ sessions: sessions, wasmFallback: fellBack });
    return loadOrt().then(function () {
      var files = {};
      var chain = Promise.resolve();
      MODELS.forEach(function (m) {
        chain = chain.then(function () {
          return fetchCached(m.url, onProgress, m.key, m.bytes).then(function (buf) { files[m.key] = buf; });
        });
      });
      return chain.then(function () {
        loadTokenizerData(JSON.parse(new TextDecoder().decode(files.tokenizer)));
        pendingFiles = files;
        return makeSessions(provider()).then(function () {
          return { sessions: sessions, wasmFallback: fellBack };
        }, function (e) {
          // WebGPU balks at some quantized ops: fall back to pure WASM.
          if (provider()[0] === "webgpu") {
            fellBack = true;
            return makeSessions(["wasm"]).then(function () {
              return { sessions: sessions, wasmFallback: true };
            });
          }
          throw e;
        });
      });
    });
  }

  // pixels: Uint8Array CHW RGB 1008x1008. Returns encoder feature tensors.
  function encodeImage(pixels) {
    var t = new window.ort.Tensor("uint8", pixels, [3, 1008, 1008]);
    return runWithFallback(function () { return sessions.image.run({ image: t }); }).then(function (out) {
      return {
        vision_pos_enc_2: out.vision_pos_enc_2,
        backbone_fpn_0: out.backbone_fpn_0,
        backbone_fpn_1: out.backbone_fpn_1,
        backbone_fpn_2: out.backbone_fpn_2
      };
    });
  }

  // feats from encodeImage; origW/H = sent-image size boxes map into.
  function detect(feats, concept, origW, origH) {
    var tk = tokens32(concept);
    var t = new window.ort.Tensor("int32", Int32Array.from(tk), [1, 32]);
    return runWithFallback(function () { return sessions.language.run({ tokens: t }); }).then(function (lang) {
      function scalar(v) { return new window.ort.Tensor("int32", Int32Array.of(v), []); }
      var feed = {
        original_height: scalar(origH),
        original_width: scalar(origW),
        vision_pos_enc_2: feats.vision_pos_enc_2,
        backbone_fpn_0: feats.backbone_fpn_0,
        backbone_fpn_1: feats.backbone_fpn_1,
        backbone_fpn_2: feats.backbone_fpn_2,
        language_mask: lang.text_attention_mask,
        language_features: lang.text_memory,
        box_coords: new window.ort.Tensor("float32", new Float32Array(4), [1, 1, 4]),
        box_labels: new window.ort.Tensor("int32", Int32Array.of(1), [1, 1]),
        box_masks: new window.ort.Tensor("bool", new Uint8Array([1]), [1, 1])
      };
      return runWithFallback(function () { return sessions.decoder.run(feed); });
    }).then(function (out) {
      var boxes = out.boxes.data, scores = out.scores.data;
      var n = scores.length, idx = [];
      for (var i = 0; i < n; i++) idx.push(i);
      idx.sort(function (a, b) { return scores[b] - scores[a]; });
      var kept = [];
      for (var k = 0; k < idx.length && kept.length < BOX_MAX_PER_CONCEPT; k++) {
        var i2 = idx[k];
        if (scores[i2] < BOX_SCORE_MIN) break;
        kept.push({ label: concept,
          box: [boxes[i2 * 4], boxes[i2 * 4 + 1], boxes[i2 * 4 + 2], boxes[i2 * 4 + 3]],
          score: scores[i2], format: "xyxy" });
      }
      return kept;
    });
  }

  window.MG_SAM3 = {
    MODELS: MODELS,
    loadTokenizerData: loadTokenizerData,
    encodeText: encodeText,
    ensureSessions: ensureSessions,
    encodeImage: encodeImage,
    detect: detect,
    wasFallback: function () { return fellBack; }
  };
})();

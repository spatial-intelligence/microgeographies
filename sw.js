const CACHE = "microgeo-v17"; // bump whenever the shell changes, or updates never reach installed users
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./sfm3d.js", "./exif.js", "./sam3local.js", "./mobilenet.js", "./config.js", "./manifest.webmanifest", "./icon.svg"];
// Pinned separately: the ONNX Runtime Web files (small) live here after
// first use; the 700 MB SAM weights live in "microgeo-sam3", written by
// the page itself. Neither is ever precached or wiped with the shell.
// MobileNet's tfjs/coco-ssd scripts and weights cache here too after
// first use, so that detector works offline as well.
const VENDOR_CACHE = "microgeo-vendor";
const MODEL_CACHE = "microgeo-sam3";
const ORT_CDN = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
const TF_CDN = "https://cdn.jsdelivr.net/npm/@tensorflow/";
const TFHUB = ["https://storage.googleapis.com/tfjs-models/", "https://tfhub.dev/"];
const THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.186.1/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== VENDOR_CACHE && k !== MODEL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheFirst(e, cacheName) {
  e.respondWith(
    caches.open(cacheName).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) c.put(e.request, res.clone());
      return res;
    })))
  );
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  if (e.request.url.startsWith(ORT_CDN)) { cacheFirst(e, VENDOR_CACHE); return; }
  if (e.request.url.startsWith(TF_CDN)) { cacheFirst(e, VENDOR_CACHE); return; }
  if (TFHUB.some((h) => e.request.url.startsWith(h))) { cacheFirst(e, VENDOR_CACHE); return; }
  if (e.request.url.startsWith(THREE_CDN)) { cacheFirst(e, VENDOR_CACHE); return; }
  if (!e.request.url.startsWith(self.location.origin)) return;
  cacheFirst(e, CACHE);
});

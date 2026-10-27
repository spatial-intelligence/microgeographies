const fileEl = document.getElementById('file');
const conceptsEl = document.getElementById('concepts');
const apiBaseEl = document.getElementById('apiBase');
const sendBtn = document.getElementById('sendBtn');
const statusEl = document.getElementById('status');
const preview = document.getElementById('preview');
const overlay = document.getElementById('overlay');
const resultEl = document.getElementById('result');
const gpsBtn = document.getElementById('gpsBtn');
const gpsOut = document.getElementById('gpsOut');

let gps = null;
let objectUrl = null;

gpsBtn.addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    gpsOut.textContent = 'Geolocation not supported on this device.';
    return;
  }
  gpsOut.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gps = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      };
      gpsOut.textContent = `lat ${gps.lat.toFixed(6)}, lon ${gps.lon.toFixed(6)} (±${Math.round(gps.accuracy)}m)`;
    },
    (err) => {
      gpsOut.textContent = `Location failed: ${err.message} (needs HTTPS + permission)`;
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

fileEl.addEventListener('change', () => {
  const f = fileEl.files[0];
  if (!f) { sendBtn.disabled = true; return; }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(f);
  preview.src = objectUrl;
  preview.hidden = false;
  preview.onload = () => {
    overlay.width = preview.clientWidth;
    overlay.height = preview.clientHeight;
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
  };
  sendBtn.disabled = false;
});

window.addEventListener('resize', () => {
  if (!preview.naturalWidth) return;
  overlay.width = preview.clientWidth;
  overlay.height = preview.clientHeight;
});

sendBtn.addEventListener('click', async () => {
  const f = fileEl.files[0];
  if (!f) return;
  const concepts = conceptsEl.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!concepts.length) {
    statusEl.textContent = 'Enter at least one object name.';
    return;
  }
  const base = apiBaseEl.value.trim().replace(/\/$/, '');
  statusEl.textContent = 'Sending…';
  resultEl.textContent = 'Waiting for SAM…';
  try {
    const fd = new FormData();
    fd.append('image', f);
    fd.append('concepts', JSON.stringify(concepts));
    if (gps) {
      fd.append('lat', String(gps.lat));
      fd.append('lon', String(gps.lon));
      fd.append('accuracy', String(gps.accuracy));
    }
    const res = await fetch(`${base}/api/detect`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    resultEl.textContent = JSON.stringify(data, null, 2);
    drawBoxes(data.detections || []);
    statusEl.textContent = `Done — ${(data.detections || []).length} box(es).`;
  } catch (e) {
    statusEl.textContent = 'Failed.';
    resultEl.textContent = String(e);
  }
});

function drawBoxes(dets) {
  const w = preview.naturalWidth, h = preview.naturalHeight;
  overlay.width = preview.clientWidth;
  overlay.height = preview.clientHeight;
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const sx = overlay.width / w, sy = overlay.height / h;
  ctx.lineWidth = 2;
  dets.forEach((d) => {
    const [x1, y1, x2, y2] = d.box;
    ctx.strokeStyle = '#d00';
    ctx.strokeRect(x1 * sx, y1 * sy, (x2 - x1) * sx, (y2 - y1) * sy);
    ctx.fillStyle = '#d00';
    ctx.font = '14px sans-serif';
    ctx.fillText(`${d.label} ${Math.round((d.score || 0) * 100)}%`, x1 * sx + 4, y1 * sy + 16);
  });
}

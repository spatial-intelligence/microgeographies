/* Microgeographies EXIF preview — ES2017 only (no ?? or ?.),
 * so it also runs under old test runners. Exposes
 * window.MG_EXIF.parseGPS(arrayBuffer) -> {hasExif, lat, lon, heading}.
 * JPEG APP1/TIFF only; never throws (returns nulls when absent).
 */
(function () {
  "use strict";

  function strOf(view, off, len) {
    var s = "";
    for (var i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  }

  function rational(view, off, le) {
    var n = le ? view.getUint32(off, true) : view.getUint32(off, false);
    var d = le ? view.getUint32(off + 4, true) : view.getUint32(off + 4, false);
    return d ? n / d : NaN;
  }

  function dms(vals) {
    return vals[0] + vals[1] / 60 + vals[2] / 3600;
  }

  // Read one IFD into {tagId: {type, count, valOff}}; valOff is absolute.
  function readIfd(view, tiffStart, ifdOff, le) {
    function u16(off) { return le ? view.getUint16(off, true) : view.getUint16(off, false); }
    function u32(off) { return le ? view.getUint32(off, true) : view.getUint32(off, false); }
    var out = {};
    var base = tiffStart + ifdOff;
    if (base + 2 > view.byteLength) return out;
    var n = u16(base);
    for (var i = 0; i < n; i++) {
      var e = base + 2 + i * 12;
      if (e + 12 > view.byteLength) break;
      var tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      var sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 9: 4, 10: 8 };
      var total = (sizes[type] || 0) * count;
      var valOff = total <= 4 ? e + 8 : tiffStart + u32(e + 8);
      out[tag] = { type: type, count: count, valOff: valOff };
    }
    return out;
  }

  function numVal(view, tiffStart, entry, le) {
    function u16(off) { return le ? view.getUint16(off, true) : view.getUint16(off, false); }
    function u32(off) { return le ? view.getUint32(off, true) : view.getUint32(off, false); }
    if (entry.type === 3) return u16(entry.valOff);
    if (entry.type === 4) return u32(entry.valOff);
    return NaN;
  }

  function asciiVal(view, entry) {
    var s = strOf(view, entry.valOff, Math.min(entry.count, 32));
    return s.replace(/\0.*$/, "").trim();
  }

  function parseGPS(buffer) {
    var empty = { hasExif: false, lat: null, lon: null, heading: null };
    try {
      var view = new DataView(buffer);
      if (view.byteLength < 4 || view.getUint8(0) !== 0xFF || view.getUint8(1) !== 0xD8) return empty;
      var off = 2, tiff = -1;
      while (off + 4 <= view.byteLength) {
        if (view.getUint8(off) !== 0xFF) break;
        var marker = view.getUint8(off + 1);
        if (marker === 0xDA || marker === 0xD9) break; // image data / end
        var len = view.getUint16(off + 2, false);
        if (marker === 0xE1 && strOf(view, off + 4, 6) === "Exif\0\0") { tiff = off + 10; break; }
        off += 2 + len;
      }
      if (tiff < 0) return empty;
      var le, magic;
      var order = strOf(view, tiff, 2);
      if (order === "II") le = true;
      else if (order === "MM") le = false;
      else return empty;
      magic = le ? view.getUint16(tiff + 2, true) : view.getUint16(tiff + 2, false);
      if (magic !== 42) return empty;
      var ifd0off = le ? view.getUint32(tiff + 4, true) : view.getUint32(tiff + 4, false);
      var ifd0 = readIfd(view, tiff, ifd0off, le);
      if (!ifd0[0x8825]) return { hasExif: true, lat: null, lon: null, heading: null };
      var gpsOff = numVal(view, tiff, ifd0[0x8825], le);
      if (isNaN(gpsOff)) return { hasExif: true, lat: null, lon: null, heading: null };
      var gps = readIfd(view, tiff, gpsOff, le);
      var out = { hasExif: true, lat: null, lon: null, heading: null };
      function comp(refTag, valTag, posRef, negRef) {
        if (!gps[valTag]) return null;
        var e = gps[valTag], vals = [];
        for (var i = 0; i < 3; i++) {
          var v = rational(view, e.valOff + i * 8, le);
          if (isNaN(v)) return null;
          vals.push(v);
        }
        var deg = dms(vals);
        var ref = gps[refTag] ? asciiVal(view, gps[refTag]).toUpperCase() : posRef;
        if (ref === negRef) deg = -deg;
        return deg;
      }
      out.lat = comp(1, 2, "N", "S");
      out.lon = comp(3, 4, "E", "W");
      if (gps[0x0011]) {
        var ref = gps[0x0010] ? asciiVal(view, gps[0x0010]).toUpperCase() : "T";
        if (ref === "T") {
          var h = rational(view, gps[0x0011].valOff, le);
          if (!isNaN(h)) out.heading = Math.round((((h % 360) + 360) % 360) * 100) / 100;
        }
      }
      return out;
    } catch (e) {
      return empty;
    }
  }

  window.MG_EXIF = { parseGPS: parseGPS };
})();

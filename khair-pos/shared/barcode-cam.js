/* Khair Mart — camera barcode reading on every device (v47, owner 2026-10-14: «لا يمكن استعمال الكاميرا لقراءة الباركود»).
   The apps used only the browser's own reader (BarcodeDetector): Windows / Linux computers, iPhones and Firefox do not have
   it (the camera button was hidden), and some Android phones have it but it reads nothing. Now:
   - the phone's own reader when it exists AND supports the shop's barcode kinds;
   - otherwise ZXing (vendor/zxing, served from this site, loaded only then): reads a frame of the camera every ~0.2 s.
   KScan.available()          → the device has a camera API (the button is shown)
   KScan.open(video)          → back camera (continuous focus when possible) playing in <video>; returns the stream
   KScan.detector()           → { kind: 'native' | 'zxing', detect(video) → Promise<[code…]> }
   KScan.errorKind(e)         → 'denied' | 'none' | 'busy' | 'other' (for a clear message) */
(function () {
  'use strict';
  if (window.KScan) return;
  var me = document.currentScript;
  var ZX_URL = new URL('../vendor/zxing/zxing.min.js', (me && me.src) || location.href).href;
  var FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf', 'qr_code', 'data_matrix'];
  var zxLoad = null;

  function available() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
  function errorKind(e) {
    var n = (e && e.name) || '';
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
    if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError' || (e && e.message === 'NO_CAMERA')) return 'none';
    if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
    return 'other';
  }
  function open(video) {
    if (!available()) { var er = new Error('NO_CAMERA'); er.name = 'NotFoundError'; return Promise.reject(er); }
    return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then(function (stream) {
        try { // sharper reading on phones that can refocus by themselves
          var tr = stream.getVideoTracks()[0], caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
          if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () { });
        } catch (e) { }
        video.setAttribute('playsinline', ''); video.muted = true; video.srcObject = stream;
        return Promise.resolve(video.play()).catch(function () { }).then(function () { return stream; });
      });
  }
  function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (zxLoad) return zxLoad;
    zxLoad = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = ZX_URL; s.async = true;
      s.onload = function () { window.ZXing ? res(window.ZXing) : rej(new Error('ZXING')); };
      s.onerror = function () { zxLoad = null; rej(new Error('ZXING')); };
      document.head.appendChild(s);
    });
    return zxLoad;
  }
  function zxingDetector(ZX) {
    var reader = new ZX.MultiFormatReader(), hints = new Map(), F = ZX.BarcodeFormat;
    hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.CODABAR, F.ITF, F.QR_CODE, F.DATA_MATRIX]);
    hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    reader.setHints(hints);
    var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    return {
      kind: 'zxing',
      detect: function (video) {
        var vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return Promise.resolve([]);
        var k = Math.min(1, 960 / vw), w = Math.round(vw * k), h = Math.round(vh * k);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        var px = ctx.getImageData(0, 0, w, h).data, lum = new Uint8ClampedArray(w * h);
        for (var i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (px[j] * 306 + px[j + 1] * 601 + px[j + 2] * 117) >> 10;
        try {
          var r = reader.decodeWithState(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.RGBLuminanceSource(lum, w, h))));
          return Promise.resolve(r && r.getText() ? [r.getText()] : []);
        } catch (e) { return Promise.resolve([]); } // no barcode in this frame
      }
    };
  }
  function detector() {
    var native = 'BarcodeDetector' in window ? Promise.resolve().then(function () { return window.BarcodeDetector.getSupportedFormats(); }).then(function (have) {
      var want = FORMATS.filter(function (f) { return (have || []).indexOf(f) >= 0; });
      if (!want.length) return null; // e.g. an Android phone without the reading module
      var d = new window.BarcodeDetector({ formats: want });
      return { kind: 'native', detect: function (v) { return d.detect(v).then(function (cs) { return cs.map(function (c) { return c.rawValue; }).filter(Boolean); }); } };
    }).catch(function () { return null; }) : Promise.resolve(null);
    return native.then(function (n) { return n || loadZxing().then(zxingDetector); });
  }
  window.KScan = { available: available, open: open, detector: detector, errorKind: errorKind };
})();

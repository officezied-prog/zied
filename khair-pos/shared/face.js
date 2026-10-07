/* Khair Mart — face capture for attendance (v17), shared by the owner app and Khair Kasir.
   Runs on the shop device: camera → face-api (vendor/face-api, loaded only when needed) → a 128-number descriptor
   and a small 96×96 JPEG of the face for the owner. The photo stays on the device except that small thumbnail at enrolment;
   the server only compares the numbers. Tests replace the engine with window.KFACE_STUB = { descriptor: [...] | null }. */
(function (root) {
  var base = '';
  var state = { loading: null };
  function scriptBase() {
    var s = document.querySelector('script[src*="shared/face.js"]');
    return s ? s.src.replace(/shared\/face\.js.*$/, '') : '';
  }
  function loadScript(src) {
    return new Promise(function (ok, bad) {
      var s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = ok; s.onerror = function () { bad(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }
  /** Loads the library and the three models once (≈7 MB the first time, then from the browser cache). */
  function load() {
    if (root.KFACE_STUB) return Promise.resolve(true);
    if (state.loading) return state.loading;
    base = base || scriptBase();
    state.loading = (root.faceapi ? Promise.resolve() : loadScript(base + 'vendor/face-api/face-api.js')).then(function () {
      // WebGL on phones and tablets; plain CPU when the device has none (slower but works). WASM is not shipped.
      var tf = root.faceapi.tf;
      return tf.setBackend('webgl').then(function (ok) { return ok ? ok : tf.setBackend('cpu'); }, function () { return tf.setBackend('cpu'); }).then(function () { return tf.ready(); });
    }).then(function () {
      var fa = root.faceapi, url = base + 'vendor/face-api/model';
      return Promise.all([fa.nets.tinyFaceDetector.loadFromUri(url), fa.nets.faceLandmark68TinyNet.loadFromUri(url), fa.nets.faceRecognitionNet.loadFromUri(url)]);
    }).then(function () { return true; }).catch(function (e) { state.loading = null; throw e; });
    return state.loading;
  }
  function startCamera(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('NO_CAMERA'));
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }).then(function (st) {
      video.srcObject = st; video.setAttribute('playsinline', ''); video.muted = true;
      return video.play().then(function () { return st; }, function () { return st; });
    });
  }
  function stopCamera(stream) { try { (stream && stream.getTracks ? stream.getTracks() : []).forEach(function (t) { t.stop(); }); } catch (e) { } }
  function thumb(video, box) {
    var c = document.createElement('canvas'); c.width = 96; c.height = 96;
    var g = c.getContext('2d'), vw = video.videoWidth || 640, vh = video.videoHeight || 480;
    var b = box || { x: vw * 0.25, y: vh * 0.15, width: vw * 0.5, height: vh * 0.7 };
    var side = Math.max(b.width, b.height) * 1.3, cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    try { g.drawImage(video, Math.max(0, cx - side / 2), Math.max(0, cy - side / 2), side, side, 0, 0, 96, 96); } catch (e) { }
    return c.toDataURL('image/jpeg', 0.7);
  }
  /** One reading of the face in front of the camera: { descriptor: number[128], thumb, score } or null (no single clear face). */
  function read(video) {
    if (root.KFACE_STUB) {
      var d = typeof root.KFACE_STUB.descriptor === 'function' ? root.KFACE_STUB.descriptor() : root.KFACE_STUB.descriptor;
      return Promise.resolve(d ? { descriptor: d.slice(), thumb: 'data:image/jpeg;base64,' + 'A'.repeat(200), score: 0.99 } : null);
    }
    var fa = root.faceapi;
    return fa.detectAllFaces(video, new fa.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })).withFaceLandmarks(true).withFaceDescriptors().then(function (all) {
      if (!all || all.length !== 1) return all && all.length > 1 ? { many: true } : null;
      var r = all[0], box = r.detection.box;
      if (box.width < (video.videoWidth || 640) * 0.18) return { small: true };
      return { descriptor: Array.prototype.slice.call(r.descriptor), thumb: thumb(video, box), score: r.detection.score };
    });
  }
  /** Average of n good readings (enrolment): steadier than a single photo. */
  function readAverage(video, n, onStep) {
    var got = [], tries = 0, best = null;
    function step() {
      if (got.length >= n) {
        var avg = new Array(128).fill(0);
        got.forEach(function (d) { for (var i = 0; i < 128; i++) avg[i] += d[i] / got.length; });
        return Promise.resolve({ descriptor: avg, thumb: best.thumb });
      }
      if (++tries > n * 6) return Promise.resolve(null);
      return read(video).then(function (r) {
        if (r && r.descriptor) { got.push(r.descriptor); if (!best || r.score > best.score) best = r; }
        if (onStep) onStep(got.length, n, r);
        return new Promise(function (ok) { setTimeout(ok, root.KFACE_STUB ? 0 : 350); }).then(step);
      });
    }
    return step();
  }
  root.KFace = { load: load, startCamera: startCamera, stopCamera: stopCamera, read: read, readAverage: readAverage };
})(window);

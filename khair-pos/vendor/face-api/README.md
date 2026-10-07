Vendored from npm `@vladmandic/face-api@1.7.15` (MIT, see LICENSE): `dist/face-api.js` (browser bundle with TensorFlow.js)
and three models: tiny face detector, 68-point tiny landmarks, face recognition (128-number descriptors).
Served from the same site as the apps, so the shop device does not depend on a CDN; loaded only when the attendance
camera opens (shared/face.js). Faces are processed on the device; only the 128 numbers go to the server.

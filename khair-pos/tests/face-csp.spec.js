// v17: the real face library (vendor/face-api) loads and reads the camera under each app's Content-Security-Policy.
// Fake camera (no face) → read() is null. TF.js probes WebAssembly once (blocked "wasm-eval"); it does not use it.
const { test, expect } = require('@playwright/test');
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['camera'] });
for (const app of ['index.html?mock=1', 'kasir/index.html?mock=1']) {
  test('face library under the CSP of ' + app.split('?')[0], async ({ page }) => {
    await page.addInitScript(() => document.addEventListener('securitypolicyviolation', e => (window.__csp = (window.__csp || [])).push(e.violatedDirective + ' ' + e.blockedURI)));
    await page.goto(app);
    const r = await page.evaluate(async () => {
      await KFace.load();
      const v = document.createElement('video'); document.body.appendChild(v);
      const st = await KFace.startCamera(v); await new Promise(res => setTimeout(res, 600));
      const out = await KFace.read(v); KFace.stopCamera(st);
      return { loaded: faceapi.nets.faceRecognitionNet.isLoaded && faceapi.nets.tinyFaceDetector.isLoaded, read: out, csp: (window.__csp || []).filter(x => !/wasm-eval/.test(x)) };
    });
    expect(r).toEqual({ loaded: true, read: null, csp: [] });
  });
}

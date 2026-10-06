// Khair Kasir (cashier app) e2e tests — mock backend (kasir/index.html?mock=1).
// Run: cd khair-pos/tests-kasir && npm install && npx playwright test
//   (or reuse the owner tests' modules: ln -s ../tests/node_modules node_modules)
// Uses the preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers); never runs `playwright install`.
// Port 8766 (the owner app tests use 8765), serving the khair-pos directory.
const { defineConfig } = require('@playwright/test');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const PORT = Number(process.env.KASIR_PORT || 8766);
module.exports = defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js/,
  timeout: 60000,
  expect: { timeout: 8000 },
  fullyParallel: false,
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    permissions: ['clipboard-read', 'clipboard-write'],
    launchOptions: process.env.KASIR_CHROMIUM ? { executablePath: process.env.KASIR_CHROMIUM } : {}
  },
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ..`,
    url: `http://127.0.0.1:${PORT}/kasir/index.html`,
    reuseExistingServer: true,
    timeout: 20000
  }
});

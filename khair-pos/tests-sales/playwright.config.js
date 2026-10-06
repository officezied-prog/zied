// Khair Sales (field-sales app) e2e tests — mock backend (sales/index.html?mock=1).
// Run: cd khair-pos/tests-sales && npm install && npx playwright test
//   (or reuse the owner tests' modules: ln -s ../tests/node_modules node_modules)
// Uses the preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers); never runs `playwright install`.
// Port 8767 (owner tests 8765, kasir tests 8766), serving the khair-pos directory.
const { defineConfig } = require('@playwright/test');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const PORT = Number(process.env.SALES_PORT || 8767);
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
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    geolocation: { latitude: -6.2655, longitude: 106.8605, accuracy: 12 },
    launchOptions: process.env.SALES_CHROMIUM ? { executablePath: process.env.SALES_CHROMIUM } : {}
  },
  webServer: {
    command: `python3 -m http.server ${PORT} --bind 127.0.0.1 --directory ..`,
    url: `http://127.0.0.1:${PORT}/sales/index.html`,
    reuseExistingServer: true,
    timeout: 20000
  }
});

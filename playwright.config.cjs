const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/web',
  timeout: 60000,
  expect: { timeout: 20000 },
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4179/minify/',
    viewport: { width: 390, height: 844 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: process.platform === 'win32' ? 'msedge' : undefined } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node scripts/serve-web.cjs',
    env: { MINIFY_BASE: '/minify/' },
    url: 'http://localhost:4179/minify/',
    reuseExistingServer: false,
  },
});

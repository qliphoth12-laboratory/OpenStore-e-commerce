// Chromium-only black-box E2E. This suite does not modify Apps Script source code.
const { defineConfig, devices } = require('@playwright/test');
const { loadE2eConfig } = require('./config');

const e2eConfig = loadE2eConfig();

module.exports = defineConfig({
  testDir: './tests',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  retries: 1,
  workers: 1,
  reporter: [['html'], ['list']],
  use: {
    baseURL: e2eConfig.baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 90_000
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});

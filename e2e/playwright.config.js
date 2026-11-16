import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT || 8765);
const externalBaseUrl = process.env.E2E_BASE_URL;
const baseURL = externalBaseUrl || `http://127.0.0.1:${port}`;
const python = process.env.PYTHON || 'python';

export default defineConfig({
  testDir: './tests',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /mobile\.spec\.js/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.js/,
      // Keep the phone viewport/touch flags but run on Chromium (CI installs one browser).
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `"${python}" -m uvicorn app.main:app --host 127.0.0.1 --port ${port}`,
        cwd: path.resolve(__dirname, '../backend'),
        env: {
          ...process.env,
          ADMIN_LOGIN: 'e2e-admin',
          ADMIN_PASSWORD: 'e2e-admin-pass',
          PASSWORD_ROUNDS: '4',
          AUTH_LOGIN_PER_MINUTE: '100',
          AUTH_REGISTER_PER_MINUTE: '100',
          DATA_DIR: path.resolve(__dirname, '.data'),
          UPLOADS_DIR: path.resolve(__dirname, '.uploads'),
          FRONTEND_DIR: path.resolve(__dirname, '../frontend'),
          SNAPSHOT_INTERVAL_SECONDS: '0.05',
          LOG_LEVEL: 'WARNING',
        },
        url: `${baseURL}/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});

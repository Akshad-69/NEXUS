import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * NEXUS end-to-end configuration.
 *
 * These tests run against the *real* stack: the API process with its seeded
 * workspace, and the SPA served by Vite. Nothing is mocked — a passing run is
 * evidence that the product boots, authenticates, and renders every route
 * without a console error or a 5xx.
 *
 *   npm run test:e2e            # desktop sweep + delivery flow + mobile checks
 *   npm run test:e2e -- --ui    # interactive
 */

/**
 * The suite owns its whole stack on its own ports.
 *
 * Reusing a developer's dev server looks convenient but is wrong twice over: the
 * API keeps writing to `apps/api/data`, so a test run permanently pollutes the
 * demo workspace, and the assertions inherit whatever state that workspace
 * happened to be in. Dedicated ports + a dedicated data directory mean a test run
 * is reproducible and leaves the demo workspace untouched.
 */
const WEB_PORT = Number(process.env.NEXUS_E2E_WEB_PORT ?? 5199);
const API_PORT = Number(process.env.NEXUS_E2E_API_PORT ?? 8788);
const API_URL = `http://127.0.0.1:${API_PORT}`;
// Absolute: the API is launched by a workspace script, so a relative path would
// resolve against `apps/api` rather than the repository root.
const DATA_DIR = process.env.NEXUS_E2E_DATA_DIR ?? resolve(process.cwd(), '.e2e-data');
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e',
  // One seeded workspace, one workspace-scoped simulation engine: parallel
  // workers would race each other's deployments and pipeline runs.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : [['list']],
  outputDir: 'test-results',

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'desktop',
      dependencies: ['setup'],
      testMatch: /(smoke|routes|delivery)\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: 'e2e/.auth/state.json',
      },
    },
    {
      name: 'mobile',
      dependencies: ['setup'],
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        storageState: 'e2e/.auth/state.json',
      },
    },
  ],

  // Both services get their own readiness gate. Gating only on the SPA would
  // start the suite against an API that has not finished seeding (~10s on an
  // empty store); gating only on the API would let a stray API on :8787 mask a
  // missing web server. Two entries keep each side honest and independently
  // reusable when you already have a dev server running.
  webServer: [
    {
      command: 'npm run build:packages && npm run dev:api',
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NEXUS_PORT: String(API_PORT), NEXUS_DATA_DIR: DATA_DIR },
    },
    {
      command: 'npm run dev:web',
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { NEXUS_WEB_PORT: String(WEB_PORT), NEXUS_API_URL: API_URL },
    },
  ],
});

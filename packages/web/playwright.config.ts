import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression suite for the dashboard. It drives a production build
 * (`yarn workspace @auto-swe/web build` first) served by `next start`, and
 * answers every gateway call from typed fixtures in `e2e/fixtures/` — no
 * gateway, database or Docker. See `docs/architecture.md` (web dashboard) for
 * how to run it and how to update the baselines on purpose.
 *
 * The browser reaches the "gateway" on the app's own origin, so `page.route`
 * intercepts every call without CORS. The server-side role gate
 * (`lib/auth.server.ts`) fetches from Node, where `page.route` cannot reach; a
 * small stub started in `e2e/support/globalSetup.ts` answers it on
 * `STUB_PORT`.
 */
const WEB_PORT = Number(process.env.VISUAL_WEB_PORT ?? 3210);
const STUB_PORT = Number(process.env.VISUAL_STUB_PORT ?? 3211);
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      // Measured run-to-run noise is a few dozen antialiased pixels, and a glyph
      // that falls back to a different system font is a few hundred; the
      // smallest real fix this suite was built against moved about a thousand.
      // 0.1% (1,152 pixels at 1280x900, 329 at 390x844) sits between the two.
      // `threshold` ignores per-pixel colour drift below 0.2 entirely.
      maxDiffPixelRatio: 0.001,
      scale: 'css',
      threshold: 0.2,
    },
  },
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  globalSetup: './e2e/support/globalSetup.ts',
  // Enough failures to show a pattern while leaving the job time to upload the shots and diffs.
  maxFailures: process.env.CI ? 10 : 0,
  outputDir: './e2e/.output/results',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // `line` prints each failure as it happens: with `list` the errors come only at the end, so a
  // job that runs out of time shows which shots failed but never why.
  reporter: process.env.CI
    ? [['line'], ['html', { open: 'never', outputFolder: './e2e/.output/report' }]]
    : [['list']],
  retries: 0,
  // One platform-free name per shot: the only platform the baselines are for is
  // the Playwright image the CI job runs in.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    colorScheme: 'dark',
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `yarn next start --hostname 127.0.0.1 --port ${WEB_PORT}`,
    env: {
      API_INTERNAL_URL: `http://127.0.0.1:${STUB_PORT}`,
      NEXT_PUBLIC_API_URL: BASE_URL,
      NEXT_TELEMETRY_DISABLED: '1',
    },
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    timeout: 120_000,
    url: `${BASE_URL}/health`,
  },
  workers: 2,
});

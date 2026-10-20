import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the REAL backend in dev auth mode.
 * - Default: starts `server/dist/main.js` on E2E_PORT (8080) with a fresh DATA_DIR,
 *   serving this package's `dist/` (run `npm run build -w web` first).
 * - E2E_BASE_URL=http://localhost:8080 uses an already running server instead.
 */
const external = process.env.E2E_BASE_URL;
const port = Number(process.env.E2E_PORT ?? 8080);
const baseURL = external ?? `http://localhost:${port}`;
// Shared by the main process and workers (env is inherited), so only one temp dir.
process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), "exidraw-e2e-"));

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: external
    ? undefined
    : {
        command: "node ../server/dist/main.js",
        url: `${baseURL}/healthz`,
        reuseExistingServer: true,
        timeout: 60_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          AUTH_MODE: "dev",
          ADMIN_EMAILS: "alice@example.test",
          DATA_DIR: process.env.E2E_DATA_DIR,
          WEB_DIST_DIR: resolve(import.meta.dirname, "dist"),
          PORT: String(port),
          PUBLIC_URL: baseURL,
          RENDERER: "off",
          LOG_LEVEL: "warn",
        },
      },
});

import { RUN_DIR } from "./e2e/run-dir.ts";
import { availableParallelism } from "node:os";
import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { E2E_LAYOUT_PORT, E2E_WEB_PORT } from "./e2e/config.ts";

/** This run's build, apart from any other run's in the same checkout. */
const WEB_OUT = join(RUN_DIR, `doriface-web-e2e-${E2E_WEB_PORT}-dist`);

/**
 * Chromium alone by default, because the required CI job installs only that browser. A wider desktop run is opt-in so
 * `E2E_BROWSERS=all` can prove Firefox and WebKit without making every CI run download three engines.
 */
const WINDOW = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 };

const e2eProjects = (): { name: string; use: Record<string, unknown> }[] => {
  const chromium = { name: "chromium", use: { ...devices["Desktop Chrome"], ...WINDOW } };
  if ((process.env["E2E_BROWSERS"] ?? "") !== "all") return [chromium];
  return [
    chromium,
    { name: "firefox", use: { ...devices["Desktop Firefox"], ...WINDOW } },
    { name: "webkit", use: { ...devices["Desktop Safari"], ...WINDOW } },
  ];
};

// Playwright stops its web servers and workers (and with them every e2e host and core) on SIGINT, not on SIGTERM, which
// would leave the layout host, its cores and vite preview running: the runner answers SIGTERM with its own SIGINT.
if (process.env["TEST_WORKER_INDEX"] === undefined) process.once("SIGTERM", () => process.kill(process.pid, "SIGINT"));

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // Each run its own results, so two runs in one checkout do not clear each other's.
  outputDir: process.env["E2E_OUTPUT_DIR"] ?? "test-results",
  timeout: 60_000,
  // Each worker runs its own e2e host and core (e2e/worker-host.ts), so workers share no terminals. Each worker is also a
  // browser, a host and a core at once: in CI no more workers than the runner has cores, or every spec that measures
  // layout or waits on focus loses a race now and then (8 workers on a 4-core runner failed a different spec each run,
  // #342).
  workers: process.env["CI"] ? availableParallelism() : 4,
  // Each worker fails the run itself when a spec leaves terminals on its core (e2e/terminal-guard.ts); this reports it.
  globalSetup: "./e2e/terminal-leaks.ts",
  globalTeardown: "./e2e/leftover-hosts.ts",
  // Where this run's hosts and scratch sessions keep their files; the teardown stops any hc process still holding one.
  metadata: { runDir: RUN_DIR },
  forbidOnly: Boolean(process.env["CI"]),
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  // The window and the pixel ratio are pinned here rather than inherited from a device preset (#862): every spec that
  // measures layout has to measure the same boxes on a Linux runner and on a developer's Mac, and a preset that moves
  // between Playwright releases would move them silently. e2eProjects() carries the same pin into every engine.
  use: {
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  },
  projects: e2eProjects(),
  webServer: [
    {
      // Only layout.e2e.ts reads this host, and a file's tests run in one worker, so the workers can share it.
      command: "bun e2e/host.ts layout",
      url: `http://127.0.0.1:${E2E_LAYOUT_PORT}/healthz`,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      // E2E_WEB_MODE=development serves a dev build (import.meta.env.DEV), for specs that differ by build (#458).
      command: `${process.env["E2E_WEB_MODE"] === "development" ? "NODE_ENV=development " : ""}bunx --bun vite build --outDir ${WEB_OUT} --emptyOutDir && bunx --bun vite preview --outDir ${WEB_OUT} --host 127.0.0.1 --port ${E2E_WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${E2E_WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

import { RUN_DIR } from "../e2e/run-dir.ts";
import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { E2E_WEB_PORT } from "../e2e/config.ts";

/**
 * The render bench (#670): the e2e suite's real host and core (one worker, so one host), the web app either built from
 * this checkout or, with BENCH_WEB_DIST, a build made beforehand (the last release's, for the release gate) served as
 * it is. bench/run.ts runs it; see docs/render-bench.md.
 */
const WEB = join(import.meta.dirname, "..");
const PREBUILT = process.env["BENCH_WEB_DIST"];
const OUT = PREBUILT ?? join(RUN_DIR, `doriface-web-bench-${E2E_WEB_PORT}-dist`);
const PREVIEW = `bunx --bun vite preview --outDir ${OUT} --host 127.0.0.1 --port ${E2E_WEB_PORT} --strictPort`;

if (process.env["TEST_WORKER_INDEX"] === undefined) process.once("SIGTERM", () => process.kill(process.pid, "SIGINT"));

export default defineConfig({
  testDir: ".",
  testMatch: "*.bench.ts",
  outputDir: process.env["BENCH_PLAYWRIGHT_DIR"] ?? join(RUN_DIR, "bench-results"),
  // One page, one host, one core: a second worker would share the machine and its numbers.
  workers: 1,
  timeout: 300_000,
  globalSetup: "../e2e/terminal-leaks.ts",
  globalTeardown: "../e2e/leftover-hosts.ts",
  metadata: { runDir: RUN_DIR },
  forbidOnly: Boolean(process.env["CI"]),
  reporter: "list",
  // Chromium as the e2e suite runs it, at a desktop size where 50 panes still show some text each.
  use: {
    browserName: "chromium",
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    viewport: { width: 1920, height: 1080 },
    trace: "off",
    serviceWorkers: "block",
  },
  webServer: {
    command: PREBUILT === undefined ? `bunx --bun vite build --outDir ${OUT} --emptyOutDir && ${PREVIEW}` : PREVIEW,
    cwd: WEB,
    url: `http://127.0.0.1:${E2E_WEB_PORT}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});

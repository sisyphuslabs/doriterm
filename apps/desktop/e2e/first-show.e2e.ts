import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_SHOW_DEADLINE_MS } from "../src/config/window.ts";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions, packagedExecutable } from "./launch.ts";
import { buildPreloadShim } from "./preload-shim.ts";

// A checkout run hides every window (hide-windows.cjs), so only the packaged app can show one.
test.skip(process.platform !== "linux" || packagedExecutable === undefined, "the packaged Linux app's GPU process");

/** How long after the main process started the window was first visible, polled every 50 ms; null if never. */
async function visibleAfter(
  app: Awaited<ReturnType<typeof electron.launch>>,
  withinMs: number,
): Promise<number | null> {
  const stopAt = Date.now() + withinMs;
  while (Date.now() < stopAt) {
    // oxlint-disable-next-line no-await-in-loop -- each poll reads the window as it is now
    const seen = await app.evaluate(({ BrowserWindow }) => ({
      visible: BrowserWindow.getAllWindows().some((window) => window.isVisible()),
      uptimeMs: Math.round(process.uptime() * 1000),
    }));
    if (seen.visible) return seen.uptimeMs;
    // oxlint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

test("the window shows within its deadline while the GPU process is still loading the system GL driver (#88)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-first-show-"));
  const hc = scratchHcSession();
  try {
    const shim = join(dir, "slow-gl-driver.so");
    buildPreloadShim("slow-gl-driver.c", shim);
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ...hc.env,
        LD_PRELOAD: shim,
        // Far past the deadline: a window that waits for the first frame stays hidden for the whole test.
        DORIFACE_E2E_SLOW_GL_SECONDS: "120",
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    // With the GPU process on, as a user's launch has it; the other e2e runs pass --disable-gpu.
    const app = await electron.launch(
      await launchOptions([`--user-data-dir=${join(dir, "profile")}`], { gpu: true, env }),
    );
    try {
      const after = await visibleAfter(app, FIRST_SHOW_DEADLINE_MS + 15_000);
      console.log(`first-show: visible ${after === null ? "never" : `${after} ms`} after the main process started`);
      expect(after).not.toBeNull();
      // The main process starts, loads the app and makes the window before the deadline starts running.
      expect(after ?? Number.POSITIVE_INFINITY).toBeLessThan(FIRST_SHOW_DEADLINE_MS + 10_000);
    } finally {
      await app.close();
    }
  } finally {
    await hc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a launch whose GPU process is ready shows the window on its first frame, before the deadline (#88)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-first-show-"));
  const hc = scratchHcSession();
  try {
    const env = Object.fromEntries(
      Object.entries({ ...process.env, ...hc.env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const app = await electron.launch(
      await launchOptions([`--user-data-dir=${join(dir, "profile")}`], { gpu: true, env }),
    );
    try {
      const after = await visibleAfter(app, 30_000);
      console.log(`first-show: visible ${after === null ? "never" : `${after} ms`} after the main process started`);
      expect(after).not.toBeNull();
    } finally {
      await app.close();
    }
  } finally {
    await hc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

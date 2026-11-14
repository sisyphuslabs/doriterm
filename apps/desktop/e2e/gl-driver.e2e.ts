import { _electron as electron, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { launchOptions } from "./launch.ts";
import { buildPreloadShim } from "./preload-shim.ts";

test.skip(process.platform !== "linux", "Mesa's GL driver is the Linux GPU process's");

test("the window is captured while the system GL driver is slow to load", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-gl-driver-"));
  const hc = scratchHcSession();
  try {
    const shim = join(dir, "slow-gl-driver.so");
    buildPreloadShim("slow-gl-driver.c", shim);
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ...hc.env,
        LD_PRELOAD: shim,
        // Longer than the screenshot's own 30 s timeout, so waiting on the driver cannot pass.
        DORIFACE_E2E_SLOW_GL_SECONDS: "120",
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const app = await electron.launch(await launchOptions([`--user-data-dir=${join(dir, "profile")}`], { env }));
    try {
      const page = await app.firstWindow();
      await page.waitForSelector("#root > *");
      // A capture waits for a composited frame, and none exists until the GPU process has finished GL init.
      await page.screenshot({ path: test.info().outputPath("gl-driver.png") });
    } finally {
      await app.close();
    }
  } finally {
    await hc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

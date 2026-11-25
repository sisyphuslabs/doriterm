import { _electron as electron, expect, test } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchHcSession } from "./hc-session.ts";
import { appDir, guardedEnv, launchOptions, packagedExecutable } from "./launch.ts";
import { buildPreloadShim } from "./preload-shim.ts";

test.skip(process.platform !== "linux" || packagedExecutable === undefined, "the race is the packaged app's, on Linux");

test("the packaged launch settles when the first navigation's commit event would be lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dd-first-document-"));
  const hc = scratchHcSession();
  try {
    const shim = join(dir, "hold-gpu-process.so");
    buildPreloadShim("hold-gpu-process.c", shim);
    const launch = await launchOptions([`--user-data-dir=${join(dir, "profile")}`]);
    if (!("executablePath" in launch)) throw new Error("the skip above keeps this spec to packaged launches");
    const raceReport = join(dir, "race-report");
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        ...hc.env,
        LD_PRELOAD: shim,
        // Far longer than Playwright takes to attach, so an attach that does not wait lands inside the first navigation.
        DORIFACE_E2E_HOLD_GPU_PROCESS_MS: "3000",
        DORIFACE_E2E_INNER: JSON.stringify([launch.executablePath, ...launch.args]),
        DORIFACE_E2E_RACE_REPORT: raceReport,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const app = await electron.launch({
      executablePath: join(appDir, "e2e", "late-page-enable.ts"),
      args: [],
      env: await guardedEnv(env),
    });
    try {
      const page = await app.firstWindow();
      await page.waitForSelector("#root > *");
      expect(page.url()).toMatch(/^app:\/\/doriface\//);
    } finally {
      await app.close();
    }
    // The race was really forced. The shim held the GPU process, and the attach a bare launch makes came while the hold
    // was on; the browser launches the network service only after the GPU process, so at that attach the first
    // navigation was in flight with no network service yet, and the service was running by the release (so its absence
    // at attach means something). The proxy held the page's Page.enable. Without these, this pass would not show that
    // the wrapper is needed.
    const forced = existsSync(raceReport) ? readFileSync(raceReport, "utf8") : "";
    const at = (pattern: RegExp): number => Number(pattern.exec(forced)?.[1] ?? Number.NaN);
    const held = at(/^gpu process held pid=\d+ at=(\d+)$/m);
    const released = at(/^gpu process released pid=\d+ at=(\d+)$/m);
    const attached = at(/^attached at=(\d+)$/m);
    expect(held).toBeLessThanOrEqual(attached);
    expect(attached).toBeLessThan(released);
    expect(forced).toContain("first navigation in flight at attach");
    expect(forced).toContain("network service not started at attach");
    expect(forced).toContain("network service running at release");
    expect(forced).toContain("held a Page.enable");
  } finally {
    await hc.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

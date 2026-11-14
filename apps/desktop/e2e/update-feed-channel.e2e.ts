import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packagedExecutable } from "./launch.ts";

// The packaged app's own update feed config, as electron-builder wrote it (#2471 review follow-up): its channel must not
// come from the version's prerelease part, or a beta build reads beta*.yml, which the get Worker never serves. This reads
// the real output of the pack step the Desktop job runs, where unit tests can only call electron-builder's internals.
// Only the Linux layout is read here. A local run may have no packed app; the Desktop job always packs one and names it
// in DORIFACE_E2E_EXECUTABLE, so in CI a missing name fails below instead of skipping the check without a word.
test.skip(process.platform !== "linux", "the packaged Linux app's resources");
test.skip(packagedExecutable === undefined && process.env["CI"] === undefined, "a local run with no packed app");

test("the packaged app's update feed config names no channel, so it reads latest*.yml", () => {
  expect(packagedExecutable, "DORIFACE_E2E_EXECUTABLE names the packed app in CI").toBeDefined();
  const config = join(dirname(packagedExecutable ?? ""), "resources", "app-update.yml");
  expect(existsSync(config), config).toBe(true);
  const text = readFileSync(config, "utf8");
  expect(text).toContain("provider: generic");
  expect(text).not.toMatch(/^channel:/m);
});

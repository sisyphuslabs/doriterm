import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packagedExecutable } from "./launch.ts";

// The packaged app's own update feed config, as electron-builder wrote it (#2471 review follow-up): its channel must not
// come from the version's prerelease part, or a beta build reads beta*.yml, which the get Worker never serves. This reads
// the real output of the pack step the Desktop job runs, where unit tests can only call electron-builder's internals.
test.skip(process.platform !== "linux" || packagedExecutable === undefined, "the packaged Linux app's resources");

test("the packaged app's update feed config names no channel, so it reads latest*.yml", () => {
  const config = join(dirname(packagedExecutable ?? ""), "resources", "app-update.yml");
  expect(existsSync(config), config).toBe(true);
  const text = readFileSync(config, "utf8");
  expect(text).toContain("provider: generic");
  expect(text).not.toMatch(/^channel:/m);
});

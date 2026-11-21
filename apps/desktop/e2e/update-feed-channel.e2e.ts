import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDir, packagedExecutable } from "./launch.ts";

// The packaged app's own update feed config, as electron-builder wrote it (#2471 review follow-up): its channel must not
// come from the version's prerelease part, or a beta build reads beta*.yml, which the get Worker never serves. This reads
// the real output of the pack step the Desktop job runs, where unit tests can only call electron-builder's internals.
test.skip(process.platform !== "linux" || packagedExecutable === undefined, "the packaged Linux app's resources");

/**
 * The version the app was packed at: electron-builder takes the default channel from its prerelease part, the part after
 * a "-" before any "+" (a build tag such as +build-1 is not a prerelease, #2542 review).
 */
const version: unknown = Reflect.get(Object(JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"))), "version");
// A stable version derives no channel, so this spec would pass with or without detectUpdateChannel: false (#2474
// review). There test/update-feed-channel.test.ts, which gives electron-builder a prerelease channel itself, holds it.
test.skip(
  typeof version !== "string" || !version.split("+")[0]?.includes("-"),
  `${String(version)} has no prerelease part to name a channel; the unit test holds the config`,
);

test("the packaged app's update feed config names no channel, so it reads latest*.yml", () => {
  const config = join(dirname(packagedExecutable ?? ""), "resources", "app-update.yml");
  expect(existsSync(config), config).toBe(true);
  const text = readFileSync(config, "utf8");
  expect(text).toContain("provider: generic");
  expect(text).not.toMatch(/^channel:/m);
});

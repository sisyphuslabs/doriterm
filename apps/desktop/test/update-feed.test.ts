import { expect, test } from "bun:test";
import { parseUpdateInfo, resolveFiles } from "electron-updater/out/providers/Provider.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const electronBuilder: unknown = JSON.parse(readFileSync(join(import.meta.dir, "..", "electron-builder.json"), "utf8"));

// The feed as get.doriterm.com composes it (#1969, apps/get feeds.ts): relative paths prefixed with the version,
// stagingPercentage from the channel pointer, and the self-update floor.
const FEED = `version: 0.1.17
files:
  - url: 0.1.17/Doriterm-0.1.17-arm64-mac.zip
    sha512: aaaa
    size: 160051571
  - url: 0.1.17/Doriterm-0.1.17-arm64.dmg
    sha512: bbbb
    size: 165502404
path: 0.1.17/Doriterm-0.1.17-arm64-mac.zip
sha512: aaaa
releaseDate: 2026-11-09T10:58:27.969Z
stagingPercentage: 25
minimumVersion: 0.1.10
`;

test("the packaged app reads the generic feed on get.doriterm.com's stable channel", () => {
  expect(Reflect.get(electronBuilder as object, "publish")).toEqual([
    { provider: "generic", url: "https://get.doriterm.com/desktop/stable" },
  ]);
});

test("electron-updater resolves the composed feed's files under the channel and hands the rollout and floor through", () => {
  const base = new URL("https://get.doriterm.com/desktop/stable/");
  const info = parseUpdateInfo(FEED, "latest-mac.yml", new URL("latest-mac.yml", base));
  expect(info).toMatchObject({ version: "0.1.17", stagingPercentage: 25, minimumVersion: "0.1.10" });
  expect(resolveFiles(info, base).map((file) => file.url.href)).toEqual([
    "https://get.doriterm.com/desktop/stable/0.1.17/Doriterm-0.1.17-arm64-mac.zip",
    "https://get.doriterm.com/desktop/stable/0.1.17/Doriterm-0.1.17-arm64.dmg",
  ]);
});

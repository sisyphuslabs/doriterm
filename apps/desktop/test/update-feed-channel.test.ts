import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// A prerelease tag (v0.1.19-beta.1) builds with that version. electron-builder names the update feed after the publish
// config's channel, and by default takes the channel from the version's prerelease part: beta*.yml instead of
// latest*.yml. release.yml, merge-update-feed.ts and the get Worker read latest*.yml under each channel's own folder, so
// the channel must never come from the version (#2471).

interface PublishConfig {
  readonly provider: string;
  readonly channel?: string | null;
}
interface PublishManager {
  getPublishConfigs(
    packager: object,
    target: null,
    arch: null,
    errorIfCannot: boolean,
  ): Promise<readonly PublishConfig[] | null>;
}

const builder: Record<string, unknown> = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "electron-builder.json"), "utf8"),
);
// app-builder-lib is electron-builder's own dependency, not this package's, so it is reached through electron-builder.
const fromBuilder = createRequire(createRequire(import.meta.url).resolve("electron-builder"));
const { getPublishConfigs } = fromBuilder("app-builder-lib/out/publish/PublishManager.js") as PublishManager;

describe("the update feed of a prerelease build", () => {
  for (const platform of ["mac", "linux", "win"] as const) {
    test(`${platform}: is written as latest*.yml, whatever the version's prerelease part`, async () => {
      // AppInfo.channel is the first part of the version's prerelease: "beta" for 0.1.19-beta.1.
      const packager = {
        platformSpecificBuildOptions: builder[platform] ?? {},
        config: builder,
        info: { config: builder, appInfo: { channel: "beta" } },
        expandMacro: (value: string) => value,
      };
      const configs = await getPublishConfigs(packager, null, null, false);
      expect(configs?.map((config) => config.channel ?? null)).toEqual([null]);
    });
  }
});

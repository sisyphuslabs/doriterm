import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { speechAddonPath } from "../src/main/speech.ts";

/**
 * What a Linux user needs before the AppImage opens is decided by the runtime electron-builder embeds, not by the app.
 * Its legacy runtime dlopen()s libfuse.so.2; the toolset named by `toolsets.appimage` is the statically linked one,
 * which carries FUSE itself. Stock Ubuntu 24.04 ships FUSE 3 and no libfuse.so.2, so the legacy runtime is exactly the
 * "dlopen(): error loading libfuse.so.2" a 24.04 user hit. The release workflow proves the launch on a runner whose
 * libfuse.so.2 is asserted absent; this test guards the config that would silently undo it at release time.
 */
const builder = JSON.parse(readFileSync(join(import.meta.dir, "..", "electron-builder.json"), "utf8")) as {
  readonly toolsets?: { readonly appimage?: string };
  readonly appImage?: { readonly executableArgs?: readonly string[] };
  readonly nsis?: { readonly include?: string };
};

test("Windows installers load the architecture guard before installing (#1298)", () => {
  expect(builder.nsis?.include).toBe("build/installer.nsh");
});

describe("packaging the AppImage", () => {
  test("the AppImage is built with the static runtime, so it needs no libfuse.so.2", () => {
    // electron-builder builds the FUSE 2 legacy runtime when toolsets.appimage is unset or "0.0.0".
    expect(builder.toolsets?.appimage).toBeString();
    expect(builder.toolsets?.appimage).not.toBe("0.0.0");
  });

  test("the AppImage desktop entry keeps --no-sandbox, which Ubuntu 24.04's AppArmor user-namespace restriction needs", () => {
    // The legacy toolset put this argument in the AppImage's desktop entry by default and the static toolset does not.
    // It stays on the AppImage target only: the deb's entry never carried it.
    expect(builder.appImage?.executableArgs).toContain("--no-sandbox");
  });
});

const mac = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "electron-builder.json"), "utf8")) as {
    readonly mac: {
      readonly entitlements: string;
      readonly entitlementsInherit: string;
      readonly extraResources?: readonly {
        readonly from: string;
        readonly to: string;
        readonly filter?: readonly string[];
      }[];
      readonly extendInfo?: Readonly<Record<string, string>>;
    };
  }
).mac;

describe("packaging dictation for macOS (#726)", () => {
  test("the signed app may take audio input, and both of macOS's prompts have their usage string", () => {
    for (const file of new Set([mac.entitlements, mac.entitlementsInherit])) {
      const plist = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(plist).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
      // Library validation stays on: the addon is signed with the app, so nothing else may be loaded.
      expect(plist).not.toContain("disable-library-validation");
    }
    expect(mac.extendInfo?.["NSMicrophoneUsageDescription"]).toBeString();
    expect(mac.extendInfo?.["NSSpeechRecognitionUsageDescription"]).toBeString();
  });

  test("the addon ships outside asar at the path the main process loads it from", () => {
    expect(mac.extraResources).toContainEqual({ from: "dist/native", to: "native", filter: ["speech.node"] });
    expect(speechAddonPath(true, "/App/Contents/Resources", "/ignored")).toBe(
      "/App/Contents/Resources/native/speech.node",
    );
  });
});

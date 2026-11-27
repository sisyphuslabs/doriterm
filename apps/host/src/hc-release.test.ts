import { describe, expect, test } from "bun:test";
import {
  compareHcVersions,
  HC_VERSION_FLOOR,
  HcInstallError,
  hcTarget,
  meetsHcFloor,
  parseHcManifest,
} from "./hc-install.ts";

const SHA = "a".repeat(64);

describe("the herdr-core build for this computer", () => {
  test("is the release target for each OS and CPU herdr-core ships, and none for any other", () => {
    expect(hcTarget("linux", "x64")).toBe("linux-x86_64");
    expect(hcTarget("linux", "arm64")).toBe("linux-aarch64");
    expect(hcTarget("darwin", "x64")).toBe("macos-x86_64");
    expect(hcTarget("darwin", "arm64")).toBe("macos-aarch64");
    expect(hcTarget("win32", "x64")).toBe("windows-x86_64");
    expect(hcTarget("win32", "arm64")).toBeUndefined();
    expect(hcTarget("linux", "ia32")).toBeUndefined();
    expect(hcTarget("linux", "riscv64")).toBeUndefined();
    expect(hcTarget("freebsd", "x64")).toBeUndefined();
  });
});

describe("the version floor", () => {
  test(`is ${HC_VERSION_FLOOR}: older is refused, the same or newer is taken, numbers compare as numbers`, () => {
    expect(HC_VERSION_FLOOR).toBe("0.1.17");
    expect(meetsHcFloor("0.1.16")).toBe(false);
    expect(meetsHcFloor("0.1.9")).toBe(false);
    expect(meetsHcFloor("0.0.99")).toBe(false);
    expect(meetsHcFloor("0.1.17")).toBe(true);
    expect(meetsHcFloor("0.1.18")).toBe(true);
    expect(meetsHcFloor("0.2.0")).toBe(true);
    expect(meetsHcFloor("1.0.0")).toBe(true);
    expect(compareHcVersions("hc 0.1.18", "0.1.17")).toBeGreaterThan(0);
    expect(compareHcVersions("0.1.17-rc.1", "0.1.17")).toBe(0);
  });
});

const manifest = (targets: object): string => JSON.stringify({ version: "0.1.18", generation: 1, targets });

/** Why the manifest was refused. */
const refused = (text: string): string => {
  try {
    parseHcManifest(text, "linux-x86_64");
  } catch (error) {
    if (error instanceof HcInstallError && error.phase === "manifest") return error.message;
  }
  throw new Error("not refused");
};

describe("the release manifest", () => {
  test("names the version, URL and sha256 of the build for a target", () => {
    const text = manifest({ "linux-x86_64": { url: "https://r.example/hc.tar.gz", sha256: SHA.toUpperCase() } });
    expect(parseHcManifest(text, "linux-x86_64")).toEqual({
      version: "0.1.18",
      url: "https://r.example/hc.tar.gz",
      sha256: SHA,
    });
  });

  test("without the target, a sha256, a URL or JSON at all is refused with why", () => {
    expect(refused(manifest({ "macos-aarch64": { url: "https://r.example/a", sha256: SHA } }))).toBe(
      "herdr-core 0.1.18 has no build for linux-x86_64",
    );
    expect(refused(manifest({ "linux-x86_64": { url: "https://r.example/a", sha256: "abc" } }))).toContain("no build");
    expect(refused(manifest({ "linux-x86_64": { url: "not a url", sha256: SHA } }))).toContain("not one");
    expect(refused(JSON.stringify({ targets: {} }))).toBe("the release manifest names no version");
    expect(refused("<html>")).toBe("the release manifest is not JSON");
  });
});

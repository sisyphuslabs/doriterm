import { expect, test } from "bun:test";
import { classify, compareVersions, DL_KEYS, dlFile, isReleaseFile, isVersionFree } from "./names.ts";

// The files the v0.1.16 release carries (gh release view v0.1.16), so a rename in release.yml or electron-builder.json
// that the /dl links would miss fails here.
const RELEASE_0_1_16 = [
  "doriface-host-linux-arm64",
  "doriface-host-linux-x64",
  "doriface-host-mac-arm64",
  "doriface-host-mac-x64",
  "Doriterm-0.1.16-arm64-mac.zip",
  "Doriterm-0.1.16-arm64-setup.exe",
  "Doriterm-0.1.16-arm64.AppImage",
  "Doriterm-0.1.16-arm64.dmg",
  "Doriterm-0.1.16-x64-mac.zip",
  "Doriterm-0.1.16-x64-setup.exe",
  "Doriterm-0.1.16-x64.dmg",
  "Doriterm-0.1.16-x86_64.AppImage",
  "doriterm-web-0.1.16.zip",
  "Doriterm_0.1.16_amd64.deb",
  "Doriterm_0.1.16_arm64.deb",
  "install.sh",
  "SHA256SUMS.txt",
];

test("every /dl key names a file the release carries, and each such file has a key", () => {
  const named = DL_KEYS.map((key) => dlFile(key, "0.1.16"));
  expect(named.toSorted()).toEqual(RELEASE_0_1_16.toSorted());
  expect(dlFile("mac-arm64.dmg", "0.1.17")).toBe("Doriterm-0.1.17-arm64.dmg");
  expect(dlFile("toString", "0.1.17")).toBeNull();
  expect(DL_KEYS.filter(isVersionFree).toSorted()).toEqual([
    "SHA256SUMS.txt",
    "host-linux-arm64",
    "host-linux-x64",
    "host-mac-arm64",
    "host-mac-x64",
    "install.sh",
  ]);
});

test("each release file is counted under its kind and platform; blockmaps and signatures are served, not counted", () => {
  const cases: [string, ReturnType<typeof classify>][] = [
    ["Doriterm-0.1.16-arm64.dmg", { kind: "desktop", platform: "mac-arm64", counted: true }],
    ["Doriterm-0.1.16-x64-mac.zip", { kind: "desktop", platform: "mac-x64", counted: true }],
    ["Doriterm-0.1.16-arm64-setup.exe", { kind: "desktop", platform: "win-arm64", counted: true }],
    ["Doriterm-0.1.16-x86_64.AppImage", { kind: "desktop", platform: "linux-x64", counted: true }],
    ["Doriterm_0.1.16_amd64.deb", { kind: "desktop", platform: "linux-x64", counted: true }],
    ["Doriterm-0.1.16-x64-setup.exe.blockmap", { kind: "desktop", platform: "win-x64", counted: false }],
    ["doriface-host-mac-arm64", { kind: "host", platform: "mac-arm64", counted: true }],
    ["doriterm-web-0.1.16.zip", { kind: "web", platform: "", counted: true }],
    ["SHA256SUMS.txt", { kind: "checksums", platform: "", counted: true }],
    ["SHA256SUMS.txt.sig", { kind: "checksums", platform: "", counted: false }],
    ["install.sh", { kind: "installer", platform: "", counted: true }],
    ["latest-mac.yml", null],
    ["Doriterm-0.1.15-arm64.dmg", null],
    ["Doriterm-0x1x16-arm64.dmg", null],
  ];
  for (const [file, expected] of cases) expect([file, classify("0.1.16", file)]).toEqual([file, expected]);
});

test("a release file is one plain path segment, never a marker or a climb", () => {
  for (const file of ["install.sh", "Doriterm_0.1.16_amd64.deb", "latest-mac.yml"])
    expect(isReleaseFile(file)).toBe(true);
  for (const file of [".complete", ".yanked", "..", "a..b", "a/b", "", "a b", "%2e%2e"]) {
    expect([file, isReleaseFile(file)]).toEqual([file, false]);
  }
});

test("versions order by number, a release above its pre-releases, then by pre-release fields", () => {
  const ordered = [
    "0.1.9",
    "0.1.10-beta.1",
    "0.1.10-beta.2",
    "0.1.10-beta.10",
    "0.1.10-rc.1",
    "0.1.10",
    "0.2.0",
    "1.0.0",
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    const [a = "", b = ""] = [ordered[i], ordered[i + 1]];
    expect([a, b, compareVersions(a, b), compareVersions(b, a)]).toEqual([a, b, -1, 1]);
  }
  expect(compareVersions("0.1.17", "0.1.17")).toBe(0);
});

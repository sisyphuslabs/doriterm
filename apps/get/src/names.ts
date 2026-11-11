/** Release versions, files, object keys and the stable `/dl/<key>` names (#1969). */

export const GITHUB_REPOSITORY = "sisyphuslabs/doriterm";
export const CHANNELS = ["stable", "beta"] as const;
export type Channel = (typeof CHANNELS)[number];

/** What a counted request fetched; `check` is a feed or manifest read. */
export type Kind = "desktop" | "host" | "installer" | "web" | "checksums" | "check";
/** The first path segment a request came through: a person, the desktop updater or the host updater. */
export type RouteName = "dl" | "v" | "desktop-update" | "host-update";

// X.Y.Z with an optional dotted pre-release, as release-version.ts accepts a tag.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
// One path segment that is never a marker (.complete, .yanked) and never climbs.
const FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export const isChannel = (value: string): value is Channel => CHANNELS.some((channel) => channel === value);
export const isVersion = (value: string): boolean => VERSION.test(value);
export const isReleaseFile = (name: string): boolean => FILE.test(name) && !name.includes("..");

export const objectKey = (version: string, file: string): string => `releases/v${version}/${file}`;
export const completeKey = (version: string): string => `releases/v${version}/.complete`;
export const yankedKey = (version: string): string => `releases/v${version}/.yanked`;
export const pointerKey = (channel: Channel): string => `channels/${channel}.json`;
/** The host's signed manifest for a channel, written by the release's mirror and re-signed by every channel move. */
export const hostManifestKey = (channel: Channel): string => `channels/${channel}.host-manifest.json`;

export const githubAssetUrl = (version: string, file: string): string =>
  `https://github.com/${GITHUB_REPOSITORY}/releases/download/v${version}/${file}`;
/** GitHub's own "latest release" redirect, which only works for a file whose name carries no version. */
export const githubLatestUrl = (file: string | null): string =>
  file === null
    ? `https://github.com/${GITHUB_REPOSITORY}/releases/latest`
    : `https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/${file}`;

/** The file each stable `/dl/<key>` link names at a version, as release.yml and electron-builder.json name them. */
const DL_FILES: Readonly<Record<string, (version: string) => string>> = {
  "mac-arm64.dmg": (v) => `Doriterm-${v}-arm64.dmg`,
  "mac-arm64.zip": (v) => `Doriterm-${v}-arm64-mac.zip`,
  "mac-x64.dmg": (v) => `Doriterm-${v}-x64.dmg`,
  "mac-x64.zip": (v) => `Doriterm-${v}-x64-mac.zip`,
  "win-x64.exe": (v) => `Doriterm-${v}-x64-setup.exe`,
  "win-arm64.exe": (v) => `Doriterm-${v}-arm64-setup.exe`,
  "linux-x64.AppImage": (v) => `Doriterm-${v}-x86_64.AppImage`,
  "linux-arm64.AppImage": (v) => `Doriterm-${v}-arm64.AppImage`,
  "linux-x64.deb": (v) => `Doriterm_${v}_amd64.deb`,
  "linux-arm64.deb": (v) => `Doriterm_${v}_arm64.deb`,
  "host-linux-x64": () => "doriface-host-linux-x64",
  "host-linux-arm64": () => "doriface-host-linux-arm64",
  "host-mac-x64": () => "doriface-host-mac-x64",
  "host-mac-arm64": () => "doriface-host-mac-arm64",
  "web.zip": (v) => `doriterm-web-${v}.zip`,
  "SHA256SUMS.txt": () => "SHA256SUMS.txt",
  "install.sh": () => "install.sh",
};

export const DL_KEYS: readonly string[] = Object.keys(DL_FILES);

export function dlFile(key: string, version: string): string | null {
  const name = Object.hasOwn(DL_FILES, key) ? DL_FILES[key] : undefined;
  return name === undefined ? null : name(version);
}

/** A file whose name is the same in every release, so GitHub's latest-release redirect can stand in for it. */
export const isVersionFree = (key: string): boolean => dlFile(key, "0.0.0") === dlFile(key, "1.0.0");

export interface AssetClass {
  readonly kind: Exclude<Kind, "check">;
  /** `mac-arm64`, `win-x64`, `linux-x64`, ...; empty for a file that is the same on every platform. */
  readonly platform: string;
  /** Whether a whole download of it is a download: a blockmap or a signature is fetched alongside one. */
  readonly counted: boolean;
}

const escape = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ARCH: Readonly<Record<string, string>> = { x64: "x64", arm64: "arm64", x86_64: "x64", amd64: "x64" };

/** What a release file is, for the count; a file this does not know is still served, and never counted. */
export function classify(version: string, file: string): AssetClass | null {
  const v = escape(version);
  const blockmap = file.endsWith(".blockmap");
  const name = blockmap ? file.slice(0, -".blockmap".length) : file;
  const desktop: readonly (readonly [RegExp, string])[] = [
    [new RegExp(`^Doriterm-${v}-(arm64|x64)\\.dmg$`), "mac"],
    [new RegExp(`^Doriterm-${v}-(arm64|x64)-mac\\.zip$`), "mac"],
    [new RegExp(`^Doriterm-${v}-(arm64|x64)-setup\\.exe$`), "win"],
    [new RegExp(`^Doriterm-${v}-(x86_64|arm64)\\.AppImage$`), "linux"],
    [new RegExp(`^Doriterm_${v}_(amd64|arm64)\\.deb$`), "linux"],
  ];
  for (const [pattern, os] of desktop) {
    const arch = pattern.exec(name)?.[1];
    if (arch !== undefined) return { kind: "desktop", platform: `${os}-${ARCH[arch] ?? arch}`, counted: !blockmap };
  }
  if (blockmap) return null;
  const host = /^doriface-host-(linux|mac)-(x64|arm64)$/.exec(file);
  if (host !== null) return { kind: "host", platform: `${host[1]}-${host[2]}`, counted: true };
  if (file === `doriterm-web-${version}.zip`) return { kind: "web", platform: "", counted: true };
  if (file === "SHA256SUMS.txt") return { kind: "checksums", platform: "", counted: true };
  if (file === "SHA256SUMS.txt.sig") return { kind: "checksums", platform: "", counted: false };
  if (file === "install.sh") return { kind: "installer", platform: "", counted: true };
  return null;
}

const identifiers = (pre: string): string[] => pre.split(".");

/** Semantic-version order: the numbers, then a release above any of its pre-releases, then the pre-release fields. */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre] = a.split(/-(.*)/s, 2);
  const [bCore = "", bPre] = b.split(/-(.*)/s, 2);
  const an = aCore.split(".").map(Number);
  const bn = bCore.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (an[i] ?? 0) - (bn[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  const ai = identifiers(aPre);
  const bi = identifiers(bPre);
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i];
    const y = bi[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Math.sign(Number(x) - Number(y));
    if (xNum) return -1;
    if (yNum) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Which herdr-core release to install, as a Doriterm release key vouched for it (#2945): the manifest is fetched, then
 * checked against the signature of the version it names before anything else is read from it, then held to the floor.
 */
import { RELEASE_PUBLIC_KEYS, verifyRelease } from "@doriface/crypto";
import { HC_VERSION_FLOOR, meetsHcFloor } from "@doriface/protocol";

/** Doriterm's mirror of the herdr-core releases it signed (.github/workflows/core-mirror.yml), at herdr's own paths. */
export const DEFAULT_RELEASES_URL = "https://get.doriterm.com";

export type HcTarget = "linux-x86_64" | "linux-aarch64" | "macos-x86_64" | "macos-aarch64" | "windows-x86_64";

/** The release build for this OS and CPU, or undefined where herdr-core ships none (Windows on ARM included). */
export function hcTarget(platform: NodeJS.Platform, arch: string): HcTarget | undefined {
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : undefined;
  if (cpu === undefined) return undefined;
  if (platform === "linux") return `linux-${cpu}`;
  if (platform === "darwin") return `macos-${cpu}`;
  if (platform === "win32" && cpu === "x86_64") return "windows-x86_64";
  return undefined;
}

export type HcInstallPhase = "manifest" | "signature" | "download" | "verify" | "extract" | "check" | "install";

export class HcInstallError extends Error {
  override readonly name = "HcInstallError";
  readonly phase: HcInstallPhase;

  constructor(phase: HcInstallPhase, message: string, options?: ErrorOptions) {
    super(message, options);
    this.phase = phase;
  }
}

export interface HcRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** The build for `target` in a release manifest (`{ version, targets: { <target>: { url, sha256 } } }`). */
export function parseHcManifest(text: string, target: HcTarget): HcRelease {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new HcInstallError("manifest", "the release manifest is not JSON", { cause: error });
  }
  const version = field(manifest, "version");
  const build = field(field(manifest, "targets"), target);
  const url = field(build, "url");
  const sha256 = field(build, "sha256");
  if (typeof version !== "string" || version === "") {
    throw new HcInstallError("manifest", "the release manifest names no version");
  }
  if (typeof url !== "string" || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new HcInstallError("manifest", `herdr-core ${version} has no build for ${target}`);
  }
  if (!URL.canParse(url)) throw new HcInstallError("manifest", `the release manifest's URL is not one: ${url}`);
  return { version, url, sha256: sha256.toLowerCase() };
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/** The version an unverified manifest claims, only to locate its signature: a plain version or nothing. */
function claimedVersion(manifest: Uint8Array): string | undefined {
  try {
    const version = field(JSON.parse(new TextDecoder().decode(manifest)), "version");
    return typeof version === "string" && VERSION.test(version) ? version : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** The release server: $HERDR_RELEASES_URL (tests; its manifests are held to the same signature), else Doriterm's mirror. */
export function hcReleasesUrl(env: Readonly<Record<string, string | undefined>>): string {
  const given = env["HERDR_RELEASES_URL"];
  return (given === undefined || given === "" ? DEFAULT_RELEASES_URL : given).replace(/\/+$/, "");
}

export async function fetchOk(url: string, phase: HcInstallPhase, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new HcInstallError(phase, `cannot reach ${what} (${url})`, { cause: error });
  }
  if (!response.ok) throw new HcInstallError(phase, `${what} answered HTTP ${response.status} (${url})`);
  return response;
}

export interface ReleaseQuery {
  readonly releases: string;
  /** $HC_VERSION: that version's manifest instead of latest.json. */
  readonly pinned: string | undefined;
  readonly target: HcTarget;
  readonly trustedKeys: readonly string[] | undefined;
  readonly phase: (next: HcInstallPhase) => void;
}

/**
 * The release a Doriterm key signed, at or above the floor. latest.json has no signature of its own: it is checked
 * against the immutable signature of the version it names, so a cached latest.json never meets another version's
 * signature. That version only locates the file; nothing else in the manifest is read until the signature over all of
 * it checks out.
 */
export async function signedRelease({
  releases,
  pinned,
  target,
  trustedKeys,
  phase,
}: ReleaseQuery): Promise<HcRelease> {
  phase("manifest");
  const path = pinned === undefined || pinned === "" ? "latest.json" : `${pinned}/manifest.json`;
  const manifest = new Uint8Array(
    await (await fetchOk(`${releases}/core/${path}`, "manifest", "the release server")).arrayBuffer(),
  );

  phase("signature");
  const named = pinned === undefined || pinned === "" ? claimedVersion(manifest) : pinned;
  if (named === undefined || !VERSION.test(named)) {
    throw new HcInstallError("manifest", "the release manifest names no version");
  }
  const signatureUrl = `${releases}/core/${named}/manifest.json.sig`;
  const signature = await (await fetchOk(signatureUrl, "signature", "the release server")).text();
  if (!verifyRelease(manifest, signature, trustedKeys ?? RELEASE_PUBLIC_KEYS)) {
    throw new HcInstallError(
      "signature",
      "the core manifest's signature is not one this host trusts; nothing was downloaded",
    );
  }
  const release = parseHcManifest(new TextDecoder().decode(manifest), target);
  if (!meetsHcFloor(release.version)) {
    throw new HcInstallError(
      "manifest",
      `herdr-core ${release.version} is older than ${HC_VERSION_FLOOR}, which Doriterm needs`,
    );
  }
  return release;
}

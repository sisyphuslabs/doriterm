/** The host's signed update manifest at get.doriterm.com/host/<channel>/manifest.json (#1969). */

export type HostTarget = "linux-x64" | "linux-arm64" | "mac-x64" | "mac-arm64";

export interface HostBuild {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface HostManifest {
  readonly version: string;
  /** The channel it was signed for; beta may be offered stable's manifest when stable is newer, never the reverse. */
  readonly channel: "stable" | "beta";
  /** The percentage of hosts offered this version, 0 to 100. */
  readonly rollout: number;
  /** The lowest version that can update itself to this one; below it, install.sh is the way up. */
  readonly minimum?: string;
  readonly targets: Readonly<Partial<Record<HostTarget, HostBuild>>>;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
const TARGETS: readonly HostTarget[] = ["linux-x64", "linux-arm64", "mac-x64", "mac-arm64"];

/** The build this host runs as, or undefined where none ships (Windows takes the host with the desktop app). */
export function hostTarget(platform: NodeJS.Platform, arch: string): HostTarget | undefined {
  const os = platform === "linux" ? "linux" : platform === "darwin" ? "mac" : undefined;
  const cpu = arch === "x64" || arch === "arm64" ? arch : undefined;
  return os === undefined || cpu === undefined ? undefined : `${os}-${cpu}`;
}

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

/** A manifest whose signature already checked out; anything malformed is null, never a partial manifest. */
export function parseHostManifest(text: string): HostManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const version = field(value, "version");
  const rollout = field(value, "rollout");
  const minimum = field(value, "minimum");
  const channel = field(value, "channel");
  if (channel !== "stable" && channel !== "beta") return null;
  if (typeof version !== "string" || !VERSION.test(version)) return null;
  if (typeof rollout !== "number" || !Number.isInteger(rollout) || rollout < 0 || rollout > 100) return null;
  if (minimum !== undefined && (typeof minimum !== "string" || !VERSION.test(minimum))) return null;
  const targets: Partial<Record<HostTarget, HostBuild>> = {};
  for (const target of TARGETS) {
    const build = field(field(value, "targets"), target);
    if (build === undefined) continue;
    const url = field(build, "url");
    const sha256 = field(build, "sha256");
    const size = field(build, "size");
    if (typeof url !== "string" || !URL.canParse(url) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
      return null;
    }
    if (typeof size !== "number" || !Number.isInteger(size) || size <= 0) return null;
    targets[target] = { url, sha256, size };
  }
  return { version, channel, rollout, targets, ...(minimum === undefined ? {} : { minimum }) };
}

const identifiers = (pre: string): string[] => (pre === "" ? [] : pre.split("."));

/**
 * Semantic-version order on what a manifest can name: the numbers, then a release above its prereleases, then the
 * prerelease identifiers one by one, numeric ones by value (beta.9 below beta.10) and below alphanumeric ones.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre = ""] = a.split(/-(.*)/s, 2);
  const [bCore = "", bPre = ""] = b.split(/-(.*)/s, 2);
  const [x, y] = [aCore.split(".").map(Number), bCore.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return Math.sign((x[i] ?? 0) - (y[i] ?? 0));
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  const [ai, bi] = [identifiers(aPre), identifiers(bPre)];
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const [p, q] = [ai[i], bi[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const [pNum, qNum] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pNum && qNum) return Math.sign(Number(p) - Number(q));
    if (pNum !== qNum) return pNum ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

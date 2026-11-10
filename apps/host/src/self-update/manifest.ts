/** The host's signed update manifest at get.doriterm.com/host/<channel>/manifest.json (#1969). */

export type HostTarget = "linux-x64" | "linux-arm64" | "mac-x64" | "mac-arm64";

export interface HostBuild {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
}

export interface HostManifest {
  readonly version: string;
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
  return { version, rollout, targets, ...(minimum === undefined ? {} : { minimum }) };
}

const core = (version: string): number[] => (version.split("-")[0] ?? "").split(".").map(Number);

/** Semantic-version order on what a manifest can name: the numbers, then a release above its prereleases. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [core(a), core(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return Math.sign((x[i] ?? 0) - (y[i] ?? 0));
  const [aPre, bPre] = [a.split("-").slice(1).join("-"), b.split("-").slice(1).join("-")];
  if (aPre === bPre) return 0;
  if (aPre === "") return 1;
  if (bPre === "") return -1;
  return aPre < bPre ? -1 : 1;
}

/**
 * Installs herdr-core (hc) the way its own distribution/install.sh and install.ps1 do: the release manifest, a download
 * whose sha256 must match, a `--version` run of the new binary, then a user-level install (an existing one is swapped
 * with `herdr-core update --from`, so its terminals keep running). Node APIs only: the Electron main process runs it too.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, cpSync, existsSync, linkSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The floor and the version order are shared with the client, which checks a core it reached against the same floor.
export { compareHcVersions, HC_VERSION_FLOOR, meetsHcFloor } from "@doriface/protocol";
import { compareHcVersions, HC_VERSION_FLOOR, meetsHcFloor } from "@doriface/protocol";

export const DEFAULT_RELEASES_URL = "https://releases.herdr.dev";

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

export type HcInstallPhase = "manifest" | "download" | "verify" | "extract" | "check" | "install";

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

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export interface HcInstallOptions {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  readonly onPhase?: ((phase: HcInstallPhase) => void) | undefined;
}

export interface HcInstalled {
  readonly version: string;
  /** The installed binary, e.g. `~/.local/bin/herdr-core`. */
  readonly path: string;
  readonly action: "installed" | "updated";
}

/** Where hc is installed for this user: `~/.local/bin`, or `%LOCALAPPDATA%\Programs\herdr-core` on Windows. */
export function hcInstallDir(
  platform: NodeJS.Platform,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const override = env["HC_INSTALL_DIR"];
  if (override !== undefined && override !== "") return override;
  if (platform !== "win32") return join(home, ".local", "bin");
  const local = env["LOCALAPPDATA"];
  return join(local === undefined || local === "" ? join(home, "AppData", "Local") : local, "Programs", "herdr-core");
}

/** The release server: $HERDR_RELEASES_URL (tests), else herdr's own. */
export function hcReleasesUrl(env: Readonly<Record<string, string | undefined>>): string {
  const given = env["HERDR_RELEASES_URL"];
  return (given === undefined || given === "" ? DEFAULT_RELEASES_URL : given).replace(/\/+$/, "");
}

interface Run {
  readonly code: number;
  readonly out: string;
}

const run = (file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<Run> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { env, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") reject(error);
      else resolve({ code: error === null ? 0 : Number(error.code), out: `${stdout}${stderr}`.trim() });
    });
  });

async function fetchOk(url: string, phase: HcInstallPhase, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new HcInstallError(phase, `cannot reach ${what} (${url})`, { cause: error });
  }
  if (!response.ok) throw new HcInstallError(phase, `${what} answered HTTP ${response.status} (${url})`);
  return response;
}

const onPath = (name: string, env: Readonly<Record<string, string | undefined>>): boolean =>
  (env["PATH"] ?? env["Path"] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .some((dir) => isExecutable(join(dir, name)));

/** Downloads, verifies and installs herdr-core for this user; never runs anything it did not verify first. */
export async function installHc(options: HcInstallOptions): Promise<HcInstalled> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const { env, home } = options;
  const phase = (next: HcInstallPhase): void => options.onPhase?.(next);
  const target = hcTarget(platform, arch);
  if (target === undefined) throw new HcInstallError("manifest", `herdr-core has no build for ${platform} ${arch}`);
  const windows = platform === "win32";
  const exe = windows ? "herdr-core.exe" : "herdr-core";
  const bin = hcInstallDir(platform, home, env);
  const installed = join(bin, exe);
  const releases = hcReleasesUrl(env);

  phase("manifest");
  const pinned = env["HC_VERSION"];
  const manifestUrl = `${releases}/core/${pinned === undefined || pinned === "" ? "latest.json" : `${pinned}/manifest.json`}`;
  const release = parseHcManifest(await (await fetchOk(manifestUrl, "manifest", "the release server")).text(), target);
  if (!meetsHcFloor(release.version)) {
    throw new HcInstallError(
      "manifest",
      `herdr-core ${release.version} is older than ${HC_VERSION_FLOOR}, which Doriterm needs`,
    );
  }

  phase("download");
  // As install.sh: only a plain URL on the release server in use is marked for its download counter.
  const plain = release.url.startsWith(`${releases}/`) && !/[?#]/.test(release.url);
  const download = plain ? `${release.url}?src=${existsSync(installed) ? "update" : "install"}` : release.url;
  const archive = new Uint8Array(await (await fetchOk(download, "download", "the download")).arrayBuffer());

  phase("verify");
  const got = createHash("sha256").update(archive).digest("hex");
  if (got !== release.sha256) {
    throw new HcInstallError(
      "verify",
      `the download is damaged (checksum mismatch: expected ${release.sha256}, got ${got}); nothing was installed`,
    );
  }

  const tmp = await mkdtemp(join(tmpdir(), "hc-install-"));
  try {
    phase("extract");
    const file = join(tmp, windows ? "hc.zip" : "hc.tar.gz");
    const unpacked = join(tmp, "hc");
    await writeFile(file, archive);
    await mkdir(unpacked);
    await extract(file, unpacked, platform, env);
    const fresh = join(unpacked, exe);
    if (!existsSync(fresh) || (windows && !existsSync(join(unpacked, "conpty", "conpty.dll")))) {
      throw new HcInstallError("extract", "the download holds no complete herdr-core");
    }
    // A download from fetch carries no quarantine flag, but one copied in by hand may; best effort, as Gatekeeper
    // would otherwise stop the --version run below.
    if (platform === "darwin")
      await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", unpacked], env).catch(() => undefined);

    phase("check");
    const check = await run(fresh, ["--version"], env).catch((error: unknown) => {
      throw new HcInstallError("check", "the downloaded herdr-core does not run on this computer", { cause: error });
    });
    if (check.code !== 0) {
      throw new HcInstallError("check", `the downloaded herdr-core does not run on this computer: ${check.out}`);
    }

    phase("install");
    await mkdir(bin, { recursive: true });
    const action = existsSync(installed) ? "updated" : "installed";
    const bundled = join(unpacked, "Herdr Core.app", "Contents", "MacOS", "herdr-core");
    const ownUser = process.getuid?.() !== 0 && bin.startsWith(`${home}/`);
    if (platform === "darwin" && ownUser && isExecutable(bundled)) {
      await installBundle({ bundled, installed, action, releases, env, unpacked });
    } else if (action === "updated") {
      // Swapped the planned way, so its terminals keep running.
      const update = await run(installed, ["update", "--from", fresh], env);
      if (update.code !== 0) throw new HcInstallError("install", `updating ${installed} failed: ${update.out}`);
    } else if (windows) {
      copyFileSync(fresh, installed);
      cpSync(join(unpacked, "conpty"), join(bin, "conpty"), { recursive: true });
    } else {
      const next = `${installed}.new`;
      copyFileSync(fresh, next);
      await chmod(next, 0o755);
      await rename(next, installed);
    }
    // `hc` beside it only where no hc exists (some window managers ship one).
    const hc = join(bin, windows ? "hc.exe" : "hc");
    if (!onPath(windows ? "hc.exe" : "hc", env) && !existsSync(hc)) {
      if (windows) linkSync(installed, hc);
      else symlinkSync("herdr-core", hc);
    }
    return { version: release.version, path: installed, action };
  } catch (error) {
    if (error instanceof HcInstallError) throw error;
    throw new HcInstallError("install", error instanceof Error ? error.message : String(error), { cause: error });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function extract(
  file: string,
  into: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  // Windows' own tar opens zips; Git Bash's, often first on PATH, cannot, so it is named by its full path.
  const tar = platform === "win32" ? join(env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const args = platform === "win32" ? ["-xf", file, "-C", into] : ["-xzf", file, "-C", into];
  const done = await run(tar, args, env).catch((error: unknown) => ({ code: -1, out: String(error) }));
  if (done.code === 0) return;
  if (platform === "win32") {
    const expand = `Expand-Archive -LiteralPath '${file}' -DestinationPath '${into}' -Force`;
    const fallback = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", expand], env);
    if (fallback.code === 0) return;
  }
  throw new HcInstallError("extract", `cannot unpack the download: ${done.out}`);
}

interface Bundle {
  readonly bundled: string;
  readonly installed: string;
  readonly action: "installed" | "updated";
  readonly releases: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly unpacked: string;
}

/** macOS: the core is its own app, Herdr Core.app, installed by the bundled binary itself (install.sh's path). */
async function installBundle({ bundled, installed, action, releases, env, unpacked }: Bundle): Promise<void> {
  if (action === "updated") {
    const [old, next] = await Promise.all([run(installed, ["--version"], env), run(bundled, ["--version"], env)]);
    if (compareHcVersions(next.out, old.out) < 0) {
      throw new HcInstallError("install", `${next.out} is older than ${old.out}; hc update --from --force downgrades`);
    }
  }
  // Only herdr's own releases are signed by herdr; a test server's are not.
  if (releases === DEFAULT_RELEASES_URL) {
    const requirement =
      '=identifier "dev.herdr.core" and anchor apple generic and certificate leaf[subject.OU] = "2W9652Q7QR"';
    const app = join(unpacked, "Herdr Core.app");
    const signed = await run("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, app], env);
    if (signed.code !== 0) throw new HcInstallError("verify", `not a signed Herdr release: ${signed.out}`);
  }
  const done = await run(bundled, ["--hc-install-bundle", bundled, installed], env);
  if (done.code !== 0) throw new HcInstallError("install", `installing Herdr Core.app failed: ${done.out}`);
  if (action === "updated") {
    const restart = await run(installed, ["server", "restart"], env);
    if (restart.code !== 0) throw new HcInstallError("install", `restarting the core failed: ${restart.out}`);
  }
}

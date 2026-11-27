/**
 * Installs herdr-core (hc) from the herdr-core releases Doriterm vouched for (#2945): a manifest a Doriterm release key
 * signed (hc-release.ts), never older than the floor or the herdr-core already installed, a download whose sha256 must
 * match the signed one, herdr's codesign on a Mac, a `--version` run of the new binary, then a user-level install (an
 * existing one is swapped with `herdr-core update --from <verified file>`, so its terminals keep running). Every core
 * update goes through here (hc-keep-current.ts included). Node APIs only: the Electron main process runs it too.
 */
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, linkSync, symlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { compareHcVersions } from "@doriface/protocol";
import {
  DEFAULT_RELEASES_URL,
  fetchOk,
  type HcInstallPhase,
  HcInstallError,
  hcReleasesUrl,
  hcTarget,
  signedRelease,
} from "./hc-release.ts";
import { extract, installBundle, isExecutable, run, verifyHerdrSigned } from "./hc-unpack.ts";

// The floor and the version order are shared with the client, which checks a core it reached against the same floor.
export { compareHcVersions, HC_VERSION_FLOOR, meetsHcFloor } from "@doriface/protocol";
export {
  DEFAULT_RELEASES_URL,
  type HcInstallPhase,
  HcInstallError,
  type HcRelease,
  hcReleasesUrl,
  type HcTarget,
  hcTarget,
  parseHcManifest,
} from "./hc-release.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface HcInstallOptions {
  readonly home: string;
  readonly env: Env;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  readonly onPhase?: ((phase: HcInstallPhase) => void) | undefined;
  /** For tests: the keys a manifest's signature must be by; every caller in a shipped build leaves the compiled ones. */
  readonly trustedKeys?: readonly string[] | undefined;
}

export interface HcInstalled {
  readonly version: string;
  /** The installed binary, e.g. `~/.local/bin/herdr-core`. */
  readonly path: string;
  readonly action: "installed" | "updated";
}

/** Where hc is installed for this user: `~/.local/bin`, or `%LOCALAPPDATA%\Programs\herdr-core` on Windows. */
export function hcInstallDir(platform: NodeJS.Platform, home: string, env: Env): string {
  const override = env["HC_INSTALL_DIR"];
  if (override !== undefined && override !== "") return override;
  if (platform !== "win32") return join(home, ".local", "bin");
  const local = env["LOCALAPPDATA"];
  return join(local === undefined || local === "" ? join(home, "AppData", "Local") : local, "Programs", "herdr-core");
}

const onPath = (name: string, env: Env): boolean =>
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
  const pinned = env["HC_VERSION"];
  const release = await signedRelease({ releases, pinned, target, trustedKeys: options.trustedKeys, phase });
  // A signed but older manifest (a rolled-back latest.json) never downgrades: asked of the herdr-core already
  // installed, before anything is downloaded, let alone run.
  if (existsSync(installed)) {
    const current = await run(installed, ["--version"], env).catch(() => undefined);
    if (current?.code === 0 && compareHcVersions(release.version, current.out) < 0) {
      throw new HcInstallError(
        "manifest",
        `herdr-core ${release.version} is older than the installed ${current.out.replace(/^hc /, "")}; nothing was downloaded`,
      );
    }
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
    // Before anything from the download runs: herdr signs its macOS builds, and a test server's are not signed.
    if (platform === "darwin" && releases === DEFAULT_RELEASES_URL) await verifyHerdrSigned(unpacked, exe, env);

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
      await installBundle(bundled, installed, action, env);
    } else if (action === "updated") {
      // Swapped the planned way, from the verified file, so its terminals keep running.
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

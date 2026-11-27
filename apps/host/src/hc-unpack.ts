/** Unpacking and placing a herdr-core download that already checked out (hc-install.ts), with Node APIs only. */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { HcInstallError } from "./hc-release.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface Run {
  readonly code: number;
  readonly out: string;
}

export const run = (file: string, args: readonly string[], env: Env): Promise<Run> =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { env, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error !== null && typeof error.code !== "number") reject(error);
      else resolve({ code: error === null ? 0 : Number(error.code), out: `${stdout}${stderr}`.trim() });
    });
  });

export const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export async function extract(file: string, into: string, platform: NodeJS.Platform, env: Env): Promise<void> {
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

const HERDR_REQUIREMENT =
  '=identifier "dev.herdr.core" and anchor apple generic and certificate leaf[subject.OU] = "2W9652Q7QR"';

/** macOS: the download's binary, and its Herdr Core.app when it has one, are signed by herdr's Apple team. */
export async function verifyHerdrSigned(unpacked: string, exe: string, env: Env): Promise<void> {
  const app = join(unpacked, "Herdr Core.app");
  for (const path of existsSync(app) ? [app, join(unpacked, exe)] : [join(unpacked, exe)]) {
    // oxlint-disable-next-line no-await-in-loop -- two codesign runs, in order
    const signed = await run("/usr/bin/codesign", ["--verify", "--strict", "-R", HERDR_REQUIREMENT, path], env);
    if (signed.code !== 0) throw new HcInstallError("verify", `not a signed Herdr release: ${signed.out}`);
  }
}

/** macOS: the core is its own app, Herdr Core.app, installed by the bundled binary itself (install.sh's path). */
export async function installBundle(
  bundled: string,
  installed: string,
  action: "installed" | "updated",
  env: Env,
): Promise<void> {
  const done = await run(bundled, ["--hc-install-bundle", bundled, installed], env);
  if (done.code !== 0) throw new HcInstallError("install", `installing Herdr Core.app failed: ${done.out}`);
  if (action === "updated") {
    const restart = await run(installed, ["server", "restart"], env);
    if (restart.code !== 0) throw new HcInstallError("install", `restarting the core failed: ${restart.out}`);
  }
}

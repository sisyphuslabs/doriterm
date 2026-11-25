import { accessSync, constants, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compareHcVersions, HC_VERSION_RECOMMENDED } from "@doriface/protocol";

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface KeepCurrentDeps {
  readonly hc: string;
  readonly version: string;
  /** The user-level install dir (hcInstallDir); hc elsewhere belongs to a package manager and is left alone. */
  readonly installDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run: (argv: readonly string[]) => Promise<Ran>;
  readonly log: (line: string) => void;
}

export type KeepCurrent =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "updated"; readonly from: string; readonly to: string; readonly terminals: number }
  | { readonly kind: "failed"; readonly reason: string };

const addresses = (ran: Ran): string[] => {
  if (ran.code !== 0) throw new Error(`hc ls failed: ${ran.stderr.trim() || `exit ${String(ran.code)}`}`);
  const value: unknown = JSON.parse(ran.stdout);
  const terminals = Array.isArray(Reflect.get(Object(value), "terminals"))
    ? Reflect.get(Object(value), "terminals")
    : [];
  return (terminals as unknown[]).map((row) => String(Reflect.get(Object(row), "address")));
};

/** Whether `hc` is the user's own install (under installDir, writable), the only kind the host may swap. */
function userInstall(hc: string, installDir: string): boolean {
  try {
    const real = realpathSync(hc);
    const dir = realpathSync(installDir);
    if (!(real === dir || real.startsWith(`${dir}/`) || dirname(resolve(hc)) === dir)) return false;
    accessSync(dirname(real), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Brings the host's hc up to the version this release recommends, with no user step. `hc update` restarts only the
 * core: the holder keeps every program running and the new core adopts its terminals, so nothing is lost. The update is
 * judged by what it promised: the new version reports, and every terminal listed before is still listed.
 */
export async function keepHcCurrent(deps: KeepCurrentDeps): Promise<KeepCurrent> {
  const skip = (reason: string): KeepCurrent => {
    deps.log(`hc stays at ${deps.version}: ${reason}`);
    return { kind: "skipped", reason };
  };
  if (deps.env["DORIFACE_HC_AUTO_UPDATE"] === "0") return skip("DORIFACE_HC_AUTO_UPDATE=0");
  if (compareHcVersions(deps.version, HC_VERSION_RECOMMENDED) >= 0)
    return skip(`at or above ${HC_VERSION_RECOMMENDED}`);
  if (!userInstall(deps.hc, deps.installDir))
    return skip("installed outside the user's own folder, so its owner updates it");
  try {
    const before = addresses(await deps.run([deps.hc, "ls", "--json"]));
    const updated = await deps.run([deps.hc, "update", "--version", HC_VERSION_RECOMMENDED, "--json"]);
    if (updated.code !== 0)
      throw new Error(`hc update failed: ${updated.stderr.trim() || `exit ${String(updated.code)}`}`);
    const now = (await deps.run([deps.hc, "--version"])).stdout.trim().replace(/^hc /, "");
    if (compareHcVersions(now, HC_VERSION_RECOMMENDED) < 0) throw new Error(`hc reports ${now} after the update`);
    const after = new Set(addresses(await deps.run([deps.hc, "ls", "--json"])));
    const lost = before.filter((address) => !after.has(address));
    if (lost.length > 0) throw new Error(`terminals missing after the update: ${lost.join(", ")}`);
    deps.log(`hc updated from ${deps.version} to ${now}; all ${before.length} terminals kept running`);
    return { kind: "updated", from: deps.version, to: now, terminals: before.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(`hc update did not complete: ${reason}`);
    return { kind: "failed", reason };
  }
}

/** Runs an hc command against the host's own session, with no inherited terminal identity. */
export async function runOnSession(
  argv: readonly string[],
  session: string | undefined,
  env: Readonly<Record<string, string | undefined>> | undefined,
): Promise<Ran> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? process.env))
    if (value !== undefined && key !== "HC_TERMINAL_ID") vars[key] = value;
  if (session !== undefined) vars["HC_SESSION"] = session;
  const child = Bun.spawn([...argv], { env: vars, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

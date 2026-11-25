import { DEFAULT_RELEASES_URL, hcInstallDir, hcTarget, parseHcManifest } from "@doriface/host/hc-install";
import { compareHcVersions } from "@doriface/protocol";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { isCoreVersion, type CoreUpdateAnswer, type CoreUpdateOffer } from "../shared/core-update.ts";
import { backupCore } from "./core-update-backup.ts";
import type { HostContext } from "./host-command.ts";

const run = promisify(execFile);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const unavailable = (message: string): CoreUpdateAnswer => ({ state: "unavailable", message });
const failed = (message: string): CoreUpdateAnswer => ({ state: "failed", message });

function coreErrorMessage(error: unknown): string | undefined {
  const stderr = field(error, "stderr");
  if (typeof stderr !== "string") return undefined;
  try {
    const message = field(field(JSON.parse(stderr), "error"), "message");
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

interface UpdateCandidate {
  readonly offer: CoreUpdateOffer;
  readonly binary: string;
  readonly sha256: string;
}

/** The local, user-managed install only. Remote cores and package-manager installs have their own update paths. */
export class CoreUpdater {
  readonly #context: HostContext;
  readonly #selected: () => string | undefined;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #releases: string;
  #busy = false;
  #candidate: UpdateCandidate | undefined;

  constructor(context: HostContext, selected: () => string | undefined) {
    this.#context = context;
    this.#selected = selected;
    this.#releases = DEFAULT_RELEASES_URL;
    if (!context.packaged) {
      const value = context.env["HERDR_RELEASES_URL"];
      if (value !== undefined && /^http:\/\/127\.0\.0\.1:\d+$/.test(value)) this.#releases = value;
    }
    this.#env = { ...context.env, HERDR_RELEASES_URL: this.#releases };
  }

  async check(): Promise<CoreUpdateAnswer> {
    if (this.#busy) return unavailable("A core update is already in progress.");
    this.#busy = true;
    this.#candidate = undefined;
    try {
      const binary = await this.#userBinary();
      if (binary === undefined) {
        return unavailable("Use the installer or package manager that installed your local herdr-core.");
      }
      const current = await this.#version(binary);
      const target = hcTarget(this.#context.platform, process.arch);
      if (target === undefined) return unavailable("There is no herdr-core release for this computer.");
      const response = await fetch(`${this.#releases}/core/latest.json`, {
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) return failed(`The release server returned HTTP ${response.status}.`);
      const manifest = await response.text();
      const generation = field(JSON.parse(manifest), "generation");
      // The desktop host and client speak hc protocol generation 1.
      if (generation !== 1) return unavailable("The new core needs a newer version of Doriterm.");
      const { version } = parseHcManifest(manifest, target);
      if (!isCoreVersion(version)) return failed("The release server returned an invalid core version.");
      if (compareHcVersions(version, current) <= 0) return { state: "current", version: current };
      const offer = { state: "available", current, version } as const;
      const sha256 = await this.#sha256(binary);
      this.#candidate = { offer, binary, sha256 };
      return offer;
    } catch (error) {
      return failed(errorText(error));
    } finally {
      this.#busy = false;
    }
  }

  async apply(confirm: (offer: CoreUpdateOffer) => Promise<boolean>): Promise<CoreUpdateAnswer> {
    if (this.#busy) return unavailable("A core update is already in progress.");
    const candidate = this.#candidate;
    if (candidate === undefined) return unavailable("Check for an update first.");
    this.#busy = true;
    try {
      if (!(await confirm(candidate.offer))) return candidate.offer;
      this.#candidate = undefined;
      if (
        (await this.#userBinary()) !== candidate.binary ||
        (await this.#sha256(candidate.binary)) !== candidate.sha256 ||
        (await this.#version(candidate.binary)) !== candidate.offer.current
      ) {
        return unavailable("The local core changed since the check. Check for updates again.");
      }
      return await this.#replace(candidate);
    } catch (error) {
      return failed(errorText(error));
    } finally {
      this.#busy = false;
    }
  }

  async #replace({ offer, binary, sha256 }: UpdateCandidate): Promise<CoreUpdateAnswer> {
    const previous = await this.#status(binary);
    if (field(previous, "installed_by") !== null) {
      return unavailable("Use the package manager that installed your local herdr-core.");
    }
    if (field(previous, "version") !== offer.current) {
      return unavailable("The running core and the installed version differ. Restart the core before updating.");
    }
    const backup = await backupCore(binary, this.#context.platform);
    let keepBackup = false;
    try {
      if ((await this.#sha256(backup.executable)) !== sha256 || (await this.#sha256(binary)) !== sha256) {
        return unavailable("The local core changed while preparing the update. Check for updates again.");
      }
      // hc takes the exact version's manifest, verifies the platform archive and stages the swap itself.
      await this.#call(binary, ["update", "--json", "--version", offer.version], 120_000);
      await this.#assertRunning(offer.version);
      return { state: "updated", version: offer.version };
    } catch (updateError) {
      try {
        const installed = await this.#userBinary();
        if (installed === undefined) {
          throw new Error("The installed core could not be located.", { cause: updateError });
        }
        if ((await this.#sha256(installed)) === sha256) return failed(errorText(updateError));
        await this.#call(installed, ["update", "--json", "--from", backup.executable, "--force"], 45_000);
        await this.#assertRunning(offer.current);
        return { state: "restored", version: offer.current };
      } catch (restoreError) {
        keepBackup = true;
        return failed(
          `Update failed: ${errorText(updateError)}. Could not restore ${offer.current}: ${errorText(restoreError)}. ` +
            `The previous core is saved at ${backup.executable}.`,
        );
      }
    } finally {
      if (!keepBackup) await rm(backup.directory, { recursive: true, force: true });
    }
  }

  async #userBinary(): Promise<string | undefined> {
    const selected = this.#selected();
    if (selected === undefined) return undefined;
    const { env, home, platform } = this.#context;
    const bin = hcInstallDir(platform, home, env);
    const expected = join(bin, platform === "win32" ? "herdr-core.exe" : "herdr-core");
    try {
      const [actual, canonical] = await Promise.all([realpath(selected), realpath(expected)]);
      if (actual !== canonical) {
        if (platform !== "win32" || actual !== join(bin, "hc.exe")) return undefined;
        const [alias, original] = await Promise.all([
          stat(actual, { bigint: true }),
          stat(canonical, { bigint: true }),
        ]);
        if (alias.ino !== original.ino || alias.dev !== original.dev) return undefined;
      }
      if (platform === "darwin") {
        // A bare old executable cannot restore an installation once it becomes a signed app bundle.
        const bundle = await realpath(
          join(home, ".local", "share", "herdr-core", "current", "Contents", "MacOS", "herdr-core"),
        );
        if (canonical !== bundle) return undefined;
      } else if (canonical !== expected) {
        return undefined;
      }
      await access(canonical, constants.R_OK | constants.X_OK);
      return expected;
    } catch (error) {
      if (field(error, "code") === "ENOENT" || field(error, "code") === "EACCES") return undefined;
      throw error;
    }
  }

  async #sha256(binary: string): Promise<string> {
    return createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
  }

  async #version(binary: string): Promise<string> {
    const output = await this.#call(binary, ["--version"]);
    const version = output.startsWith("hc ") ? output.slice(3) : undefined;
    if (!isCoreVersion(version)) throw new Error("The selected binary does not report a herdr-core release version.");
    return version;
  }

  async #status(binary: string): Promise<unknown> {
    return JSON.parse(await this.#call(binary, ["server", "status", "--json"]));
  }

  async #assertRunning(version: string): Promise<void> {
    const binary = await this.#userBinary();
    if (
      binary === undefined ||
      (await this.#version(binary)) !== version ||
      field(await this.#status(binary), "version") !== version
    ) {
      throw new Error(`herdr-core ${version} did not come back after restart.`);
    }
  }

  async #call(binary: string, args: readonly string[], timeout = 15_000): Promise<string> {
    try {
      const { stdout } = await run(binary, args, {
        cwd: this.#context.home,
        env: this.#env,
        windowsHide: true,
        timeout,
        maxBuffer: 1 << 20,
      });
      return stdout.trim();
    } catch (error) {
      throw new Error(coreErrorMessage(error) ?? "herdr-core could not finish the command.", { cause: error });
    }
  }
}

import { createHash } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { RELEASE_PUBLIC_KEYS, verifyRelease } from "@doriface/crypto";
import { compareVersions, type HostManifest, hostTarget, parseHostManifest } from "./manifest.ts";
import { inRollout } from "./rollout.ts";

export const UPDATE_ORIGIN = "https://get.doriterm.com";
export type UpdateChannel = "stable" | "beta";

export type SelfUpdatePhase = "manifest" | "signature" | "download" | "verify" | "check" | "install";

export class SelfUpdateError extends Error {
  override readonly name = "SelfUpdateError";
  readonly phase: SelfUpdatePhase;
  constructor(phase: SelfUpdatePhase, message: string, options?: ErrorOptions) {
    super(message, options);
    this.phase = phase;
  }
}

export type UpdateOutcome =
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "held"; readonly version: string; readonly rollout: number }
  | { readonly kind: "below-minimum"; readonly version: string; readonly minimum: string }
  | { readonly kind: "updated"; readonly version: string };

export interface SelfUpdateOptions {
  readonly channel: UpdateChannel;
  readonly origin?: string;
  readonly currentVersion: string;
  /** The binary to replace: the running doriface-host. */
  readonly binary: string;
  /** This host's rollout id (rollout.ts updaterId). */
  readonly updaterId: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly trustedKeys?: readonly string[];
  readonly fetcher?: (url: string) => Promise<Response>;
  /** Runs a binary with arguments and answers its exit code and output. */
  readonly run?: (file: string, args: readonly string[]) => Promise<{ readonly code: number; readonly out: string }>;
}

const runFile = (file: string, args: readonly string[]): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 30_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });

async function bytesOf(fetcher: (url: string) => Promise<Response>, url: string, phase: SelfUpdatePhase) {
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (error) {
    throw new SelfUpdateError(phase, `cannot reach ${url}`, { cause: error });
  }
  if (!response.ok) throw new SelfUpdateError(phase, `${url} answered HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * One check, in the order #1969 fixes, stopping at the first failure: the manifest and its signature are fetched and the
 * signature verified against the keys compiled into this binary before anything else is read from it; a version that is
 * not newer, a host below the manifest's floor, and a host outside the rollout stop there; otherwise the build is
 * downloaded to <binary>.new, its size and sha256 checked, it must answer --version with the manifest's version, and it
 * is renamed over the binary. The caller exits, and the service manager starts the new binary.
 */
export async function selfUpdate(options: SelfUpdateOptions): Promise<UpdateOutcome> {
  const origin = (options.origin ?? UPDATE_ORIGIN).replace(/\/+$/, "");
  const fetcher = options.fetcher ?? ((url: string) => fetch(url, { redirect: "follow" }));
  const base = `${origin}/host/${options.channel}/manifest.json`;
  const [body, signature] = await Promise.all([
    bytesOf(fetcher, base, "manifest"),
    bytesOf(fetcher, `${base}.sig`, "signature"),
  ]);
  if (!verifyRelease(body, new TextDecoder().decode(signature), options.trustedKeys ?? RELEASE_PUBLIC_KEYS)) {
    throw new SelfUpdateError(
      "signature",
      "the manifest's signature is not one this host trusts; nothing was downloaded",
    );
  }
  const manifest: HostManifest | null = parseHostManifest(new TextDecoder().decode(body));
  if (manifest === null) throw new SelfUpdateError("manifest", "the signed manifest is malformed");
  // A beta host may take stable's manifest (the Worker offers beta the newer of the two); stable never takes beta's.
  if (manifest.channel !== options.channel && !(options.channel === "beta" && manifest.channel === "stable")) {
    throw new SelfUpdateError("manifest", `the signed manifest is for ${manifest.channel}, not ${options.channel}`);
  }
  const { version } = manifest;
  if (compareVersions(version, options.currentVersion) <= 0)
    return { kind: "current", version: options.currentVersion };
  if (manifest.minimum !== undefined && compareVersions(options.currentVersion, manifest.minimum) < 0) {
    return { kind: "below-minimum", version, minimum: manifest.minimum };
  }
  if (!inRollout(options.updaterId, manifest.rollout)) return { kind: "held", version, rollout: manifest.rollout };

  const target = hostTarget(options.platform ?? process.platform, options.arch ?? process.arch);
  const build = target === undefined ? undefined : manifest.targets[target];
  if (build === undefined) throw new SelfUpdateError("manifest", `${version} has no build for this host`);
  if (new URL(build.url).origin !== new URL(origin).origin) {
    throw new SelfUpdateError("manifest", `the manifest names a build outside ${origin}: ${build.url}`);
  }
  const download = await bytesOf(fetcher, build.url, "download");
  const got = createHash("sha256").update(download).digest("hex");
  if (download.byteLength !== build.size || got !== build.sha256) {
    throw new SelfUpdateError(
      "verify",
      `the download does not match the manifest (sha256 ${got}); nothing was replaced`,
    );
  }
  const next = `${options.binary}.new`;
  try {
    await writeFile(next, download, { mode: 0o755 });
    await chmod(next, 0o755);
    const check = await (options.run ?? runFile)(next, ["--version"]);
    if (check.code !== 0 || check.out.split(/\s+/).at(-1) !== version) {
      throw new SelfUpdateError("check", `the new binary answers "${check.out}" to --version, not ${version}`);
    }
    await rename(next, options.binary);
  } catch (error) {
    await rm(next, { force: true });
    if (error instanceof SelfUpdateError) throw error;
    throw new SelfUpdateError("install", `replacing ${options.binary} failed`, { cause: error });
  }
  return { kind: "updated", version };
}

/**
 * Mirrors one herdr-core release that Doriterm vouches for (#2945). herdr's release server publishes no signature, so
 * a maintainer dispatches core-mirror.yml for a version and this signs it with the Doriterm release key; hosts check
 * that signature (RELEASE_PUBLIC_KEYS) before they download anything. The order is fixed, and a failure anywhere leaves
 * core/latest naming the version it named before:
 *   1. the upstream manifest names every target, each as a file under <upstream>/core/<version>/ with a sha256
 *   2. every downloaded archive matches its sha256 (core-mirror.yml also checks the macOS ones against herdr's codesign
 *      requirement before this runs)
 *   3. the signing key is one the shipped builds trust
 *   4. each archive is uploaded to core/v<version>/, created once, then read back and hashed again
 *   5. core/v<version>/manifest.json and its .sig are written once, naming the archives on Doriterm's origin
 *   6. core/latest moves to this version, never back to an older one (an older version is mirrored for HC_VERSION pins)
 */
import { compareVersions, CORE_POINTER_KEY, coreObjectKey, isReleaseFile } from "../../apps/get/src/names.ts";
import { signRelease } from "../../packages/crypto/src/release.ts";
import { type ObjectStore, sha256Hex } from "./r2-store.ts";
import { assertTrustedSigner, putImmutable } from "./release-mirror.ts";

/** The herdr-core builds hosts install (apps/host/src/hc-install.ts `HcTarget`); a mirror carries every one. */
export const CORE_TARGETS = [
  "linux-x86_64",
  "linux-aarch64",
  "macos-x86_64",
  "macos-aarch64",
  "windows-x86_64",
] as const;
export const HERDR_RELEASES = "https://releases.herdr.dev";

export interface CoreBuild {
  readonly file: string;
  readonly sha256: string;
}

export interface UpstreamCore {
  readonly version: string;
  readonly generation: number;
  readonly targets: Readonly<Record<(typeof CORE_TARGETS)[number], CoreBuild>>;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** Step 1: herdr's manifest for exactly `version`, every target a plain file under its own release directory. */
export function parseUpstreamCore(text: string, version: string, upstream = HERDR_RELEASES): UpstreamCore {
  const manifest: unknown = JSON.parse(text);
  if (field(manifest, "version") !== version) {
    throw new Error(`the upstream manifest names ${String(field(manifest, "version"))}, not ${version}`);
  }
  const generation = field(manifest, "generation");
  const base = `${upstream}/core/${version}/`;
  const build = (target: (typeof CORE_TARGETS)[number]): CoreBuild => {
    const entry = field(field(manifest, "targets"), target);
    const url = field(entry, "url");
    const sha256 = field(entry, "sha256");
    const file = typeof url === "string" && url.startsWith(base) ? url.slice(base.length) : "";
    if (!isReleaseFile(file)) throw new Error(`${target}: ${String(url)} is not a file under ${base}`);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`${target}: no sha256`);
    return { file, sha256 };
  };
  return {
    version,
    generation: typeof generation === "number" ? generation : 1,
    targets: {
      "linux-x86_64": build("linux-x86_64"),
      "linux-aarch64": build("linux-aarch64"),
      "macos-x86_64": build("macos-x86_64"),
      "macos-aarch64": build("macos-aarch64"),
      "windows-x86_64": build("windows-x86_64"),
    },
  };
}

async function get(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Downloads herdr's manifest for `version` and every archive it names into `dir`, the manifest as upstream.json. Only
 * a file under that release's own directory is fetched; whether the bytes match is mirrorCore's to decide.
 */
export async function fetchUpstreamCore(version: string, dir: string, upstream = HERDR_RELEASES): Promise<void> {
  const manifest = await get(`${upstream}/core/${version}/manifest.json`);
  const core = parseUpstreamCore(new TextDecoder().decode(manifest), version, upstream);
  await Bun.write(`${dir}/upstream.json`, manifest);
  await Promise.all(
    CORE_TARGETS.map(async (target) => {
      const { file } = core.targets[target];
      await Bun.write(`${dir}/${file}`, await get(`${upstream}/core/${version}/${file}`));
    }),
  );
}

/** The manifest hosts read at <origin>/core/<version>/manifest.json: herdr's shape, the archives on Doriterm's origin. */
export function coreManifest(origin: string, core: UpstreamCore): Uint8Array {
  const targets = Object.fromEntries(
    CORE_TARGETS.map((target) => {
      const { file, sha256 } = core.targets[target];
      return [target, { url: `${origin}/core/${core.version}/${file}`, sha256 }];
    }),
  );
  return new TextEncoder().encode(
    `${JSON.stringify({ version: core.version, generation: core.generation, targets }, null, 2)}\n`,
  );
}

export interface CoreMirrorPlan {
  readonly version: string;
  /** The Worker's origin the manifest's URLs name. */
  readonly origin: string;
  /** herdr's manifest for the version, as downloaded. */
  readonly upstreamManifest: string;
  /** Where the archives were downloaded, each under its upstream file name. */
  readonly dir: string;
  readonly secretKey: Uint8Array;
  readonly trustedKeys: readonly string[];
}

const fileSha256 = async (path: string): Promise<string> => sha256Hex(await Bun.file(path).bytes());

export async function mirrorCore(store: ObjectStore, plan: CoreMirrorPlan, log: (line: string) => void): Promise<void> {
  const core = parseUpstreamCore(plan.upstreamManifest, plan.version);
  const builds = CORE_TARGETS.map((target) => core.targets[target]);
  const hashes = await Promise.all(builds.map((build) => fileSha256(`${plan.dir}/${build.file}`)));
  const damaged = builds.filter((build, i) => hashes[i] !== build.sha256).map((build) => build.file);
  if (damaged.length > 0) throw new Error(`do not match the upstream sha256: ${damaged.join(", ")}; nothing uploaded`);
  log(`checked ${builds.length} archives against herdr's manifest`);
  assertTrustedSigner(plan.secretKey, plan.trustedKeys);

  for (const build of builds) {
    const key = coreObjectKey(plan.version, build.file);
    // oxlint-disable-next-line no-await-in-loop -- one archive in memory at a time
    await putImmutable(store, key, await Bun.file(`${plan.dir}/${build.file}`).bytes(), "application/octet-stream");
    // oxlint-disable-next-line no-await-in-loop -- read back right after its upload
    const item = await store.get(key);
    if (item === null || sha256Hex(item.body) !== build.sha256) throw new Error(`${key} read back does not match`);
  }
  log(`uploaded, read back and re-hashed ${builds.length} archives`);

  const manifest = coreManifest(plan.origin, core);
  const signature = new TextEncoder().encode(signRelease(manifest, plan.secretKey));
  await putImmutable(store, coreObjectKey(plan.version, "manifest.json"), manifest, "application/json");
  await putImmutable(store, coreObjectKey(plan.version, "manifest.json.sig"), signature, "text/plain; charset=utf-8");
  log(`wrote the signed manifest for herdr-core ${plan.version}`);

  const current = await store.get(CORE_POINTER_KEY);
  const offered =
    current === null ? null : String(field(JSON.parse(new TextDecoder().decode(current.body)), "version"));
  if (offered !== null && compareVersions(plan.version, offered) < 0) {
    log(`core/latest stays at ${offered}, newer than ${plan.version}; ${plan.version} is mirrored for pinned installs`);
    return;
  }
  const pointer = new TextEncoder().encode(`${JSON.stringify({ version: plan.version })}\n`);
  const moved = await store.put(
    CORE_POINTER_KEY,
    pointer,
    current === null ? { create: true } : { replace: current.etag },
    "application/json",
  );
  if (!moved) throw new Error("core/latest moved while this run held it; re-run the mirror");
  log(`core/latest now names herdr-core ${plan.version} (previous ${offered ?? "none"})`);
}

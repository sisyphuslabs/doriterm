/**
 * Mirrors a published GitHub release into the release bucket and moves its channel (#1969). The order is fixed, and a
 * failure anywhere leaves the previous pointer in place, so get.doriterm.com keeps offering the previous version and
 * /v/<new version>/ redirects to GitHub until a re-run completes:
 *   1. every downloaded file matches SHA256SUMS.txt and GitHub's own digest, and every listed file was downloaded
 *   2. SHA256SUMS.txt is signed with the release key, which must be one the shipped builds trust
 *   3. each file is uploaded with its SHA-256 as the signed payload hash, created once (a re-run accepts an identical
 *      object and refuses a different one)
 *   4. each object is read back and hashed again
 *   5. releases/v<version>/.complete records every file's hash and size
 *   6. the channel's host manifest is written and signed
 *   7. the pointer moves, only over the pointer read before (If-Match)
 */
import { type Channel, compareVersions, completeKey, objectKey } from "../../apps/get/src/names.ts";
import { releasePublicKey, signRelease } from "../../packages/crypto/src/release.ts";
import { type ObjectStore, sha256Hex } from "./r2-store.ts";
import {
  type CompleteRecord,
  completeBytes,
  type FileRecord,
  hostManifest,
  parseComplete,
  readCurrentPointer,
  writeHostManifest,
  writePointer,
} from "./release-records.ts";

export interface GitHubAsset {
  readonly name: string;
  /** `sha256:<hex>`, as `gh release view --json assets` reports it. */
  readonly digest: string;
}

export interface MirrorPlan {
  readonly version: string;
  readonly channel: Channel;
  readonly rollout: number;
  readonly minimum?: string;
  readonly runId: string;
  readonly now: string;
  /** The Worker's origin the host manifest's URLs name. */
  readonly origin: string;
  /** Where the release's files were downloaded. */
  readonly dir: string;
  readonly assets: readonly GitHubAsset[];
  readonly secretKey: Uint8Array;
  readonly trustedKeys: readonly string[];
}

const SIGNATURE = "SHA256SUMS.txt.sig";
const CONTENT_TYPE = (name: string): string =>
  /\.(?:txt|sh|yml|sig)$/.test(name) ? "text/plain; charset=utf-8" : "application/octet-stream";

async function fileSha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64}) [ *](\S.*)$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined)
      throw new Error(`SHA256SUMS.txt has a malformed line: ${line}`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/** Step 1: the release's files, each checked three ways, or a refusal before anything is uploaded. */
export async function verifyAssets(dir: string, assets: readonly GitHubAsset[]): Promise<Record<string, FileRecord>> {
  const sums = parseSums(await Bun.file(`${dir}/SHA256SUMS.txt`).text());
  const files: Record<string, FileRecord> = {};
  const problems: string[] = [];
  for (const asset of assets) {
    if (asset.name === SIGNATURE) continue;
    const github = /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1];
    const listed = asset.name === "SHA256SUMS.txt" ? github : sums.get(asset.name);
    // oxlint-disable-next-line no-await-in-loop -- one large file at a time keeps the runner's memory flat
    const local = await fileSha256(`${dir}/${asset.name}`);
    if (github === undefined) problems.push(`${asset.name}: GitHub reports no sha256 digest`);
    else if (listed === undefined) problems.push(`${asset.name}: not listed in SHA256SUMS.txt`);
    else if (local !== listed || local !== github)
      problems.push(`${asset.name}: downloaded ${local}, listed ${listed}, GitHub ${github}`);
    else files[asset.name] = { sha256: local, size: Bun.file(`${dir}/${asset.name}`).size };
  }
  for (const name of sums.keys())
    if (!assets.some((asset) => asset.name === name)) problems.push(`${name}: listed but not attached`);
  if (problems.length > 0) throw new Error(`the release's files do not check out:\n  ${problems.join("\n  ")}`);
  return files;
}

/** Creates an immutable object, or accepts the identical one a previous run left; never overwrites. */
export async function putImmutable(
  store: ObjectStore,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  if (await store.put(key, body, { create: true }, contentType)) return;
  const existing = await store.get(key);
  if (existing === null || sha256Hex(existing.body) !== sha256Hex(body)) {
    throw new Error(`${key} already exists with different bytes; a mirrored file is never replaced`);
  }
}

async function putComplete(store: ObjectStore, record: CompleteRecord): Promise<void> {
  const key = completeKey(record.version);
  if (await store.put(key, completeBytes(record), { create: true }, "application/json")) return;
  const existing = await store.get(key);
  const stored = existing === null ? null : parseComplete(existing.body);
  if (JSON.stringify(stored?.files) !== JSON.stringify(record.files) || stored?.minimum !== record.minimum) {
    throw new Error(`${key} already records different files; a mirrored release is never replaced`);
  }
}

export async function mirrorRelease(store: ObjectStore, plan: MirrorPlan, log: (line: string) => void): Promise<void> {
  const files = await verifyAssets(plan.dir, plan.assets);
  log(`checked ${Object.keys(files).length} files against SHA256SUMS.txt and GitHub's digests`);

  if (!plan.trustedKeys.includes(releasePublicKey(plan.secretKey))) {
    throw new Error(
      "the signing key is not one of RELEASE_PUBLIC_KEYS, so no shipped build would accept its signatures",
    );
  }
  const sums = await Bun.file(`${plan.dir}/SHA256SUMS.txt`).bytes();
  const signature = new TextEncoder().encode(signRelease(sums, plan.secretKey));
  await Bun.write(`${plan.dir}/${SIGNATURE}`, signature);
  files[SIGNATURE] = { sha256: sha256Hex(signature), size: signature.byteLength };

  const names = Object.keys(files).toSorted();
  const bodyOf = (name: string): Promise<Uint8Array> =>
    name === SIGNATURE ? Promise.resolve(signature) : Bun.file(`${plan.dir}/${name}`).bytes();
  for (const name of names) {
    // oxlint-disable-next-line no-await-in-loop -- uploads run one at a time, each up to a few hundred MB
    await putImmutable(store, objectKey(plan.version, name), await bodyOf(name), CONTENT_TYPE(name));
  }
  log(`uploaded ${names.length} objects`);
  for (const name of names) {
    // oxlint-disable-next-line no-await-in-loop -- read back one object at a time
    const item = await store.get(objectKey(plan.version, name));
    const want = files[name]?.sha256;
    if (item === null || sha256Hex(item.body) !== want)
      throw new Error(`${name} read back from the bucket does not match`);
  }
  log(`read back and re-hashed ${names.length} objects`);

  const record: CompleteRecord = {
    version: plan.version,
    files,
    mirroredAt: plan.now,
    runId: plan.runId,
    ...(plan.minimum === undefined ? {} : { minimum: plan.minimum }),
  };
  await putComplete(store, record);
  await writeHostManifest(
    store,
    plan.channel,
    hostManifest(plan.origin, plan.channel, record, plan.rollout),
    plan.secretKey,
  );
  log(`wrote .complete and the signed ${plan.channel} host manifest`);

  const current = await readCurrentPointer(store, plan.channel);
  const was = current.pointer;
  if (was !== null && compareVersions(plan.version, was.version) < 0) {
    throw new Error(
      `the ${plan.channel} channel offers ${was.version}, newer than ${plan.version}; use release-channel.yml`,
    );
  }
  const previous = was === null ? undefined : was.version === plan.version ? was.previous : was.version;
  const moved = await writePointer(store, plan.channel, current, {
    version: plan.version,
    rollout: plan.rollout,
    publishedAt: plan.now,
    ...(previous === undefined ? {} : { previous }),
    ...(plan.minimum === undefined ? {} : { minimum: plan.minimum }),
  });
  if (!moved) throw new Error(`channels/${plan.channel}.json moved while this run held it; re-run the mirror`);
  log(`${plan.channel} now offers ${plan.version} to ${plan.rollout}% (previous ${previous ?? "none"})`);
}

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePublicKey, verifyRelease } from "../../packages/crypto/src/release.ts";
import {
  CORE_TARGETS,
  coreArchiveName,
  type CoreMirrorPlan,
  HERDR_RELEASES,
  mirrorCore,
} from "../../.github/scripts/core-mirror.ts";
import { sha256Hex } from "../../.github/scripts/r2-store.ts";
import { MemoryBucket } from "./support/release-bucket.ts";

const key = crypto.getRandomValues(new Uint8Array(32));
const rotated = crypto.getRandomValues(new Uint8Array(32));
const trusted = [releasePublicKey(key)];
const ORIGIN = "https://get.doriterm.com";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const quiet = () => undefined;

/** herdr's release for `version` as core-fetch leaves it: every archive, and a manifest naming their sha256. */
function upstream(
  version: string,
  edit: (manifest: { targets: Record<string, { url: string; sha256: string }> }) => void = () => {},
) {
  const dir = mkdtempSync(join(tmpdir(), "core-mirror-"));
  dirs.push(dir);
  const targets: Record<string, { url: string; sha256: string }> = {};
  for (const target of CORE_TARGETS) {
    const bytes = new TextEncoder().encode(`herdr-core ${version} ${target}`);
    writeFileSync(join(dir, coreArchiveName(target)), bytes);
    targets[target] = { url: `${HERDR_RELEASES}/core/${version}/${coreArchiveName(target)}`, sha256: sha256Hex(bytes) };
  }
  const manifest = { version, generation: 1, notes: "upstream notes", targets };
  edit(manifest);
  return { dir, manifest: JSON.stringify(manifest) };
}

const plan = (
  version: string,
  release = upstream(version),
  secretKey = key,
  trustedKeys = trusted,
): CoreMirrorPlan => ({
  version,
  origin: ORIGIN,
  upstreamManifest: release.manifest,
  dir: release.dir,
  secretKey,
  trustedKeys,
});

const signedText = async (bucket: MemoryBucket, path: string, keys = trusted) => {
  const body = await (await bucket.worker(path)).text();
  const signature = await (await bucket.worker(`${path}.sig`)).text();
  return { body, valid: verifyRelease(new TextEncoder().encode(body), signature, keys) };
};

/** As a host checks latest.json: against the immutable signature of the version its body names. */
const latestAsHostsCheck = async (bucket: MemoryBucket, body?: string) => {
  const text = body ?? (await (await bucket.worker("/core/latest.json")).text());
  const version: string = JSON.parse(text).version;
  const signature = await (await bucket.worker(`/core/${version}/manifest.json.sig`)).text();
  return { version, valid: verifyRelease(new TextEncoder().encode(text), signature, trusted), body: text };
};

test("a mirrored core is what hosts read: a signed latest.json naming archives on Doriterm's origin, which it serves", async () => {
  const bucket = new MemoryBucket();
  await mirrorCore(bucket, plan("0.1.22"), quiet);

  const latest = await latestAsHostsCheck(bucket);
  expect(latest.valid).toBe(true);
  expect((await bucket.worker("/core/latest.json.sig")).status).toBe(404);
  const manifest: { version: string; targets: Record<string, { url: string; sha256: string }> } = JSON.parse(
    latest.body,
  );
  expect(manifest.version).toBe("0.1.22");
  expect(Object.keys(manifest.targets)).toEqual([...CORE_TARGETS]);
  const linux = manifest.targets["linux-x86_64"];
  expect(linux?.url).toBe(`${ORIGIN}/core/0.1.22/herdr-core-linux-x86_64.tar.gz`);

  const archive = await bucket.worker("/core/0.1.22/herdr-core-linux-x86_64.tar.gz");
  const bytes = new Uint8Array(await archive.arrayBuffer());
  expect(archive.status).toBe(200);
  expect(sha256Hex(bytes)).toBe(linux?.sha256 ?? "");
  expect((await signedText(bucket, "/core/0.1.22/manifest.json")).body).toBe(latest.body);
});

test.each([
  ["an archive that does not match herdr's sha256", "tamper", "do not match the upstream sha256"],
  ["a key no shipped build trusts", "untrusted", "not one of RELEASE_PUBLIC_KEYS"],
  ["an archive URL outside the release's own directory", "https://elsewhere.example/herdr-core.tar.gz", "is not"],
  ["a macOS archive under another name, which the codesign step would not look for", "rename", "is not"],
  ["a target named like the downloaded manifest", "upstream.json", "is not"],
  ["a target named like the signed manifest's signature", "manifest.json.sig", "is not"],
  ["a target name that climbs out of the release directory", "../latest/herdr-core.tar.gz", "is not"],
  ["a manifest for another version", "version", "names 0.1.21, not 0.1.22"],
] as const)("%s stops the run before anything is uploaded", async (_, fault, message) => {
  const bucket = new MemoryBucket();
  const release = upstream("0.1.22", (manifest) => {
    const mac = manifest.targets["macos-aarch64"];
    if (mac === undefined) return;
    const base = `${HERDR_RELEASES}/core/0.1.22/`;
    if (fault === "rename") mac.url = `${base}herdr-core-mac.tgz`;
    else if (fault.startsWith("https://")) mac.url = fault;
    else if (fault !== "tamper" && fault !== "untrusted" && fault !== "version") mac.url = `${base}${fault}`;
    if (fault === "version") Reflect.set(manifest, "version", "0.1.21");
  });
  if (fault === "tamper") writeFileSync(join(release.dir, coreArchiveName("linux-aarch64")), "tampered");
  const secret = fault === "untrusted" ? crypto.getRandomValues(new Uint8Array(32)) : key;
  await expect(mirrorCore(bucket, plan("0.1.22", release, secret), quiet)).rejects.toThrow(message);
  expect(bucket.puts).toEqual([]);
  expect((await bucket.worker("/core/latest.json")).status).toBe(404);
});

test("a latest.json a host cached before core/latest moved still verifies, as the new one does: each names its own signature", async () => {
  const bucket = new MemoryBucket();
  await mirrorCore(bucket, plan("0.1.21"), quiet);
  const cached = await (await bucket.worker("/core/latest.json")).text();
  await mirrorCore(bucket, plan("0.1.22"), quiet);
  const before = await latestAsHostsCheck(bucket, cached);
  const after = await latestAsHostsCheck(bucket);
  expect([before.version, before.valid, after.version, after.valid]).toEqual(["0.1.21", true, "0.1.22", true]);
});

test("after a key rotation a re-run re-signs a mirrored version with the new key, and still never replaces its manifest", async () => {
  const bucket = new MemoryBucket();
  const release = upstream("0.1.22");
  await mirrorCore(bucket, plan("0.1.22", release), quiet);
  const manifest = bucket.text("core/v0.1.22/manifest.json");
  const both = [...trusted, releasePublicKey(rotated)];
  await mirrorCore(bucket, plan("0.1.22", release, rotated, both), quiet);
  expect(bucket.text("core/v0.1.22/manifest.json")).toBe(manifest);
  const onlyNew = [releasePublicKey(rotated)];
  expect((await signedText(bucket, "/core/0.1.22/manifest.json", onlyNew)).valid).toBe(true);
  expect((await signedText(bucket, "/core/0.1.22/manifest.json", trusted)).valid).toBe(false);
  // A signer that is not trusted cannot re-sign: the signature stays the rotated key's.
  await expect(mirrorCore(bucket, plan("0.1.22", release, key, onlyNew), quiet)).rejects.toThrow(
    "not one of RELEASE_PUBLIC_KEYS",
  );
  expect((await signedText(bucket, "/core/0.1.22/manifest.json", onlyNew)).valid).toBe(true);
});

test("a re-run accepts its own objects, and an older version is mirrored for pins without moving latest", async () => {
  const bucket = new MemoryBucket();
  const release = upstream("0.1.22");
  await mirrorCore(bucket, plan("0.1.22", release), quiet);
  await mirrorCore(bucket, plan("0.1.22", release), quiet);
  const lines: string[] = [];
  await mirrorCore(bucket, plan("0.1.21"), (line) => lines.push(line));
  expect(lines.at(-1)).toBe("core/latest stays at 0.1.22, newer than 0.1.21; 0.1.21 is mirrored for pinned installs");
  expect((await latestAsHostsCheck(bucket)).version).toBe("0.1.22");
  const pinned = await signedText(bucket, "/core/0.1.21/manifest.json");
  expect([pinned.valid, JSON.parse(pinned.body).version]).toEqual([true, "0.1.21"]);
});

test("a version's mirrored files are never replaced with different bytes", async () => {
  const bucket = new MemoryBucket();
  await mirrorCore(bucket, plan("0.1.22"), quiet);
  const rebuilt = upstream("0.1.22", (manifest) => {
    const linux = manifest.targets["linux-x86_64"];
    if (linux !== undefined) linux.sha256 = sha256Hex(new TextEncoder().encode("rebuilt"));
  });
  writeFileSync(join(rebuilt.dir, coreArchiveName("linux-x86_64")), "rebuilt");
  await expect(mirrorCore(bucket, plan("0.1.22", rebuilt), quiet)).rejects.toThrow("a mirrored file is never replaced");
});

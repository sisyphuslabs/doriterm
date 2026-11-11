import { afterEach, expect, test } from "bun:test";
import { RELEASE_PUBLIC_KEYS, releasePublicKey, verifyRelease } from "../../packages/crypto/src/release.ts";
import { type MirrorPlan, mirrorRelease } from "../../.github/scripts/release-mirror.ts";
import { type FakeRelease, fakeRelease, MemoryBucket } from "./support/release-bucket.ts";

// Any 32 bytes are an Ed25519 seed.
const key = crypto.getRandomValues(new Uint8Array(32));
const trusted = [releasePublicKey(key)];
const releases: FakeRelease[] = [];
afterEach(() => releases.splice(0).forEach((release) => release.cleanup()));

const plan = (version: string, tamper?: string, rollout = 100): MirrorPlan => {
  const release = fakeRelease(version, tamper);
  releases.push(release);
  return {
    version,
    channel: "stable",
    rollout,
    runId: "1",
    now: "2026-11-12T03:10:00Z",
    origin: "https://get.doriterm.com",
    dir: release.dir,
    assets: release.assets,
    secretKey: key,
    trustedKeys: trusted,
  };
};
const quiet = () => undefined;
const location = async (bucket: MemoryBucket, path: string) => (await bucket.worker(path)).headers.get("location");

test("a mirrored release is what get.doriterm.com serves: /dl, the signed checksums and the signed host manifest", async () => {
  const bucket = new MemoryBucket();
  await mirrorRelease(bucket, plan("0.1.17"), quiet);
  expect(await location(bucket, "/dl/host-linux-x64")).toBe(
    "https://get.doriterm.com/v/0.1.17/doriface-host-linux-x64?via=dl&channel=stable",
  );
  const file = await bucket.worker("/v/0.1.17/doriface-host-linux-x64");
  expect([file.status, file.headers.get("x-doriterm-source"), await file.text()]).toEqual([
    200,
    "r2",
    "host linux-x64 0.1.17",
  ]);

  const sums = new Uint8Array(await (await bucket.worker("/v/0.1.17/SHA256SUMS.txt")).arrayBuffer());
  expect(verifyRelease(sums, await (await bucket.worker("/v/0.1.17/SHA256SUMS.txt.sig")).text(), trusted)).toBe(true);

  const manifestText = await (await bucket.worker("/host/stable/manifest.json")).text();
  const signature = await (await bucket.worker("/host/stable/manifest.json.sig")).text();
  expect(verifyRelease(new TextEncoder().encode(manifestText), signature, trusted)).toBe(true);
  const manifest: unknown = JSON.parse(manifestText);
  expect(manifest).toMatchObject({
    version: "0.1.17",
    channel: "stable",
    rollout: 100,
    targets: { "mac-arm64": { url: "https://get.doriterm.com/host/stable/0.1.17/doriface-host-mac-arm64" } },
  });
});

test("a re-run accepts its own objects, and the next release records the one before it as previous", async () => {
  const bucket = new MemoryBucket();
  await mirrorRelease(bucket, plan("0.1.16"), quiet);
  await mirrorRelease(bucket, plan("0.1.16"), quiet);
  await mirrorRelease(bucket, plan("0.1.17", undefined, 20), quiet);
  expect(JSON.parse(bucket.text("channels/stable.json") ?? "")).toEqual({
    version: "0.1.17",
    previous: "0.1.16",
    rollout: 20,
    publishedAt: "2026-11-12T03:10:00Z",
  });
  // A refused backport leaves the signed manifest naming the version the channel still offers (#1977 review).
  const manifest = bucket.text("channels/stable.host-manifest.json");
  await expect(mirrorRelease(bucket, plan("0.1.15"), quiet)).rejects.toThrow("newer than 0.1.15");
  expect(bucket.text("channels/stable.host-manifest.json")).toBe(manifest);
  expect((await bucket.worker("/host/stable/manifest.json")).status).toBe(200);
});

test("a file that does not match SHA256SUMS.txt or GitHub's digest stops the run before anything is uploaded", async () => {
  const bucket = new MemoryBucket();
  await expect(mirrorRelease(bucket, plan("0.1.17", "doriface-host-linux-x64"), quiet)).rejects.toThrow(
    "doriface-host-linux-x64: downloaded",
  );
  const missing = plan("0.1.17");
  await expect(mirrorRelease(bucket, { ...missing, assets: missing.assets.slice(1) }, quiet)).rejects.toThrow(
    "listed but not attached",
  );
  expect(bucket.puts).toEqual([]);
});

test("a signing key the shipped builds do not trust is refused before anything is uploaded", async () => {
  const bucket = new MemoryBucket();
  await expect(mirrorRelease(bucket, { ...plan("0.1.17"), trustedKeys: [] }, quiet)).rejects.toThrow(
    "RELEASE_PUBLIC_KEYS",
  );
  // The list builds actually ship refuses the test's random key too.
  await expect(mirrorRelease(bucket, { ...plan("0.1.17"), trustedKeys: RELEASE_PUBLIC_KEYS }, quiet)).rejects.toThrow(
    "RELEASE_PUBLIC_KEYS",
  );
  expect(bucket.puts).toEqual([]);
});

test("a mirror that fails after its upload leaves the previous version offered and /v/<new>/ on GitHub", async () => {
  const bucket = new MemoryBucket();
  await mirrorRelease(bucket, plan("0.1.16"), quiet);
  bucket.failPutOf = /v0\.1\.17\/\.complete$/;
  await expect(mirrorRelease(bucket, plan("0.1.17"), quiet)).rejects.toThrow("injected failure");
  expect(bucket.objects.has("releases/v0.1.17/doriface-host-linux-x64")).toBe(true);
  expect(await location(bucket, "/dl/host-linux-x64")).toContain("/v/0.1.16/");
  expect(await location(bucket, "/v/0.1.17/doriface-host-linux-x64")).toBe(
    "https://github.com/sisyphuslabs/doriterm/releases/download/v0.1.17/doriface-host-linux-x64",
  );
  expect(JSON.parse(await (await bucket.worker("/host/stable/manifest.json")).text())).toMatchObject({
    version: "0.1.16",
  });
});

test("an object already in the bucket with other bytes is never replaced, and a pointer moved mid-run is not overwritten", async () => {
  const bucket = new MemoryBucket();
  bucket.objects.set("releases/v0.1.17/install.sh", new TextEncoder().encode("other"));
  await expect(mirrorRelease(bucket, plan("0.1.17"), quiet)).rejects.toThrow(
    "install.sh already exists with different bytes",
  );
  expect(bucket.text("channels/stable.json")).toBeUndefined();

  const racing = new MemoryBucket();
  await mirrorRelease(racing, plan("0.1.16"), quiet);
  const original = racing.get.bind(racing);
  racing.get = async (name) => {
    const item = await original(name);
    if (name === "channels/stable.json") racing.objects.set(name, new TextEncoder().encode('{"moved":true}'));
    return item;
  };
  const manifest = racing.text("channels/stable.host-manifest.json");
  await expect(mirrorRelease(racing, plan("0.1.17"), quiet)).rejects.toThrow("moved while this run held it");
  expect(racing.text("channels/stable.json")).toBe('{"moved":true}');
  expect(racing.text("channels/stable.host-manifest.json")).toBe(manifest);
});

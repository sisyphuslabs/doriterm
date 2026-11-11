import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { generateHostIdentity } from "@doriface/crypto";
import { RELAY_PASSES_FILE, openReadOnlyRelayPasses, relayPassFile } from "./relay-passes.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-passes-"));
  dirs.push(dir);
  return dir;
}

/** A pass for `signPub`'s host (its first 16 hash bytes at offset 10), valid for 30 days. */
async function farPass(signPub: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const pass = new Uint8Array(58);
  pass.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(signPub))).subarray(0, 16), 10);
  const view = new DataView(pass.buffer);
  view.setUint8(0, 1);
  view.setUint8(1, 1);
  const nowS = Math.floor(Date.now() / 1000);
  view.setUint32(2, nowS);
  view.setUint32(6, nowS + 30 * 24 * 60 * 60);
  return pass;
}

describe("relay-passes.json (contract v1.6)", () => {
  test("a no-host mesh join presents a proof from the file, and a refusal never writes the file", async () => {
    const dir = stateDir();
    const origin = "wss://relay.example";
    const identity = generateHostIdentity();
    const pass = await farPass(identity.sign.publicKey);
    relayPassFile(dir).save(new Map([[origin, { pass, offsetMs: 0, receivedAt: Date.now() }]]));
    const before = readFileSync(join(dir, RELAY_PASSES_FILE), "utf8");
    const book = await openReadOnlyRelayPasses(dir, identity, () => undefined);
    const proof = book.proof("client", "a".repeat(26), origin);
    expect(proof).toBeDefined();
    book.refused(origin, proof ?? "");
    expect(book.proof("client", "a".repeat(26), origin)).toBeUndefined();
    expect(readFileSync(join(dir, RELAY_PASSES_FILE), "utf8")).toBe(before);
  });

  test("passes round-trip with their clock offsets, in an owner-only file", () => {
    const dir = stateDir();
    const pass = crypto.getRandomValues(new Uint8Array(58));
    relayPassFile(dir).save(new Map([["wss://relay.example", { pass, offsetMs: -1234, receivedAt: 99 }]]));
    expect(relayPassFile(dir).load()).toEqual(
      new Map([["wss://relay.example", { pass, offsetMs: -1234, receivedAt: 99 }]]),
    );
    expect(statSync(join(dir, RELAY_PASSES_FILE)).mode & 0o777).toBe(0o600);
  });

  test("a missing file is no passes, and malformed entries are skipped", () => {
    const dir = stateDir();
    expect(relayPassFile(dir).load().size).toBe(0);
    writeFileSync(
      join(dir, RELAY_PASSES_FILE),
      JSON.stringify({
        version: 1,
        passes: { "wss://a": { pass: 1 }, "wss://b": { pass: "AA", offsetMs: 0, receivedAt: 0 } },
      }),
    );
    expect([...relayPassFile(dir).load().keys()]).toEqual(["wss://b"]);
  });
});

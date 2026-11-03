import { base64urlEncode, generateX25519 } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardFor, deviceOf, machine, MeshFixture, noiseOf } from "../testing/mesh-history.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function meshOf() {
  const dir = mkdtempSync(join(tmpdir(), "dh-authorize-index-"));
  dirs.push(dir);
  const [founder, second, member] = [machine("founder"), machine("second"), machine("member")];
  const mesh = new MeshFixture(dir, founder);
  mesh.admit(founder, second);
  mesh.admit(founder, member);
  return { mesh, founder, second, member };
}

describe("the index takes a member's core id and device key from its governing admission's card", () => {
  test("a later re-admit of a current member with another card changes neither", () => {
    const { mesh, second, member } = meshOf();
    const other = { ...member, hcId: "another-core", device: generateX25519() };
    mesh.admit(second, other);
    const entry = mesh.store.authorizeIndex()?.member(noiseOf(member));
    expect(entry?.hcId).toBe(member.hcId);
    expect(entry?.devicePub).toBe(deviceOf(member));
    expect(mesh.store.authorizeIndex()?.isMemberHcId("another-core")).toBe(false);
  });

  test("a rekey card moves the Noise key but carries no other core id or device key into the index", () => {
    const { mesh, member } = meshOf();
    const noise = generateX25519();
    const rekeyed = { ...member, hcId: "rekeyed-core", device: generateX25519() };
    mesh.record(member, "rekey", { card: cardFor(rekeyed, mesh.meshId, member, { ...member.identity, noise }) });
    const index = mesh.store.authorizeIndex();
    const entry = index?.member(base64urlEncode(noise.publicKey));
    expect(entry?.hcId).toBe(member.hcId);
    expect(entry?.devicePub).toBe(deviceOf(member));
    expect(index?.isMemberHcId("rekeyed-core")).toBe(false);
  });
});

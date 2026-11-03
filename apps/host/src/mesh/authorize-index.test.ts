import { base64urlEncode, generateX25519 } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../state/devices.ts";
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
  return { dir, mesh, founder, second, member };
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

describe("LOW-7/8: a current member's superseded keys are refused and cleaned like a revoked member's", () => {
  test("its Noise key before a rekey, and the device key of a card that does not govern it", () => {
    const { dir, mesh, second, member } = meshOf();
    const other = { ...member, device: generateX25519() };
    mesh.admit(second, other);
    const noise = generateX25519();
    mesh.record(member, "rekey", { card: cardFor(member, mesh.meshId, member, { ...member.identity, noise }) });
    const devices = new DeviceStore(dir);
    devices.add(member.identity.noise.publicKey, "the member's old key as a device");
    mesh.record(second, "ack");
    const index = mesh.store.authorizeIndex();
    for (const key of [noiseOf(member), deviceOf(other)]) {
      expect(index?.deviceRefusal(key)).toBe("a superseded key of a mesh member");
      expect(index?.cleanup().keys.has(key)).toBe(true);
    }
    expect(index?.deviceRefusal(deviceOf(member))).toBe("this key belongs to a mesh member: use the mesh line");
    expect(index?.member(base64urlEncode(noise.publicKey))).toBeDefined();
    expect(devices.list()).toEqual([]);
  });
});

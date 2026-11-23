import { generateX25519 } from "@doriface/crypto";
import { afterEach, expect, test } from "bun:test";
import { DeviceStore } from "../state/devices.ts";
import { ownOf, removeSides, side } from "../testing/join-harness.ts";
import { sessionPeer } from "./authorize.ts";

afterEach(removeSides);

test("no owner key opens the mcp stream: a machine member, a paired device and an unknown key are refused", () => {
  const a = side("alpha");
  const phone = generateX25519();
  const devices = new DeviceStore(a.dir);
  a.mesh.found(a.m.identity, ownOf(a));
  devices.add(phone.publicKey, "phone");
  const index = a.mesh.authorizeIndex();
  // The same keys on the hc stream, so a refusal below is the stream's and not a key the fixture failed to admit.
  expect(sessionPeer("hc", a.m.identity.noise.publicKey, index, devices).kind).toBe("member");
  expect(sessionPeer("hc", phone.publicKey, index, devices).kind).toBe("device");
  for (const key of [a.m.identity.noise.publicKey, phone.publicKey, generateX25519().publicKey]) {
    expect(sessionPeer("mcp", key, index, devices)).toEqual({
      kind: "refused",
      reason: "this host serves no mcp stream",
    });
  }
});

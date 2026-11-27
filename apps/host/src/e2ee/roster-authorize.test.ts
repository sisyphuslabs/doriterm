import { generateX25519, x25519FromSecret, type Stream } from "@doriface/crypto";
import { signCard } from "@doriface/mesh";
import { afterEach, expect, test } from "bun:test";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { ownOf, removeSides, side } from "../testing/join-harness.ts";
import { indexOf, AuthorizeIndex } from "../mesh/authorize-index.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { sessionPeer } from "./authorize.ts";
import { viewOf } from "@doriface/mesh";

afterEach(removeSides);

test("the roster admits paired and client keys while refusing machine, revoked and unknown keys", () => {
  const a = side("alpha");
  const c = side("browser");
  const devices = new DeviceStore(a.dir);
  const machineDevice = generateX25519();
  a.mesh.found(a.m.identity, { ...ownOf(a), devicePub: Buffer.from(machineDevice.publicKey).toString("base64url") });
  devices.add(c.m.identity.noise.publicKey, "browser");
  const peer = (key: Uint8Array) => sessionPeer("roster", key, a.mesh.authorizeIndex(), devices);
  expect(peer(c.m.identity.noise.publicKey).kind).toBe("device");
  expect(peer(a.m.identity.noise.publicKey).kind).toBe("refused");
  expect(peer(machineDevice.publicKey).kind).toBe("refused");
  expect(peer(generateX25519().publicKey).kind).toBe("refused");
  const mesh = a.mesh.read()?.meshId ?? "";
  const card = signCard(
    cardBody(
      c.m.identity,
      { name: "browser", hcId: "", devicePub: noiseOf(c.m) },
      mesh,
      signPubOf(a.m),
      undefined,
      "client",
    ),
    c.m.identity.sign.secretKey,
  );
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "admit",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { card },
  }));
  devices.revoke(noiseOf(c.m));
  expect(peer(c.m.identity.noise.publicKey).kind).toBe("client");
  expect(sessionPeer("push", c.m.identity.noise.publicKey, a.mesh.authorizeIndex(), devices).kind).toBe("client");
  expect(sessionPeer("push", a.m.identity.noise.publicKey, a.mesh.authorizeIndex(), devices).kind).toBe("refused");
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "revoke",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { signPubs: [signPubOf(c.m)], reason: "revoke" },
  }));
  expect(peer(c.m.identity.noise.publicKey).kind).toBe("refused");
});

test("C3: even interpreting an enrolled card seed as X25519 does not open any stream", () => {
  const a = side("alpha");
  const c = side("browser");
  a.mesh.found(a.m.identity, ownOf(a));
  const mesh = a.mesh.read()?.meshId ?? "";
  const raw = c.m.identity.sign.secretKey;
  const card = signCard(
    cardBody(
      c.m.identity,
      { name: "browser", hcId: "", devicePub: noiseOf(c.m) },
      mesh,
      signPubOf(a.m),
      undefined,
      "client",
    ),
    raw,
  );
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "admit",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { card },
  }));
  const records = a.mesh.read()?.records ?? [];
  const index = new AuthorizeIndex(indexOf(records, viewOf(records), 1));
  const devices = new DeviceStore(a.dir);
  const openedByCardSeed = x25519FromSecret(raw).publicKey;
  const mcp = { enabled: () => true };
  const streams: readonly (Stream | undefined)[] = [undefined, "hc", "mesh", "push", "roster", "mcp", "restore-owner"];
  for (const stream of streams) expect(sessionPeer(stream, openedByCardSeed, index, devices, mcp).kind).toBe("refused");
  for (const stream of ["hc", "push", "roster", "mcp", "restore-owner"] as const)
    expect(sessionPeer(stream, c.m.identity.noise.publicKey, index, devices, mcp).kind).toBe("client");
  expect(sessionPeer("mesh", a.m.identity.noise.publicKey, index, devices).kind).toBe("member");
});

import { generateX25519, type Stream } from "@doriface/crypto";
import { signCard } from "@doriface/mesh";
import { afterEach, expect, test } from "bun:test";
import { DeviceStore } from "../state/devices.ts";
import { McpGrantStore } from "../state/mcp-grants.ts";
import { cardBody } from "../state/mesh.ts";
import { ownOf, removeSides, side } from "../testing/join-harness.ts";
import { mcpGrantFor } from "../testing/mcp-grant.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { MCP_ONLY, type Peer, sessionPeer } from "./authorize.ts";

afterEach(removeSides);

test("stream and key matrix keeps grant keys out of owner streams and owner keys out of MCP", () => {
  const a = side("alpha");
  const browser = side("browser");
  const devices = new DeviceStore(a.dir);
  const store = new McpGrantStore(a.dir);
  const phone = generateX25519().publicKey;
  const machineDevice = generateX25519().publicKey;
  a.mesh.found(a.m.identity, { ...ownOf(a), devicePub: Buffer.from(machineDevice).toString("base64url") });
  const mesh = a.mesh.read()?.meshId;
  if (mesh === undefined) throw new Error("missing mesh in test fixture");
  const card = signCard(
    cardBody(
      browser.m.identity,
      { name: "browser", hcId: "", devicePub: noiseOf(browser.m) },
      mesh,
      signPubOf(a.m),
      undefined,
      "client",
    ),
    browser.m.identity.sign.secretKey,
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
  devices.add(phone, "phone");
  const liveKey = generateX25519().publicKey;
  const burnedKey = generateX25519().publicKey;
  const expiredKey = generateX25519().publicKey;
  const grant = mcpGrantFor(liveKey);
  const burned = mcpGrantFor(burnedKey);
  store.setEnabled(true);
  store.add(grant);
  store.add(burned);
  store.revoke(burned.key);
  store.add({ ...mcpGrantFor(expiredKey), expiresAt: 1 });

  const index = a.mesh.authorizeIndex();
  const streams: readonly (Stream | undefined)[] = [undefined, "hc", "mesh", "push", "roster", "mcp"];
  const refused = streams.map((): Peer["kind"] => "refused");
  const rows: readonly { readonly key: Uint8Array; readonly kinds: readonly Peer["kind"][] }[] = [
    { key: a.m.identity.noise.publicKey, kinds: ["member", "member", "member", "refused", "refused", "refused"] },
    { key: browser.m.identity.noise.publicKey, kinds: ["client", "client", "refused", "client", "client", "refused"] },
    { key: phone, kinds: ["device", "device", "refused", "device", "device", "refused"] },
    { key: liveKey, kinds: ["refused", "refused", "refused", "refused", "refused", "agent"] },
    { key: machineDevice, kinds: refused },
    { key: burnedKey, kinds: refused },
    { key: expiredKey, kinds: refused },
    { key: generateX25519().publicKey, kinds: refused },
  ];
  const grants = { store, now: () => 1 };
  for (const { key, kinds } of rows) {
    expect(streams.map((stream) => sessionPeer(stream, key, index, devices, grants).kind)).toEqual([...kinds]);
  }
  expect(sessionPeer("mcp", liveKey, index, devices, grants)).toEqual({ kind: "agent", grant });
  store.setEnabled(false);
  expect(sessionPeer("mcp", liveKey, index, devices, grants)).toEqual({
    kind: "refused",
    reason: "MCP is off on this host",
  });
});

test("a live grant accidentally entered for an owner key still cannot open MCP", () => {
  const a = side("alpha");
  const store = new McpGrantStore(a.dir);
  const devices = new DeviceStore(a.dir);
  const key = generateX25519().publicKey;
  devices.add(key, "phone");
  store.setEnabled(true);
  store.add(mcpGrantFor(key));
  expect(sessionPeer("mcp", key, undefined, devices, { store, now: () => 1 })).toEqual({
    kind: "refused",
    reason: "an owner key does not open the mcp stream",
  });
});

test("a key that holds a grant, live or revoked, opens no owner stream even when it is also a paired device", () => {
  const a = side("alpha");
  const store = new McpGrantStore(a.dir);
  const devices = new DeviceStore(a.dir);
  const live = generateX25519().publicKey;
  const revoked = generateX25519().publicKey;
  devices.add(live, "phone");
  devices.add(revoked, "tablet");
  store.setEnabled(true);
  store.add(mcpGrantFor(live));
  store.add(mcpGrantFor(revoked));
  store.revoke(mcpGrantFor(revoked).key);
  const grants = { store, now: () => 1 };
  // Without the grant file both keys are ordinary paired devices: the refusal below is the grant's, not the fixture's.
  expect(sessionPeer("hc", live, undefined, devices).kind).toBe("device");
  for (const key of [live, revoked]) {
    for (const stream of [undefined, "hc", "push", "roster"] as const) {
      expect(sessionPeer(stream, key, undefined, devices, grants)).toEqual({ kind: "refused", reason: MCP_ONLY });
    }
  }
});

test("a caller with no grant store still refuses the MCP stream", () => {
  const a = side("alpha");
  const devices = new DeviceStore(a.dir);
  expect(sessionPeer("mcp", generateX25519().publicKey, undefined, devices)).toEqual({
    kind: "refused",
    reason: "this host serves no mcp stream",
  });
});

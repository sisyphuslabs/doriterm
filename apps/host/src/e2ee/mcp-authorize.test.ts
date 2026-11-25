import { base64urlEncode, generateX25519, type Stream } from "@doriface/crypto";
import { signCard } from "@doriface/mesh";
import { afterEach, expect, test } from "bun:test";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { ownOf, removeSides, side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { type Peer, sessionPeer } from "./authorize.ts";

afterEach(removeSides);

const refuse = (reason: string): Peer => ({ kind: "refused", reason });

test("the MCP switch gates push-equivalent keys on MCP only, including when the switch throws", () => {
  const a = side("alpha");
  const browser = side("browser");
  const devices = new DeviceStore(a.dir);
  const phone = generateX25519().publicKey;
  const machineDevice = generateX25519().publicKey;
  a.mesh.found(a.m.identity, { ...ownOf(a), devicePub: base64urlEncode(machineDevice) });
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
  devices.add(machineDevice, "machine device");

  const index = a.mesh.authorizeIndex();
  const streams: readonly (Stream | undefined)[] = [undefined, "hc", "mesh", "push", "roster", "mcp"];
  const keys = [
    a.m.identity.noise.publicKey,
    browser.m.identity.noise.publicKey,
    phone,
    machineDevice,
    generateX25519().publicKey,
  ];
  const logs: string[] = [];
  let reads = 0;
  const switchFor = (enabled: boolean) => ({
    enabled: () => {
      reads++;
      return enabled;
    },
  });
  const on = switchFor(true);
  const off = switchFor(false);
  const broken = {
    enabled: () => {
      ++reads;
      throw new Error("bad mcp.json");
    },
    log: (line: string) => void logs.push(line),
  };
  for (const key of keys) {
    for (const stream of streams) {
      const baseline = sessionPeer(stream, key, index, devices);
      if (stream !== "mcp") {
        expect(sessionPeer(stream, key, index, devices, on)).toEqual(baseline);
        expect(sessionPeer(stream, key, index, devices, off)).toEqual(baseline);
        expect(sessionPeer(stream, key, index, devices, broken)).toEqual(baseline);
        continue;
      }
      const push = sessionPeer("push", key, index, devices);
      expect(sessionPeer(stream, key, index, devices, on)).toEqual(
        push.kind === "refused" && push.reason === "a mesh member has no push stream"
          ? refuse("a mesh member has no mcp stream")
          : push,
      );
      expect(sessionPeer(stream, key, index, devices, off)).toEqual(refuse("MCP is off on this host"));
      expect(sessionPeer(stream, key, index, devices, broken)).toEqual(refuse("cannot read the MCP switch"));
      expect(baseline).toEqual(refuse("this host serves no mcp stream"));
    }
  }
  expect(reads).toBe(keys.length * 3);
  expect(logs).toEqual(keys.map(() => "cannot read the MCP switch: Error: bad mcp.json"));
});

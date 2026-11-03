import { CloseCode, generateX25519, type SecureLink, SessionKind } from "@doriface/crypto";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveSessions } from "../e2ee/sessions.ts";
import { type Machine, machine, MeshFixture } from "../testing/mesh-history.ts";
import { DeviceStore } from "./devices.ts";
import { KnownHosts } from "./known-hosts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dh-mesh-cleanup-"));
  dirs.push(dir);
  const founder = machine("founder");
  const joiner = machine("joiner");
  const devices = new DeviceStore(dir);
  const known = new KnownHosts(dir);
  const phone = generateX25519();
  devices.add(phone.publicKey, "phone");
  devices.add(joiner.identity.noise.publicKey, "joiner as a device");
  devices.add(joiner.device.publicKey, "joiner's device key");
  const other = { hostId: machine("x").identity.hostId, hostKey: generateX25519().publicKey, relayUrl: "wss://r" };
  known.add(other);
  known.add({ hostId: joiner.identity.hostId, hostKey: joiner.identity.noise.publicKey, relayUrl: "wss://r" });
  return { dir, founder, joiner, devices, known, phone, other, mesh: new MeshFixture(dir, founder) };
}

const names = (devices: DeviceStore): string[] => devices.list().map((device) => device.name);

describe("H-4: join and revoke cleanup of devices.json and known-hosts.json", () => {
  test("merging an admit removes the joiner's Noise and device keys and its saved host, and nothing else", () => {
    const { founder, joiner, devices, known, mesh, other } = setup();
    mesh.admit(founder, joiner);
    expect(names(devices)).toEqual(["phone"]);
    expect(known.get(joiner.identity.hostId)).toBeUndefined();
    expect(known.get(other.hostId)).toBeDefined();
    expect(mesh.logs.filter((line) => line.startsWith("mesh: removed"))).toHaveLength(3);
  });

  test("merging a revoke removes every key the member ever had, including one a device entry gained later", () => {
    const { founder, joiner, devices, known, mesh } = setup();
    mesh.admit(founder, joiner);
    const old = joiner.identity.noise.publicKey;
    const fresh = generateX25519();
    mesh.rekey(joiner, fresh);
    devices.add(old, "stale entry");
    devices.add(fresh.publicKey, "stale entry 2");
    known.add({ hostId: joiner.identity.hostId, hostKey: old, relayUrl: "wss://r" });
    mesh.revoke(founder, joiner);
    expect(names(devices)).toEqual(["phone"]);
    expect(known.get(joiner.identity.hostId)).toBeUndefined();
  });

  test("the cleanup runs inside the same state-lock hold as the mesh.json write", () => {
    const { dir, founder, joiner, mesh } = setup();
    const held: boolean[] = [];
    const original = DeviceStore.prototype.removeKeysHeld;
    const spy = spyOn(DeviceStore.prototype, "removeKeysHeld").mockImplementation(function (this: DeviceStore, keys) {
      held.push(existsSync(join(dir, "state.lock")));
      return original.call(this, keys);
    });
    mesh.admit(founder, joiner);
    spy.mockRestore();
    expect(held).toEqual([true]);
  });
});

function liveSession(key: Uint8Array): SecureLink & { readonly closes: number[] } {
  const closes: number[] = [];
  return {
    closes,
    kind: SessionKind.Session,
    remoteStatic: key,
    handshakeHash: new Uint8Array(32),
    peerName: undefined,
    lanUrls: [],
    stream: undefined,
    send() {},
    onData: () => () => {},
    onClose: () => () => {},
    close(code) {
      closes.push(code ?? 1000);
    },
  };
}

describe("live sessions follow the mesh", () => {
  test("a member's session stays while it is a member and closes 4401 once a revoke is merged", () => {
    const { dir, founder, joiner, devices, mesh, phone } = setup();
    mesh.admit(founder, joiner);
    const sessions = new LiveSessions(devices, () => {}, mesh.store);
    const [line, device] = [liveSession(joiner.identity.noise.publicKey), liveSession(phone.publicKey)];
    sessions.add(line);
    sessions.add(device);
    expect([line.closes, device.closes]).toEqual([[], []]);
    mesh.revoke(founder, joiner);
    sessions.closeRevoked();
    expect([line.closes, device.closes]).toEqual([[CloseCode.UnknownDevice], []]);
    expect(existsSync(join(dir, "mesh.json"))).toBe(true);
  });

  test("a paired device whose key is a member's device key is closed even though devices.json lists it", () => {
    const { founder, joiner, devices, mesh } = setup();
    const member: Machine = joiner;
    mesh.admit(founder, member);
    devices.add(member.device.publicKey, "re-added");
    const sessions = new LiveSessions(devices, () => {}, mesh.store);
    const session = liveSession(member.device.publicKey);
    sessions.add(session);
    expect(session.closes).toEqual([CloseCode.UnknownDevice]);
  });
});

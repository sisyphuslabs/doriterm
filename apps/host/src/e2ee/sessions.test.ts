import { base64urlEncode, generateX25519, type SecureLink, SessionKind } from "@doriface/crypto";
import { memoryLinkPair, type MemoryEnd } from "@doriface/crypto/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { settle } from "../mesh/testing/fake-clock.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "../state/devices.ts";
import { MeshStore } from "../state/mesh.ts";
import { REVOKED } from "./accept.ts";
import { LiveSessions } from "./sessions.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stores() {
  const dir = mkdtempSync(join(tmpdir(), "dh-sessions-"));
  dirs.push(dir);
  const devices = new DeviceStore(dir);
  const logs: string[] = [];
  return {
    devices,
    logs,
    sessions: new LiveSessions(devices, (line) => void logs.push(line), new MeshStore(dir, { log: () => {} })),
  };
}

const session = (end: MemoryEnd, remoteStatic: Uint8Array): SecureLink =>
  Object.assign(end, {
    kind: SessionKind.Session,
    remoteStatic,
    handshakeHash: new Uint8Array(32),
    peerName: undefined,
    lanUrls: [],
    stream: undefined,
  });

describe("registering a live session", () => {
  test("a session no store authorizes is closed at once, and add says so", () => {
    const [end] = memoryLinkPair();
    const { sessions, logs } = stores();
    expect(sessions.add(session(end, generateX25519().publicKey))).toBe(false);
    expect(end.closeCode).toBe(REVOKED.code);
    expect(logs).toContain("e2ee: close code=4401 source=live-sessions stream=hc: key is no longer authorized");
  });

  test("a paired device's session stays open, and add says so", () => {
    const { devices, sessions } = stores();
    const key = generateX25519().publicKey;
    devices.add(key, "phone");
    const [end] = memoryLinkPair();
    expect(sessions.add(session(end, key))).toBe(true);
    expect(end.closeCode).toBeUndefined();
  });

  test("count is every session it serves now", () => {
    const { devices, sessions } = stores();
    const phone = generateX25519();
    const laptop = generateX25519();
    devices.add(phone.publicKey, "phone");
    devices.add(laptop.publicKey, "laptop");
    const [first] = memoryLinkPair();
    const [second] = memoryLinkPair();
    expect(sessions.count()).toBe(0);
    expect(sessions.add(session(first, phone.publicKey))).toBe(true);
    expect(sessions.add(session(second, laptop.publicKey))).toBe(true);
    expect(sessions.count()).toBe(2);
  });
});

describe("whether a session from a key is open (presence, design section 8.2)", () => {
  test("is true while any session from the key is open, and false once the last one closed here", () => {
    const { devices, sessions } = stores();
    const key = generateX25519().publicKey;
    const name = base64urlEncode(key);
    devices.add(key, "phone");
    expect(sessions.has(name)).toBe(false);
    const [first] = memoryLinkPair(true);
    const [second] = memoryLinkPair(true);
    sessions.add(session(first, key));
    sessions.add(session(second, key));
    expect(sessions.has(name)).toBe(true);
    first.close(1000, "done");
    expect(sessions.has(name)).toBe(true);
    second.close(1000, "done");
    expect(sessions.has(name)).toBe(false);
  });

  test("is false for a session no store authorizes, once add closed it", async () => {
    const { sessions } = stores();
    const key = generateX25519().publicKey;
    const [end] = memoryLinkPair();
    expect(sessions.add(session(end, key))).toBe(false);
    await settle();
    expect(sessions.has(base64urlEncode(key))).toBe(false);
  });

  test("is false once the remote end hung up", async () => {
    const { devices, sessions } = stores();
    const key = generateX25519().publicKey;
    devices.add(key, "phone");
    const [ours, theirs] = memoryLinkPair();
    sessions.add(session(ours, key));
    expect(sessions.has(base64urlEncode(key))).toBe(true);
    theirs.close(1001, "gone");
    await settle();
    expect(sessions.has(base64urlEncode(key))).toBe(false);
  });
});

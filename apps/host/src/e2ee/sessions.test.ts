import { base64urlEncode, CloseCode, generateX25519, type SecureLink, SessionKind } from "@doriface/crypto";
import { parsePolicy } from "@doriface/policy";
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

/** A session whose link dropped and that waits for its client's resume (contract v1.11). */
const waiting = (end: MemoryEnd, remoteStatic: Uint8Array): SecureLink =>
  Object.assign(session(end, remoteStatic), { detached: true });

/** A session that detaches when told, as a resumable session does when its link drops. */
function droppable(end: MemoryEnd, remoteStatic: Uint8Array) {
  const listeners: ((reason: Error) => void)[] = [];
  const link = Object.assign(session(end, remoteStatic), {
    detached: false,
    onDetached: (listener: (reason: Error) => void) => (listeners.push(listener), () => undefined),
  });
  return {
    session: link,
    drop: () => {
      link.detached = true;
      for (const listener of listeners) listener(new Error("dropped"));
    },
  };
}

describe("a plan's session limit and sessions that wait for their client (#2853)", () => {
  const ONE = parsePolicy('{"plan":"free","limits":{"sessions":1}}');

  test("a device that comes back with a new session replaces its own waiting one, and the limit still holds", async () => {
    const { devices, sessions, logs } = stores();
    const phone = generateX25519().publicKey;
    devices.add(phone, "phone");
    const [old] = memoryLinkPair();
    expect(sessions.add(waiting(old, phone))).toBe(true);
    expect(sessions.count()).toBe(1);
    // The phone's own waiting session is not counted against its new one.
    expect(sessions.count(base64urlEncode(phone))).toBe(0);
    const [fresh] = memoryLinkPair();
    expect(sessions.admitHc(session(fresh, phone), ONE)).toBe(true);
    expect(old.closeCode).toBe(CloseCode.IdleTimeout);
    expect(fresh.closeCode).toBeUndefined();
    // A memory link reports its close a turn later; a real session reports it as it closes.
    await settle();
    expect(sessions.count()).toBe(1);
    expect(logs.some((line) => line.includes("replaced by a new session from the same device"))).toBe(true);
  });

  test("a device with several views replaces only as many waiting ones as it needs, oldest first; the rest stay resumable", async () => {
    const THREE = parsePolicy('{"plan":"free","limits":{"sessions":3}}');
    const { devices, sessions } = stores();
    const phone = generateX25519().publicKey;
    devices.add(phone, "phone");
    const [live] = memoryLinkPair();
    const [older] = memoryLinkPair();
    const [newer] = memoryLinkPair();
    expect(sessions.add(session(live, phone))).toBe(true);
    expect(sessions.add(waiting(older, phone))).toBe(true);
    expect(sessions.add(waiting(newer, phone))).toBe(true);
    const [fresh] = memoryLinkPair();
    expect(sessions.admitHc(session(fresh, phone), THREE)).toBe(true);
    expect(older.closeCode).toBe(CloseCode.IdleTimeout);
    expect(newer.closeCode).toBeUndefined();
    expect(live.closeCode).toBeUndefined();
    await settle();
    expect(sessions.count()).toBe(3);
  });

  test("the view replaced is the one that has waited longest, whatever order the views opened in (#2886 review)", () => {
    const TWO = parsePolicy('{"plan":"free","limits":{"sessions":2}}');
    const { devices, sessions } = stores();
    const phone = generateX25519().publicKey;
    devices.add(phone, "phone");
    const [first] = memoryLinkPair();
    const [second] = memoryLinkPair();
    const openedFirst = droppable(first, phone);
    const openedSecond = droppable(second, phone);
    expect(sessions.add(openedFirst.session)).toBe(true);
    expect(sessions.add(openedSecond.session)).toBe(true);
    // The view opened second dropped first, so it has waited longest.
    openedSecond.drop();
    openedFirst.drop();
    const [fresh] = memoryLinkPair();
    expect(sessions.admitHc(session(fresh, phone), TWO)).toBe(true);
    expect(second.closeCode).toBe(CloseCode.IdleTimeout);
    expect(first.closeCode).toBeUndefined();
  });

  test("an MCP session never replaces a waiting one: it is refused while the plan is full", () => {
    const { devices, sessions } = stores();
    const phone = generateX25519().publicKey;
    devices.add(phone, "phone");
    const [old] = memoryLinkPair();
    expect(sessions.add(waiting(old, phone))).toBe(true);
    const [mcp] = memoryLinkPair();
    expect(sessions.admitLimited(Object.assign(session(mcp, phone), { stream: "mcp" }), ONE)).toBe(false);
    expect(mcp.closeCode).toBe(CloseCode.RateLimited);
    expect(old.closeCode).toBeUndefined();
  });

  test("another device is still refused while one waits, and a device's live session is never replaced", () => {
    const { devices, sessions } = stores();
    const phone = generateX25519().publicKey;
    const laptop = generateX25519().publicKey;
    devices.add(phone, "phone");
    devices.add(laptop, "laptop");
    const [old] = memoryLinkPair();
    expect(sessions.add(waiting(old, phone))).toBe(true);
    const [other] = memoryLinkPair();
    expect(sessions.count(base64urlEncode(laptop))).toBe(1);
    expect(sessions.admitHc(session(other, laptop), ONE)).toBe(false);
    expect(other.closeCode).toBe(CloseCode.RateLimited);
    expect(old.closeCode).toBeUndefined();

    const { devices: devices2, sessions: sessions2 } = stores();
    devices2.add(phone, "phone");
    const [live] = memoryLinkPair();
    expect(sessions2.add(session(live, phone))).toBe(true);
    expect(sessions2.count(base64urlEncode(phone))).toBe(1);
    const [second] = memoryLinkPair();
    expect(sessions2.admitHc(session(second, phone), ONE)).toBe(false);
    expect(live.closeCode).toBeUndefined();
  });
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

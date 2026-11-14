import { base64urlEncode, generateX25519, type SecureLink, SessionKind } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataHandler, Link } from "../link.ts";
import { DeviceStore } from "../state/devices.ts";
import { MeshStore } from "../state/mesh.ts";
import { REVOKED } from "./accept.ts";
import { watchRevocations } from "./revocation-watch.ts";
import { LiveSessions } from "./sessions.ts";

// A revoke written by another process (`doriface-host devices revoke`) reaches a session that is already admitted
// (#2530): the check on every hc chunk refuses it at once, and the state-dir watch closes an idle one.

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function admitted() {
  const dir = mkdtempSync(join(tmpdir(), "dh-revocation-"));
  dirs.push(dir);
  const devices = new DeviceStore(dir);
  const sessions = new LiveSessions(devices, () => undefined, new MeshStore(dir, { log: () => {} }));
  const key = generateX25519().publicKey;
  devices.add(key, "phone");
  const [end, peer] = memoryLinkPair(true);
  const secure: SecureLink = Object.assign(end, {
    kind: SessionKind.Session,
    remoteStatic: key,
    handshakeHash: new Uint8Array(32),
    peerName: undefined,
    lanUrls: [],
    stream: undefined,
  });
  expect(sessions.add(secure)).toBe(true);
  // Another DeviceStore on the same dir stands for the other process.
  const revokeElsewhere = () => expect(new DeviceStore(dir).revoke(base64urlEncode(key))).toHaveLength(1);
  return { dir, sessions, secure, end, peer, revokeElsewhere };
}

function hcLink() {
  const sent: Uint8Array[] = [];
  const received: { handler?: DataHandler } = {};
  const link: Link = {
    send: async (bytes) => void sent.push(bytes),
    onData: (handler) => void (received.handler = handler),
    onClose: () => undefined,
    close: () => undefined,
  };
  return { link, sent, deliver: (bytes: Uint8Array) => received.handler?.(bytes) };
}

const chunk = (text: string) => new TextEncoder().encode(text);

describe("a guarded hc link", () => {
  test("serves and answers while the device is paired", async () => {
    const { sessions, secure } = admitted();
    const hc = hcLink();
    const guarded = sessions.guardHc(secure, hc.link);
    const served: Uint8Array[] = [];
    guarded.onData((bytes) => void served.push(bytes));
    await hc.deliver(chunk("request"));
    await guarded.send(chunk("answer"));
    expect(served).toHaveLength(1);
    expect(hc.sent).toHaveLength(1);
  });

  test("after a revoke from another process, neither serves the next request nor sends an answer, and closes 4401", async () => {
    const { sessions, secure, end, revokeElsewhere } = admitted();
    const hc = hcLink();
    const guarded = sessions.guardHc(secure, hc.link);
    const served: Uint8Array[] = [];
    guarded.onData((bytes) => void served.push(bytes));
    revokeElsewhere();
    await hc.deliver(chunk("request"));
    await guarded.send(chunk("answer to an earlier request"));
    expect(served).toHaveLength(0);
    expect(hc.sent).toHaveLength(0);
    expect(end.closeCode).toBe(REVOKED.code);
  });

  test("refuses when the devices file cannot be read (fails closed)", async () => {
    const { dir, sessions, secure, end } = admitted();
    const hc = hcLink();
    const guarded = sessions.guardHc(secure, hc.link);
    const served: Uint8Array[] = [];
    guarded.onData((bytes) => void served.push(bytes));
    writeFileSync(join(dir, "devices.json"), "{ not json");
    await hc.deliver(chunk("request"));
    expect(served).toHaveLength(0);
    expect(end.closeCode).toBe(REVOKED.code);
  });
});

describe("a guarded push stream", () => {
  test("after a revoke from another process, takes no subscription line and sends no reply or notice, and closes 4401", async () => {
    const { sessions, secure, end, peer, revokeElsewhere } = admitted();
    const push = sessions.guardPush(secure);
    const taken: Uint8Array[] = [];
    const received: Uint8Array[] = [];
    push.onData((bytes) => void taken.push(bytes));
    peer.onData((bytes) => void received.push(bytes));
    await peer.send(chunk("subscribe\n"));
    expect(taken).toHaveLength(1);
    revokeElsewhere();
    await peer.send(chunk("subscribe\n"));
    await push.send(chunk("notice\n"));
    expect(taken).toHaveLength(1);
    expect(received).toHaveLength(0);
    expect(end.closeCode).toBe(REVOKED.code);
  });
});

describe("a resume", () => {
  test("is allowed while the device is paired, and refused and closed 4401 after a revoke from another process", () => {
    const { sessions, secure, end, revokeElsewhere } = admitted();
    expect(sessions.allows(secure)).toBe(true);
    revokeElsewhere();
    expect(sessions.allows(secure)).toBe(false);
    expect(end.closeCode).toBe(REVOKED.code);
  });
});

describe("the revocation watch", () => {
  test("closes an idle session promptly when another process revokes its device", async () => {
    const { dir, sessions, end, revokeElsewhere } = admitted();
    const closed = Promise.withResolvers<void>();
    stops.push(
      watchRevocations(
        dir,
        () => {
          sessions.closeRevoked();
          if (end.closeCode !== undefined) closed.resolve();
        },
        () => undefined,
      ),
    );
    revokeElsewhere();
    const timeout = setTimeout(() => closed.reject(new Error("the watch did not close the session within 5 s")), 5_000);
    await closed.promise.finally(() => clearTimeout(timeout));
    expect(end.closeCode).toBe(REVOKED.code);
  });
});

import { CloseCode, rawStaticKey, secureLink } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildLink, createGateway } from "../gateway.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { type Machine, machine, MeshFixture } from "../testing/mesh-history.ts";
import type { E2eeWire } from "./links.ts";
import { LiveSessions } from "./sessions.ts";
import { coreIdOf } from "./first-line.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
/** The first line hc 0.1.17's machine dial sends (captured through a tee'ing `--via`), and its `machine.add` probe. */
const peerHello = (id: string) =>
  `{"id":1,"jsonrpc":"2.0","method":"hello","params":{"calls_you":"peerb","core":{"id":"${id}","name":"mac"},"features":["framed"],"framed":true,"generation":1}}\n`;
const PROBE = '{"id":1,"jsonrpc":"2.0","method":"hello","params":{"generation":1}}\n';
const CLIENT = '{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n';

describe("H-6: the first hc line's core id", () => {
  test("is read from a machine dial's hello, and absent from the probe and from a client's hello", () => {
    expect(coreIdOf(encode(peerHello("abc").trimEnd()))).toBe("abc");
    expect(coreIdOf(encode(PROBE.trimEnd()))).toBeUndefined();
    expect(coreIdOf(encode(CLIENT.trimEnd()))).toBeUndefined();
    expect(coreIdOf(encode("not json"))).toBeUndefined();
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A gateway on a mesh of `founder` (this host) and `member`; its hc pipe records what reaches it. */
function gatewayOn(founder: Machine, member: Machine) {
  const dir = mkdtempSync(join(tmpdir(), "dh-first-line-"));
  dirs.push(dir);
  const mesh = new MeshFixture(dir, founder);
  mesh.admit(founder, member);
  const devices = new DeviceStore(dir);
  const piped: Uint8Array[] = [];
  const reached = Promise.withResolvers<string>();
  const logs: string[] = [];
  const exited = Promise.withResolvers<void>();
  const child: ChildLink = {
    exited: exited.promise,
    send: async (bytes) => {
      piped.push(bytes);
      reached.resolve(new TextDecoder().decode(bytes));
    },
    onData: () => {},
    onClose: () => {},
    close: () => exited.resolve(),
  };
  const log = (line: string): void => void logs.push(line);
  const deps = { identity: founder.identity, devices, pairing: new PairingStore(dir), mesh: mesh.store, log };
  const gateway = createGateway({
    token: "t".repeat(32),
    hostVersion: "0",
    hcVersion: "0",
    openPipe: () => child,
    log,
    e2ee: { ...deps, lanUrls: [], sessions: new LiveSessions(devices, log, mesh.store) },
  });
  return { gateway, devices, piped, logs, reached: reached.promise };
}

async function dialAndSend(
  setup: ReturnType<typeof gatewayOn>,
  key: Machine["identity"]["noise"],
  founder: Machine,
  line: string,
) {
  const [clientEnd, hostEnd] = memoryLinkPair();
  const wire: E2eeWire = {
    send: (bytes) => hostEnd.send(bytes),
    onData: (listener) => hostEnd.onData(listener),
    onClose: (listener) => hostEnd.onClose(listener),
    close: (code, reason) => hostEnd.close(code, reason),
    flushed: () => Promise.resolve(),
    readWhen() {},
  };
  const served = setup.gateway.serveE2ee(wire, { kind: "lan" });
  const client = await secureLink(clientEnd, {
    role: "initiator",
    hostId: founder.identity.hostId,
    staticKey: rawStaticKey(key),
    remoteStatic: founder.identity.noise.publicKey,
  });
  await served;
  const closed = Promise.withResolvers<void>();
  client.onClose(() => closed.resolve());
  client.send(encode(line));
  client.send(encode("after"));
  return { hostEnd, closed: closed.promise };
}

describe("H-6: the gateway gates the first hc line", () => {
  test("a member's line announcing its own core id reaches hc whole; announcing another closes 4401 with nothing piped", async () => {
    const [founder, member] = [machine("founder"), machine("member")];
    const ok = gatewayOn(founder, member);
    await dialAndSend(ok, member.identity.noise, founder, peerHello(member.hcId));
    expect(await ok.reached).toStartWith(peerHello(member.hcId));
    const bad = gatewayOn(founder, member);
    const run = await dialAndSend(bad, member.identity.noise, founder, peerHello("someone-else"));
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(bad.piped).toEqual([]);
    expect(bad.logs).toContain("mesh: closing a session: core id does not match the member's card");
  });

  test("a device announcing a member's core id closes 4401; its own client hello passes", async () => {
    const [founder, member, phone] = [machine("founder"), machine("member"), machine("phone")];
    const bad = gatewayOn(founder, member);
    bad.devices.add(phone.identity.noise.publicKey, "phone");
    const run = await dialAndSend(bad, phone.identity.noise, founder, peerHello(member.hcId));
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(bad.piped).toEqual([]);
    const ok = gatewayOn(founder, member);
    ok.devices.add(phone.identity.noise.publicKey, "phone");
    await dialAndSend(ok, phone.identity.noise, founder, CLIENT);
    expect(await ok.reached).toStartWith(CLIENT);
  });

  test("a member's probe hello without a core id passes", async () => {
    const [founder, member] = [machine("founder"), machine("member")];
    const ok = gatewayOn(founder, member);
    await dialAndSend(ok, member.identity.noise, founder, PROBE);
    expect(await ok.reached).toStartWith(PROBE);
  });
});

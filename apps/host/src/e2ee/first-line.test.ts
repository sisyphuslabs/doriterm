import { CloseCode } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT, dial, gatewayOn, peerHello, PROBE } from "../testing/gateway-harness.ts";
import { type Machine, machine } from "../testing/mesh-history.ts";
import { hcLineOf } from "./hc-line.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text.trimEnd());

describe("H-6: the hc lines' core id", () => {
  test("is read from a machine dial's hello, and absent from the probe and from a client's hello", () => {
    expect(hcLineOf(encode(peerHello("abc")))).toEqual({ kind: "hello", coreId: "abc", framed: true });
    expect(hcLineOf(encode(PROBE))).toEqual({ kind: "hello", coreId: undefined, framed: false });
    expect(hcLineOf(encode(CLIENT))).toEqual({ kind: "hello", coreId: undefined, framed: true });
    expect(hcLineOf(encode("not json")).kind).toBe("malformed");
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function on(founder: Machine, member: Machine) {
  const dir = mkdtempSync(join(tmpdir(), "dh-first-line-"));
  dirs.push(dir);
  return gatewayOn(founder, member, { dir });
}

describe("H-6: the gateway gates the hc hello", () => {
  test("a member's line announcing its own core id reaches hc whole; announcing another closes 4401 with nothing piped", async () => {
    const [founder, member] = [machine("founder"), machine("member")];
    const ok = on(founder, member);
    (await dial(ok, member.identity.noise, founder)).send(peerHello(member.hcId));
    await ok.pipe.reached;
    expect(ok.pipe.text()).toStartWith(peerHello(member.hcId));
    const bad = on(founder, member);
    const run = await dial(bad, member.identity.noise, founder);
    run.send(peerHello("someone-else"));
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(bad.pipe.piped).toEqual([]);
  });

  test("a device announcing a member's core id closes 4401; its own client hello passes", async () => {
    const [founder, member, phone] = [machine("founder"), machine("member"), machine("phone")];
    const bad = on(founder, member);
    bad.devices.add(phone.identity.noise.publicKey, "phone");
    const run = await dial(bad, phone.identity.noise, founder);
    run.send(peerHello(member.hcId));
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(bad.pipe.piped).toEqual([]);
    const ok = on(founder, member);
    ok.devices.add(phone.identity.noise.publicKey, "phone");
    (await dial(ok, phone.identity.noise, founder)).send(CLIENT);
    await ok.pipe.reached;
    expect(ok.pipe.text()).toStartWith(CLIENT);
  });

  test("a member's probe hello without a core id passes, as early bytes in message 1", async () => {
    const [founder, member] = [machine("founder"), machine("member")];
    const ok = on(founder, member);
    await dial(ok, member.identity.noise, founder, PROBE);
    await ok.pipe.reached;
    expect(ok.pipe.text()).toBe(PROBE);
  });
});

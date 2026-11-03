import { CloseCode } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT, dial, gatewayOn, peerHello, PROBE } from "../testing/gateway-harness.ts";
import { machine } from "../testing/mesh-history.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deviceSession() {
  const dir = mkdtempSync(join(tmpdir(), "dh-first-line-shapes-"));
  dirs.push(dir);
  const [founder, member, phone] = [machine("founder"), machine("member"), machine("phone")];
  const setup = gatewayOn(founder, member, { dir });
  setup.devices.add(phone.identity.noise.publicKey, "phone");
  return { setup, founder, member, phone };
}

/** What a paired device sends ahead of a peer hello that claims a member's core, so hc 0.1.17 reads the claim. */
const AHEAD = {
  "a blank line": "\n",
  "an empty JSON array": "[]\n",
  "a line that is not JSON": "not json\n",
  "a ping request": '{"jsonrpc":"2.0","id":0,"method":"ping"}\n',
  "a hello with params hc refuses": '{"jsonrpc":"2.0","id":0,"method":"hello","params":5}\n',
  "a hello without jsonrpc or id": '{"method":"hello"}\n',
  "a hello without an id": '{"jsonrpc":"2.0","method":"hello","params":{}}\n',
  "a hello without jsonrpc": '{"id":0,"method":"hello","params":{}}\n',
} as const;

describe("HIGH-1: no line hc would read past reaches it ahead of the gated hello", () => {
  for (const [shape, ahead] of Object.entries(AHEAD)) {
    test(`${shape}, then a peer hello with a member's core id: 4400 and nothing piped`, async () => {
      const { setup, founder, member, phone } = deviceSession();
      const run = await dial(setup, phone.identity.noise, founder);
      run.send(ahead + peerHello(member.hcId));
      await run.closed;
      expect(run.hostEnd.closeCode).toBe(CloseCode.CryptoFailure);
      expect(setup.pipe.piped).toEqual([]);
    });
  }

  test("a 4300-byte peer hello with a member's core id (no line feed within 4096 bytes): 4400 and nothing piped", async () => {
    const { setup, founder, member, phone } = deviceSession();
    const line = peerHello(member.hcId, "x".repeat(4300 - peerHello(member.hcId).length - 9));
    expect(line).toHaveLength(4300);
    const run = await dial(setup, phone.identity.noise, founder);
    run.send(line);
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.CryptoFailure);
    expect(setup.pipe.piped).toEqual([]);
  });

  test("a clean unframed hello, then a framed peer hello with a member's core id: 4401, the claim never piped", async () => {
    const { setup, founder, member, phone } = deviceSession();
    const run = await dial(setup, phone.identity.noise, founder);
    run.send('{"jsonrpc":"2.0","id":0,"method":"hello","params":{}}\n' + peerHello(member.hcId));
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(setup.pipe.text()).not.toContain(member.hcId);
  });

  const unswitched = {
    "generation 1.0": '{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true,"generation":1.0}}\n',
    "a lone surrogate": '{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true,"calls_you":"\\ud800"}}\n',
    "1e400 in a field hc ignores": '{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true,"x":1e400}}\n',
    "a leading byte order mark": '\ufeff{"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}}\n',
    "1e400 overwritten by a duplicate key":
      '{"jsonrpc":"2.0","id":0,"method":"hello","params":{"x":1e400,"x":1,"framed":true}}\n',
    "a lone surrogate overwritten by a duplicate key":
      '{"jsonrpc":"2.0","id":0,"method":"hello","params":{"core":"\\ud800","core":null,"framed":true}}\n',
  } as const;
  for (const [what, hello] of Object.entries(unswitched)) {
    test(`a framed hello with ${what} (hc refuses it and stays plain), then a member's peer hello: 4400`, async () => {
      const { setup, founder, member, phone } = deviceSession();
      const run = await dial(setup, phone.identity.noise, founder);
      run.send(hello + peerHello(member.hcId));
      await run.closed;
      expect(run.hostEnd.closeCode).toBe(CloseCode.CryptoFailure);
      expect(setup.pipe.text()).not.toContain(member.hcId);
    });
  }

  test("after a framed client hello, frames pass through untouched", async () => {
    const { setup, founder, phone } = deviceSession();
    const run = await dial(setup, phone.identity.noise, founder);
    const frame = "\u0000\u0000\u0000\u0000\u0001\u0002\u0000\u0000\u0000{}not a line";
    run.send(CLIENT + frame);
    await setup.pipe.reached;
    expect(setup.pipe.text()).toBe(CLIENT + frame);
    expect(run.hostEnd.closeCode).toBeUndefined();
  });
});

describe("MEDIUM-5: the gate follows its lines across the device's messages", () => {
  test("the probe hello in one message, then a member's peer hello in the next: 4401, only the probe piped", async () => {
    const { setup, founder, member, phone } = deviceSession();
    const run = await dial(setup, phone.identity.noise, founder);
    run.send(PROBE);
    await setup.pipe.reached;
    run.send(peerHello(member.hcId));
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(setup.pipe.text()).toBe(PROBE);
  });

  test("the probe split inside its line, then a member's peer hello split across two more messages: 4401", async () => {
    const { setup, founder, member, phone } = deviceSession();
    const claim = peerHello(member.hcId);
    const run = await dial(setup, phone.identity.noise, founder);
    run.send(PROBE.slice(0, 20));
    run.send(PROBE.slice(20) + claim.slice(0, 30));
    run.send(claim.slice(30));
    await run.closed;
    expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
    expect(setup.pipe.text()).not.toContain(member.hcId);
  });
});

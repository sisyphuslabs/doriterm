import { CloseCode } from "@doriface/crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT, dial, gatewayOn, peerHello, PROBE } from "../testing/gateway-harness.ts";
import { MeshStore } from "../state/mesh.ts";
import { loadDeviceKey } from "../state/known-hosts.ts";
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
  return { ...gatewayOn(founder, member, { dir }), dir };
}

describe("H-6: the gateway gates the hc hello", () => {
  test.each(["\n", "\r\n"])(
    "#1420: a plain connect device claiming a member core is attributable; the member key keeps the hello intact (%j)",
    async (newline) => {
      const [founder, member] = [machine("founder"), machine("member")];
      const bad = on(founder, member);
      // The shim's plain `connect` loads this separate key, unlike `connect --mesh`.
      const device = loadDeviceKey(bad.dir);
      bad.devices.add(device.publicKey, "paired-machine");
      const hello = peerHello(member.hcId).replace("\n", newline);
      const run = await dial(bad, device, founder);
      run.send(hello);
      await run.closed;
      expect(run.hostEnd.closeCode).toBe(CloseCode.UnknownDevice);
      expect(bad.pipe.piped).toEqual([]);
      expect(bad.logs).toContain(
        "e2ee: close code=4401 source=hc-hello peer=device stream=hc: a device announced a mesh member's core id",
      );

      const withoutCore = on(founder, member);
      withoutCore.devices.add(device.publicKey, "paired-machine");
      const client = await dial(withoutCore, device, founder);
      const stripped = hello.replace(`"core":{"id":"${member.hcId}","name":"mac"},`, "");
      client.send(stripped);
      await withoutCore.pipe.reached;
      expect(withoutCore.pipe.text()).toBe(stripped);
      expect(client.hostEnd.closeCode).toBeUndefined();
      client.client.close();

      const mesh = on(founder, member);
      const legitimate = await dial(mesh, member.identity.noise, founder);
      legitimate.send(hello);
      await mesh.pipe.reached;
      expect(mesh.pipe.text()).toBe(hello);
      expect(legitimate.hostEnd.closeCode).toBeUndefined();
      legitimate.client.close();
    },
  );

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

  test("MEDIUM-3: a mesh state the gate cannot read closes 1011, starts no hc connect and pipes no early byte", async () => {
    const [founder, member] = [machine("founder"), machine("member")];
    const dir = mkdtempSync(join(tmpdir(), "dh-first-line-"));
    dirs.push(dir);
    let reads = 0;
    class GateReadFails extends MeshStore {
      override authorizeIndex() {
        // Reads 1 and 2 are authorize and the live-session re-check; read 3 is the gate's.
        if (++reads === 3) throw new Error("mesh.json: cannot stat");
        return super.authorizeIndex();
      }
    }
    const setup = gatewayOn(founder, member, { dir, mesh: new GateReadFails(dir, { log: () => {} }) });
    const run = await dial(setup, member.identity.noise, founder, peerHello("someone-else"));
    await run.closed;
    expect(reads).toBe(3);
    expect(run.hostEnd.closeCode).toBe(1011);
    expect(setup.opened()).toBe(0);
    expect(setup.pipe.piped).toEqual([]);
  });

  test("a member's probe hello without a core id passes, as early bytes in message 1", async () => {
    const [founder, member] = [machine("founder"), machine("member")];
    const ok = on(founder, member);
    await dial(ok, member.identity.noise, founder, PROBE);
    await ok.pipe.reached;
    expect(ok.pipe.text()).toBe(PROBE);
  });
});

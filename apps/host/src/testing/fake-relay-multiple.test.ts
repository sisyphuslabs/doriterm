import { expect, test } from "bun:test";
import { generateX25519, rawStaticKey, secureLink } from "@doriface/crypto";
import { connectRelayClient } from "@doriface/relay-client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Host, startHost } from "../host.ts";
import { DeviceStore } from "../state/devices.ts";
import { loadHostIdentity } from "../state/host-keys.ts";
import { ByteReader } from "./byte-reader.ts";
import { FakeRelay } from "./fake-relay.ts";
import { createHcSession, HELLO, rpcFrame } from "./hc-session.ts";
import { RelayClientBridge } from "./relay-client-bridge.ts";

test("two hosts have independent relay sessions and stopping one leaves the other's client alive (#1297)", async () => {
  const relay = new FakeRelay();
  const bridge = new RelayClientBridge(relay);
  const phone = generateX25519();
  const fixtures = ["first", "second"].map((name) => {
    const dir = mkdtempSync(join(tmpdir(), `relay-${name}-`));
    const core = createHcSession(`relay-${name}`);
    const identity = loadHostIdentity(dir);
    new DeviceStore(dir).add(phone.publicKey, "phone");
    return { dir, core, identity };
  });
  const hosts: Host[] = [];
  try {
    for (const fixture of fixtures) {
      hosts.push(
        // oxlint-disable-next-line no-await-in-loop -- establish each named uplink before opening the next
        await startHost({
          listen: { hostname: "127.0.0.1", port: 0 },
          token: `test-${crypto.randomUUID()}`,
          hc: fixture.core.hc,
          session: fixture.core.name,
          env: fixture.core.env,
          stateDir: fixture.dir,
          relay: { url: relay.url },
          log: () => {},
        }),
      );
      // oxlint-disable-next-line no-await-in-loop -- the answer identifies the host that just started
      expect(await relay.answers.next()).toEqual({ hostId: fixture.identity.hostId, verified: true });
    }
    const targets = fixtures.flatMap(({ identity }) =>
      [bridge.url, relay.url].map((relayUrl) => ({ identity, relayUrl })),
    );
    const clients = await Promise.all(
      targets.map(async ({ identity, relayUrl }) => {
        const transport = await connectRelayClient({ relayUrl, hostId: identity.hostId });
        const link = await secureLink(transport, {
          role: "initiator",
          hostId: identity.hostId,
          staticKey: rawStaticKey(phone),
          remoteStatic: identity.noise.publicKey,
        });
        const bytes = new ByteReader();
        link.onData((chunk) => bytes.push(chunk));
        link.onClose(() => bytes.end());
        link.send(HELLO);
        expect(JSON.parse(new TextDecoder().decode(await bytes.line())).result.framed).toBe(true);
        return { link, bytes };
      }),
    );
    try {
      await hosts[0]?.stop();
      await Promise.all(
        clients.slice(2).map(async (survivor) => {
          survivor.link.send(rpcFrame(1, "terminal.list"));
          expect((await survivor.bytes.frame()).byteLength).toBeGreaterThan(9);
        }),
      );
    } finally {
      for (const client of clients) client.link.close();
    }
  } finally {
    for (const host of hosts) {
      // oxlint-disable-next-line no-await-in-loop -- stop hosts before their cores
      await host.stop();
    }
    await bridge.stop();
    await relay.stop();
    for (const { core, dir } of fixtures) {
      // oxlint-disable-next-line no-await-in-loop -- dispose each owned core before removing its state
      await core.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 30_000);

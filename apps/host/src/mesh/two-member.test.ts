import { expect, test } from "bun:test";
import { OPEN_POLICY } from "@doriface/policy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../gateway.ts";
import { LiveSessions } from "../e2ee/sessions.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { dial, peerHello, recordingPipe } from "../testing/gateway-harness.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet, type NetHost } from "./testing/mesh-net.ts";

/** Each host serves the same persisted membership that its own gossip writes, over real Noise hc sessions. */
function gatewayFor(host: NetHost, dir: string) {
  const devices = new DeviceStore(dir);
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const sessions = new LiveSessions(devices, log, host.store);
  const pipe = recordingPipe();
  let opened = 0;
  const gateway = createGateway({
    token: "t".repeat(32),
    hostVersion: "test",
    hcVersion: "test",
    openPipe: () => {
      opened++;
      return pipe.child;
    },
    log,
    e2ee: {
      identity: host.member.machine.identity,
      devices,
      pairing: new PairingStore(dir),
      mesh: host.store,
      sessions,
      policy: OPEN_POLICY,
      live: sessions,
      lanUrls: [],
      log,
    },
  });
  return { gateway, devices, logs, pipe, sessions, opened: () => opened };
}

test("#1420: a plain two-member mesh keeps both hc lines and sync connected across view updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dh-two-member-"));
  const [a, b] = [peer("plain-a"), peer("plain-b")];
  const clock = new FakeClock();
  const net = new MeshNet(clock, seededRandom(1420));
  const { records } = meshOf([a, b]);
  const hosts = [net.add(a, records), net.add(b, records)] as const;
  const [atA, atB] = [gatewayFor(hosts[0], join(dir, "a")), gatewayFor(hosts[1], join(dir, "b"))];
  const lines: Awaited<ReturnType<typeof dial>>[] = [];
  try {
    const toA = await dial(atA, b.machine.identity.noise, a.machine);
    lines.push(toA);
    const toB = await dial(atB, a.machine.identity.noise, b.machine);
    lines.push(toB);
    toA.send(peerHello(b.hcId));
    toB.send(peerHello(a.hcId));
    await Promise.all([atA.pipe.reached, atB.pipe.reached]);
    const memberB = hosts[0].gossip.view.members.find((member) => member.signPub === b.signPub);
    if (memberB === undefined) throw new Error("the pair has no second member");
    expect(await hosts[0].gossip.sync(memberB, "push")).toBe(true);
    await clock.advance(1);
    const syncA = hosts[0].gossip.session(b.signPub);
    const syncB = hosts[1].gossip.session(a.signPub);
    expect(syncA).toBeDefined();
    expect(syncB).toBeDefined();

    // More than the 60 s sync linger, with real records exchanged in both directions.
    const exchange = async (round: number): Promise<void> => {
      if (round === 4) return;
      await clock.advance(25_000);
      hosts[0].gossip.append({ type: "name", signPub: a.signPub, name: `alpha-${round}` });
      hosts[1].gossip.append({ type: "name", signPub: b.signPub, name: `beta-${round}` });
      await clock.advance(1);
      atA.sessions.closeRevoked();
      atB.sessions.closeRevoked();
      expect(net.converged()).toBe(true);
      expect(hosts.map((host) => host.gossip.possiblyRevoked)).toEqual([false, false]);
      expect(hosts[0].gossip.session(b.signPub)).toBe(syncA);
      expect(hosts[1].gossip.session(a.signPub)).toBe(syncB);
      expect(lines.map((line) => line.hostEnd.closeCode)).toEqual([undefined, undefined]);
      expect([atA.sessions.count(), atB.sessions.count()]).toEqual([1, 1]);
      return exchange(round + 1);
    };
    await exchange(0);
    // The machine hello is preserved: the shim's removal of params.core is unnecessary on a member's line.
    expect(atA.pipe.text()).toBe(peerHello(b.hcId));
    expect(atB.pipe.text()).toBe(peerHello(a.hcId));
    expect([...atA.logs, ...atB.logs].filter((line) => line.includes("code=4401"))).toEqual([]);
  } finally {
    for (const line of lines) line.client.close();
    for (const host of hosts) host.gossip.stop();
    await Promise.all([atA.gateway.closeAll(), atB.gateway.closeAll()]);
    rmSync(dir, { recursive: true, force: true });
  }
  // Two real Noise handshakes and four settled sync rounds: well over bun's 5 s default on a loaded runner.
}, 30_000);

import { describe, expect, test } from "bun:test";
import { SecureLinkError } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { parseRecord } from "@doriface/mesh";
import type { MemberEntry } from "./authorize-index.ts";
import { indexOf } from "./anti-entropy.ts";
import { DialPolicy } from "./dial-policy.ts";
import { type LiveParts, liveFactsOf } from "./live-facts.ts";
import { MemberDialer } from "./member-dialer.ts";
import { Reconciler } from "./reconciler.ts";
import { FakeClock, seededRandom, settle } from "./testing/fake-clock.ts";
import { FakeMachines, hcError } from "./testing/fake-machines.ts";
import { fallbacks } from "@doriface/mesh";
import { hostIdFor } from "./testing/hc-mesh.ts";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet, type NetHost } from "./testing/mesh-net.ts";

const noLines = { lines: () => [], status: new Map() };
/** A three-member mesh's stored set, signed once for the file: this case reads it, and is not about signing it (#780). */
const STORED = meshOf([peer("a"), peer("b"), peer("c")]).records;
const coreMember = (name: string): MemberEntry => ({
  signPub: `sign-${name}`,
  hostId: hostIdFor(name),
  noisePub: `noise-${name}`,
  devicePub: undefined,
  name,
  hcId: `core-${name}`,
});
const partsOf = (host: NetHost, open: readonly string[] = []): LiveParts => ({
  policy: host.policy,
  gossip: host.gossip,
  reconciler: noLines,
  openFrom: (noisePub) => open.includes(noisePub),
});

function pair(): { clock: FakeClock; mesh: MeshNet; a: NetHost; b: NetHost } {
  const clock = new FakeClock();
  const mesh = new MeshNet(clock, seededRandom(11));
  const members = [peer("a"), peer("b")];
  const { records } = meshOf(members);
  const [a, b] = members.map((member) => mesh.add(member, records));
  if (a === undefined || b === undefined) throw new Error("no hosts");
  return { clock, mesh, a, b };
}

describe("a member's presence in status (section 8.6: an authenticated session from it is open now)", () => {
  test("is shown while its session is open, and not after it went offline and answered 4404", async () => {
    const { clock, mesh, a, b } = pair();
    await b.gossip.sync(a.member, "push");
    await settle();
    expect(liveFactsOf(partsOf(a), clock).peers.get(b.member.signPub)?.presence).toBe(true);
    mesh.offline("b");
    a.write("ack");
    // A member that was reached is reconnecting for 5 s (#2448): its refusals show once the dial at 5 s failed too.
    await clock.advance(6_000);
    const facts = liveFactsOf(partsOf(a), clock).peers.get(b.member.signPub);
    expect(facts?.gate?.refusals).toBe(1);
    expect(facts?.presence).toBe(false);
  });
});

describe("presence through an hc line (section 8.2: any authenticated session from the member)", () => {
  test("a member with no sync session but an open hc line reads as present", () => {
    const { clock, a, b } = pair();
    expect(liveFactsOf(partsOf(a), clock).peers.get(b.member.signPub)?.presence).toBe(false);
    const facts = liveFactsOf(partsOf(a, [b.member.noisePub]), clock);
    expect(facts.peers.get(b.member.signPub)?.presence).toBe(true);
  });
});

describe("the gate in status (section 8.2)", () => {
  test("a 4429 is not shown as an offline member: the budget's halving names it", () => {
    const { clock, a, b } = pair();
    a.policy.report(b.member.signPub, 4429);
    const facts = liveFactsOf(partsOf(a), clock);
    expect(facts.peers.get(b.member.signPub)?.gate).toBeNull();
    expect(facts.budget.halvedUntil).toBeInstanceOf(Date);
  });

  test("a member that refuses one dial after it was reached is reconnecting: not shown as offline (#2448)", () => {
    const { clock, a, b } = pair();
    a.policy.report(b.member.signPub, "connected");
    a.policy.report(b.member.signPub, 4404);
    const facts = liveFactsOf(partsOf(a), clock);
    expect(facts.peers.get(b.member.signPub)?.gate).toBeNull();
  });
});

describe("the counters and the revoke hint in status (sections 8.6 and 10.1)", () => {
  test("peerCounter counts no claim on a counter this host already holds (a hello that claims what it signed)", async () => {
    const { clock, a, b } = pair();
    const own = a
      .records()
      .map(parseRecord)
      .filter((body) => body?.by === a.member.signPub);
    const highest = Math.max(...own.map((body) => body?.n ?? 0));
    expect(highest).toBeGreaterThan(0);
    await b.gossip.sync(a.member, "push");
    await settle();
    expect(liveFactsOf(partsOf(a), clock).peerCounter).toBe(0);
  });

  test("a sync dial a member refused with 4401 marks this host possibly revoked, until a dial to it connects", async () => {
    const clock = new FakeClock();
    const policy = new DialPolicy({ clock, random: seededRandom(2), onDue: () => undefined });
    const answers = [new SecureLinkError(4401, "revoked mesh member")];
    const dialer = new MemberDialer({
      policy,
      dial: () => {
        const answer = answers.shift();
        return answer === undefined ? Promise.resolve(memoryLinkPair()[0]) : Promise.reject(answer);
      },
      flushOpen: () => false,
      attach: () => undefined,
      revoked: () => false,
      log: () => undefined,
    });
    const m = peer("m");
    expect(await dialer.sync(m, "push")).toBe(false);
    expect(dialer.refusedAsRevoked).toBe(1);
    await clock.advance(30_000);
    expect(await dialer.sync(m, "probe")).toBe(true);
    expect(dialer.refusedAsRevoked).toBe(0);
  });

  test("a join-race 4401 clears once the member dials in (section 5.4: it had not merged this host's admission)", async () => {
    const { clock, mesh, a, b } = pair();
    mesh.refuse("a", 4401);
    await b.gossip.sync(a.member, "push");
    await settle();
    expect(b.gossip.possiblyRevoked).toBe(true);
    mesh.accept("a");
    await a.gossip.sync(b.member, "push");
    await clock.advance(1);
    expect(b.gossip.possiblyRevoked).toBe(false);
  });

  test("a 4401 clears when a sync goes over a session the member already holds open", async () => {
    const clock = new FakeClock();
    const policy = new DialPolicy({ clock, random: seededRandom(6), onDue: () => undefined });
    // Each sync asks twice (before and after taking a token) while no session is open.
    const open = [false, false, true];
    const dialer = new MemberDialer({
      policy,
      dial: () => Promise.reject(new SecureLinkError(4401, "revoked mesh member")),
      flushOpen: () => open.shift() ?? true,
      attach: () => undefined,
      revoked: () => false,
      log: () => undefined,
    });
    const m = peer("m");
    expect(await dialer.sync(m, "push")).toBe(false);
    expect(dialer.refusedAsRevoked).toBe(1);
    expect(await dialer.sync(m, "push")).toBe(true);
    expect(dialer.refusedAsRevoked).toBe(0);
  });
});

describe("a member's line in status (section 8.1)", () => {
  test("a machine the reconcile just added reads as herdr lists it after the add, not absent", async () => {
    const clock = new FakeClock();
    const [self, b] = [coreMember("self"), coreMember("b")];
    const options = { program: "/opt/doriface-host", stateDir: "/state", selfHostId: self.hostId };
    const reconciler = new Reconciler({ machines: new FakeMachines(clock), ...options, clock, log: () => undefined });
    const view = { members: [self, b], revoked: [] };
    await reconciler.reconcile(view);
    const policy = new DialPolicy({ clock, random: seededRandom(4), onDue: () => undefined });
    const gossip = {
      view,
      self: self.signPub,
      lastSync: () => undefined,
      owedCount: () => 0,
      session: () => undefined,
      peerCounter: 0,
      possiblyRevoked: false,
    };
    const facts = liveFactsOf({ policy, gossip, reconciler, openFrom: () => false }, clock);
    expect(facts.lines.get(b.signPub)?.state).toBe("connected");
  });

  test("a line that replaced an earlier entry for the member's core says which, and how it had been added", async () => {
    const clock = new FakeClock();
    const [self, b] = [coreMember("self"), coreMember("b")];
    const machines = new FakeMachines(clock);
    machines.seed({ name: "b", target: "box", via: false });
    machines.failAdds.set("b", [hcError("name_taken")]);
    machines.failAdds.set(fallbacks("b", b.hostId)[0] ?? "", [hcError("already_added")]);
    const options = { program: "/opt/doriface-host", stateDir: "/state", selfHostId: self.hostId };
    const reconciler = new Reconciler({ machines, ...options, clock, log: () => undefined });
    const view = { members: [self, b], overCap: [], revoked: [] };
    await reconciler.reconcile(view);
    const policy = new DialPolicy({ clock, random: seededRandom(4), onDue: () => undefined });
    const gossip = {
      view,
      self: self.signPub,
      lastSync: () => undefined,
      owedCount: () => 0,
      session: () => undefined,
      peerCounter: 0,
      possiblyRevoked: false,
    };
    const facts = liveFactsOf({ policy, gossip, reconciler, openFrom: () => false }, clock);
    expect(facts.lines.get(b.signPub)?.replaced).toEqual({ name: "b", kind: "ssh" });
    expect((await machines.list()).map((machine) => machine.name)).toEqual(["b"]);
  });
});

describe("the owed count's cost (status runs on the host's event loop)", () => {
  test("a stored set is hashed and parsed once, however many peers and status calls read it", () => {
    expect(indexOf(STORED)).toBe(indexOf(STORED));
    expect(indexOf([...STORED])).not.toBe(indexOf(STORED));
  });
});

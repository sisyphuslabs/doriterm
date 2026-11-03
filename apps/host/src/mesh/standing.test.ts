import { describe, expect, test } from "bun:test";
import { leaveMesh } from "./leave.ts";
import { READ_ONLY_GRACE_MS, SelfStanding } from "./role.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { hashOf, parseRecord, type Signed } from "@doriface/mesh";
import { meshOf, peer } from "./testing/mesh-peers.ts";
import { MeshNet } from "./testing/mesh-net.ts";
import type { MeshView } from "./mesh-view.ts";

const self = peer("b");
const withSelf: MeshView = { members: [peer("a"), self], overCap: [], revoked: [] };
const without: MeshView = { members: [peer("a")], overCap: [], revoked: [self.signPub] };

describe("a host revoked in its own view (S-7)", () => {
  test("goes read-only on the grace timer, never ejecting on one record, and resumes when the view has it again", async () => {
    const clock = new FakeClock();
    let ejected = 0;
    const standing = new SelfStanding({ self: self.signPub, clock, onEject: () => (ejected += 1) });
    expect(standing.update(without)).toEqual({ kind: "read-only", until: READ_ONLY_GRACE_MS });
    expect(standing.canSign).toBe(false);
    await clock.advance(READ_ONLY_GRACE_MS - 1);
    expect(ejected).toBe(0);
    expect(standing.update(withSelf).kind).toBe("member");
    await clock.advance(READ_ONLY_GRACE_MS);
    expect(ejected).toBe(0);
    expect(standing.canSign).toBe(true);
  });

  test("past the 12-member cap it is read-only too: an over-cap host signs nothing (section 6.4)", () => {
    const standing = new SelfStanding({ self: self.signPub, clock: new FakeClock(), onEject: () => undefined });
    const overCap: MeshView = { members: [peer("a")], overCap: [self], revoked: [] };
    expect(standing.update(overCap).kind).toBe("read-only");
    expect(standing.canSign).toBe(false);
  });

  test("is ejected only once the grace ran out with the view still revoking it", async () => {
    const clock = new FakeClock();
    let ejected = 0;
    const standing = new SelfStanding({ self: self.signPub, clock, onEject: () => (ejected += 1) });
    standing.update(without);
    standing.update(without);
    await clock.advance(READ_ONLY_GRACE_MS);
    expect(ejected).toBe(1);
    expect(standing.update(withSelf).kind).toBe("ejected");
  });
});

describe("mesh leave (S-8)", () => {
  test("signs and pushes a self-revoke, and deletes the state only after another member holds it", async () => {
    const clock = new FakeClock();
    const net = new MeshNet(clock, seededRandom(11));
    const members = ["a", "b"].map(peer);
    const { records } = meshOf(members);
    for (const entry of members) net.add(entry, records);
    const leaving = net.host("b");
    const staying = net.host("a");
    let heldAtRemoval: boolean | undefined;
    const isSelfRevoke = (record: Signed): boolean => {
      const body = parseRecord(record);
      const subject = body?.type === "revoke" ? body.subject : undefined;
      return subject !== undefined && "signPubs" in subject && subject.signPubs.includes(self.signPub);
    };
    const outcome = leaveMesh({
      gossip: leaving.gossip,
      self: self.signPub,
      clock,
      removeState: () => (heldAtRemoval ??= staying.records().some(isSelfRevoke)),
    });
    await clock.advance(10_000);
    expect(await outcome).toBe("acked");
    expect(heldAtRemoval).toBe(true);
    const revoke = leaving.records().find(isSelfRevoke);
    expect(staying.records().map(hashOf)).toContain(revoke === undefined ? "" : hashOf(revoke));
    expect(staying.names()).toEqual(["a"]);
  });
});

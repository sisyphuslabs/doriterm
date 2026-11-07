import { describe, expect, test } from "bun:test";
import { READ_ONLY_GRACE_MS, SelfStanding } from "./role.ts";
import { FakeClock } from "./testing/fake-clock.ts";
import { peer } from "./testing/mesh-peers.ts";
import type { MeshView } from "./mesh-view.ts";

const self = peer("b");
const withSelf: MeshView = { members: [peer("a"), self], revoked: [] };
const without: MeshView = { members: [peer("a")], revoked: [self.signPub] };

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

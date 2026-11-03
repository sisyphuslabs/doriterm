import { describe, expect, test } from "bun:test";
import type { ByteLink } from "@doriface/crypto";
import { DialPolicy } from "./dial-policy.ts";
import { MeshLines } from "./mesh-lines.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { hostIdFor } from "./testing/hc-mesh.ts";
import type { MeshMember, MeshView } from "./upstream.ts";

const member = (name: string): MeshMember => ({
  signPub: `sign-${name}`,
  hostId: hostIdFor(name),
  noisePub: `noise-${name}`,
  name,
  hcId: `hc-${name}`,
});
const [a, b, m] = [member("a"), member("b"), member("m")];

function closingLink(): ByteLink & { readonly closes: { code?: number; reason?: string }[] } {
  const closes: { code?: number; reason?: string }[] = [];
  return {
    closes,
    send: () => undefined,
    onData: () => () => undefined,
    onClose: () => () => undefined,
    close: (code, reason) =>
      void closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }),
  };
}

function lines(view: MeshView, dial: (member: MeshMember) => Promise<ByteLink>) {
  const policy = new DialPolicy({ clock: new FakeClock(), random: seededRandom(3), onDue: () => undefined });
  return { policy, lines: new MeshLines({ view: () => view, policy, dial, waitMs: 10 }) };
}

describe("line grants (section 7.2)", () => {
  test("a member past the 12-member cap gets no line: 4401 with the cap as the reason, and no dial", async () => {
    const dialed: string[] = [];
    const view: MeshView = { members: [a], overCap: [m], revoked: [] };
    const { lines: grants } = lines(view, (target) => {
      dialed.push(target.name);
      return Promise.resolve(closingLink());
    });
    expect(await grants.grant(m.hostId)).toEqual({
      ok: false,
      code: 4401,
      reason: `host ${m.hostId} is past the mesh's 12-member cap`,
    });
    expect(dialed).toEqual([]);
  });

  test("a rate-limited member is named as such, with its next try", async () => {
    const { policy, lines: grants } = lines({ members: [a, b], overCap: [], revoked: [] }, () =>
      Promise.resolve(closingLink()),
    );
    policy.report(b.signPub, 4429);
    expect(await grants.grant(b.hostId)).toEqual({
      ok: false,
      code: 4429,
      reason: "b: the relay is rate limiting this host (4429); next try in 30 s",
    });
  });

  test("a line dial that fails without a close code gates the member", async () => {
    const { policy, lines: grants } = lines({ members: [a, b], overCap: [], revoked: [] }, () =>
      Promise.reject(new Error("the dial timed out")),
    );
    expect((await grants.grant(b.hostId)).ok).toBe(false);
    expect(policy.gate(b.signPub)?.misses).toBe(1);
  });

  test("closing lines says why: revoked, or past the cap", async () => {
    const [toB, toM] = [closingLink(), closingLink()];
    const links = new Map([
      [b.hostId, toB],
      [m.hostId, toM],
    ]);
    const { lines: grants } = lines({ members: [a, b, m], overCap: [], revoked: [] }, (target) =>
      Promise.resolve(links.get(target.hostId) ?? closingLink()),
    );
    await grants.grant(b.hostId);
    await grants.grant(m.hostId);
    grants.closeRevoked({ members: [a], overCap: [m], revoked: [b.signPub] });
    expect(toB.closes).toEqual([{ code: 4401, reason: "revoked from the mesh" }]);
    expect(toM.closes).toEqual([{ code: 4401, reason: "past the mesh's 12-member cap" }]);
  });
});

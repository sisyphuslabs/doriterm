import { describe, expect, test } from "bun:test";
import type { ByteLink } from "@doriface/crypto";
import { RelayCloseError } from "@doriface/relay-client";
import { DialPolicy } from "./dial-policy.ts";
import { LineGrants } from "./line-grants.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { hostIdFor } from "./testing/hc-mesh.ts";
import type { MemberEntry } from "./authorize-index.ts";
import type { MeshView } from "./mesh-view.ts";
import { NoUplinkError } from "./no-uplink.ts";

const member = (name: string): MemberEntry => ({
  signPub: `sign-${name}`,
  hostId: hostIdFor(name),
  noisePub: `noise-${name}`,
  devicePub: undefined,
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

function lines(view: MeshView, dial: (member: MemberEntry) => Promise<ByteLink>) {
  const policy = new DialPolicy({ clock: new FakeClock(), random: seededRandom(3), onDue: () => undefined });
  return { policy, lines: new LineGrants({ view: () => view, policy, dial, waitMs: 10 }) };
}

describe("line grants (section 7.2)", () => {
  test("a host that is not a member gets no line: 4401, and no dial", async () => {
    const dialed: string[] = [];
    const view: MeshView = { members: [a], revoked: [] };
    const { lines: grants } = lines(view, (target) => {
      dialed.push(target.name);
      return Promise.resolve(closingLink());
    });
    expect(await grants.grant(m.hostId)).toEqual({ ok: false, code: 4401, reason: "not a member of this mesh" });
    expect(dialed).toEqual([]);
  });

  test("a rate-limited member is named as such, with its next try", async () => {
    const { policy, lines: grants } = lines({ members: [a, b], revoked: [] }, () => Promise.resolve(closingLink()));
    policy.report(b.signPub, 4429);
    expect(await grants.grant(b.hostId)).toEqual({
      ok: false,
      code: 4429,
      reason: "b: the relay is rate limiting this host (4429); next try in 30 s",
    });
  });

  test("a member that was reached and refuses one dial is named as reconnecting, not offline (#2448)", async () => {
    const { policy, lines: grants } = lines({ members: [a, b], revoked: [] }, () => Promise.resolve(closingLink()));
    policy.report(b.signPub, "connected");
    policy.report(b.signPub, 4404);
    expect(await grants.grant(b.hostId)).toEqual({
      ok: false,
      code: 4404,
      reason: "b is reconnecting; next try in 2 s",
    });
  });

  test("a line dial refused for its pass (4412) gates nothing, unlike an offline member (4404)", async () => {
    const refusedFor = (code: number) =>
      lines({ members: [a, b], revoked: [] }, () => Promise.reject(new RelayCloseError(code, "closed")));
    const pass = refusedFor(4412);
    expect(await pass.lines.grant(b.hostId)).toMatchObject({ ok: false, code: 4412 });
    expect(pass.policy.gate(b.signPub)).toBeUndefined();
    const offline = refusedFor(4404);
    await offline.lines.grant(b.hostId);
    expect(offline.policy.gate(b.signPub)?.misses).toBe(1);
  });

  test("a line dial that fails without a close code gates the member", async () => {
    const { policy, lines: grants } = lines({ members: [a, b], revoked: [] }, () =>
      Promise.reject(new Error("the dial timed out")),
    );
    expect((await grants.grant(b.hostId)).ok).toBe(false);
    expect(policy.gate(b.signPub)?.misses).toBe(1);
  });

  test("closing lines closes a revoked member's only, and says why", async () => {
    const [toB, toM] = [closingLink(), closingLink()];
    const links = new Map([
      [b.hostId, toB],
      [m.hostId, toM],
    ]);
    const { lines: grants } = lines({ members: [a, b, m], revoked: [] }, (target) =>
      Promise.resolve(links.get(target.hostId) ?? closingLink()),
    );
    await grants.grant(b.hostId);
    await grants.grant(m.hostId);
    grants.closeRevoked({ members: [a, m], revoked: [b.signPub] });
    expect(toB.closes).toEqual([{ code: 4401, reason: "revoked from the mesh" }]);
    expect(toM.closes).toEqual([]);
  });

  test("a line whose dial finishes after its member was revoked is closed, never handed over (#420)", async () => {
    let view: MeshView = { members: [a, b], revoked: [] };
    const policy = new DialPolicy({ clock: new FakeClock(), random: seededRandom(3), onDue: () => undefined });
    const dialing = Promise.withResolvers<ByteLink>();
    const grants = new LineGrants({ view: () => view, policy, dial: () => dialing.promise, waitMs: 10 });
    const granting = grants.grant(b.hostId);
    await Promise.resolve();
    view = { members: [a], revoked: [b.signPub] };
    grants.closeRevoked(view);
    const late = closingLink();
    dialing.resolve(late);
    expect(await granting).toEqual({ ok: false, code: 4401, reason: "not a member of this mesh" });
    expect(late.closes).toEqual([{ code: 4401, reason: "revoked from the mesh" }]);
  });
});

describe("a host that keeps no relay uplink (L-E5)", () => {
  test("refuses the line 4404 without gating the member or keeping the token", async () => {
    const { policy, lines: grants } = lines({ members: [a, b], revoked: [] }, () =>
      Promise.reject(new NoUplinkError()),
    );
    expect(await grants.grant(b.hostId)).toEqual({ ok: false, code: 4404, reason: new NoUplinkError().message });
    expect(policy.gate(b.signPub)).toBeUndefined();
    const all = await Promise.all(Array.from({ length: 12 }, (_, i) => policy.acquire(`m${i}`, "push", { waitMs: 0 })));
    expect(all.every((grant) => grant.ok)).toBe(true);
  });
});

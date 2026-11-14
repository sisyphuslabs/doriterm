import { describe, expect, test } from "bun:test";
import { CloseCode, SecureLinkError } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { RelayCloseError } from "@doriface/relay-client";
import type { MemberEntry } from "./authorize-index.ts";
import { DialPolicy } from "./dial-policy.ts";
import { MemberDialer } from "./member-dialer.ts";
import { FakeClock, seededRandom } from "./testing/fake-clock.ts";
import { hostIdFor } from "./testing/hc-mesh.ts";
import { peer } from "./testing/mesh-peers.ts";

const m: MemberEntry = {
  signPub: "sign-m",
  hostId: hostIdFor("m"),
  noisePub: "noise-m",
  devicePub: undefined,
  name: "m",
  hcId: "hc-m",
};

function dialerRefusedWith(code: number) {
  const policy = new DialPolicy({ clock: new FakeClock(), random: seededRandom(5), onDue: () => undefined });
  const logs: string[] = [];
  const dialer = new MemberDialer({
    policy,
    dial: () => Promise.reject(new RelayCloseError(code, "closed")),
    flushOpen: () => false,
    attach: () => undefined,
    revoked: () => false,
    log: (line) => void logs.push(line),
  });
  return { policy, dialer, logs };
}

describe("a member that answered a dial (L-E2)", () => {
  test("is not gated as offline when this host fails to attach the session; the session closes 1011", async () => {
    const member = peer("a");
    const policy = new DialPolicy({ clock: new FakeClock(), random: seededRandom(7), onDue: () => undefined });
    const [near] = memoryLinkPair(true);
    const dialer = new MemberDialer({
      policy,
      dial: () => Promise.resolve(near),
      flushOpen: () => false,
      attach: () => {
        throw new Error("the session could not start");
      },
      revoked: () => false,
      log: () => undefined,
    });
    expect(await dialer.sync(member, "push")).toBe(false);
    expect(policy.gate(member.signPub)).toBeUndefined();
    expect(near.closeCode).toBe(1011);
  });
});

const HOUR_MS = 60 * 60 * 1000;

function dialerFailingWith(error: Error, revoked: boolean) {
  const clock = new FakeClock();
  const policy = new DialPolicy({ clock, random: seededRandom(5), onDue: () => undefined });
  const logs: string[] = [];
  let dials = 0;
  const dialer = new MemberDialer({
    policy,
    dial: () => {
      dials += 1;
      return Promise.reject(error);
    },
    flushOpen: () => false,
    attach: () => undefined,
    revoked: () => revoked,
    log: (line) => void logs.push(line),
  });
  return { clock, policy, dialer, logs, dials: () => dials };
}

const handshakeRefused = (code: number = CloseCode.CryptoFailure) =>
  new SecureLinkError(code, "link closed during the handshake");

describe("an owed revoke to a revoked member that answers but refuses the handshake", () => {
  test("backs off from 1 h, doubling to a 6 h cap, and logs once while the refusal lasts", async () => {
    const { clock, policy, dialer, logs } = dialerFailingWith(handshakeRefused(), true);
    const attempts = async (left: number, waits: readonly number[]): Promise<readonly number[]> => {
      if (left === 0) return waits;
      expect(await dialer.sync(m, "revoke-push")).toBe(false);
      const gate = policy.gate(m.signPub);
      expect(gate?.cause).toBe("refused");
      const wait = (gate?.nextAt ?? 0) - clock.now();
      await clock.advance(wait);
      return attempts(left - 1, [...waits, wait]);
    };
    expect(await attempts(5, [])).toEqual([1, 2, 4, 6, 6].map((hours) => hours * HOUR_MS));
    expect(logs.filter((line) => line.includes("undeliverable"))).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  test("a dial asked for while it waits is refused with no dial and no log line", async () => {
    const { dialer, logs, dials } = dialerFailingWith(handshakeRefused(), true);
    await dialer.sync(m, "revoke-push");
    expect(await dialer.sync(m, "revoke-push")).toBe(false);
    expect(await dialer.sync(m, "probe")).toBe(false);
    expect(dials()).toBe(1);
    expect(logs).toHaveLength(1);
  });

  test("is dialed again only when its backoff is due, since a revoked member shows no presence (#2454 review)", async () => {
    const { clock, dialer, dials } = dialerFailingWith(handshakeRefused(), true);
    await dialer.sync(m, "revoke-push");
    await clock.advance(30 * 60_000);
    expect(await dialer.sync(m, "probe")).toBe(false);
    expect(dials()).toBe(1);
    await clock.advance(30 * 60_000);
    await dialer.sync(m, "probe");
    expect(dials()).toBe(2);
  });

  test("its 4401 does not say this host may be revoked; a live member's 4401 still does", async () => {
    const revoked = dialerFailingWith(handshakeRefused(CloseCode.UnknownDevice), true);
    await revoked.dialer.sync(m, "revoke-push");
    expect(revoked.dialer.refusedAsRevoked).toBe(0);
    const live = dialerFailingWith(handshakeRefused(CloseCode.UnknownDevice), false);
    await live.dialer.sync(m, "push");
    expect(live.dialer.refusedAsRevoked).toBe(1);
  });
});

describe("a live member whose handshake drops", () => {
  test("is still gated as offline on the 30 s probe backoff", async () => {
    const { clock, policy, dialer } = dialerFailingWith(handshakeRefused(), false);
    await dialer.sync(m, "push");
    expect(policy.gate(m.signPub)?.cause).toBe("offline");
    expect((policy.gate(m.signPub)?.nextAt ?? 0) - clock.now()).toBe(30_000);
  });
});

describe("a sync dial's close code reaches the dial policy (section 8.2, contract v1.6)", () => {
  test("a 4412 gates nothing; a 4429 gates the member as rate limited; a 4404 as offline", async () => {
    const pass = dialerRefusedWith(4412);
    expect(await pass.dialer.sync(m, "push")).toBe(false);
    expect(pass.policy.gate(m.signPub)).toBeUndefined();
    const limited = dialerRefusedWith(4429);
    await limited.dialer.sync(m, "push");
    expect(limited.policy.gate(m.signPub)?.cause).toBe("rate-limited");
    const offline = dialerRefusedWith(4404);
    await offline.dialer.sync(m, "push");
    expect(offline.policy.gate(m.signPub)?.misses).toBe(1);
  });
});

describe("a live member's 4401 reaches the dial policy as itself (#2517)", () => {
  test("a reached member that refuses this host as revoked is gated offline with no reconnect grace", async () => {
    const { policy, dialer } = dialerRefusedWith(4401);
    policy.report(m.signPub, "connected");
    expect(await dialer.sync(m, "push")).toBe(false);
    expect(policy.gate(m.signPub)).toMatchObject({ cause: "offline", misses: 1 });
  });
});

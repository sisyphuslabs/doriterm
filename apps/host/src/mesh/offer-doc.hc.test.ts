import { HcConnection } from "@doriface/client";
import { MESH_OFFER_DOC } from "@doriface/protocol";
import { expect, test } from "bun:test";
import type { Clock } from "./clock.ts";
import { spawnHcLink } from "./hc-machines.ts";
import { RETRY_MS, serveMeshOffers } from "./offer-doc.ts";
import { createHcSession } from "../testing/hc-session.ts";
import { FakeClock } from "./testing/fake-clock.ts";

import { client, field, noJoins } from "../testing/offer-doc-client.ts";

type Join = { name: string; hostId: string; expiresAt: number };

/** Joins the test admits by hand, through the listener the service registers. */
function joins() {
  const listeners = new Set<(join: Join) => void>();
  return {
    onAdmitted: (listener: (join: Join) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    admit: (join: Join) => {
      for (const listener of listeners) listener(join);
    },
  };
}

/**
 * Virtual time for the service: a FakeClock whose timers report when they are set, and a wall clock that runs with it
 * from `start`, plus whatever step the test gives it.
 */
function testTime(start: number) {
  const fake = new FakeClock();
  const set: number[] = [];
  const waiters = new Set<{ ms: number; resolve: () => void }>();
  const clock: Clock = {
    now: () => fake.now(),
    after(ms, run) {
      set.push(ms);
      for (const waiter of waiters) {
        if (waiter.ms !== ms) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
      return fake.after(ms, run);
    },
  };
  let step = 0;
  const time = { clock, wallNow: () => start + fake.now() + step };
  return {
    time,
    /** The wall clock jumps by `ms` (negative: back), as a clock sync can make it. */
    stepWall(ms: number) {
      step += ms;
    },
    fake,
    set,
    /** Resolves once a timer of `ms` is set (now or already). */
    timerSet(ms: number): Promise<void> {
      if (set.includes(ms)) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      waiters.add({ ms, resolve });
      return promise;
    },
  };
}

test("a wall clock stepped back before the offer expires still ends with the link dropped (#834)", async () => {
  const session = createHcSession("dh-offer-clock-step");
  const target = { hc: session.hc, session: session.name, env: session.env };
  const t = testTime(1_800_000_000_000);
  const expiresAt = t.time.wallNow() + 60_000;
  const service = serveMeshOffers(
    target,
    () => {},
    noJoins,
    () => Promise.resolve({ link: "doriface://pair#h=x&m=1", expiresAt }),
    spawnHcLink,
    t.time,
  );
  const app = await client(session);
  try {
    await service.ready;
    await app.request("r1");
    await t.timerSet(60_000);
    // The wall clock steps back 30 s, then the 60 s timer fires: by the wall clock the offer still admits for 30 s.
    t.stepWall(-30_000);
    await t.fake.advance(60_000);
    expect(t.set).toEqual([60_000, 30_000]);
    await t.fake.advance(30_000);
    expect(t.time.wallNow()).toBe(expiresAt);
    expect(await app.until((value) => field(value, "expired") === true)).toEqual({ request: "r1", expired: true });
  } finally {
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 30_000);

test("a join admitted while the line to the core is down is written once it is back (#834)", async () => {
  const session = createHcSession("dh-offer-join-reconnect");
  const target = { hc: session.hc, session: session.name, env: session.env };
  const t = testTime(1_800_000_000_000);
  const expiresAt = t.time.wallNow() + 600_000;
  const admitted = joins();
  const service = serveMeshOffers(
    target,
    () => {},
    admitted.onAdmitted,
    () => Promise.resolve({ link: "doriface://pair#h=x&m=1", expiresAt }),
    spawnHcLink,
    t.time,
  );
  const app = await client(session);
  try {
    await service.ready;
    await app.request("r1");
    await app.until((value) => field(value, "link") !== undefined);
    expect(service.kill()).toHaveLength(1);
    // The reconnect is scheduled once the service has seen its line close.
    await t.timerSet(RETRY_MS);
    admitted.admit({ name: "laptop", hostId: "h2", expiresAt });
    await t.fake.advance(RETRY_MS);
    expect(await app.until((value) => field(value, "joined") !== undefined)).toEqual({
      request: "r1",
      joined: { name: "laptop", hostId: "h2" },
    });
  } finally {
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 30_000);

test("a join on the offer is written back in place of the link, with the machine's name", async () => {
  const session = createHcSession("dh-offer-joined");
  const target = { hc: session.hc, session: session.name, env: session.env };
  const expiresAt = Date.now() + 60_000;
  const listeners = new Set<(join: { name: string; hostId: string; expiresAt: number }) => void>();
  const onAdmitted = (listener: (join: { name: string; hostId: string; expiresAt: number }) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const service = serveMeshOffers(
    target,
    () => {},
    onAdmitted,
    () => Promise.resolve({ link: "doriface://pair#h=x&m=1", expiresAt }),
  );
  const app = await client(session);
  try {
    await service.ready;
    await app.request("r1");
    await app.until((value) => field(value, "link") !== undefined);
    // A join on some other offer (another expiry) is not this request's.
    for (const listener of listeners) listener({ name: "elsewhere", hostId: "h9", expiresAt: 1 });
    for (const listener of listeners) listener({ name: "laptop", hostId: "h2", expiresAt });
    expect(await app.until((value) => field(value, "joined") !== undefined)).toEqual({
      request: "r1",
      joined: { name: "laptop", hostId: "h2" },
    });
  } finally {
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 30_000);

test("a request is answered with one single-use offer, and the link is dropped once it expires", async () => {
  const session = createHcSession("dh-offer");
  const target = { hc: session.hc, session: session.name, env: session.env };
  let opened = 0;
  const service = serveMeshOffers(
    target,
    () => {},
    noJoins,
    () => {
      opened += 1;
      return Promise.resolve({ link: `doriface://pair#h=x&m=1&n=${opened}`, expiresAt: Date.now() + 1_500 });
    },
  );
  const app = await client(session);
  try {
    await service.ready;
    await app.request("first");
    const answered = await app.until((value) => typeof field(value, "link") === "string");
    expect(answered).toEqual({ request: "first", link: "doriface://pair#h=x&m=1&n=1", expiresAt: expect.any(Number) });
    // The host's own write is a doc event too; it must not open a second offer for the same request.
    const expired = await app.until((value) => field(value, "expired") === true);
    expect(expired).toEqual({ request: "first", expired: true });
    expect(opened).toBe(1);

    await app.request("second");
    const second = await app.until(
      (value) => field(value, "request") === "second" && field(value, "link") !== undefined,
    );
    expect(field(second, "link")).toBe("doriface://pair#h=x&m=1&n=2");
  } finally {
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 30_000);

test("an offer the host cannot open is answered with why", async () => {
  const session = createHcSession("dh-offer-fail");
  const target = { hc: session.hc, session: session.name, env: session.env };
  const service = serveMeshOffers(
    target,
    () => {},
    noJoins,
    () => Promise.reject(new Error("the mesh is full")),
  );
  const app = await client(session);
  try {
    await service.ready;
    await app.request("n1");
    expect(await app.until((value) => field(value, "error") !== undefined)).toEqual({
      request: "n1",
      error: "the mesh is full",
    });
  } finally {
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 30_000);

test("a link that expired while no service ran is dropped when the service starts", async () => {
  const session = createHcSession("dh-offer-stale");
  const target = { hc: session.hc, session: session.name, env: session.env };
  const app = await client(session);
  const { version } = await (async () => {
    const link = spawnHcLink(target);
    const core = await HcConnection.open(link);
    try {
      return await core.call("doc.get", { name: MESH_OFFER_DOC });
    } finally {
      core.close();
      link.close();
    }
  })();
  const seed = spawnHcLink(target);
  const seedCore = await HcConnection.open(seed);
  await seedCore.call("doc.set", {
    name: MESH_OFFER_DOC,
    value: { request: "old", link: "doriface://pair#h=x&m=1", expiresAt: Date.now() - 1_000 },
    version,
  });
  seedCore.close();
  seed.close();
  const service = serveMeshOffers(
    target,
    () => {},
    noJoins,
    () => Promise.reject(new Error("no offer here")),
  );
  try {
    await service.ready;
    expect(await app.until((value) => field(value, "expired") === true)).toEqual({ request: "old", expired: true });
  } finally {
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 30_000);

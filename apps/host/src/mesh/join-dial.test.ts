import { buildPairingUrl, createPairingOffer, DEFAULT_RELAY_URL, fingerprintOf, pairingSlotOf } from "@doriface/crypto";
import { OPEN_POLICY } from "@doriface/policy";
import { afterEach, describe, expect, test } from "bun:test";
import { parseTarget } from "../connect/target.ts";
import { LiveSessions } from "../e2ee/sessions.ts";
import { PairingSlots } from "../pairing-slots.ts";
import { DeviceStore } from "../state/devices.ts";
import { PairingStore } from "../state/pairing.ts";
import { failure, ownOf, removeSides, side, type Side } from "../testing/join-harness.ts";
import { HostMesh } from "./host-mesh.ts";
import { joinMesh, type JoinOptions } from "./join-dial.ts";
import type { PendingJoin } from "./pending-joins.ts";

afterEach(removeSides);

const log = (): void => {};
const PENDING: PendingJoin = {
  nonce: "waiting",
  name: "beta",
  noisePub: "noise-beta",
  hostId: "h",
  fingerprint: "f",
  expiresAt: 0,
  kind: "machine",
  code: "123 456",
  joinerConfirmed: false,
};

const inviter = side("inviter");
const linkTo = (mesh: boolean): string =>
  buildPairingUrl({
    webOrigin: "https://doriface.example",
    hostId: inviter.m.identity.hostId,
    noiseStaticPub: inviter.m.identity.noise.publicKey,
    signPub: inviter.m.identity.sign.publicKey,
    linkSecret: createPairingOffer().linkSecret,
    relayUrl: DEFAULT_RELAY_URL,
    mesh,
  });

/** Joins with a socket factory that refuses to connect, so "dialed" means the refusals let the join through. */
function attempt(joiner: Side, target: string, extra: Partial<JoinOptions> = {}) {
  const dials: string[] = [];
  const asked: string[] = [];
  const options: JoinOptions = {
    stateDir: joiner.dir,
    identity: joiner.m.identity,
    target: parseTarget(target),
    fingerprint: undefined,
    ...ownOf(joiner),
    yes: false,
    confirm: async (question) => {
      asked.push(question);
      return false;
    },
    relayUrl: undefined,
    defaultRelayUrl: DEFAULT_RELAY_URL,
    createSocket: (url) => {
      dials.push(url);
      throw new Error("dialed");
    },
    log: () => {},
    ...extra,
  };
  return { outcome: failure(joinMesh(options)), dials, asked };
}

describe("J-2: code comparison replaces the fingerprint question, with an optional extra pin", () => {
  test.each([[false], [true]])(
    "a code without --fingerprint (yes=%p) reaches the slot lookup without asking",
    async (yes) => {
      let lookedUp = false;
      const relay = Bun.serve({
        port: 0,
        fetch() {
          lookedUp = true;
          return new Response(null, { status: 404 });
        },
      });
      try {
        const run = attempt(side("joiner"), "7KQ3 9D2M", { yes, relayUrl: relay.url.toString() });
        expect(await run.outcome).toContain("no host is offering this code");
        expect(lookedUp).toBe(true);
        expect(run.asked).toEqual([]);
        expect(run.dials).toEqual([]);
      } finally {
        await relay.stop(true);
      }
    },
  );

  test("a code with a fingerprint shorter than 4 groups is refused before any dial", async () => {
    const run = attempt(side("joiner"), "7KQ39D2M", { fingerprint: "3FA9", yes: true });
    expect(await run.outcome).toContain("--fingerprint wants at least the first 4 groups");
    expect(run.dials).toEqual([]);
  });

  test("a link dials before asking because its comparison code comes from the authenticated session", async () => {
    const asked = attempt(side("joiner"), linkTo(true));
    expect(await asked.outcome).toBe("dialed");
    expect(asked.asked).toEqual([]);
    expect(asked.dials).toHaveLength(1);
    const yes = attempt(side("joiner"), linkTo(true), { yes: true });
    expect(await yes.outcome).toBe("dialed");
    expect(yes.asked).toEqual([]);
  });

  test.each([false, true])("a supplied fingerprint is checked before dialing with yes=%s", async (yes) => {
    const mismatch = attempt(side("joiner"), linkTo(true), { yes, fingerprint: "FFFF FFFF FFFF FFFF" });
    expect(await mismatch.outcome).toContain("fingerprint");
    expect(mismatch.dials).toEqual([]);
    const matched = attempt(side("joiner"), linkTo(true), {
      yes,
      fingerprint: fingerprintOf(inviter.m.identity.noise.publicKey),
    });
    expect(await matched.outcome).toBe("dialed");
    expect(matched.dials).toHaveLength(1);
  });
});

describe("refusals before dialing", () => {
  test("a device pairing link is refused: it joins nothing", async () => {
    const run = attempt(side("joiner"), linkTo(false), { yes: true });
    expect(await run.outcome).toBe("this link pairs a device: run doriface-host mesh pair on the member");
    expect(run.dials).toEqual([]);
  });

  test("a join refused before dialing keeps the host's own mesh offer", async () => {
    const joiner = side("joiner");
    const offer = new PairingStore(joiner.dir).offer(Date.now(), true);
    let withdrawn = 0;
    const run = attempt(joiner, linkTo(true), { yes: true, name: "t7", offerWithdrawn: () => void withdrawn++ });
    expect(await run.outcome).toBe('"t7" is not a valid mesh name');
    expect(new PairingStore(joiner.dir).read()?.code).toBe(offer.code);
    expect(withdrawn).toBe(0);
  });

  test("a host already in a mesh, and a name herdr would refuse, are refused", async () => {
    const member = side("member");
    member.mesh.found(member.m.identity, ownOf(member));
    const inMesh = attempt(member, linkTo(true), { yes: true });
    expect(await inMesh.outcome).toContain("already: run mesh leave first");
    const badName = attempt(side("joiner"), linkTo(true), { yes: true, name: "t7" });
    expect(await badName.outcome).toBe('"t7" is not a valid mesh name');
    expect([...inMesh.dials, ...badName.dials]).toEqual([]);
  });
});

describe("J-4: a join withdraws the host's own open mesh offer (#1301)", () => {
  test("the offer is withdrawn, the running host is told, and the join dials", async () => {
    const joiner = side("joiner");
    new PairingStore(joiner.dir).offer(Date.now(), true);
    let withdrawn = 0;
    const run = attempt(joiner, linkTo(true), { yes: true, offerWithdrawn: () => void withdrawn++ });
    expect(await run.outcome).toBe("dialed");
    expect(run.dials).toHaveLength(1);
    expect(new PairingStore(joiner.dir).read()).toBeUndefined();
    expect(withdrawn).toBe(1);
  });

  test("the host's own invite is refused before its offer is withdrawn", async () => {
    const joiner = side("joiner");
    const offer = new PairingStore(joiner.dir).offer(Date.now(), true);
    const ownLink = buildPairingUrl({
      webOrigin: "https://doriface.example",
      hostId: joiner.m.identity.hostId,
      noiseStaticPub: joiner.m.identity.noise.publicKey,
      signPub: joiner.m.identity.sign.publicKey,
      linkSecret: offer.linkSecret,
      relayUrl: DEFAULT_RELAY_URL,
      mesh: true,
    });
    const run = attempt(joiner, ownLink, { yes: true });
    expect(await run.outcome).toBe("this invite is this host's own: run mesh join on the machine that joins");
    expect(run.dials).toEqual([]);
    expect(new PairingStore(joiner.dir).read()?.code).toBe(offer.code);
  });

  test("a device pairing offer is left open", async () => {
    const joiner = side("joiner");
    const offer = new PairingStore(joiner.dir).offer(Date.now(), false);
    let withdrawn = 0;
    const run = attempt(joiner, linkTo(true), { yes: true, offerWithdrawn: () => void withdrawn++ });
    expect(await run.outcome).toBe("dialed");
    expect(new PairingStore(joiner.dir).read()?.code).toBe(offer.code);
    expect(withdrawn).toBe(0);
  });

  test("on the running host, the offer's pending joins expire and its relay slot is released", async () => {
    const joiner = side("joiner");
    const released = Promise.withResolvers<string>();
    const registrar = { register: async () => "registered" as const, release: released.resolve };
    const slots = new PairingSlots(new PairingStore(joiner.dir), joiner.m.identity.noise.publicKey, registrar, log);
    const host = new HostMesh({
      stateDir: joiner.dir,
      identity: joiner.m.identity,
      mesh: joiner.mesh,
      slots,
      sessions: new LiveSessions(new DeviceStore(joiner.dir), log, joiner.mesh),
      policy: OPEN_POLICY,
      hc: { hc: "hc" },
      relay: { url: undefined },
      floor: () => undefined,
      log,
    });
    const offer = await host.pair(false);
    const asked = host.pending.ask({ ...PENDING, expiresAt: offer.expiresAt });
    const run = attempt(joiner, linkTo(true), { yes: true, offerWithdrawn: () => host.offerWithdrawn() });
    expect(await run.outcome).toBe("dialed");
    expect(await asked).toBe("expired");
    expect(await released.promise).toBe(pairingSlotOf(offer.code));
    slots.stop();
  });
});

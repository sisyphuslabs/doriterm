import { afterEach, expect, test } from "bun:test";
import { signCard } from "@doriface/mesh";
import { OPEN_POLICY } from "@doriface/policy";
import { LiveSessions } from "../e2ee/sessions.ts";
import { PairingSlots } from "../pairing-slots.ts";
import { PairingStore } from "../state/pairing.ts";
import { cardBody } from "../state/mesh.ts";
import { removeSides, side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { setup, exchange } from "../testing/roster-harness.ts";
import { meshDeps } from "./host-deps.ts";
import { sweepRoster } from "./roster-admits.ts";
afterEach(removeSides);
const log = () => {};

test("starting the host sweeps a roster client unpaired while it was stopped", async () => {
  const { a, c, deps, devices } = setup();
  await (
    await exchange(deps, c)
  ).serving;
  devices.revoke(noiseOf(c.m));
  const slots = new PairingSlots(new PairingStore(a.dir), a.m.identity.noise.publicKey, undefined, log);
  const sessions = new LiveSessions(devices, log, a.mesh);
  const running = meshDeps({
    stateDir: a.dir,
    hc: { hc: "unused" },
    identity: a.m.identity,
    mesh: a.mesh,
    slots,
    sessions,
    policy: OPEN_POLICY,
    relay: { url: undefined },
    log,
  });
  try {
    expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))).toBeUndefined();
    expect(a.mesh.read()?.records).toHaveLength(3);
  } finally {
    slots.stop();
    await running.sync.stop();
  }
});

test("the marker sweeps only the roster admit and preserves a separate invite admission", async () => {
  const { a, c, deps, devices } = setup();
  await (
    await exchange(deps, c)
  ).serving;
  const invited = side("invited");
  const mesh = a.mesh.read()?.meshId ?? "";
  const card = signCard(
    cardBody(
      invited.m.identity,
      {
        name: "invited",
        hcId: "",
        devicePub: noiseOf(invited.m),
      },
      mesh,
      signPubOf(a.m),
      undefined,
      "client",
    ),
    invited.m.identity.sign.secretKey,
  );
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "admit",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { card },
  }));
  devices.revoke(noiseOf(c.m));
  sweepRoster(deps);
  expect(a.mesh.authorizeIndex()?.client(noiseOf(c.m))).toBeUndefined();
  expect(a.mesh.authorizeIndex()?.client(noiseOf(invited.m))).toBeDefined();
});

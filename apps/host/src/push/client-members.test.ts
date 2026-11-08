import { memoryLinkPair } from "@doriface/crypto/testing";
import { signCard } from "@doriface/mesh";
import { DEFAULT_PUSH_PREFS, encodePushLine, parsePushHostLine } from "@doriface/protocol";
import { afterEach, expect, test } from "bun:test";
import { DeviceStore } from "../state/devices.ts";
import { cardBody } from "../state/mesh.ts";
import { createHcSession } from "../testing/hc-session.ts";
import { ownOf, removeSides, side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { startHostPush } from "./host-push.ts";
import { SubscriptionStore } from "./subscriptions.ts";

afterEach(removeSides);
const keys = { endpoint: "https://fcm.googleapis.com/browser", p256dh: "B".repeat(87), auth: "C".repeat(22) };

function joined() {
  const a = side("alpha");
  const c = side("browser");
  a.mesh.found(a.m.identity, ownOf(a));
  const mesh = a.mesh.read()?.meshId ?? "";
  const card = signCard(
    cardBody(
      c.m.identity,
      {
        name: "browser",
        hcId: "",
        devicePub: noiseOf(c.m),
      },
      mesh,
      signPubOf(a.m),
      undefined,
      "client",
    ),
    c.m.identity.sign.secretKey,
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
  return { a, c, mesh, subscriptions: new SubscriptionStore(a.dir) };
}

test.each(["revoke", "orphan"] as const)("an index rebuild prunes a %s client's subscriptions", (mode) => {
  const { a, c, mesh, subscriptions } = joined();
  subscriptions.put(noiseOf(c.m), keys, DEFAULT_PUSH_PREFS);
  a.mesh.sign(a.m.identity, (n, prev) => ({
    v: 2,
    mesh,
    type: "revoke",
    by: signPubOf(a.m),
    n,
    prev,
    subject: { signPubs: [mode === "orphan" ? signPubOf(a.m) : signPubOf(c.m)], reason: "revoke" },
  }));
  expect(subscriptions.list()).toEqual([]);
});

test("an unpaired client registers over a push stream and survives pruning while current", async () => {
  const { a, c, subscriptions } = joined();
  const session = createHcSession("client-push");
  const push = await startHostPush({
    stateDir: a.dir,
    hostId: a.m.identity.hostId,
    devices: new DeviceStore(a.dir),
    mesh: a.mesh,
    hc: { hc: session.hc, session: session.name, env: session.env },
    log() {},
  });
  const [host, client] = memoryLinkPair(true);
  const reply = Promise.withResolvers<ReturnType<typeof parsePushHostLine>>();
  client.onData((bytes) => reply.resolve(parsePushHostLine(new TextDecoder().decode(bytes).trim())));
  try {
    push.serve(host, noiseOf(c.m));
    client.send(
      new TextEncoder().encode(encodePushLine({ t: "subscribe", subscription: keys, prefs: DEFAULT_PUSH_PREFS })),
    );
    expect(await reply.promise).toEqual({ t: "ok" });
    push.prune();
    expect(subscriptions.list().map((entry) => entry.owner)).toEqual([noiseOf(c.m)]);
  } finally {
    client.close();
    await push.stop();
    await session.dispose();
  }
}, 10000);

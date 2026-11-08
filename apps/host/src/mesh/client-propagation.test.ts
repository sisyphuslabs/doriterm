import { afterEach, expect, test } from "bun:test";
import { sessionPeer } from "../e2ee/authorize.ts";
import { DeviceStore } from "../state/devices.ts";
import { beginClient, clearPropagation, roster, twoHosts, welcome } from "../testing/client-propagation-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { resume } from "../testing/roster-resume-harness.ts";
import { settle } from "./testing/fake-clock.ts";

afterEach(clearPropagation);

test.each(["connected", "resumed", "disconnected"] as const)(
  "a committed client admission propagates to the other running host when %s",
  async (mode) => {
    const f = await twoHosts();
    expect(f.syncA.formatReady()).toBe(true);
    const joined = await beginClient(f);
    const { pending } = joined;
    if (mode === "connected") {
      f.host.pending.decide(pending.nonce, true, pending.code);
      joined.lines.send({ t: "confirm" });
      await welcome(joined.lines);
    } else {
      if (mode === "disconnected") {
        joined.lines.send({ t: "confirm" });
        await settle();
      }
      joined.lines.close(1000, "connection dropped");
      await joined.lines.ended;
      if (mode === "resumed") {
        const resumed = await resume(f, pending.nonce);
        expect(resumed.first.t).toBe("reveal");
        f.host.pending.decide(pending.nonce, true, pending.code);
        resumed.client.send({ t: "confirm" });
        await welcome(resumed.client);
      } else {
        const retained = f.host.resumes.get(pending.nonce, noiseOf(f.c.m));
        if (retained === undefined) throw new Error("no retained admission");
        f.host.pending.decide(pending.nonce, true, pending.code);
        await retained.welcome;
      }
    }
    await settle();
    expect(f.a.mesh.authorizeIndex()?.client(noiseOf(f.c.m))?.signPub).toBe(signPubOf(f.c.m));
    expect(f.b.mesh.authorizeIndex()?.client(noiseOf(f.c.m))?.signPub).toBe(signPubOf(f.c.m));
    await f.syncA.stop();
    expect(
      sessionPeer(undefined, f.c.m.identity.noise.publicKey, f.b.mesh.authorizeIndex(), new DeviceStore(f.b.dir)).kind,
    ).toBe("client");
  },
);

test("a paired client's roster admission reaches the other running host", async () => {
  const f = await twoHosts();
  f.devices.add(f.c.m.identity.noise.publicKey, "browser");
  await roster(f);
  await settle();
  expect(f.b.mesh.authorizeIndex()?.client(noiseOf(f.c.m))?.signPub).toBe(signPubOf(f.c.m));
});

test.each(["leave", "unpair", "refresh-sweep"] as const)(
  "a client's %s revocation propagates to the other running host",
  async (mode) => {
    const f = await twoHosts(true);
    const removed = mode === "refresh-sweep" ? f.other : f.c;
    expect(f.b.mesh.authorizeIndex()?.client(noiseOf(removed.m))).toBeDefined();
    if (mode === "leave") await roster(f, f.c, "leave");
    else {
      f.devices.revoke(noiseOf(removed.m));
      if (mode === "unpair") f.host.sweepRoster();
      else await roster(f);
    }
    await settle();
    expect(f.a.mesh.authorizeIndex()?.client(noiseOf(removed.m))).toBeUndefined();
    expect(f.b.mesh.authorizeIndex()?.client(noiseOf(removed.m))).toBeUndefined();
    expect(
      sessionPeer(undefined, removed.m.identity.noise.publicKey, f.b.mesh.authorizeIndex(), new DeviceStore(f.b.dir))
        .kind,
    ).toBe("refused");
  },
);

import { base64urlEncode, generateX25519 } from "@doriface/crypto";
import { afterEach, expect, test } from "bun:test";
import { createHcSession } from "../testing/hc-session.ts";
import { failure, inviteDeps, joinerContext, removeSides, runJoin, side } from "../testing/join-harness.ts";
import { client, field } from "../testing/offer-doc-client.ts";
import { serveMeshOffers } from "./offer-doc.ts";
import { PendingJoins } from "./pending-joins.ts";

afterEach(removeSides);

test("an automatic machine admission completes its real offer document after persisting membership", async () => {
  const session = createHcSession("dh-auto-admission");
  const [a, b] = [side("alpha"), side("beta")];
  const expiresAt = Date.now() + 60_000;
  const pending = new PendingJoins();
  pending.setAuto(expiresAt);
  const admitted: {
    readonly name: string;
    readonly hostId: string;
    readonly expiresAt: number;
    readonly stored: boolean;
  }[] = [];
  const unfollow = pending.onAdmitted((join) => {
    admitted.push({
      name: join.name,
      hostId: join.hostId,
      expiresAt: join.expiresAt,
      stored: a.mesh.authorizeIndex()?.member(base64urlEncode(b.m.identity.noise.publicKey)) !== undefined,
    });
  });
  const service = serveMeshOffers(
    { hc: session.hc, session: session.name, env: session.env },
    () => {},
    (listener) => pending.onAdmitted(listener),
    async () => ({ link: "doriface://pair#h=x&m=1", expiresAt }),
  );
  const app = await client(session);
  try {
    await service.ready;
    await app.request("automatic-machine");
    await app.until((value) => field(value, "link") !== undefined);
    const run = runJoin(inviteDeps(a, pending, expiresAt), joinerContext(b, a), b.m.identity.noise.publicKey);
    await Promise.all([run.invited, run.joined]);
    expect(admitted).toEqual([{ name: "beta", hostId: b.m.identity.hostId, expiresAt, stored: true }]);
    expect(await app.until((value) => field(value, "joined") !== undefined)).toEqual({
      request: "automatic-machine",
      joined: { name: "beta", hostId: b.m.identity.hostId },
    });
    expect(pending.list()).toEqual([]);
    expect(run.inviterEnd.closeCode).toBeUndefined();
  } finally {
    unfollow();
    await app.close();
    await service.stop();
    await session.dispose();
  }
}, 30_000);

test("a refused automatic machine join never announces an admission", async () => {
  const [a, b] = [side("alpha"), side("beta")];
  const expiresAt = Date.now() + 60_000;
  const pending = new PendingJoins();
  pending.setAuto(expiresAt);
  const admitted: string[] = [];
  const unfollow = pending.onAdmitted((join) => {
    admitted.push(join.hostId);
  });
  try {
    const run = runJoin(inviteDeps(a, pending, expiresAt), joinerContext(b, a), generateX25519().publicKey);
    expect(await failure(run.invited)).toBe("the card's Noise key is not the session's");
    expect(admitted).toEqual([]);
  } finally {
    unfollow();
  }
});

import { base64urlEncode } from "@doriface/crypto";
import { memoryLinkPair } from "@doriface/crypto/testing";
import { signCard } from "@doriface/mesh";
import { INVITER_EXPECTS, MeshLines } from "@doriface/mesh/join";
import { afterEach, expect, test } from "bun:test";
import { cardBody } from "../state/mesh.ts";
import { failure, inviteDeps, ownOf, removeSides, side } from "../testing/join-harness.ts";
import { noiseOf, signPubOf } from "../testing/mesh-history.ts";
import { isRejoin } from "./admission.ts";
import { serveJoin } from "./invite.ts";

afterEach(removeSides);

test.each(["inviter", "unclaimed"] as const)(
  "an approved client cannot name an %s device key it did not authenticate",
  async (target) => {
    const a = side("alpha");
    const c = side("browser");
    const other = side("other");
    a.mesh.found(a.m.identity, ownOf(a));
    const before = a.mesh.read();
    const deps = { ...inviteDeps(a), formatReady: () => true };
    const [host, peer] = memoryLinkPair(true);
    const client = new MeshLines(peer, ["offer", "reveal", "records", "done", "refused"]);
    const served = failure(serveJoin(new MeshLines(host, INVITER_EXPECTS), c.m.identity.noise.publicKey, deps));
    try {
      const offer = await client.next();
      if (offer.t !== "offer") throw new Error("no offer");
      client.send({
        t: "card",
        ...signCard(
          cardBody(
            c.m.identity,
            {
              name: "browser",
              hcId: "",
              devicePub: noiseOf(target === "inviter" ? a.m : other.m),
            },
            offer.mesh,
            offer.inviter,
            offer.nonce,
            "client",
          ),
          c.m.identity.sign.secretKey,
        ),
        sas: base64urlEncode(new Uint8Array(32).fill(17)),
      });
      const first = await client.next();
      if (first.t === "reveal") {
        const pending = await deps.pending.next();
        deps.pending.decide(pending.nonce, true, pending.code);
        client.send({ t: "confirm" });
      }
      expect(await served).toContain("the client's device key is not the session's");
      expect(a.mesh.read()).toEqual(before);
      expect(a.mesh.authorizeIndex()?.member(noiseOf(a.m))?.signPub).toBe(signPubOf(a.m));
      expect(a.mesh.authorizeIndex()?.deviceRefusal(noiseOf(a.m))).toBeUndefined();
    } finally {
      deps.pending.expireAll();
      deps.resumes.clear();
      client.close(1000, "test complete");
      host.close();
    }
  },
);

test.each([{ refresh: false }, { refresh: true }])(
  "every card key is checked before accepting a machine refresh=$refresh",
  ({ refresh }) => {
    const a = side("alpha");
    const c = side("beta");
    a.mesh.found(a.m.identity, ownOf(a));
    const mesh = a.mesh.read()?.meshId ?? "";
    const body = cardBody(c.m.identity, ownOf(c), mesh, signPubOf(a.m));
    if (refresh)
      a.mesh.sign(a.m.identity, (n, prev) => ({
        v: 2,
        mesh,
        by: signPubOf(a.m),
        type: "admit",
        n,
        prev,
        subject: { card: signCard(body, c.m.identity.sign.secretKey) },
      }));
    expect(() =>
      isRejoin(
        a.mesh.authorizeIndex(),
        {
          ...body,
          devicePub: noiseOf(a.m),
        },
        a.mesh.read()?.records ?? [],
      ),
    ).toThrow("this Noise key is another mesh member's");
  },
);

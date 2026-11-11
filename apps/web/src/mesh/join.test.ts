import { generateEd25519, generateX25519, hostIdOf, rawStaticKey } from "@doriface/crypto";
import { DEVICE_LINK_REFUSAL, JoinRefused } from "@doriface/mesh/join";
import { CloseCode } from "@doriface/relay-client";
import { describe, expect, test } from "bun:test";
import { offerFrom, type PairingOffer } from "../pair/fragment.ts";
import { memoryStore } from "../storage/idb.ts";
import { DeviceCodeOffer, dialRefusalOf, type JoinDeps, joinMesh, refuseEarly } from "./join.ts";
import { MembershipStore } from "./membership.ts";

/** An offer of the given target, parsed as the pair route parses one (hostId bound to the signing key). */
function offerOf(target: "device" | "mesh", secret: Parameters<typeof offerFrom>[1]): PairingOffer {
  const sign = generateEd25519();
  const parsed = offerFrom(
    { hostId: hostIdOf(sign.publicKey), noiseStaticPub: generateX25519().publicKey, signPub: sign.publicKey },
    secret,
    { relayUrl: "wss://relay.example", target },
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.offer;
}

const linkOffer = (target: "device" | "mesh"): PairingOffer =>
  offerOf(target, { mode: "link", linkSecret: new Uint8Array(32).fill(1) });

/** A handshake failure as the relay client reports a host's close. */
const closed = (code: number): Error => Object.assign(new Error(`closed ${code}`), { code });

function deps(loaded: string[]): JoinDeps {
  return {
    loadDeviceKey: async () => {
      loaded.push("device key");
      return rawStaticKey(generateX25519());
    },
    loadSignKey: async () => {
      loaded.push("sign key");
      return generateEd25519();
    },
    membership: new MembershipStore(memoryStore()),
  };
}

describe("what a browser may join (#1386, the shared guard)", () => {
  test("a device pairing link cannot start a join: refused in the host's words, and nothing is dialed or loaded", async () => {
    const loaded: string[] = [];
    const outcome = await joinMesh(linkOffer("device"), "Chrome on macOS", deps(loaded)).then(
      () => "joined",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).toBe(DEVICE_LINK_REFUSAL);
    expect(loaded).toEqual([]);
  });

  test("a typed code the host refuses with 4401 (a device pairing offer, or any refusal from an older host) pairs this browser as a device, with the same code", () => {
    const typed = offerOf("mesh", { mode: "code", code: "7K3M9QXR" });
    const refusal = dialRefusalOf(typed, closed(CloseCode.UnknownDevice));
    expect(refusal).toBeInstanceOf(DeviceCodeOffer);
    const device = refusal instanceof DeviceCodeOffer ? refusal.offer : undefined;
    expect(device?.target).toBe("device");
    expect(device?.secret).toEqual(typed.secret);
    expect(device?.hostId).toBe(typed.hostId);
  });

  test("a link the host refuses stays refused, and a typed code's other refusals keep their words", () => {
    expect(dialRefusalOf(linkOffer("mesh"), closed(CloseCode.UnknownDevice))).toBeInstanceOf(JoinRefused);
    const wrong = dialRefusalOf(offerOf("mesh", { mode: "code", code: "7K3M9QXR" }), closed(CloseCode.CryptoFailure));
    expect(wrong).toBeInstanceOf(JoinRefused);
    expect(wrong?.message).toBe("The code doesn't match this host. Check it and try again.");
  });

  test("a typed code the host refuses on a mesh offer (used, expired, replaced) keeps the mesh join's words (#1492)", () => {
    const refusal = dialRefusalOf(
      offerOf("mesh", { mode: "code", code: "7K3M9QXR" }),
      closed(CloseCode.MeshCodeRefused),
    );
    expect(refusal).toBeInstanceOf(JoinRefused);
    expect(refusal?.message).toBe(
      "The host refused this invite: it was used already or replaced. Run doriface-host mesh pair again.",
    );
  });

  test("a mesh invite passes the early refusals when this browser is in no mesh yet", async () => {
    await expect(refuseEarly(linkOffer("mesh"), new MembershipStore(memoryStore()))).resolves.toBeDefined();
  });

  test("a browser that is a member already is refused before anything is dialed", async () => {
    const membership = new MembershipStore(memoryStore());
    await membership.adopt({
      meshId: "mesh-1",
      records: [],
      signPub: "x",
      inviter: { hostId: "h", hostKey: "k" },
      relayUrl: "wss://relay.example",
      joinedAt: "2026-11-08T00:00:00.000Z",
    });
    await expect(refuseEarly(linkOffer("mesh"), membership)).rejects.toThrow("this browser is in mesh mesh-1 already");
  });
});

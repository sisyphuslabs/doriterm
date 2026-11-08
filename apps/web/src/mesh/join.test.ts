import { generateEd25519, generateX25519, hostIdOf, rawStaticKey } from "@doriface/crypto";
import { DEVICE_LINK_REFUSAL } from "@doriface/mesh/join";
import { describe, expect, test } from "bun:test";
import { offerFrom, type PairingOffer } from "../pair/fragment.ts";
import { memoryStore } from "../storage/idb.ts";
import { type JoinDeps, joinMesh, refuseEarly } from "./join.ts";
import { MembershipStore } from "./membership.ts";

/** A link offer of the given target, parsed as the pair route parses one (hostId bound to the signing key). */
function linkOffer(target: "device" | "mesh"): PairingOffer {
  const sign = generateEd25519();
  const parsed = offerFrom(
    { hostId: hostIdOf(sign.publicKey), noiseStaticPub: generateX25519().publicKey, signPub: sign.publicKey },
    { mode: "link", linkSecret: new Uint8Array(32).fill(1) },
    { relayUrl: "wss://relay.example", target },
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.offer;
}

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

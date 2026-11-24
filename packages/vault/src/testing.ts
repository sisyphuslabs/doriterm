import { base64urlEncode } from "@doriface/crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { RevisionLedger, recipientOf, unseal } from "typevault/core";
import type { DeviceKey, MemberSigner, VaultContext } from "./context.ts";

export const MESH = "mesh-test";
export const NOW = "2026-11-24T00:00:00.000Z";

const isKeyPair = (value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair => "privateKey" in value;

export interface TestDevice {
  readonly signPub: string;
  readonly signer: MemberSigner;
  readonly key: DeviceKey;
  readonly ledger: RevisionLedger;
}

/** A member device: an Ed25519 mesh signing key and a non-extractable WebCrypto X25519 vault key, as a browser holds. */
export async function testDevice(): Promise<TestDevice> {
  const secret = ed25519.utils.randomSecretKey();
  const signPub = base64urlEncode(ed25519.getPublicKey(secret));
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  if (!isKeyPair(pair)) throw new Error("X25519 generateKey returned a single key");
  const { privateKey } = pair;
  return {
    signPub,
    signer: { signPub, sign: async (message) => ed25519.sign(message, secret) },
    key: {
      recipient: await recipientOf(privateKey),
      protection: "non-extractable",
      unseal: (sealed) => unseal([privateKey], sealed),
    },
    ledger: new RevisionLedger(),
  };
}

export const contextOf = (device: TestDevice, members: readonly TestDevice[]): VaultContext => ({
  mesh: MESH,
  members: new Set(members.map((member) => member.signPub)),
  self: device.signer,
  key: device.key,
  ledger: device.ledger,
  now: () => NOW,
});

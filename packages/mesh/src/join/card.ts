import { base64urlEncode, type KeyPair } from "@doriface/crypto";
import type { CardBody, MemberKind } from "../records/types.ts";

/** The card a member puts in its own `found`, `admit` or `rekey`: everything but the mesh, inviter, nonce and keys. */
export type OwnCard = Omit<CardBody, "v" | "mesh" | "inviter" | "nonce" | "hostId" | "signPub" | "noisePub">;

/**
 * Who signs a card: the Ed25519 pair that signs it and the Noise key it attests. A host holds both as raw pairs; a
 * browser holds the Noise half as a key it may not read, so only its public bytes are asked for.
 */
export interface MemberIdentity {
  readonly hostId: string;
  readonly sign: KeyPair;
  readonly noisePub: Uint8Array;
}

const nonce = (): string => base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

export interface CardPlacement {
  /** The meshId, or `"-"` in a found. */
  readonly mesh: string;
  /** The admitting member's signPub, or `"-"` in a found. */
  readonly inviter: string;
  readonly nonce?: string | undefined;
  /** Absent writes a version 1 card, which every released build reads and can only mean a machine. */
  readonly kind?: MemberKind | undefined;
}

export function cardBodyFor(identity: MemberIdentity, card: OwnCard, placement: CardPlacement): CardBody {
  const body = {
    mesh: placement.mesh,
    inviter: placement.inviter,
    nonce: placement.nonce ?? nonce(),
    hostId: identity.hostId,
    signPub: base64urlEncode(identity.sign.publicKey),
    noisePub: base64urlEncode(identity.noisePub),
    ...card,
  };
  return placement.kind === undefined ? { v: 1, ...body } : { v: 2, kind: placement.kind, ...body };
}

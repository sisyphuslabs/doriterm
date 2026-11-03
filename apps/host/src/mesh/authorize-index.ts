import {
  canonicalOrder,
  cardOf,
  type CardBody,
  hashOf,
  parseRecord,
  type Signed,
  verifyCard,
  type View,
} from "@doriface/mesh";

/** A member as the host authorizes it: the keys and herdr core id of its current card, and its mesh name. */
export interface MemberEntry {
  readonly signPub: string;
  readonly hostId: string;
  readonly noisePub: string;
  readonly devicePub: string | undefined;
  readonly name: string;
  readonly hcId: string;
}

/** A member the view removed, with every Noise and device key any of its cards ever named. */
export interface RevokedEntry {
  readonly signPub: string;
  readonly hostId: string;
  readonly keys: readonly string[];
}

/** What `authorize` needs from one generation of `mesh.json`, persisted with it so a handshake never evaluates. */
export interface IndexData {
  readonly generation: number;
  readonly members: readonly MemberEntry[];
  readonly overCap: readonly MemberEntry[];
  readonly revoked: readonly RevokedEntry[];
}

const cardsBySigner = (records: readonly Signed[], eff: ReadonlySet<string> | undefined) => {
  const cards = new Map<string, CardBody[]>();
  for (const record of canonicalOrder(records)) {
    const body = parseRecord(record);
    const signed = body === undefined ? undefined : cardOf(body);
    const card = signed === undefined ? undefined : verifyCard(signed);
    if (card === undefined) continue;
    if (eff !== undefined && !eff.has(hashOf(record))) continue;
    cards.set(card.signPub, [...(cards.get(card.signPub) ?? []), card]);
  }
  return cards;
};

/** Derives the index from the records and their view: current cards for members, every card ever for the revoked. */
export function indexOf(records: readonly Signed[], view: View, generation: number): IndexData {
  const effective = cardsBySigner(records, view.eff);
  const everything = cardsBySigner(records, undefined);
  const entry = (signPub: string): MemberEntry[] => {
    const card = effective.get(signPub)?.at(-1);
    if (card === undefined) return [];
    const noisePub = view.noise.get(signPub) ?? card.noisePub;
    const name = view.name.get(signPub) ?? card.name;
    return [{ signPub, hostId: card.hostId, noisePub, devicePub: card.devicePub, name, hcId: card.hcId }];
  };
  const active = [...view.members].filter((key) => !view.overCap.has(key));
  const revoked = [...view.revoked].flatMap((signPub): RevokedEntry[] => {
    const cards = everything.get(signPub) ?? [];
    const first = cards[0];
    if (first === undefined) return [];
    const keys = cards.flatMap((card) =>
      card.devicePub === undefined ? [card.noisePub] : [card.noisePub, card.devicePub],
    );
    return [{ signPub, hostId: first.hostId, keys: [...new Set(keys)] }];
  });
  return { generation, members: active.flatMap(entry), overCap: [...view.overCap].flatMap(entry), revoked };
}

/** The in-memory lookups over one {@link IndexData}: everything a handshake asks, by base64url key. */
export class AuthorizeIndex {
  readonly generation: number;
  readonly #byNoise = new Map<string, MemberEntry>();
  readonly #overCap = new Set<string>();
  readonly #revoked = new Set<string>();
  readonly #memberDevices = new Set<string>();
  readonly #hcIds = new Set<string>();
  readonly #hostIds = new Set<string>();

  constructor(data: IndexData) {
    this.generation = data.generation;
    for (const member of data.members) {
      this.#byNoise.set(member.noisePub, member);
      if (member.devicePub !== undefined) this.#memberDevices.add(member.devicePub);
    }
    for (const member of data.overCap) {
      this.#overCap.add(member.noisePub);
      if (member.devicePub !== undefined) this.#overCap.add(member.devicePub);
    }
    for (const member of [...data.members, ...data.overCap]) {
      this.#hcIds.add(member.hcId);
      this.#hostIds.add(member.hostId);
    }
    for (const entry of data.revoked) {
      for (const key of entry.keys) this.#revoked.add(key);
      this.#hostIds.add(entry.hostId);
    }
  }

  /** The current, not over-cap member whose Noise key this is. */
  member(key: string): MemberEntry | undefined {
    return this.#byNoise.get(key);
  }

  /** Why a key that is not a current member's Noise key may not be a device, if it may not (section 9.2 step 2). */
  deviceRefusal(key: string): string | undefined {
    if (this.#revoked.has(key)) return "revoked mesh member";
    if (this.#overCap.has(key)) return "over-cap mesh member";
    if (this.#memberDevices.has(key)) return "this key belongs to a mesh member: use the mesh line";
    return undefined;
  }

  /** Whether the key is any member's or revoked member's Noise or device key (no device may hold it). */
  claimsKey(key: string): boolean {
    return this.#byNoise.has(key) || this.deviceRefusal(key) !== undefined;
  }

  isMemberHcId(hcId: string): boolean {
    return this.#hcIds.has(hcId);
  }

  /** Keys and hostIds no paired-device or known-hosts store may keep (sections 4.5 and 6.7). */
  cleanup(): { readonly keys: ReadonlySet<string>; readonly hostIds: ReadonlySet<string> } {
    const keys = new Set([...this.#byNoise.keys(), ...this.#memberDevices, ...this.#overCap, ...this.#revoked]);
    return { keys, hostIds: this.#hostIds };
  }
}

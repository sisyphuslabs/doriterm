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
  /** Every other Noise or device key a current member's cards ever named: refused and cleaned like a revoked key. */
  readonly superseded: readonly string[];
}

const cardOfRecord = (record: Signed): CardBody | undefined => {
  const body = parseRecord(record);
  const signed = body === undefined ? undefined : cardOf(body);
  return signed === undefined ? undefined : verifyCard(signed);
};

const cardsBySigner = (records: readonly Signed[], eff: ReadonlySet<string> | undefined) => {
  const cards = new Map<string, CardBody[]>();
  for (const record of canonicalOrder(records)) {
    const card = cardOfRecord(record);
    if (card === undefined) continue;
    if (eff !== undefined && !eff.has(hashOf(record))) continue;
    cards.set(card.signPub, [...(cards.get(card.signPub) ?? []), card]);
  }
  return cards;
};

const entryOf = (card: CardBody, noisePub: string, name: string): MemberEntry => ({
  signPub: card.signPub,
  hostId: card.hostId,
  noisePub,
  devicePub: card.devicePub,
  name,
  hcId: card.hcId,
});

/**
 * Derives the index from the records and their view. A member's core id, device key and hostId come from its
 * governing admission's card (a later re-admit or rekey card cannot change them), its Noise key and name from the
 * view. Every other key a member's cards ever named is superseded. An over-cap key is refused on every effective
 * card it holds (stricter than its governing card alone), and a revoked key on every card it ever had.
 */
export function indexOf(records: readonly Signed[], view: View, generation: number): IndexData {
  const byHash = new Map(records.map((record) => [hashOf(record), record]));
  const effective = cardsBySigner(records, view.eff);
  const everything = cardsBySigner(records, undefined);
  const member = (signPub: string): MemberEntry[] => {
    const governing = byHash.get(view.governing.get(signPub) ?? "");
    const card = governing === undefined ? undefined : cardOfRecord(governing);
    if (card === undefined) return [];
    return [entryOf(card, view.noise.get(signPub) ?? card.noisePub, view.name.get(signPub) ?? card.name)];
  };
  const overCap = (signPub: string): MemberEntry[] =>
    (effective.get(signPub) ?? []).map((card) => entryOf(card, card.noisePub, card.name));
  const revoked = [...view.revoked].flatMap((signPub): RevokedEntry[] => {
    const cards = everything.get(signPub) ?? [];
    const first = cards[0];
    if (first === undefined) return [];
    const keys = cards.flatMap((card) =>
      card.devicePub === undefined ? [card.noisePub] : [card.noisePub, card.devicePub],
    );
    return [{ signPub, hostId: first.hostId, keys: [...new Set(keys)] }];
  });
  const members = [...view.members].flatMap(member);
  const superseded = members.flatMap(({ signPub, noisePub, devicePub }) =>
    (everything.get(signPub) ?? [])
      .flatMap((card) => (card.devicePub === undefined ? [card.noisePub] : [card.noisePub, card.devicePub]))
      .filter((key) => key !== noisePub && key !== devicePub),
  );
  return {
    generation,
    members,
    overCap: [...view.overCap].flatMap(overCap),
    revoked,
    superseded: [...new Set(superseded)],
  };
}

/** The in-memory lookups over one {@link IndexData}: everything a handshake asks, by base64url key. */
export class AuthorizeIndex {
  readonly generation: number;
  readonly #byNoise = new Map<string, MemberEntry>();
  readonly #overCap = new Set<string>();
  readonly #revoked = new Set<string>();
  readonly #memberDevices = new Set<string>();
  readonly #superseded: ReadonlySet<string>;
  readonly #hcIds = new Set<string>();
  readonly #hostIds = new Set<string>();

  constructor(data: IndexData) {
    this.generation = data.generation;
    this.#superseded = new Set(data.superseded);
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
    if (this.#superseded.has(key)) return "a superseded key of a mesh member";
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
    const keys = new Set([
      ...this.#byNoise.keys(),
      ...this.#memberDevices,
      ...this.#overCap,
      ...this.#revoked,
      ...this.#superseded,
    ]);
    return { keys, hostIds: this.#hostIds };
  }
}

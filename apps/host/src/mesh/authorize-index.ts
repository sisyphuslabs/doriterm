import {
  canonicalOrder,
  cardOf,
  type CardBody,
  hashOf,
  type MemberKind,
  parseRecord,
  type Signed,
  verifyCard,
  type View,
} from "@doriface/mesh";

/** A member as the host authorizes it: the keys and herdr core id of its current card, its kind, and its mesh name. */
export interface MemberEntry {
  readonly signPub: string;
  readonly hostId: string;
  readonly noisePub: string;
  readonly devicePub: string | undefined;
  readonly name: string;
  readonly hcId: string;
  /**
   * What its keys may do. Absent means a machine: an index written before kinds existed, or a fixture, could only ever
   * have been one. A client connects to machines and never dials one (design of #942).
   */
  readonly kind?: MemberKind | undefined;
  /** The governing admission, retained for device limits, removal previews and the roster marker. */
  readonly admitter?: string | undefined;
  readonly admitId?: string | undefined;
  /** This machine's last recorded admitted client session, in epoch milliseconds; never signed or gossiped. */
  readonly lastSessionAt?: number | undefined;
}

/** A member the view removed, with every Noise and device key any of its cards ever named. */
export interface RevokedEntry {
  readonly signPub: string;
  readonly hostId: string;
  readonly keys: readonly string[];
}

/** A signing key and the Noise and device keys its effective cards name: what may contest a key (#90, R2). */
export interface NamingEntry {
  readonly signPub: string;
  readonly keys: readonly string[];
}

/**
 * The admission rules `indexOf` applies, saved with the index. Raise it whenever a change to `indexOf` would authorize
 * less than an earlier build's index: leaving a member out, or listing more keys in `named`, `revoked` or `superseded`
 * so that `member` or `client` refuses one. A saved index under other rules is rebuilt at start (#1483), as the first
 * such change, the client key binding of #1476, needs.
 */
export const INDEX_RULES = 2;

/** What `authorize` needs from one generation of `mesh.json`, persisted with it so a handshake never evaluates. */
export interface IndexData {
  readonly generation: number;
  /** The {@link INDEX_RULES} it was built under. */
  readonly rules: number;
  readonly members: readonly MemberEntry[];
  readonly revoked: readonly RevokedEntry[];
  /** Every other Noise or device key a current member's cards ever named: refused and cleaned like a revoked key. */
  readonly superseded: readonly string[];
  /**
   * For every current and revoked member, the keys its effective cards name. Only these contest a key: a
   * card the view ignores (void under R1, or signed after its signer's revoke) names nothing here.
   */
  readonly named: readonly NamingEntry[];
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

const keysOf = (card: CardBody): string[] =>
  card.devicePub === undefined ? [card.noisePub] : [card.noisePub, card.devicePub];

const entryOf = (card: CardBody, noisePub: string, name: string): MemberEntry => ({
  signPub: card.signPub,
  hostId: card.hostId,
  noisePub,
  devicePub: card.devicePub,
  name,
  hcId: card.hcId,
  kind: card.kind ?? "machine",
});

/**
 * Derives the index from the records and their view. A member's core id, device key and hostId come from its
 * governing admission's card (a later re-admit or rekey card cannot change them), its Noise key and name from the
 * view. Every other key a member's cards ever named is superseded, and a revoked key is refused on every card it ever
 * had. What contests
 * a key (`named`) comes from effective cards only, so a record the view ignores cannot take a member's key away.
 */
export function indexOf(records: readonly Signed[], view: View, generation: number): IndexData {
  const byHash = new Map(records.map((record) => [hashOf(record), record]));
  const effective = cardsBySigner(records, view.eff);
  const everything = cardsBySigner(records, undefined);
  const member = (signPub: string): MemberEntry[] => {
    const governing = byHash.get(view.governing.get(signPub) ?? "");
    const card = governing === undefined ? undefined : cardOfRecord(governing);
    if (card === undefined) return [];
    const admitter = view.admitter.get(signPub);
    if (card.kind === "client") {
      // Design 4.1: a client's session key is its device key. A card naming another key reaches no one, so it is left
      // out of the index instead of failing the whole view (#1473).
      if (card.devicePub !== card.noisePub) return [];
      const author = byHash.get(view.governing.get(admitter ?? "") ?? "");
      const authorCard = author === undefined ? undefined : cardOfRecord(author);
      if (
        admitter === undefined ||
        !view.members.has(admitter) ||
        authorCard === undefined ||
        authorCard.kind === "client"
      )
        return [];
    }
    return [
      {
        ...entryOf(card, view.noise.get(signPub) ?? card.noisePub, view.name.get(signPub) ?? card.name),
        admitter,
        admitId: view.governing.get(signPub),
      },
    ];
  };
  const revoked = [...view.revoked].flatMap((signPub): RevokedEntry[] => {
    const cards = everything.get(signPub) ?? [];
    const first = cards[0];
    if (first === undefined) return [];
    return [{ signPub, hostId: first.hostId, keys: [...new Set(cards.flatMap(keysOf))] }];
  });
  const members = [...view.members].flatMap(member);
  const superseded = members.flatMap(({ signPub, noisePub, devicePub }) =>
    (everything.get(signPub) ?? []).flatMap(keysOf).filter((key) => key !== noisePub && key !== devicePub),
  );
  const named = [...new Set([...view.members, ...view.revoked])].flatMap((signPub): NamingEntry[] => {
    const keys = (effective.get(signPub) ?? []).flatMap(keysOf);
    return keys.length === 0 ? [] : [{ signPub, keys: [...new Set(keys)] }];
  });
  return {
    generation,
    rules: INDEX_RULES,
    members,
    revoked,
    superseded: [...new Set(superseded)],
    named,
  };
}

/** The in-memory lookups over one {@link IndexData}: everything a handshake asks, by base64url key. */
export class AuthorizeIndex {
  readonly generation: number;
  readonly #byNoise = new Map<string, MemberEntry>();
  readonly #revoked = new Set<string>();
  /** The removed members whose cards named each revoked key. */
  readonly #removedBy = new Map<string, Set<string>>();
  readonly #memberDevices = new Set<string>();
  /** A client member's session key, by member. It never enters the Noise map: a client must not dial (design of #942). */
  readonly #clientDevices = new Map<string, MemberEntry>();
  readonly #superseded: ReadonlySet<string>;
  readonly #hcIds = new Set<string>();
  readonly #hostIds = new Set<string>();
  readonly #signPubs = new Set<string>();
  /** The signing keys whose effective cards name each key (current and revoked members). */
  readonly #namedBy = new Map<string, Set<string>>();

  constructor(data: IndexData) {
    this.generation = data.generation;
    this.#superseded = new Set(data.superseded);
    for (const member of data.members) {
      if (member.kind === "client") {
        if (member.devicePub !== undefined) this.#clientDevices.set(member.devicePub, member);
        continue;
      }
      this.#byNoise.set(member.noisePub, member);
      if (member.devicePub !== undefined) this.#memberDevices.add(member.devicePub);
    }
    for (const member of data.members) {
      this.#signPubs.add(member.signPub);
      this.#hcIds.add(member.hcId);
      // A client has no machine to learn as a host, and its paired entry must survive cleanup for push.
      if (member.kind !== "client") this.#hostIds.add(member.hostId);
    }
    for (const entry of data.revoked) {
      for (const key of entry.keys) {
        this.#revoked.add(key);
        this.#removedBy.set(key, (this.#removedBy.get(key) ?? new Set<string>()).add(entry.signPub));
      }
      this.#hostIds.add(entry.hostId);
    }
    const name = (key: string | undefined, signPub: string): void => {
      if (key === undefined) return;
      const by = this.#namedBy.get(key) ?? new Set<string>();
      by.add(signPub);
      this.#namedBy.set(key, by);
    };
    for (const entry of data.members) {
      name(entry.noisePub, entry.signPub);
      name(entry.devicePub, entry.signPub);
    }
    for (const entry of data.named) for (const key of entry.keys) name(key, entry.signPub);
  }

  /**
   * The current member whose Noise key this is, when no other signing key's effective card names it (#90): a key that
   * two members hold, that a revoked member's card named before its revoke, or that is another
   * member's superseded key authorizes nobody. A void card, or one signed after its signer's revoke, contests nothing.
   */
  member(key: string): MemberEntry | undefined {
    const entry = this.#byNoise.get(key);
    return entry === undefined || this.namedByAnother(key, entry.signPub) ? undefined : entry;
  }

  /** Whether an effective card of a signing key other than `signPub` names `key` (a member's, revoked or superseded key). */
  namedByAnother(key: string, signPub: string): boolean {
    return [...(this.#namedBy.get(key) ?? [])].some((by) => by !== signPub);
  }

  /**
   * The current client member whose session key this is. A client is admitted on the hc stream and refused on the mesh
   * stream, so it is found here and never in `member()`, which answers for a member that dials.
   */
  client(key: string): MemberEntry | undefined {
    const entry = this.#clientDevices.get(key);
    return entry === undefined || this.namedByAnother(key, entry.signPub) ? undefined : entry;
  }

  /** Why a key that is not a current member's Noise key may not be a device, if it may not (section 9.2 step 2). */
  deviceRefusal(key: string): string | undefined {
    if (this.#revoked.has(key)) return "revoked mesh member";
    if (this.#memberDevices.has(key)) return "this key belongs to a mesh member: use the mesh line";
    if (this.#superseded.has(key)) return "a superseded key of a mesh member";
    if (this.#byNoise.has(key) && this.member(key) === undefined)
      return "a Noise key that more than one mesh key names";
    return undefined;
  }

  /**
   * Whether `key` is a removed member's (one of `signPub`'s, when given). Such a key opens no session but the roster's,
   * where it reads only the records up to its own removal (design 10.3), so a removed browser can learn it was removed.
   */
  removed(key: string, signPub?: string): boolean {
    const by = this.#removedBy.get(key);
    return by !== undefined && (signPub === undefined || by.has(signPub));
  }

  /** Whether the key is any member's or revoked member's Noise or device key (no device may hold it). */
  claimsKey(key: string): boolean {
    return this.#byNoise.has(key) || this.deviceRefusal(key) !== undefined;
  }

  /** Members in the view: what a plan's `machines` limit counts. */
  get memberCount(): number {
    return this.#signPubs.size;
  }

  /** A plan's machines limit counts only machines, never browsers or phones. */
  get machineCount(): number {
    return this.#byNoise.size;
  }

  clients(): readonly MemberEntry[] {
    return [...this.#clientDevices.values()].filter((entry) => this.client(entry.devicePub ?? "") !== undefined);
  }

  isMember(signPub: string): boolean {
    return this.#signPubs.has(signPub);
  }

  isMemberHcId(hcId: string): boolean {
    return this.#hcIds.has(hcId);
  }

  /** Keys and hostIds no paired-device or known-hosts store may keep (sections 4.5 and 6.7). */
  cleanup(): { readonly keys: ReadonlySet<string>; readonly hostIds: ReadonlySet<string> } {
    const keys = new Set([...this.#byNoise.keys(), ...this.#memberDevices, ...this.#revoked, ...this.#superseded]);
    return { keys, hostIds: this.#hostIds };
  }
}

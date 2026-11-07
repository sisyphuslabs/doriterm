// The record and member-card shapes of contract v1.5 ("Mesh" > "Records").

/** A signed record or member card: the exact body bytes the signer produced, and its signature (base64url). */
export interface Signed {
  readonly body: string;
  readonly sig: string;
}

export const MEMBER_KINDS = ["machine", "client"] as const;
/** What a member's keys may do: a machine dials peers, a client connects to machines. */
export type MemberKind = (typeof MEMBER_KINDS)[number];

export interface CardBody {
  /** 1 is the format every released build reads and can only mean a machine; 2 carries an explicit kind. */
  readonly v: 1 | 2;
  /** Written by 2 and required there; a version 1 card is a machine, because that is all it could ever have meant. */
  readonly kind?: MemberKind | undefined;
  /** The meshId, or "-" only in the founder's own card. */
  readonly mesh: string;
  /** The admitting member's signPub, the member's own signPub in a rekey, or "-" only in the founder's own card. */
  readonly inviter: string;
  readonly nonce: string;
  readonly hostId: string;
  readonly signPub: string;
  readonly noisePub: string;
  readonly devicePub?: string;
  readonly name: string;
  readonly hcId: string;
}

export const RECORD_TYPES = ["found", "admit", "revoke", "name", "rekey", "ack"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const REVOKE_REASONS = ["revoke", "compromised", "leave"] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export interface CardSubject {
  readonly card: Signed;
}
export interface RevokeSubject {
  readonly signPubs: readonly string[];
  readonly reason: RevokeReason;
}
export interface NameSubject {
  readonly signPub: string;
  readonly name: string;
}
export type Subject = CardSubject | RevokeSubject | NameSubject;

export interface RecordBody {
  readonly v: 2;
  /** The meshId, or "-" only in the found record. */
  readonly mesh: string;
  readonly type: RecordType;
  readonly by: string;
  readonly n: number;
  readonly prev: readonly string[];
  readonly subject?: Subject;
  /** Signer time, display only. */
  readonly at?: string;
}

export const MAX_MESH_MEMBERS = 12;
export const MAX_BODY_BYTES = 2048;
export const MAX_PREV = 64;
export const MAX_REVOKE_SUBJECTS = 16;
export const MAX_RECORDS = 4096;
export const MAX_DANGLING = 256;

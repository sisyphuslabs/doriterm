import { base64urlEncode, type KeyPair, type StaticKey } from "@doriface/crypto";
import { meshIdOf, parseRecord, type Signed } from "@doriface/mesh";
import {
  JOIN_DEADLINE_MS,
  JOINER_EXPECTS,
  type LineLink,
  type MeshInvite,
  MeshLines,
  runJoiner,
} from "@doriface/mesh/join";
import { clientIdOf, memberIdentityOf } from "./identity.ts";
import { type BrowserMembership, type MembershipStore, membersOf, type MeshMember } from "./membership.ts";

/** The member the browser dialed and authenticated: the inviter's hostId and the Noise key the handshake proved. */
export interface Inviter {
  readonly hostId: string;
  readonly hostKey: Uint8Array;
  readonly relayUrl: string;
}

export interface BrowserJoinerDeps {
  readonly invite: MeshInvite;
  readonly sign: KeyPair;
  /** The device key: the Noise static the session proved, and the key the card names as this client's `devicePub`. */
  readonly device: StaticKey;
  readonly name: string;
  readonly membership: MembershipStore;
  readonly log?: ((line: string) => void) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface BrowserJoined {
  readonly meshId: string;
  readonly membership: BrowserMembership;
  readonly members: readonly MeshMember[];
}

/**
 * The joiner role on an authenticated mesh session (the shared `runJoiner`), as a browser runs it: a version 2 card of
 * kind `client`, signed by this browser's own key, naming its device key as both Noise static and `devicePub`; the
 * checked welcome goes to the membership store, which refuses it if another mesh was adopted meanwhile.
 */
export async function joinOnLink(link: LineLink, inviter: Inviter, deps: BrowserJoinerDeps): Promise<BrowserJoined> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((): void => {});
  const devicePub = base64urlEncode(deps.device.publicKey);
  let stored: BrowserMembership | undefined;
  const adopt = async (records: readonly Signed[]): Promise<boolean> => {
    const found = records.find((record) => parseRecord(record)?.type === "found");
    if (found === undefined) throw new Error("a welcome without a found record");
    const next: BrowserMembership = {
      meshId: meshIdOf(found),
      records,
      signPub: base64urlEncode(deps.sign.publicKey),
      inviter: { hostId: inviter.hostId, hostKey: base64urlEncode(inviter.hostKey) },
      relayUrl: inviter.relayUrl,
      joinedAt: new Date(now()).toISOString(),
    };
    if (!(await deps.membership.adopt(next))) return false;
    stored = next;
    return true;
  };
  const meshId = await runJoiner(new MeshLines(link, JOINER_EXPECTS), {
    invite: deps.invite,
    identity: memberIdentityOf(deps.sign, deps.device.publicKey),
    own: { name: deps.name, hcId: clientIdOf(deps.sign.publicKey), devicePub },
    kind: "client",
    dialed: { hostId: inviter.hostId, noisePub: inviter.hostKey },
    deadline: now() + JOIN_DEADLINE_MS,
    adopt,
    log,
  });
  if (stored === undefined) throw new Error("the join resolved without a stored membership");
  return { meshId, membership: stored, members: membersOf(stored.records) };
}

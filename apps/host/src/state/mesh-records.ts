import { base64urlEncode, type HostIdentity } from "@doriface/crypto";
import { type CardBody, type MemberKind, type RecordBody, type Signed } from "@doriface/mesh";
import { cardBodyFor, type OwnCard } from "@doriface/mesh/join";
import { AuthorizeIndex } from "../mesh/authorize-index.ts";
import { MESH_FILE, type MeshFile } from "./mesh-file.ts";

/** The authorize index a file persisted with its records; a stale or missing one is refused rather than evaluated. */
export function persistedIndex(file: MeshFile): AuthorizeIndex {
  if (file.index?.generation !== file.generation) throw new Error(`${MESH_FILE}: its authorize index is stale`);
  return new AuthorizeIndex(file.index);
}

/** The card body for this host in mesh `mesh`, invited by `inviter` (both `"-"` in a found). */
export function cardBody(
  identity: HostIdentity,
  card: OwnCard,
  mesh: string,
  inviter: string,
  at?: string,
  kind?: MemberKind,
): CardBody {
  const member = { hostId: identity.hostId, sign: identity.sign, noisePub: identity.noise.publicKey };
  return cardBodyFor(member, card, { mesh, inviter, nonce: at, kind });
}

/** The founding record of a mesh whose first member is this host. */
export const foundBody = (identity: HostIdentity, card: Signed): RecordBody => ({
  v: 2,
  mesh: "-",
  type: "found",
  by: base64urlEncode(identity.sign.publicKey),
  n: 1,
  prev: [],
  subject: { card },
});

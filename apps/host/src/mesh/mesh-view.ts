import type { Signed, View } from "@doriface/mesh";
import { type IndexData, indexOf, type MemberEntry } from "./authorize-index.ts";

/**
 * What sync, the reconciler and the bridge read of a view: each member with its governing card's hostId and core id
 * and its current Noise key and name (sections 5, 7 and 8), the members past the 12th, and the revoked keys.
 */
export interface MeshView {
  readonly members: readonly MemberEntry[];
  readonly overCap: readonly MemberEntry[];
  readonly revoked: readonly string[];
}

export const meshViewOfIndex = (data: IndexData): MeshView => ({
  members: data.members,
  overCap: data.overCap,
  revoked: data.revoked.map((entry) => entry.signPub),
});

/**
 * The members a host may dial, sync with, add as a herdr machine or count as a witness: machines only.
 *
 * A client stays in `members`, because the status document shows it to a person, but it is refused on the mesh stream: a
 * list that includes it asks a machine to reach something that never answers, so the readiness gate would wait on a hello
 * that never comes and the reconciler would add a phone as a machine (design of #942, sections 4, 6 and 8).
 */
export const machinesOf = (view: MeshView): readonly MemberEntry[] =>
  view.members.filter((member) => member.kind !== "client");

/** The signing keys of {@link machinesOf}: what may witness a revoke. */
export const machineKeysOf = (view: MeshView): ReadonlySet<string> =>
  new Set(machinesOf(view).map((member) => member.signPub));

export const meshViewOf = (records: readonly Signed[], view: View): MeshView =>
  meshViewOfIndex(indexOf(records, view, 0));

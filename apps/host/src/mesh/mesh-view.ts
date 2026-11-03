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

export const meshViewOf = (records: readonly Signed[], view: View): MeshView =>
  meshViewOfIndex(indexOf(records, view, 0));

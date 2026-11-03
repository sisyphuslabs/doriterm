import { type Signed, viewOf } from "@doriface/mesh";
import type { MeshStore } from "../state/mesh.ts";
import type { AuthorizeIndex, MemberEntry } from "./authorize-index.ts";
import { type MeshView, meshViewOf, meshViewOfIndex } from "./mesh-view.ts";

export type StoredMeshStore = Pick<MeshStore, "read" | "authorizeIndex">;

/**
 * What sync reads of mesh.json on every hello and want: the records, parsed once per written file (the store re-reads
 * its index only when the file changed), and the view the file's index holds.
 */
export class StoredMesh {
  readonly #store: StoredMeshStore;
  #parsed: { readonly index: AuthorizeIndex; readonly records: readonly Signed[] } | undefined;

  constructor(store: StoredMeshStore) {
    this.#store = store;
  }

  records(): readonly Signed[] {
    const index = this.#store.authorizeIndex();
    if (index !== undefined && this.#parsed?.index === index) return this.#parsed.records;
    const records = this.#store.read()?.records ?? [];
    this.#parsed = index === undefined ? undefined : { index, records };
    return records;
  }

  view(): MeshView {
    const file = this.#store.read();
    if (file?.index !== undefined) return meshViewOfIndex(file.index);
    const records = file?.records ?? [];
    return meshViewOf(records, viewOf(records));
  }
}

/** Every member and over-cap entry this host has seen, so a revoked member is still named and dialed by its hostId. */
export class MemberBook {
  readonly #known = new Map<string, MemberEntry>();

  remember(view: MeshView): void {
    for (const member of [...view.members, ...view.overCap]) this.#known.set(member.signPub, member);
  }

  all(): readonly MemberEntry[] {
    return [...this.#known.values()];
  }

  get(signPub: string): MemberEntry | undefined {
    return this.#known.get(signPub);
  }

  hostIdOf(signPub: string): string {
    return this.#known.get(signPub)?.hostId ?? signPub;
  }

  nameOf(signPub: string): string {
    return this.#known.get(signPub)?.name ?? signPub;
  }
}

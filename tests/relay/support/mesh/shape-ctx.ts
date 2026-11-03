import type { RecordKit, Actor } from "./records.ts";
import { actorOf, lastOwn } from "./records.ts";
import { identityOf, mintIdentity } from "./identity.ts";
import type { Mesh } from "./mesh.ts";
import { meshIdOf, storedRecords } from "./status.ts";

/** What a shape's steps may use: real hosts to drive, and the keys to sign with. */
export interface Ctx {
  readonly mesh: Mesh;
  readonly kit: RecordKit;
  readonly meshId: string;
  /** A host's keys and card fields. The first call reads them, so a host may be stopped afterwards. */
  actor(name: string): Promise<Actor>;
  /** Keys no host holds: what a compromised member mints. */
  mint(label: string): Actor;
  /** `of`'s newest record as `via` stores it: where a backdated chain of its own continues from. */
  last(of: Actor, via: string): { readonly n: number; readonly hash: string };
  readonly minted: readonly Actor[];
}

export function makeCtx(mesh: Mesh, kit: RecordKit, founder: string): Ctx {
  const known = new Map<string, Promise<Actor>>();
  const minted: Actor[] = [];
  return {
    mesh,
    kit,
    get meshId() {
      return meshIdOf(mesh.host(founder));
    },
    actor(name) {
      const cached = known.get(name);
      if (cached !== undefined) return cached;
      const made = (async () => actorOf(identityOf(mesh.host(name)), name, (await mesh.core(name)).hello.core.id))();
      known.set(name, made);
      return made;
    },
    mint(label) {
      const actor = actorOf(mintIdentity(), label, `hc-${label}`);
      minted.push(actor);
      return actor;
    },
    last: (of, via) => lastOwn(kit, storedRecords(mesh.host(via)), of.signPub),
    minted,
  };
}

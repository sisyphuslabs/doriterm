import type { Clock } from "./clock.ts";
import type { MeshView } from "./mesh-view.ts";

/** Section 6.4: a host its own computed view revoked stays read-only this long before it ejects itself. */
export const READ_ONLY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type SelfRole =
  | { readonly kind: "member" }
  | { readonly kind: "read-only"; readonly until: number }
  | { readonly kind: "ejected" };

/**
 * This host's own standing in its computed view. A view that drops it, revoked (section 6.4), makes it read-only (it signs nothing) for the grace period, and a later view that has it again makes it a
 * member again (R5a to R5b). Only the grace running out ejects it, never a single record.
 */
export class SelfStanding {
  readonly #self: string;
  readonly #clock: Clock;
  readonly #graceMs: number;
  readonly #onEject: () => void;
  #role: SelfRole = { kind: "member" };
  #cancel: () => void = () => undefined;

  constructor(options: { self: string; clock: Clock; onEject: () => void; graceMs?: number }) {
    this.#self = options.self;
    this.#clock = options.clock;
    this.#onEject = options.onEject;
    this.#graceMs = options.graceMs ?? READ_ONLY_GRACE_MS;
  }

  get role(): SelfRole {
    return this.#role;
  }

  get canSign(): boolean {
    return this.#role.kind === "member";
  }

  update(view: MeshView): SelfRole {
    if (this.#role.kind === "ejected") return this.#role;
    const member = view.members.some((entry) => entry.signPub === this.#self);
    if (member) {
      this.#cancel();
      this.#role = { kind: "member" };
    } else if (this.#role.kind === "member") {
      this.#role = { kind: "read-only", until: this.#clock.now() + this.#graceMs };
      this.#cancel = this.#clock.after(this.#graceMs, () => {
        this.#role = { kind: "ejected" };
        this.#onEject();
      });
    }
    return this.#role;
  }
}

import type { DialPolicy, DueReason } from "./dial-policy.ts";
import type { LineGrants } from "./line-grants.ts";
import type { Reconciler } from "./reconciler.ts";
import type { MeshView } from "./mesh-view.ts";

export interface MeshDriverOptions {
  readonly reconciler: Reconciler;
  readonly lines: LineGrants;
  readonly policy: DialPolicy;
  readonly view: MeshView;
}

/**
 * Wires sync to herdr (section 8): every view change reconciles `machine.list` and closes the outbound lines of
 * members it removed. A newly admitted member is added after the policy's 0-5 s jitter, a member's presence makes
 * herdr dial its line now (or adds it, when its add failed while it was offline), and a due probe or the end of
 * settle reconciles. Nothing here waits for a person.
 */
export class MeshDriver {
  readonly #reconciler: Reconciler;
  readonly #lines: LineGrants;
  readonly #policy: DialPolicy;
  #view: MeshView;

  constructor(options: MeshDriverOptions) {
    this.#reconciler = options.reconciler;
    this.#lines = options.lines;
    this.#policy = options.policy;
    this.#view = options.view;
  }

  start(): Promise<void> {
    return this.#reconciler.reconcile(this.#view);
  }

  viewChanged(view: MeshView): Promise<void> {
    const before = new Set(this.#view.members.map((member) => member.signPub));
    for (const member of view.members) {
      if (before.has(member.signPub)) continue;
      this.#reconciler.holdAdd(member.hostId);
      this.#policy.added(member.signPub);
    }
    this.#view = view;
    this.#lines.closeRevoked(view);
    return this.#reconciler.reconcile(view);
  }

  due(signPub: string, reason: DueReason): Promise<void> {
    const member = this.#view.members.find((entry) => entry.signPub === signPub);
    if (member === undefined) return Promise.resolve();
    if (reason === "presence") return this.#reconciler.presence(member);
    if (reason === "added") return this.#reconciler.releaseAdd(member.hostId);
    if (reason === "budget") return this.#reconciler.budgetAvailable(member.hostId);
    return this.#reconciler.reconcile(this.#view);
  }
}

import type { DueReason } from "./dial-policy.ts";
import type { MeshLines } from "./mesh-lines.ts";
import type { Reconciler } from "./reconciler.ts";
import type { MeshView } from "./upstream.ts";

/**
 * Wires sync to herdr (section 8): every view change reconciles `machine.list` and closes the outbound lines of
 * members it removed; a member's presence makes herdr dial its line now; a new member or the end of settle reconciles.
 * Nothing here waits for a person.
 */
export class MeshDriver {
  readonly #reconciler: Reconciler;
  readonly #lines: MeshLines;
  #view: MeshView;

  constructor(options: { readonly reconciler: Reconciler; readonly lines: MeshLines; readonly view: MeshView }) {
    this.#reconciler = options.reconciler;
    this.#lines = options.lines;
    this.#view = options.view;
  }

  start(): Promise<void> {
    return this.#reconciler.reconcile(this.#view);
  }

  viewChanged(view: MeshView): Promise<void> {
    this.#view = view;
    this.#lines.closeRevoked(view);
    return this.#reconciler.reconcile(view);
  }

  due(signPub: string, reason: DueReason): Promise<void> {
    const member = this.#view.members.find((entry) => entry.signPub === signPub);
    if (member === undefined) return Promise.resolve();
    if (reason === "presence") return this.#reconciler.presence(member);
    return this.#reconciler.reconcile(this.#view);
  }
}

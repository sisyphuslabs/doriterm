import type { FormatSupport } from "./format-readiness.ts";

/** Not a record on purpose: a capability written into the signed DAG is the very thing an older member cannot read. */
export class FormatAnswers {
  readonly #reads = new Map<string, readonly number[] | undefined>();

  record(hostId: string, reads: readonly number[] | undefined): void {
    this.#reads.set(hostId, reads);
  }

  /**
   * Drops every answer whose member is no longer in the roster.
   *
   * Readiness ignores a non-member anyway, so this is not about correctness: it is about a host that runs for weeks holding
   * a statement from every machine it has ever met. The review of #956 asked for it.
   */
  keep(signPubs: ReadonlySet<string>): void {
    for (const hostId of this.#reads.keys()) if (!signPubs.has(hostId)) this.#reads.delete(hostId);
  }

  all(): readonly FormatSupport[] {
    return [...this.#reads].map(([hostId, reads]) => ({ hostId, reads }));
  }
}

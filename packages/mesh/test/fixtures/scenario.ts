import type { Draft } from "./records.ts";

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly records: readonly Draft[];
  /** The honest view. */
  readonly expectMembers: readonly string[];
  readonly expectRevoked: readonly string[];
  readonly expectName?: Readonly<Record<string, string>>;
  /** A disclosed residual: the fail-closed view R3 gives instead of the honest one, asserted so any change shows. */
  readonly residual?: { readonly members: readonly string[]; readonly revoked: readonly string[] };
}

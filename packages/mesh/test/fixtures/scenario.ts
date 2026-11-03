import type { RefusalReason } from "../../src/door.ts";
import type { Draft } from "./records.ts";

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly records: readonly Draft[];
  /** Offered at the door, as signed records, after `records` are stored; the door refuses each with `refusals`. */
  readonly batch?: readonly Draft[];
  readonly refusals?: readonly RefusalReason[];
  /** Written after the batch by a host that stored only what the door kept. */
  readonly after?: readonly Draft[];
  /** The honest view. */
  readonly expectMembers: readonly string[];
  readonly expectRevoked: readonly string[];
  readonly expectName?: Readonly<Record<string, string>>;
  readonly expectNoise?: Readonly<Record<string, string>>;
  readonly expectAdmitter?: Readonly<Record<string, string>>;
  readonly expectOverCap?: readonly string[];
  /** A disclosed residual: the fail-closed view R3 gives instead of the honest one, asserted so any change shows. */
  readonly residual?: { readonly members: readonly string[]; readonly revoked: readonly string[] };
}

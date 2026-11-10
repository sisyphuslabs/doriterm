import { HcRpcError } from "@doriface/protocol";

/** What the reconciler does after herdr refused a mesh line's `machine.add` under one name (design section 8.1). */
export type AddRefusal =
  /** `name_taken`: the next fallback name is tried. */
  | { readonly kind: "next_name" }
  /** `already_added`: the member's core is here under an earlier entry, which the line replaces. */
  | { readonly kind: "migrate" }
  /** A named STUCK state, retried when the view or the list changes, or every 10 minutes. */
  | { readonly kind: "stuck"; readonly reason: string }
  /** Anything else (unreachable, the dial budget): retried on the backoff or the budget's event. */
  | { readonly kind: "retry"; readonly refused: string; readonly message: string };

export const kindOf = (error: unknown): string => (error instanceof HcRpcError ? error.kind : "unreachable");
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * herdr answers `invalid_params` both for a name it refuses and for a via command it will not run (`bad command …`,
 * which a herdr-core that runs no via on its platform answers for every mesh line). Only the first is a name problem:
 * renaming the machine does nothing for the second (#1582).
 */
const VIA_REFUSAL = /^bad command\b/;

export function addRefusalOf(error: unknown, name: string): AddRefusal {
  const kind = kindOf(error);
  const message = messageOf(error);
  switch (kind) {
    case "name_taken":
      return { kind: "next_name" };
    case "already_added":
      return { kind: "migrate" };
    case "invalid_params":
      return VIA_REFUSAL.test(message)
        ? { kind: "stuck", reason: `via_refused: this herdr-core cannot run the mesh line here: ${message}` }
        : { kind: "stuck", reason: `invalid_name: herdr refused "${name}": ${message}` };
    default:
      return { kind: "retry", refused: kind, message };
  }
}

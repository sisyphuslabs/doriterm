/**
 * Which formats a member has been seen to read, from its own answer over an authenticated session.
 *
 * This is deliberately not a record in the mesh's signed DAG: a member on an older build would refuse an unknown record
 * type and hold anything referring to it as dangling, so a capability announced as a record could not be read by the very
 * build that has to prove support. The answer lives only as long as the mesh does and is asked again after every restart.
 */
export interface FormatSupport {
  readonly hostId: string;
  readonly reads?: readonly number[] | undefined;
}

export type Readiness = { readonly kind: "ready" } | { readonly kind: "blocked"; readonly missing: readonly string[] };

/**
 * Whether the writer may emit records in `required`, given the current roster and what each member has answered.
 *
 * The roster decides who counts: a member that has left cannot block a write, and a member that has never answered cannot
 * be assumed to support anything. This is the writer-side gate the design requires, because refusing the record on the
 * receiving side is not enough — an older reader rejects the admission and then holds a revoke that references it as
 * dangling, so the revoke is silently not applied.
 */
/** The mesh-file format a client's admission needs: the kind it carries is what a version-2 reader drops. */
export const CLIENT_ADMISSION_FORMAT = 3;

export function formatReadiness(
  members: readonly string[],
  answers: readonly FormatSupport[],
  required: number,
): Readiness {
  const supported = new Set<string>();
  for (const answer of answers) {
    if (answer.reads?.includes(required) === true) supported.add(answer.hostId);
  }
  const missing = members.filter((hostId) => !supported.has(hostId));
  return missing.length === 0 ? { kind: "ready" } : { kind: "blocked", missing };
}

/**
 * Why an admission may not be written, or undefined when it may. A machine is never held back: only a client needs the
 * whole cohort to read the new format, because an older member would reject the admission and then hold any later revoke
 * that references it as dangling, so the revoke would silently not apply (design of #942).
 */
export function admissionRefusal(kind: string | undefined, ready: boolean): string | undefined {
  if (kind !== "client" || ready) return undefined;
  return "a client can join once every machine in this mesh reads the new format";
}

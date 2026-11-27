import { type ReadmitApproval, type ReadmitSubject, verifyBundleChallenge, verifyReadmit } from "@doriface/mesh";

export interface RestoreClient {
  readonly signPub: string;
  readonly devicePub: string;
  readonly live: boolean;
}

type Decision =
  | { readonly kind: "empty" | "denied" | "waiting" }
  | { readonly kind: "approved"; readonly proof: ReadmitSubject };

const EMPTY: Decision = { kind: "empty" };
const WAITING: Decision = { kind: "waiting" };
const DENIED: Decision = { kind: "denied" };
const MAX_PENDING = 128;

interface Pending {
  readonly mesh: string;
  readonly request: ReadmitSubject;
  oldRequired: boolean;
  readonly others: Set<string>;
  denied: boolean;
  approval?: ReadmitApproval;
  oldApproval?: string;
}

const idOf = ({ newSig, oldSig }: ReadmitSubject): string => `${newSig}${oldSig ?? ""}`;

/** A denial or an old-client requirement cannot be downgraded by disconnecting that client. */
export class RestoreRequests {
  readonly #pending = new Map<string, Pending>();

  offer(mesh: string, request: ReadmitSubject, clients: readonly RestoreClient[]): Decision {
    const old = clients.find((client) => client.signPub === request.old);
    if (
      old === undefined ||
      request.noise === old.devicePub ||
      clients.some((client) => client.signPub === request.signPub || client.devicePub === request.noise) ||
      request.oldSig === undefined ||
      request.approval !== undefined ||
      request.oldApproval !== undefined ||
      !verifyReadmit(mesh, request)
    )
      return EMPTY;
    const key = idOf(request);
    let entry = this.#pending.get(key);
    if (entry === undefined) {
      const others = clients.filter((client) => client.signPub !== request.old).map((client) => client.signPub);
      if (this.#pending.size >= MAX_PENDING) return EMPTY;
      entry = { mesh, request, oldRequired: old.live, others: new Set(others), denied: false };
      this.#pending.set(key, entry);
    }
    if (entry.mesh !== mesh) return EMPTY;
    if (entry.denied) return DENIED;
    if (old.live) entry.oldRequired = true;
    if (entry.oldRequired && entry.oldApproval === undefined) return WAITING;
    // Membership can add a new approver while an admissible request is pending, but may not remove a requirement.
    for (const client of clients) if (client.signPub !== request.old) entry.others.add(client.signPub);
    if (
      entry.others.size !== 0 &&
      !clients.some((client) => client.signPub !== request.old && client.signPub === entry.approval?.by)
    )
      return WAITING;
    return {
      kind: "approved",
      proof: {
        ...request,
        ...(entry.oldApproval === undefined ? {} : { oldApproval: entry.oldApproval }),
        ...(entry.approval === undefined ? {} : { approval: entry.approval }),
      },
    };
  }

  forClient(signPub: string): readonly ReadmitSubject[] {
    return [...this.#pending.values()]
      .filter(
        (entry) =>
          !entry.denied &&
          (entry.oldRequired && entry.oldApproval === undefined
            ? entry.request.old === signPub
            : entry.approval === undefined && entry.others.has(signPub)),
      )
      .map(({ request }) => request);
  }

  answer(mesh: string, request: ReadmitSubject, by: string, approval: ReadmitApproval | null): boolean {
    const entry = this.#pending.get(idOf(request));
    if (entry === undefined || entry.mesh !== mesh || !this.forClient(by).includes(entry.request)) return false;
    if (approval === null) {
      entry.denied = true;
      return true;
    }
    if (approval.by !== by || !verifyReadmit(mesh, { ...entry.request, approval })) return false;
    if (by === entry.request.old) entry.oldApproval = approval.sig;
    else entry.approval = approval;
    return true;
  }

  prune(current: ReadonlySet<string>): void {
    for (const [id, entry] of this.#pending) {
      if (!current.has(entry.request.old)) this.#pending.delete(id);
    }
  }
}

export function mayReadBundle(
  current: ReadonlySet<string>,
  { challenge, old, sig }: { readonly challenge: string; readonly old: string; readonly sig: string },
): boolean {
  return current.has(old) && verifyBundleChallenge(challenge, sig, old);
}

import {
  isJsonObject,
  type JsonValue,
  type MachineView,
  MESH_APPROVAL_DOC,
  MESH_STATUS_DOC,
  type MeshPendingJoin,
  type MeshStatus,
  parseMeshStatus,
} from "@doriface/protocol";

export type Verdict = "approve" | "deny";

/**
 * What the host made of the last answer, which it writes back beside it (`apps/host/src/mesh/approval-doc.ts`): not
 * read yet, taken (`decided: true`), no such join held there any more (`decided: false`: it expired, or was answered
 * elsewhere), or refused with a reason (`error`).
 */
export type HostOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "taken" }
  | { readonly kind: "gone" }
  | { readonly kind: "refused"; readonly reason: string };

export interface Answered {
  readonly nonce: string;
  readonly verdict: Verdict;
  readonly outcome: HostOutcome;
}

export type MeshRead =
  | { readonly phase: "loading" }
  | { readonly phase: "none" }
  | { readonly phase: "unreadable" }
  | { readonly phase: "failed"; readonly message: string }
  | {
      readonly phase: "ready";
      readonly status: MeshStatus;
      readonly machines: readonly MachineView[];
      /** Every join waiting on a machine this app reaches, this core's first (#2939). */
      readonly requests: readonly JoinRequest[];
      /** Connected machines whose mesh documents could not be read, so their joins may be missing here. */
      readonly unread: readonly string[];
    };

/**
 * A pending join and the machine that holds it. Pending joins live in the inviting host's memory and are published only
 * in its own status document, so an owner looking at another machine reads them there and answers through that
 * machine's approval document.
 */
export interface JoinRequest {
  readonly join: MeshPendingJoin;
  /** The machine that holds the join, as machine.list lists it; null for this core. */
  readonly machine: MachineView | null;
  /** That machine's answer document, when it names this join. */
  readonly answered: Answered | undefined;
}

export interface MeshCalls {
  /** `on` names another machine as machine.list does; omitted for this core. */
  readonly doc: (name: string, on?: string) => Promise<{ readonly value: JsonValue; readonly version: number }>;
  readonly setDoc: (name: string, value: JsonValue, version: number, on?: string) => Promise<unknown>;
  readonly machines: () => Promise<readonly MachineView[]>;
}

function outcomeIn(value: { readonly [key: string]: JsonValue }): HostOutcome {
  const error = value["error"];
  if (typeof error === "string") return { kind: "refused", reason: error };
  const decided = value["decided"];
  if (decided === true) return { kind: "taken" };
  if (decided === false) return { kind: "gone" };
  return { kind: "sent" };
}

function answeredIn(value: JsonValue): Answered | undefined {
  if (!isJsonObject(value)) return undefined;
  const approve = value["approve"];
  const deny = value["deny"];
  if (typeof approve === "string") return { nonce: approve, verdict: "approve", outcome: outcomeIn(value) };
  if (typeof deny === "string") return { nonce: deny, verdict: "deny", outcome: outcomeIn(value) };
  return undefined;
}

const failedRead = (error: unknown): MeshRead => ({
  phase: "failed",
  message: error instanceof Error ? error.message : String(error),
});

const requestsIn = (
  pending: readonly MeshPendingJoin[],
  machine: MachineView | null,
  answer: JsonValue,
): JoinRequest[] => {
  const answered = answeredIn(answer);
  return pending.map((join) => ({ join, machine, answered: answered?.nonce === join.nonce ? answered : undefined }));
};

/** The joins waiting on one other machine; undefined when its documents cannot be read. */
async function machineRequests(calls: MeshCalls, machine: MachineView): Promise<JoinRequest[] | undefined> {
  try {
    const [doc, answer] = await Promise.all([
      calls.doc(MESH_STATUS_DOC, machine.name),
      calls.doc(MESH_APPROVAL_DOC, machine.name),
    ]);
    const status = doc.value === null ? undefined : parseMeshStatus(doc.value);
    return requestsIn(status?.pending ?? [], machine, answer.value);
  } catch {
    return undefined;
  }
}

async function readMesh(calls: MeshCalls): Promise<MeshRead> {
  const [doc, machines, answer] = await Promise.all([
    calls.doc(MESH_STATUS_DOC),
    calls.machines(),
    calls.doc(MESH_APPROVAL_DOC),
  ]);
  if (doc.value === null) return { phase: "none" };
  const status = parseMeshStatus(doc.value);
  if (status === undefined) return { phase: "unreadable" };
  const connected = machines.filter((machine) => machine.state === "connected");
  const elsewhere = await Promise.all(connected.map((machine) => machineRequests(calls, machine)));
  const requests = requestsIn(status.pending, null, answer.value);
  const held = new Set(requests.map((request) => request.join.nonce));
  for (const found of elsewhere) {
    for (const request of found ?? []) {
      if (held.has(request.join.nonce)) continue;
      held.add(request.join.nonce);
      requests.push(request);
    }
  }
  const unread = connected.filter((_, index) => elsewhere[index] === undefined).map((machine) => machine.name);
  return { phase: "ready", status, machines, requests, unread };
}

/**
 * Reads the `doriface-mesh` document with machine.list and the approval document beside it, and answers joins. The
 * core answers calls concurrently, so reads can land out of order: a read is shown only if no read started after it
 * has been shown. When `refresh` settles, its own read or a newer one is on screen.
 */
export class MeshReader {
  readonly #calls: MeshCalls;
  #onRead: ((read: MeshRead) => void) | undefined;
  #started = 0;
  #shown = 0;

  constructor(calls: MeshCalls) {
    this.#calls = calls;
  }

  /** Shows each read to `onRead` until the returned stop is called. */
  subscribe(onRead: (read: MeshRead) => void): () => void {
    this.#onRead = onRead;
    return () => {
      if (this.#onRead === onRead) this.#onRead = undefined;
    };
  }

  async refresh(): Promise<void> {
    const read = ++this.#started;
    const next = await readMesh(this.#calls).catch(failedRead);
    if (read <= this.#shown) return;
    this.#shown = read;
    this.#onRead?.(next);
  }

  /** Answers a join on the machine that holds it, through that machine's approval document. */
  async answer(request: JoinRequest, verdict: Verdict): Promise<void> {
    const { nonce, code } = request.join;
    if (verdict === "approve" && (code === undefined || !/^\d{3} \d{3}$/.test(code))) {
      throw new Error("Update this client to approve with the join code.");
    }
    const on = request.machine?.name;
    const { version } = await this.#calls.doc(MESH_APPROVAL_DOC, on);
    const value = verdict === "approve" ? { approve: nonce, code: code ?? "" } : { deny: nonce };
    try {
      await this.#calls.setDoc(MESH_APPROVAL_DOC, value, version, on);
    } finally {
      await this.refresh();
    }
  }
}

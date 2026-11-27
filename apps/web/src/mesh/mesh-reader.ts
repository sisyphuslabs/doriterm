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

/** How long another machine's mesh documents may take before the read goes on without them (and names it unread). */
export const REMOTE_READ_MS = 3_000;

/** Settles with the read, or with undefined once its bound passes; a test passes one that settles when it says. */
export type ReadBound = <T>(read: Promise<T>) => Promise<T | undefined>;

export const boundBy =
  (ms: number): ReadBound =>
  (read) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    });
    return Promise.race([read, late]).finally(() => clearTimeout(timer));
  };

/**
 * Another machine's status belongs to this mesh only when it names this mesh and its own host is one of this mesh's
 * members: an added machine can sit in another owner's mesh, whose joins are not this owner's to see or answer.
 */
const sameMesh = (ours: MeshStatus, theirs: MeshStatus): boolean =>
  theirs.meshId === ours.meshId && ours.members.some((member) => member.hostId === theirs.self);

/** The joins of this mesh waiting on one other machine; undefined when its documents cannot be read in time. */
async function machineRequests(
  calls: MeshCalls,
  machine: MachineView,
  ours: MeshStatus,
  bound: ReadBound,
): Promise<JoinRequest[] | undefined> {
  let read: readonly [{ readonly value: JsonValue }, { readonly value: JsonValue }] | undefined;
  try {
    read = await bound(
      Promise.all([calls.doc(MESH_STATUS_DOC, machine.name), calls.doc(MESH_APPROVAL_DOC, machine.name)]),
    );
  } catch {
    return undefined;
  }
  if (read === undefined) return undefined;
  const [doc, answer] = read;
  if (doc.value === null) return [];
  const theirs = parseMeshStatus(doc.value);
  if (theirs === undefined) return undefined;
  return sameMesh(ours, theirs) ? requestsIn(theirs.pending, machine, answer.value) : [];
}

/** The name a join's holder goes by: the machine as machine.list names it, or this host by its mesh name. */
export function holderOf(request: JoinRequest, status: MeshStatus): string {
  if (request.machine !== null) return request.machine.name;
  return status.members.find((member) => member.hostId === status.self)?.name ?? status.self;
}

async function readMesh(calls: MeshCalls, bound: ReadBound): Promise<MeshRead> {
  const [doc, machines, answer] = await Promise.all([
    calls.doc(MESH_STATUS_DOC),
    calls.machines(),
    calls.doc(MESH_APPROVAL_DOC),
  ]);
  if (doc.value === null) return { phase: "none" };
  const status = parseMeshStatus(doc.value);
  if (status === undefined) return { phase: "unreadable" };
  const connected = machines.filter((machine) => machine.state === "connected");
  const elsewhere = await Promise.all(connected.map((machine) => machineRequests(calls, machine, status, bound)));
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
  readonly #bound: ReadBound;
  #onRead: ((read: MeshRead) => void) | undefined;
  #started = 0;
  #shown = 0;

  constructor(calls: MeshCalls, bound: ReadBound = boundBy(REMOTE_READ_MS)) {
    this.#calls = calls;
    this.#bound = bound;
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
    const next = await readMesh(this.#calls, this.#bound).catch(failedRead);
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
    if (on !== undefined) await this.#heldInThisMesh(on);
    const { version } = await this.#calls.doc(MESH_APPROVAL_DOC, on);
    const value = verdict === "approve" ? { approve: nonce, code: code ?? "" } : { deny: nonce };
    try {
      await this.#calls.setDoc(MESH_APPROVAL_DOC, value, version, on);
    } finally {
      await this.refresh();
    }
  }

  /** Refuses to answer on a machine whose status, read now, is not of this mesh (it may have left since the read). */
  async #heldInThisMesh(on: string): Promise<void> {
    const [ours, theirs] = await Promise.all([this.#calls.doc(MESH_STATUS_DOC), this.#calls.doc(MESH_STATUS_DOC, on)]);
    const own = parseMeshStatus(ours.value);
    const held = parseMeshStatus(theirs.value);
    if (own === undefined || held === undefined || !sameMesh(own, held)) {
      throw new Error(`${on} is not in this mesh now, so its joins are not answered from here.`);
    }
  }
}

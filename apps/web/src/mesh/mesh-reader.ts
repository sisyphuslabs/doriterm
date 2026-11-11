import {
  isJsonObject,
  type JsonValue,
  type MachineView,
  MESH_APPROVAL_DOC,
  MESH_STATUS_DOC,
  type MeshStatus,
  parseMeshStatus,
} from "@doriface/protocol";

export type Verdict = "approve" | "deny";

export type MeshRead =
  | { readonly phase: "loading" }
  | { readonly phase: "none" }
  | { readonly phase: "unreadable" }
  | { readonly phase: "failed"; readonly message: string }
  | {
      readonly phase: "ready";
      readonly status: MeshStatus;
      readonly machines: readonly MachineView[];
      /** This host's answer document: which pending join was approved or denied last. */
      readonly answered: { readonly nonce: string; readonly verdict: Verdict } | undefined;
    };

export interface MeshCalls {
  readonly doc: (name: string) => Promise<{ readonly value: JsonValue; readonly version: number }>;
  readonly setDoc: (name: string, value: JsonValue, version: number) => Promise<unknown>;
  readonly machines: () => Promise<readonly MachineView[]>;
}

function answeredIn(value: JsonValue): { nonce: string; verdict: Verdict } | undefined {
  if (!isJsonObject(value)) return undefined;
  const approve = value["approve"];
  const deny = value["deny"];
  if (typeof approve === "string") return { nonce: approve, verdict: "approve" };
  if (typeof deny === "string") return { nonce: deny, verdict: "deny" };
  return undefined;
}

const failedRead = (error: unknown): MeshRead => ({
  phase: "failed",
  message: error instanceof Error ? error.message : String(error),
});

async function readMesh(calls: MeshCalls): Promise<MeshRead> {
  const [doc, machines, answer] = await Promise.all([
    calls.doc(MESH_STATUS_DOC),
    calls.machines(),
    calls.doc(MESH_APPROVAL_DOC),
  ]);
  if (doc.value === null) return { phase: "none" };
  const status = parseMeshStatus(doc.value);
  if (status === undefined) return { phase: "unreadable" };
  return { phase: "ready", status, machines, answered: answeredIn(answer.value) };
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

  async answer(nonce: string, verdict: Verdict, code?: string): Promise<void> {
    if (verdict === "approve" && (code === undefined || !/^\d{3} \d{3}$/.test(code))) {
      throw new Error("Update this client to approve with the join code.");
    }
    const { version } = await this.#calls.doc(MESH_APPROVAL_DOC);
    const value = verdict === "approve" ? { approve: nonce, code: code ?? "" } : { deny: nonce };
    try {
      await this.#calls.setDoc(MESH_APPROVAL_DOC, value, version);
    } finally {
      await this.refresh();
    }
  }
}

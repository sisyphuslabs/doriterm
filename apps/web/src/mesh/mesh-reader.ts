import type { HcConnection } from "@doriface/client";
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

export const meshCallsOf = (connection: HcConnection): MeshCalls => ({
  doc: (name) => connection.call("doc.get", { name }),
  setDoc: (name, value, version) => connection.call("doc.set", { name, value, version }),
  machines: async () => (await connection.call("machine.list")).machines,
});

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
 * has been shown, and `refresh` settles once a read at least as new as its own is on screen.
 */
export class MeshReader {
  readonly #calls: MeshCalls;
  readonly #onRead: (read: MeshRead) => void;
  #closed = false;
  #started = 0;
  #shown = 0;
  #waiting: { readonly read: number; readonly resolve: () => void }[] = [];

  constructor(calls: MeshCalls, onRead: (read: MeshRead) => void) {
    this.#calls = calls;
    this.#onRead = onRead;
  }

  async refresh(): Promise<void> {
    const read = ++this.#started;
    const next = await readMesh(this.#calls).catch(failedRead);
    if (this.#closed) return;
    if (read > this.#shown) {
      this.#shown = read;
      this.#onRead(next);
      const shown = this.#waiting.filter((entry) => entry.read <= read);
      this.#waiting = this.#waiting.filter((entry) => entry.read > read);
      for (const entry of shown) entry.resolve();
    }
    if (read > this.#shown) await new Promise<void>((resolve) => this.#waiting.push({ read, resolve }));
  }

  async answer(nonce: string, verdict: Verdict): Promise<void> {
    const { version } = await this.#calls.doc(MESH_APPROVAL_DOC);
    const value = verdict === "approve" ? { approve: nonce } : { deny: nonce };
    try {
      await this.#calls.setDoc(MESH_APPROVAL_DOC, value, version);
    } finally {
      await this.refresh();
    }
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#waiting) entry.resolve();
    this.#waiting = [];
  }
}

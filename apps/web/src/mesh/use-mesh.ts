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
import { useCallback, useEffect, useState } from "react";
import { MACHINE_REFRESH_MS } from "../workspace/use-machines.ts";

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

export interface Mesh {
  readonly read: MeshRead;
  readonly answer: (nonce: string, verdict: Verdict) => Promise<void>;
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

async function readMesh(connection: HcConnection): Promise<MeshRead> {
  const [doc, list, answer] = await Promise.all([
    connection.call("doc.get", { name: MESH_STATUS_DOC }),
    connection.call("machine.list"),
    connection.call("doc.get", { name: MESH_APPROVAL_DOC }),
  ]);
  if (doc.value === null) return { phase: "none" };
  const status = parseMeshStatus(doc.value);
  if (status === undefined) return { phase: "unreadable" };
  return { phase: "ready", status, machines: list.machines, answered: answeredIn(answer.value) };
}

/**
 * The `doriface-mesh` document with machine.list beside it to check it against, read on a timer while the page is
 * visible like the machine list, and again after this device answers a pending join.
 */
export function useMesh(connection: HcConnection): Mesh {
  const [read, setRead] = useState<MeshRead>({ phase: "loading" });
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((count) => count + 1), []);
  useEffect(() => {
    let current = true;
    readMesh(connection).then(
      (result) => {
        if (current) setRead(result);
        return result;
      },
      (error: unknown) => {
        if (current) setRead(failedRead(error));
      },
    );
    return () => {
      current = false;
    };
  }, [connection, reads]);
  useEffect(() => {
    const whenVisible = (): void => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = setInterval(whenVisible, MACHINE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  // An answer settles only once the documents have been read again, so the row shows what they hold now.
  const answer = useCallback(
    async (nonce: string, verdict: Verdict): Promise<void> => {
      const { version } = await connection.call("doc.get", { name: MESH_APPROVAL_DOC });
      const value = verdict === "approve" ? { approve: nonce } : { deny: nonce };
      try {
        await connection.call("doc.set", { name: MESH_APPROVAL_DOC, value, version });
      } finally {
        setRead(await readMesh(connection).catch(failedRead));
      }
    },
    [connection],
  );
  return { read, answer };
}

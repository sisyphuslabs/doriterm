import type { HcConnection } from "@doriface/client";
import { MESH_APPROVAL_DOC, MESH_STATUS_DOC } from "@doriface/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Roster } from "../roster/roster.ts";
import { useRoster } from "../roster/use-roster.ts";
import { type MeshCalls, type MeshRead, MeshReader, type Verdict } from "./mesh-reader.ts";

export type { Verdict } from "./mesh-reader.ts";

export interface Mesh {
  readonly read: MeshRead;
  /** Settles once the documents, read again after the write, are shown. */
  readonly answer: (nonce: string, verdict: Verdict, code?: string) => Promise<void>;
}

const MESH_DOCS: ReadonlySet<string> = new Set([MESH_STATUS_DOC, MESH_APPROVAL_DOC]);

/** The mesh documents through the connection, and machine.list through the one reader the roster keeps for the core. */
export const meshCallsOf = (connection: HcConnection, roster: Roster): MeshCalls => ({
  doc: (name) => connection.call("doc.get", { name }),
  setDoc: (name, value, version) => connection.call("doc.set", { name, value, version }),
  // The roster keeps a failed read as `error` beside the machines it read before; the mesh read says it failed (#1876).
  machines: () =>
    roster.refreshMachines().then(() => {
      const { views, error } = roster.snapshot.machines;
      if (error !== undefined) throw new Error(error);
      return views;
    }),
});

/**
 * The `doriface-mesh` document with machine.list beside it to check it against: read when the shared roster opens, again
 * when a mesh document changes (`doc` event), when a machine is added, removed, renamed or changes line, and after every
 * gap in the feed, and again after this device answers a pending join.
 */
export function useMesh(connection: HcConnection): Mesh {
  const { roster } = useRoster(connection);
  const [read, setRead] = useState<MeshRead>({ phase: "loading" });
  const reader = useMemo(() => new MeshReader(meshCallsOf(connection, roster)), [connection, roster]);
  useEffect(() => {
    const stop = reader.subscribe(setRead);
    const refresh = (): void => void reader.refresh();
    refresh();
    const stops = [
      roster.onGap(refresh),
      roster.onChange((change) => (change.kind.startsWith("machine-") ? refresh() : undefined)),
      roster.onDoc((machine, name) => (machine === null && MESH_DOCS.has(name) ? refresh() : undefined)),
    ];
    return () => {
      for (const each of stops) each();
      stop();
    };
  }, [reader, roster]);
  const answer = useCallback(
    (nonce: string, verdict: Verdict, code?: string) => reader.answer(nonce, verdict, code),
    [reader],
  );
  return { read, answer };
}

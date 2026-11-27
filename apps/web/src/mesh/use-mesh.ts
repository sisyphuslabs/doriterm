import type { HcConnection } from "@doriface/client";
import { MESH_APPROVAL_DOC, MESH_STATUS_DOC } from "@doriface/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Roster } from "../roster/roster.ts";
import { useRoster } from "../roster/use-roster.ts";
import { type JoinRequest, type MeshCalls, type MeshRead, MeshReader, type Verdict } from "./mesh-reader.ts";

export type { Verdict } from "./mesh-reader.ts";

export interface Mesh {
  readonly read: MeshRead;
  /** Answers on the machine that holds the join; settles once the documents, read again after the write, are shown. */
  readonly answer: (request: JoinRequest, verdict: Verdict) => Promise<void>;
}

const MESH_DOCS: ReadonlySet<string> = new Set([MESH_STATUS_DOC, MESH_APPROVAL_DOC]);

/** The mesh documents through the connection, and machine.list through the one reader the roster keeps for the core. */
export const meshCallsOf = (connection: HcConnection, roster: Roster): MeshCalls => ({
  doc: (name, on) => connection.call("doc.get", on === undefined ? { name } : { name, on }),
  setDoc: (name, value, version, on) =>
    connection.call("doc.set", on === undefined ? { name, value, version } : { name, on, value, version }),
  // The roster's own list, which it reads again when a machine changes, after a gap and on its timer: a read forced here
  // on every mesh refresh, now that the join card follows the mesh on the workspace, lands during a machine's reconnect
  // and cost that machine's layout its spaces (#2944, unavailable-actions.e2e.ts). Only a roster that has listed nothing
  // yet is asked. The roster keeps a failed read as `error` beside the machines it read before; the mesh read says it
  // failed (#1876).
  machines: async () => {
    if (roster.snapshot.machines.listed === 0) await roster.refreshMachines();
    const { views, error } = roster.snapshot.machines;
    if (error !== undefined) throw new Error(error);
    return views;
  },
});

/**
 * The `doriface-mesh` document with machine.list beside it to check it against: read when the shared roster opens, again
 * when a mesh document changes here or on another machine (`doc` event: another machine holds the joins it invited), when
 * a machine is added, removed, renamed or changes line, and after every gap in the feed, and again after this device
 * answers a pending join.
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
      roster.onDoc((_machine, name) => (MESH_DOCS.has(name) ? refresh() : undefined)),
    ];
    return () => {
      for (const each of stops) each();
      stop();
    };
  }, [reader, roster]);
  const answer = useCallback((request: JoinRequest, verdict: Verdict) => reader.answer(request, verdict), [reader]);
  return { read, answer };
}

import type { HcConnection } from "@doriface/client";
import { HcRpcError, type JsonObject, type MachineView } from "@doriface/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DocCalls, type DocEdit, LAYOUT_DOC, LayoutDoc } from "@doriface/protocol/layout";

/** One machine's layout as this screen can show it: `doc` is the last one read, and `readOnly` says why it is frozen. */
export interface MachineLayout {
  /** null for this core, else what this core calls the machine now. */
  readonly machine: string | null;
  /** null for this core, else the machine's permanent id (tab keys survive a rename). */
  readonly machineId: string | null;
  readonly doc: JsonObject | null;
  readonly loaded: boolean;
  /** Why edits are refused now, or null when they are taken. */
  readonly readOnly: string | null;
  readonly edit: (change: DocEdit) => Promise<boolean>;
}

/** Documents use permanent ids; only the RPC address uses a name, which may change before the feed tells this page. */
export function docCalls(connection: Pick<HcConnection, "call">, machines: () => readonly MachineView[]): DocCalls {
  const addressed = async <T>(id: string | null, call: (on: string | null) => Promise<T>): Promise<T> => {
    const on = id === null ? null : machines().find((machine) => machine.id === id)?.name;
    if (on === undefined) throw new Error("The layout cannot take changes now: the machine is not connected");
    try {
      return await call(on);
    } catch (cause) {
      if (id === null || !(cause instanceof HcRpcError) || cause.kind !== "machine_unknown") throw cause;
      const listed = await connection.call("machine.list");
      const renamed = listed.machines.find((machine) => machine.id === id);
      if (renamed === undefined || renamed.name === on) throw cause;
      return call(renamed.name);
    }
  };
  return {
    get: (id) =>
      addressed(id, (on) => connection.call("doc.get", on === null ? { name: LAYOUT_DOC } : { name: LAYOUT_DOC, on })),
    set: (id, value, version) =>
      addressed(id, (on) =>
        connection.call(
          "doc.set",
          on === null ? { name: LAYOUT_DOC, value, version } : { name: LAYOUT_DOC, on, value, version },
        ),
      ),
  };
}

/** Why a machine's layout takes no edits while it is still being read. */
export const LAYOUT_LOADING = "the layout is loading";

const NOT_CONNECTED = "the machine is not connected";

/**
 * Why a machine with no live document takes no edits, in the words its row uses: one the page holds as connected
 * through a redial (the grace from #904) is reconnecting, and its edits wait for it rather than calling it disconnected
 * while its row reads connected (#918); anything else is not connected.
 */
export function noEditsWhy(id: string | null, shown: readonly MachineView[]): string {
  const view = shown.find((machine) => machine.id === id);
  return view?.state === "connected" ? "the machine is reconnecting" : NOT_CONNECTED;
}

/** A machine's edits: through its live document, or refused with `why` when it has none. */
export function docEdit(
  live: Pick<LayoutDoc, "edit"> | undefined,
  why: string = NOT_CONNECTED,
): (change: DocEdit) => Promise<boolean> {
  if (live === undefined) return () => Promise.reject(new Error(`The layout cannot take changes now: ${why}`));
  return (change) => live.edit(change);
}

/** The last document read per core and machine id, so a machine that drops keeps its tabs on screen (read-only). */
const lastRead = new Map<string, JsonObject | null>();

/**
 * The herdr-app document of this core and of every connected added machine, read now and again on each `doc` event the
 * feed reports (`heard`). A machine that is not connected shows the last document read from it and takes no edits.
 */
export function useLayoutDocs(
  connection: HcConnection,
  machines: readonly MachineView[],
  /** The machines as their rows show them (connected through a redial hold), so a refusal says what the row says. */
  shown: readonly MachineView[] = machines,
): { readonly layouts: readonly MachineLayout[]; readonly heard: (machine: string | null, version: number) => void } {
  const core = connection.hello.core.id;
  const docs = useRef(new Map<string | null, LayoutDoc>());
  const machinesNow = useRef(machines);
  machinesNow.current = machines;
  const [, rerender] = useState(0);
  const connected = machines.filter((machine) => machine.state === "connected").map((machine) => machine.id);
  const ids = connected.join("\u0000");

  useEffect(() => {
    const calls = docCalls(connection, () => machinesNow.current);
    const want = new Set<string | null>([null, ...(ids === "" ? [] : ids.split("\u0000"))]);
    for (const machine of docs.current.keys()) if (!want.has(machine)) docs.current.delete(machine);
    for (const machine of want) {
      if (docs.current.has(machine)) continue;
      const doc = new LayoutDoc(calls, machine, () => rerender((count) => count + 1));
      docs.current.set(machine, doc);
      void doc.refresh();
    }
    rerender((count) => count + 1);
  }, [connection, ids]);
  useEffect(() => () => docs.current.clear(), [connection]);

  const heard = useCallback((machine: string | null, version: number): void => {
    const id = machine === null ? null : machinesNow.current.find((view) => view.name === machine)?.id;
    if (id !== undefined) void docs.current.get(id)?.heard(version);
  }, []);

  const layouts = [null, ...machines].map((view): MachineLayout => {
    const machine = view === null ? null : view.name;
    const machineId = view === null ? null : view.id;
    const cacheKey = `${core}|${machineId ?? ""}`;
    const live = docs.current.get(machineId);
    const state = live?.state;
    if (state?.phase === "ready") lastRead.set(cacheKey, state.doc);
    const kept = lastRead.get(cacheKey);
    const why = noEditsWhy(machineId, shown);
    const readOnly =
      state === undefined
        ? why
        : state.phase === "ready"
          ? null
          : state.phase === "unreadable"
            ? `this layout has ${state.reason}, which this version of Doriterm cannot edit`
            : state.phase === "loading"
              ? LAYOUT_LOADING
              : state.reason;
    return {
      machine,
      machineId,
      doc: state?.phase === "ready" ? state.doc : (kept ?? null),
      loaded: state?.phase === "ready" || kept !== undefined,
      readOnly,
      edit: docEdit(live, why),
    };
  });
  return { layouts, heard };
}

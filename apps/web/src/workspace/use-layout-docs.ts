import type { HcConnection } from "@doriface/client";
import type { JsonObject, MachineView } from "@doriface/protocol";
import { type DocEdit, type DocState, type EditShown, type LayoutDoc, storedPins } from "@doriface/protocol/layout";
import { docCalls } from "../roster/doc-calls.ts";
import { useRoster } from "../roster/use-roster.ts";

export { docCalls };

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
  readonly edit: (change: DocEdit, shown?: EditShown) => Promise<boolean>;
  /** The ids of its pinned tabs (#1561), from the machine's own pins document, never from herdr-app's. */
  readonly pins?: ReadonlySet<string>;
  /** Edits the machine's pins document (`pinEdit`). */
  readonly editPins?: (change: DocEdit) => Promise<boolean>;
}

/** Why a machine's layout takes no edits while it is still being read. */
export const LAYOUT_LOADING = "the layout is loading";

const NOT_CONNECTED = "the machine is not connected";

/**
 * Why a machine with no live document takes no edits, in the words its row uses: one the page holds as connected
 * through a redial (the grace from #904) is reconnecting, and its edits are refused as reconnecting rather than as
 * disconnected while its row reads connected or reconnecting (#918); anything else is not connected. An edit is never
 * queued for later.
 */
export function noEditsWhy(id: string | null, shown: readonly MachineView[]): string {
  const view = shown.find((machine) => machine.id === id);
  return view?.state === "connected" || view?.state === "reconnecting" ? "the machine is reconnecting" : NOT_CONNECTED;
}

/** A machine's edits: through its live document, or refused with `why` when it has none. */
export function docEdit(
  live: Pick<LayoutDoc, "edit"> | undefined,
  why: string = NOT_CONNECTED,
): (change: DocEdit, shown?: EditShown) => Promise<boolean> {
  if (live === undefined) return () => Promise.reject(new Error(`The layout cannot take changes now: ${why}`));
  return (change, shown) => live.edit(change, shown);
}

/**
 * The herdr-app document of this core and of every connected added machine, as the shared roster holds them: read
 * again on each `doc` event and on every gap in the feed. A machine that is not connected shows the last document
 * read from it and takes no edits.
 */
/**
 * Why a machine's layout takes no edits now, in the words its refusal shows; null when an edit may go ahead. `why` is
 * the reason when the machine has no live document at all.
 */
export function readOnlyOf(state: DocState | undefined, why: string): string | null {
  if (state === undefined) return why;
  if (state.phase === "ready") return null;
  if (state.phase === "unreadable")
    return `this layout has ${state.reason}, which this version of Doriterm cannot edit`;
  if (state.phase === "loading") return LAYOUT_LOADING;
  return state.reason;
}

export function useLayoutDocs(
  connection: HcConnection,
  machines: readonly MachineView[],
  /** The machines as their rows show them (connected through a redial hold), so a refusal says what the row says. */
  shown: readonly MachineView[] = machines,
): { readonly layouts: readonly MachineLayout[] } {
  const { roster } = useRoster(connection);
  const layouts = [null, ...machines].map((view): MachineLayout => {
    const machine = view === null ? null : view.name;
    const machineId = view === null ? null : view.id;
    const live = roster.docs.live(machineId);
    const livePins = roster.pins.live(machineId);
    const state = live?.state;
    const kept = roster.docs.kept(machineId);
    const why = machineId === null ? LAYOUT_LOADING : noEditsWhy(machineId, shown);
    const readOnly = readOnlyOf(state, why);
    return {
      machine,
      machineId,
      doc: state?.phase === "ready" ? state.doc : (kept ?? null),
      loaded: state?.phase === "ready" || kept !== undefined,
      readOnly,
      edit: docEdit(live, why),
      pins: storedPins(roster.pins.kept(machineId) ?? null),
      editPins: docEdit(livePins, why),
    };
  });
  return { layouts };
}

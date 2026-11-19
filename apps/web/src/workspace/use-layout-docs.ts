import type { HcConnection } from "@doriface/client";
import type { JsonObject, MachineView } from "@doriface/protocol";
import { type DocEdit, type EditShown, type LayoutDoc, storedPins } from "@doriface/protocol/layout";
import { docCalls } from "../roster/doc-calls.ts";
import { useRoster } from "../roster/use-roster.ts";
import { offlineReason, stateReason } from "./machine-state.ts";

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

/** Connected layouts must answer before restoration finishes; an unavailable layout need not hold the page up. */
export function layoutsRestored(
  machinesListed: boolean,
  layouts: readonly Pick<MachineLayout, "loaded" | "readOnly">[],
): boolean {
  return machinesListed && layouts.every((layout) => layout.loaded || layout.readOnly !== LAYOUT_LOADING);
}

/**
 * Why a machine with no live document takes no edits: a connected machine waits for its layout, while any other
 * machine is named with its row's state, including reconnecting only during the page's grace (#918).
 */
export function noEditsWhy(id: string | null, shown: readonly MachineView[]): string {
  const view = shown.find((machine) => machine.id === id);
  if (view === undefined) return offlineReason();
  return view.state === "connected" ? LAYOUT_LOADING : stateReason(view.state, view.name);
}

/** A machine's edits: through its live document, or refused with `why` when it has none. */
export function docEdit(
  live: Pick<LayoutDoc, "edit"> | undefined,
  why: string = offlineReason(),
): (change: DocEdit, shown?: EditShown) => Promise<boolean> {
  if (live === undefined) return () => Promise.reject(new Error(`The layout cannot take changes now: ${why}`));
  return (change, shown) => live.edit(change, shown);
}

/**
 * The herdr-app document of this core and of every connected added machine, as the shared roster holds them: read
 * again on each `doc` event and on every gap in the feed. A machine that is not connected shows the last document
 * read from it and takes no edits.
 */
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
    // A machine past its reconnect grace takes no edits even while its last document is still held: every action on
    // it is offered disabled at once, not refused after the click (#2455).
    // The page's own reading first (it holds a redialing machine as reconnecting through the grace), else hc's.
    const machineState = view === null ? undefined : (shown.find((one) => one.id === machineId)?.state ?? view.state);
    const gone = machineState !== undefined && machineState !== "connected" && machineState !== "reconnecting";
    const readOnly =
      gone || state === undefined
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
      pins: storedPins(roster.pins.kept(machineId) ?? null),
      editPins: docEdit(livePins, why),
    };
  });
  return { layouts };
}

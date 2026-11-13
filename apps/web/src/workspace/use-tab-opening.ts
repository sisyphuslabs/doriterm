import type { JsonObject, Terminal } from "@doriface/protocol";
import { docSpaces, freshId, type NewSpace, type Node, terminalBlock } from "@doriface/protocol/layout";
import { type SetStateAction, useCallback } from "react";
import { spaceKey, tabKey } from "../layout/view.ts";
import { findTerminal, keepTransient, localOf, type LayoutTab } from "./layout-model.ts";
import { machineOf } from "./model.ts";
import { apartWrite, newTabWrite, type PaneAt } from "./pane-writes.ts";
import { placeOf } from "./placement.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

export const rootOf = (id: string, children: readonly Node[]): Node => ({ children: [...children], id, type: "row" });

/** The transient tab's terminal as a tab for the document, with fresh ids. */
export function written(tab: LayoutTab): { id: string; pane: string; root: Node } {
  const id = freshId("tb");
  const pane = freshId("p");
  const address = tab.panes[0]?.address ?? "";
  return { id, pane, root: rootOf(id, [terminalBlock(pane, localOf(address))]) };
}

/** What useLayout hands the tab-opening callbacks: its view of the layouts and how it shows a pane. */
export interface TabOpeningDeps {
  readonly active: LayoutTab | null;
  readonly tabs: readonly LayoutTab[];
  readonly terminals: readonly Terminal[];
  readonly layoutOf: (machine: string | null) => MachineLayout | undefined;
  readonly show: (key: string, pane: string | null, select?: boolean) => void;
  readonly goInstead: (
    machineId: string | null,
    asked: { readonly key: string; readonly pane: string },
    there: PaneAt,
    back: string | null,
  ) => void;
  readonly keepHere: (address: string) => void;
  readonly setLoose: (change: SetStateAction<readonly string[]>) => void;
}

export interface TabOpening {
  readonly addTab: (
    address: string,
    newSpace?: boolean,
    into?: string,
    placed?: (doc: JsonObject | null, makeId: (prefix: "spc") => string) => NewSpace,
  ) => void;
  readonly openTerminal: (address: string, newSpace?: boolean, space?: string) => void;
  readonly placeTerminal: (address: string) => void;
}

/** Opening a terminal in a tab: a new tab beside the one in view, in a named space, or where its labels place it. */
export function useTabOpening({
  active,
  tabs,
  terminals,
  layoutOf,
  show,
  goInstead,
  keepHere,
  setLoose,
}: TabOpeningDeps): TabOpening {
  /** The first live terminal shown alone, written to its own machine's layout, or kept on this screen when it takes none. */
  const keepApart = useCallback(
    (tab: LayoutTab): void => {
      const own = layoutOf(tab.machine);
      const address = tab.panes[0]?.address ?? "";
      if (own === undefined || own.readOnly !== null) {
        return setLoose((prev) => (prev.includes(address) ? prev : [...prev, address]));
      }
      const kept = written(tab);
      const space = { id: freshId("spc"), folder: "" };
      void own.edit((doc) => apartWrite(doc, localOf(address), kept, space));
    },
    [layoutOf],
  );

  const addTab = useCallback(
    (
      address: string,
      newSpace = false,
      into?: string,
      placed?: (doc: JsonObject | null, makeId: (prefix: "spc") => string) => NewSpace,
    ): void => {
      const machine = machineOf(address) ?? null;
      const layout = layoutOf(machine);
      const writable = layout !== undefined && layout.readOnly === null;
      // A tab placed by its terminal's labels never takes the transient tab with it: that one keeps a space of its own.
      const transient = keepTransient(active, address, writable);
      const fate = placed !== undefined && transient !== null ? "apart" : transient;
      if (fate === "apart" && active !== null) keepApart(active);
      if (layout === undefined || layout.readOnly !== null) return keepHere(address);
      const id = freshId("tb");
      const pane = freshId("p");
      const tab: JsonObject = { id, name: "", root: rootOf(id, [terminalBlock(pane, localOf(address))]) };
      const kept =
        fate === "with-new" && active !== null
          ? {
              terminal: localOf(active.panes[0]?.address ?? ""),
              tab: written(active),
              follows: !newSpace && into === undefined,
            }
          : null;
      // herdr-app's add_tab: right after the selected tab of the selected space; a terminal of another machine, or one
      // asked for as a new space, starts a space of its own, never the first space of the document.
      // A named space of this machine takes it, after its selected tab when that is the one in view, else last.
      const docSpace =
        into === undefined || layout.doc === null
          ? undefined
          : docSpaces(layout.doc).find((each) => spaceKey(layout.machineId, each.id) === into);
      const named = docSpace?.id ?? null;
      // Only an existing space is worth a guess before the write: a space the write would make gets its id there.
      const guess = placed?.(layout.doc, () => "");
      const near =
        !newSpace &&
        active !== null &&
        !active.transient &&
        active.machine === machine &&
        (named === null || active.spaceKey === into) &&
        (guess === undefined || active.space === guess.id)
          ? active
          : null;
      const space = guess ?? { id: named ?? near?.space ?? freshId("spc"), folder: "" };
      const asked = tabKey(layout.machineId, id);
      // Where the document already shows the terminal: another device adopted it while this write waited (#2122). A
      // second tab for it is never written; the view asked to show the new tab shows that one instead.
      let adopted: PaneAt | null = null;
      void layout
        .edit((doc) => {
          // A placed tab's space is decided on the document this write lands on, as adoption decides it (#2467).
          const where = placed === undefined ? space : placed(doc, freshId);
          const after = where.id === space.id ? near?.id : undefined;
          const write = newTabWrite(doc, localOf(address), tab, where, after, kept, layout.pins);
          adopted = write.instead;
          return write.doc;
        })
        .then((saved) => {
          const there = adopted;
          if (saved) return saved;
          // A write the machine refused (its line down) is told by `failed`; the terminal stays on this screen as a loose
          // tab, kept mounted when the document read back without it (keepMounts), instead of going with that read.
          if (there === null) {
            setLoose((prev) => (prev.includes(address) ? prev : [...prev, address]));
            return saved;
          }
          goInstead(layout.machineId, { key: asked, pane }, there, null);
          return saved;
        });
      show(asked, pane);
    },
    [active, goInstead, keepApart, keepHere, layoutOf, setLoose, show],
  );

  const openTerminal = useCallback(
    (address: string, newSpace = false, space?: string): void => {
      const found = findTerminal(tabs, address);
      if (found === null) addTab(address, newSpace, space);
      else show(found.tab.key, found.pane.id);
    },
    [addTab, show, tabs],
  );
  const placeTerminal = useCallback(
    (address: string): void => {
      const found = findTerminal(tabs, address);
      if (found !== null) return show(found.tab.key, found.pane.id);
      const terminal = terminals.find((each) => each.address === address);
      const layout = layoutOf(machineOf(address) ?? null);
      if (terminal === undefined || layout === undefined) return addTab(address);
      return addTab(address, false, undefined, (doc, makeId) => placeOf(doc, terminal, makeId));
    },
    [addTab, layoutOf, show, tabs, terminals],
  );
  return { addTab, openTerminal, placeTerminal };
}

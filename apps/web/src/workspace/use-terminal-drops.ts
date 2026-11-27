import { freshId } from "@doriface/protocol/layout";
import { useCallback } from "react";
import type { Zone } from "../layout/drop-zone.ts";
import { tabKey as makeTabKey } from "../layout/view.ts";
import { type LayoutTab, localOf } from "./layout-model.ts";
import { machineOf } from "./model.ts";
import { detachPaneWrite, tabDropWrite, terminalDropWrite } from "./terminal-drop.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

/** Where a terminal dragged from the sidebar lands: pane `pane` of the tab keyed `tab`, in the zone the pointer is in. */
export interface TerminalDropTarget {
  readonly tab: string;
  readonly pane: string;
  readonly zone: Zone;
}

/** What makes a terminal dragged from the sidebar or a tab dragged from the tab strip a pane. */
export interface TerminalDrops {
  /**
   * Whether the tab keyed `tab` takes the terminal as a pane: a tab of a document that takes edits, on the terminal's own
   * machine, since a machine's document names only its own terminals.
   */
  readonly takesTerminal: (address: string, tab: string) => boolean;
  /** Makes the terminal a pane at `target` (terminal-drop.ts) and focuses it; true once the write landed. */
  readonly dropTerminal: (address: string, target: TerminalDropTarget) => Promise<boolean>;
  /** Whether the tab keyed `targetTab` can accept the tab keyed `sourceTab` as a split or swap. */
  readonly takesTab: (sourceTab: string, targetTab: string) => boolean;
  /** Docks `sourceTab` onto `target` (tabDropWrite) and focuses its pane; true once the write landed. */
  readonly dropTab: (sourceTab: string, target: TerminalDropTarget) => Promise<boolean>;
  /** Pops `paneId` out of split tab `tabKey` into its own tab right after it without restarting its terminal. */
  readonly detachPane: (tabKey: string, paneId: string) => Promise<boolean>;
}

export interface TerminalDropsContext {
  readonly tabs: readonly LayoutTab[];
  readonly layoutOf: (machine: string | null) => MachineLayout | undefined;
  readonly show: (key: string, pane: string | null) => void;
}

export function useTerminalDrops({ tabs, layoutOf, show }: TerminalDropsContext): TerminalDrops {
  const writable = useCallback(
    (address: string, key: string): { readonly tab: LayoutTab; readonly layout: MachineLayout } | null => {
      const tab = tabs.find((each) => each.key === key);
      if (tab === undefined || tab.transient || tab.readOnly !== null) return null;
      if ((machineOf(address) ?? null) !== tab.machine) return null;
      const layout = layoutOf(tab.machine);
      return layout === undefined || layout.readOnly !== null ? null : { tab, layout };
    },
    [layoutOf, tabs],
  );

  const writablePair = useCallback(
    (
      sourceKey: string,
      targetKey: string,
    ): { readonly source: LayoutTab; readonly target: LayoutTab; readonly layout: MachineLayout } | null => {
      if (sourceKey === targetKey) return null;
      const source = tabs.find((each) => each.key === sourceKey);
      const target = tabs.find((each) => each.key === targetKey);
      if (source === undefined || target === undefined) return null;
      if (source.transient || target.transient || source.readOnly !== null || target.readOnly !== null) return null;
      if (source.machine !== target.machine) return null;
      const layout = layoutOf(target.machine);
      return layout === undefined || layout.readOnly !== null ? null : { source, target, layout };
    },
    [layoutOf, tabs],
  );

  const takesTerminal = useCallback(
    (address: string, key: string): boolean => writable(address, key) !== null,
    [writable],
  );

  const dropTerminal = useCallback(
    async (address: string, target: TerminalDropTarget): Promise<boolean> => {
      const place = writable(address, target.tab);
      if (place === null) return false;
      const { tab, layout } = place;
      const drop = { tab: tab.id, target: target.pane, zone: target.zone };
      const fresh = { pane: freshId("p"), container: freshId("s") };
      let shown: string | null = null;
      const written = await layout.edit((doc) => {
        const write = terminalDropWrite(doc, localOf(address), drop, fresh);
        shown = write?.pane ?? null;
        return write?.doc ?? null;
      });
      if (written && shown !== null) show(tab.key, shown);
      return written;
    },
    [show, writable],
  );

  const takesTab = useCallback(
    (sourceKey: string, targetKey: string): boolean => writablePair(sourceKey, targetKey) !== null,
    [writablePair],
  );

  const dropTab = useCallback(
    async (sourceKey: string, target: TerminalDropTarget): Promise<boolean> => {
      const pair = writablePair(sourceKey, target.tab);
      if (pair === null) return false;
      const { source, target: dest, layout } = pair;
      const drop = { tab: dest.id, target: target.pane, zone: target.zone };
      const containerId = freshId("s");
      let shown: string | null = null;
      const written = await layout.edit((doc) => {
        const write = tabDropWrite(doc, source.id, drop, containerId);
        shown = write?.pane ?? null;
        return write?.doc ?? null;
      });
      if (written && shown !== null) show(dest.key, shown);
      return written;
    },
    [show, writablePair],
  );

  const detachPane = useCallback(
    async (key: string, paneId: string): Promise<boolean> => {
      const tab = tabs.find((each) => each.key === key);
      if (tab === undefined || tab.transient || tab.readOnly !== null || tab.panes.length < 2) return false;
      const layout = layoutOf(tab.machine);
      if (layout === undefined || layout.readOnly !== null) return false;
      const newTabId = freshId("tb");
      const written = await layout.edit((doc) => detachPaneWrite(doc, tab.id, paneId, newTabId)?.doc ?? null);
      if (written) show(makeTabKey(layout.machineId, newTabId), paneId);
      return written;
    },
    [layoutOf, show, tabs],
  );

  return { takesTerminal, dropTerminal, takesTab, dropTab, detachPane };
}

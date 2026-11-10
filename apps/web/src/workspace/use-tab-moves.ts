import { moveTab as moveDocTab } from "@doriface/protocol/layout";
import { useCallback, useRef, useState } from "react";
import type { LayoutTab } from "./layout-model.ts";
import { moveTabTo, type TabMove } from "./tab-order.ts";
import type { DropTarget } from "./use-drop-pane.ts";

/**
 * Moving a tab in the strip: the strip shows one space's tabs in their document's order, so a move edits that document
 * and every device sees it (#404). Only a move that changes the order is said.
 */
export function useTabMoves(
  tabs: readonly LayoutTab[],
  layoutOf: (machine: string | null) => DropTarget | undefined,
): { readonly moveTab: (key: string, to: number) => void; readonly lastMove: TabMove | null } {
  const [lastMove, setLastMove] = useState<TabMove | null>(null);
  const shown = useRef(tabs);
  shown.current = tabs;
  const moveTab = useCallback(
    (key: string, to: number): void => {
      const tab = shown.current.find((each) => each.key === key);
      const layout = tab === undefined || tab.transient ? undefined : layoutOf(tab.machine);
      if (tab === undefined || layout === undefined || layout.readOnly !== null) return;
      const keys = shown.current.map((each) => each.key);
      // The strip shows one space of one machine, so its pinned tabs are the ones a move keeps to their side (#1561).
      const pins = new Set(shown.current.filter((each) => each.pinned).map((each) => each.id));
      // Said once the document has the new order, so the strip reads the tab's new place, not the one it left.
      void layout
        .edit((doc) => (doc === null ? null : moveDocTab(doc, tab.id, to, pins)))
        .then((moved) => {
          if (moved) setLastMove((said) => moveTabTo(keys, said, key, to).said);
          return moved;
        });
    },
    [layoutOf],
  );
  return { moveTab, lastMove };
}

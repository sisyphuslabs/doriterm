import { type PointerEvent, type RefObject, useMemo, useRef, useState } from "react";
import type { TabActions, TabOffers } from "./tab-item.tsx";

/** The strip's own callbacks, as TabBar takes them. */
export interface TabCallbacks {
  readonly onSelect?: ((id: string) => void) | undefined;
  readonly onClose?: ((id: string) => void) | undefined;
  readonly onPin?: ((id: string, pinned: boolean) => void) | undefined;
  readonly onCloseSet?: ((id: string, which: "right" | "others") => void) | undefined;
  readonly onNew?: (() => void) | undefined;
  readonly onRename?: ((id: string) => void) | undefined;
  readonly onMove?: ((id: string, to: number) => void) | undefined;
}

interface Drag {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>, id: string, local: number) => void;
}

/** Each group's drag, and whether a touch is held on the strip. */
export interface TabDrags {
  readonly pinnedDrag: Drag;
  readonly restDrag: Drag;
  readonly touching: () => boolean;
}

/** What the strip keeps for its tabs' menus: their buttons, whether an item handed the keyboard on, the open menu. */
export interface TabMenuState {
  readonly buttons: RefObject<Map<string, HTMLButtonElement>>;
  readonly handedOn: RefObject<boolean>;
  readonly setMenuFor: (id: string | null) => void;
}

/**
 * One set of tab callbacks for the life of the strip, each calling the latest props and drag: a new set would draw every
 * tab again on every render of the strip (#2086). Which items a tab offers changes only with which callbacks were given.
 */
export function useTabActions(
  callbacks: TabCallbacks,
  drags: TabDrags,
  menus: TabMenuState,
): { readonly actions: TabActions; readonly offers: TabOffers } {
  const latest = useRef({ ...callbacks, ...drags });
  latest.current = { ...callbacks, ...drags };
  const { buttons, handedOn, setMenuFor } = menus;
  const [actions] = useState<TabActions>(() => ({
    select: (id) => latest.current.onSelect?.(id),
    close: (id) => latest.current.onClose?.(id),
    rename: (id) => latest.current.onRename?.(id),
    move: (id, to) => latest.current.onMove?.(id, to),
    pin: (id, pinned) => latest.current.onPin?.(id, pinned),
    closeSet: (id, which) => latest.current.onCloseSet?.(id, which),
    newTab: () => latest.current.onNew?.(),
    pointerDown: (event, id, local, pinned) =>
      (pinned ? latest.current.pinnedDrag : latest.current.restDrag).onPointerDown(event, id, local),
    touching: () => latest.current.touching(),
    button: (id, element) => {
      if (element === null) buttons.current.delete(id);
      else buttons.current.set(id, element);
    },
    // An item that opened a dialog (Rename tab…) has given it the keyboard, and the menu closes a moment later: taking
    // focus back to the tab would lose the name typed meanwhile. What the item chose decides, not who holds the keyboard.
    finalFocus: (id) => {
      if (handedOn.current) return false;
      const holder = document.activeElement;
      if (holder instanceof HTMLElement && holder.closest('[role="dialog"]') !== null) return false;
      return buttons.current.get(id) ?? true;
    },
    menuOpenChange: (id, open) => {
      if (open) handedOn.current = false;
      setMenuFor(open ? id : null);
    },
    handOn: () => {
      handedOn.current = true;
    },
  }));
  const { onMove, onRename, onNew, onPin, onClose, onCloseSet } = callbacks;
  const offers = useMemo<TabOffers>(
    () => ({
      move: onMove !== undefined,
      rename: onRename !== undefined,
      newTab: onNew !== undefined,
      pin: onPin !== undefined,
      close: onClose !== undefined,
      closeSet: onCloseSet !== undefined,
    }),
    [onMove, onRename, onNew, onPin, onClose, onCloseSet],
  );
  return { actions, offers };
}

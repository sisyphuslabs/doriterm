import { Plus } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./icon-button.tsx";
import { Menu } from "./menu.tsx";
import { useTabActions } from "./tab-actions.ts";
import { useTabDrag } from "./tab-drag.ts";
import { DropCaret, DropIndicator, placement } from "./tab-drop.tsx";
import { TabItem, type WorkspaceTab } from "./tab-item.tsx";

export type { WorkspaceTab } from "./tab-item.tsx";

/** A tab that moved, by any path (drag, its menu, a key); counted so moving it to the same place again is news. */
export interface TabMoved {
  readonly id: string;
  readonly count: number;
}

export interface TabBarProps {
  readonly tabs: readonly WorkspaceTab[];
  readonly activeId: string;
  readonly onSelect?: (id: string) => void;
  readonly onClose?: (id: string) => void;
  /** Pins or unpins a tab from its menu (#1561). */
  readonly onPin?: (id: string, pinned: boolean) => void;
  /** "Close tabs to the right" and "Close other tabs" from a tab's menu; neither closes a pinned tab (#1561). */
  readonly onCloseSet?: (id: string, which: "right" | "others") => void;
  readonly onNew?: () => void;
  /** New tab cannot start a terminal now (the space's machine is not reachable): it stays in place, disabled. */
  readonly newDisabled?: boolean;
  /** herdr-app's new menu: given, the strip's New tab button opens it (#466 item 7); else the button is `onNew`. */
  readonly newMenu?: ReactNode;
  /** Asks for a tab's name: a double-click on it, as herdr-app's strip, and Rename tab in its menu. */
  readonly onRename?: (id: string) => void;
  /** Moves a tab so it ends at index `to` of `tabs`; without it tabs neither drag nor offer Move in their menu. */
  readonly onMove?: (id: string, to: number) => void;
  /** The New tab shortcut as key chips, from the app's live binding; none when it is unbound. */
  readonly newTabKeys?: readonly string[];
  /** The Move tab left and right shortcuts as key chips, shown in each tab's menu. */
  readonly moveKeys?: { readonly left?: readonly string[]; readonly right?: readonly string[] };
  /** The last move, which the strip announces to screen readers once, as it stood when the tab moved. */
  readonly moved?: TabMoved | null;
  /** Before the tabs, e.g. the button that brings a hidden sidebar back where the sidebar was. */
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
}

/**
 * herdr-app's tab strip: raised pill for the active tab, which alone shows its close button; status glyph instead of
 * colour bars, and a tooltip only on a title cut short; tabs reorder by drag, the wheel steps through them, and a tab's
 * menu renames, adds or closes.
 */
export function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onPin,
  onCloseSet,
  onNew,
  newDisabled = false,
  newMenu,
  onRename,
  onMove,
  newTabKeys,
  moveKeys,
  moved,
  leading,
  trailing,
  className,
}: TabBarProps) {
  const list = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Whether the New tab menu closed on one of its items, rather than Escape or a click away, and what that item gave the
  // keyboard to (a terminal being started takes it at once, type-ahead).
  const chose = useRef(false);
  const handedTo = useRef<HTMLElement | null>(null);
  // Whether the open tab menu's item handed the keyboard to a question it opened. The choice decides, not who holds
  // the keyboard as the menu closes: the question's first paint can come after that, and the strip would take it back.
  const handedOn = useRef(false);
  // The tabs the strip drew before its last change of tabs: they carry data-arrived, so the DOM move a reorder makes
  // does not replay their arrival; a tab new to the list draws once without it and arrives. A pin or unpin is such a
  // change too, even when the order stays: it moves the tab into the other group, a DOM move as well (#2013).
  const ids = tabs.map((tab) => tab.id);
  const key = tabs.map((tab) => (tab.pinned === true ? `${tab.id}*` : tab.id)).join("\n");
  const [drawn, setDrawn] = useState(() => ({ key, before: new Set<string>(), now: new Set(ids) }));
  if (drawn.key !== key) setDrawn({ key, before: drawn.now, now: new Set(ids) });
  // The strip owns a touch's long press: held and moved it drags the tab, held and let go it opens the tab's menu.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Pinned tabs lead (#1561) and sit in a group of their own that never scrolls, so they stay in view while the other
  // tabs scroll; each group drags within itself, so no drag carries a tab across the last pinned one.
  const firstUnpinned = tabs.findIndex((tab) => tab.pinned !== true);
  const pins = firstUnpinned === -1 ? tabs.length : firstUnpinned;
  const pinnedList = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const dragOptions = (from: number) => ({
    onMove: onMove === undefined ? undefined : (id: string, to: number) => onMove(id, to + from),
    onStart: () => setMenuFor(null),
    onHoldRelease: (id: string, x: number, y: number) => {
      const item = list.current?.querySelector(`[data-tab-id="${CSS.escape(id)}"]`);
      item?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    },
  });
  const pinnedDrag = useTabDrag(pinnedList, ids.slice(0, pins), dragOptions(0));
  const restDrag = useTabDrag(scroller, ids.slice(pins), dragOptions(pins));
  const lifted = pinnedDrag.lifted ?? restDrag.lifted;
  const touching = (): boolean => pinnedDrag.touching() || restDrag.touching();

  // With more tabs than fit, the selected one (a new tab lands after it) scrolls into view; New tab no longer scrolls
  // with the tabs to carry them along. Again when its title changes: a new tab's label settles after it arrives.
  const activeTitle = tabs.find((tab) => tab.id === activeId)?.title;
  useEffect(() => {
    // The whole tab, with its close button, not only its label button.
    buttons.current.get(activeId)?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, key, activeTitle]);

  // Said once per move, as the strip stood then: a later title change or a tab opening or closing does not say it again.
  // The count's parity changes the text each time, so a second move to the same place is still read out.
  const [said, setSaid] = useState({ count: 0, text: "" });
  const last = moved ?? null;
  if (last !== null && last.count !== said.count) {
    const at = tabs.findIndex((tab) => tab.id === last.id);
    const tab = tabs[at];
    const text =
      tab === undefined
        ? ""
        : `Moved ${tab.title} to position ${at + 1} of ${tabs.length}${last.count % 2 === 0 ? "" : "\u00a0"}`;
    setSaid({ count: last.count, text });
  }

  const { actions, offers } = useTabActions(
    { onSelect, onClose, onPin, onCloseSet, onNew, onRename, onMove },
    { pinnedDrag, restDrag, touching },
    { buttons, handedOn, setMenuFor },
  );
  const lastUnpinned = tabs.findLastIndex((tab) => tab.pinned !== true);

  // One tab, in whichever group it sits: `index` is its place among all the tabs, which the menu's moves use.
  const tabItem = (tab: WorkspaceTab, index: number): ReactNode => {
    const pinned = tab.pinned === true;
    const { drag, settle } = pinned ? pinnedDrag : restDrag;
    const local = pinned ? index : index - pins;
    const place = placement(tab.id, local, drag, settle);
    return (
      <TabItem
        key={tab.id}
        tab={tab}
        index={index}
        local={local}
        active={tab.id === activeId}
        // Pinned tabs lead and keep to their own side of the strip: a move never crosses the last pinned tab (#1561).
        leftmost={pinned ? 0 : pins}
        rightmost={pinned ? pins - 1 : tabs.length - 1}
        closesRight={lastUnpinned > index}
        closesOthers={firstUnpinned !== -1 && (lastUnpinned !== index || firstUnpinned !== index)}
        dragging={drag?.id === tab.id}
        lifted={lifted === tab.id}
        arrived={drawn.before.has(tab.id)}
        offset={place.offset}
        placeClass={place.className}
        menuOpen={menuFor === tab.id}
        moveLeftKeys={moveKeys?.left}
        moveRightKeys={moveKeys?.right}
        offers={offers}
        actions={actions}
      />
    );
  };

  return (
    // The row is the titlebar's drag box, padding and gaps included, so the window drags everywhere in it but its
    // controls. A shell that puts a control over the row's start moves the row past it (a margin) rather than unmarking
    // the row: Electron applies the regions in layout order and the last one over a point wins (#643, #688).
    <div
      data-titlebar
      className={cn(
        "flex h-(--tabbar-height) shrink-0 items-center gap-[3px] border-b border-border bg-chrome px-2.5",
        className,
      )}
    >
      {leading}
      <div
        ref={list}
        role="tablist"
        aria-label="Tabs"
        // As herdr-app's strip: a vertical wheel step selects the previous or next tab, wrapping at the ends as tab.next
        // and tab.prev do (#466 item 8); sideways scrolls the strip.
        onWheel={(event) => {
          if (Math.abs(event.deltaY) < 1 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
          const at = tabs.findIndex((tab) => tab.id === activeId);
          if (at === -1) return;
          const next = tabs[(at + (event.deltaY > 0 ? 1 : -1) + tabs.length) % tabs.length];
          if (next !== undefined && next.id !== activeId) onSelect?.(next.id);
        }}
        className="flex min-w-0 flex-1 items-center gap-[3px]"
      >
        {pins === 0 ? null : (
          <div
            ref={pinnedList}
            data-tab-pins
            onClickCapture={pinnedDrag.onClickCapture}
            className="relative flex shrink-0 items-center gap-[3px] py-1"
          >
            {pinnedDrag.drag === null ? null : <DropIndicator drag={pinnedDrag.drag} />}
            {pinnedDrag.drag === null ? null : <DropCaret drag={pinnedDrag.drag} />}
            {tabs.slice(0, pins).map((tab, index) => tabItem(tab, index))}
          </div>
        )}
        {/* herdr-app's #tab-scroll: tabs alone scroll, with a scrollbar once they overflow, and gap(3) between them.
            py-1 holds the buttons' 4 px hit area (after:-inset-1) inside the strip: past its edge it was scrollable
            overflow, and classic scrollbars drew a vertical bar for it (#343). The strip scrolls only sideways. */}
        <div
          ref={scroller}
          data-tab-scroll
          onClickCapture={restDrag.onClickCapture}
          className="relative flex min-w-0 flex-1 items-center gap-[3px] overflow-x-auto overflow-y-hidden py-1"
        >
          {restDrag.drag === null ? null : <DropIndicator drag={restDrag.drag} />}
          {restDrag.drag === null ? null : <DropCaret drag={restDrag.drag} />}
          {tabs.slice(pins).map((tab, index) => tabItem(tab, index + pins))}
        </div>
      </div>

      {/* Outside the scrolling tabs, as herdr-app's tab-new beside #tab-scroll: 22 tabs never push it away (item 5). */}
      {newMenu === undefined ? (
        <IconButton
          label="New tab"
          {...(newTabKeys === undefined ? {} : { keys: newTabKeys })}
          icon={<Plus />}
          disabled={newDisabled}
          onClick={onNew}
        />
      ) : (
        <Menu
          trigger={
            <IconButton
              label="New tab"
              {...(newTabKeys === undefined ? {} : { keys: newTabKeys })}
              icon={<Plus />}
              disabled={newDisabled}
            />
          }
          className="w-[250px]"
          onOpenChange={(open) => {
            if (!open) return;
            chose.current = false;
            handedTo.current = null;
          }}
          // A choice starts a tab that takes the keyboard at once, so the page stays live (not modal) and, as the menu
          // closes, focus goes where the choice put it rather than back to +, where the next keys typed would press it.
          modal={false}
          // Base UI asks once the closing animation has ended. The page was live all along, so by then the person may
          // have moved on (another menu, a dialog): what holds the keyboard now keeps it (#1014).
          finalFocus={() => {
            const holder = document.activeElement;
            const movedOn = holder instanceof HTMLElement && holder !== document.body && holder !== handedTo.current;
            if (movedOn) return false;
            return chose.current ? (handedTo.current ?? false) : true;
          }}
        >
          <div
            className="contents"
            onClickCapture={(event) => {
              chose.current = true;
              const popup = event.currentTarget;
              const record = (focus: FocusEvent): void => {
                if (focus.target instanceof HTMLElement && !popup.contains(focus.target))
                  handedTo.current = focus.target;
              };
              document.addEventListener("focusin", record, true);
              // Removed once the whole click has been dispatched (microtasks would run between its listeners, before the
              // item's own handler focuses anything).
              setTimeout(() => document.removeEventListener("focusin", record, true), 0);
            }}
          >
            {newMenu}
          </div>
        </Menu>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {said.text}
      </span>
      {trailing}
    </div>
  );
}

import { ArrowLeft, ArrowRight, ArrowRightToLine, CopyX, Pencil, Pin, PinOff, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./icon-button.tsx";
import { ContextMenu, Menu, MenuItem, MenuSeparator, skipMenuHandler } from "./menu.tsx";
import { StatusIndicator, type AgentStatus } from "./status.tsx";
import { useTabDrag } from "./tab-drag.ts";
import { DropCaret, DropIndicator, placement } from "./tab-drop.tsx";

export interface WorkspaceTab {
  readonly id: string;
  readonly title: string;
  readonly icon?: ReactNode;
  readonly status?: AgentStatus;
  /** The id of the tab panel it shows (WAI-ARIA tabs: `aria-controls`). */
  readonly controls?: string;
  /** Pinned in front of the others (#1561): drawn as its icon alone, with no close button. */
  readonly pinned?: boolean;
}

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
 * A tab's title, cut at 170 px with an ellipsis; only a title cut short carries a tooltip with the whole of it (an agent's
 * long name, #1541), so a title that fits has none (#478).
 */
function TabLabel({ text }: { readonly text: string }) {
  const [clipped, setClipped] = useState(false);
  const label = useRef<HTMLSpanElement>(null);
  // Measured again for a new title, whose box can keep its width while the text inside it grows past it.
  useLayoutEffect(() => {
    const element = label.current;
    if (element === null) return undefined;
    const check = (): void => setClipped(element.scrollWidth > element.clientWidth + 1);
    const observer = new ResizeObserver(check);
    observer.observe(element);
    check();
    return () => observer.disconnect();
  }, [text]);
  return (
    // Positioned above the tab button's hit layer (its ::after), so a pointer over the label reaches this title (#1530).
    <span ref={label} title={clipped ? text : undefined} className="relative z-[1] max-w-[170px] truncate">
      {text}
    </span>
  );
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

  // One tab, in whichever group it sits: `index` is its place among all the tabs, which the menu's moves use.
  const tabItem = (tab: WorkspaceTab, index: number): ReactNode => {
    const active = tab.id === activeId;
    const pinned = tab.pinned === true;
    // Pinned tabs lead and keep to their own side of the strip: a move never crosses the last pinned tab (#1561).
    const leftmost = pinned ? 0 : pins;
    const rightmost = pinned ? pins - 1 : tabs.length - 1;
    // Its group's drag, and its place within that group.
    const { drag, settle, onPointerDown } = pinned ? pinnedDrag : restDrag;
    const local = pinned ? index : index - pins;
    const place = placement(tab.id, local, drag, settle);
    const item = (
      <div
        key={tab.id}
        data-tab-id={tab.id}
        {...(drag?.id === tab.id ? { "data-dragging": "" } : {})}
        {...(lifted === tab.id ? { "data-lifted": "" } : {})}
        {...(drawn.before.has(tab.id) ? { "data-arrived": "" } : {})}
        onPointerDown={(event) => onPointerDown(event, tab.id, local)}
        onTouchStart={skipMenuHandler}
        onContextMenu={(event) => {
          if (!touching()) return;
          skipMenuHandler(event);
          event.preventDefault();
        }}
        style={place.offset === 0 ? undefined : { translate: `${place.offset}px 0` }}
        className={cn(
          "group relative motion-arrive flex h-[29px] shrink-0 items-center gap-[7px] rounded-[7px] border pl-2.5 text-[0.8rem] select-none [--arrive-duration:var(--duration-micro)]",
          // A pinned tab has no close button, so it keeps one padding selected or not: selecting it never resizes it.
          active
            ? cn("border-border bg-raised text-foreground", pinned ? "pr-2.5" : "pr-1")
            : "border-transparent pr-2.5 text-muted-foreground hover:bg-hover",
          lifted === tab.id && "border-border bg-raised shadow-overlay hover:bg-raised",
          place.className,
        )}
      >
        <button
          ref={(element) => {
            if (element === null) buttons.current.delete(tab.id);
            else buttons.current.set(tab.id, element);
          }}
          type="button"
          role="tab"
          aria-selected={active}
          aria-controls={tab.controls}
          onClick={() => onSelect?.(tab.id)}
          onDoubleClick={() => onRename?.(tab.id)}
          {...(pinned ? { title: tab.title, "data-pinned": "" } : {})}
          // The hit area spans the whole tab and half the 3 px gap to the next, past the wrapper's 1 px border:
          // no dead column beside its Close button or between two tabs. Close comes later, so it stays on top.
          className="flex min-w-0 items-center gap-[7px] rounded-xs outline-none after:absolute after:inset-y-0 after:-inset-x-[2.5px] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          {pinned && tab.icon === undefined ? <Pin aria-hidden className="size-3.5 shrink-0" /> : tab.icon}
          {pinned ? <span className="sr-only">{tab.title}</span> : <TabLabel text={tab.title} />}
          {/* herdr-app draws nothing for an idle tab: a spinner while working, a dot when blocked or done. */}
          {tab.status === undefined || tab.status === "idle" || tab.status === "unknown" ? null : (
            <StatusIndicator status={tab.status} className="size-3" />
          )}
        </button>
        {active && !pinned ? (
          <IconButton
            label={`Close ${tab.title}`}
            icon={<X />}
            data-tab-close
            onClick={(event) => {
              // Selecting a tab moves the strip (only the selected tab has this button), so the second click of a
              // double-click on the tab can land here: that is a rename of the tab, never its close.
              if (event.detail > 1) onRename?.(tab.id);
              else onClose?.(tab.id);
            }}
            className="size-5 [&_svg:not([data-slot=spinner])]:size-3"
          />
        ) : null}
      </div>
    );
    if (onMove === undefined) return item;
    return (
      <ContextMenu
        key={tab.id}
        trigger={item}
        // An item that opened a dialog (Rename tab…) has given it the keyboard, and the menu closes a moment
        // later: taking focus back to the tab would lose the name typed meanwhile. The question's first paint can
        // come after that close, so what the item chose decides, not who holds the keyboard as the menu goes.
        finalFocus={() => {
          if (handedOn.current) return false;
          const holder = document.activeElement;
          if (holder instanceof HTMLElement && holder.closest('[role="dialog"]') !== null) return false;
          return buttons.current.get(tab.id) ?? true;
        }}
        open={menuFor === tab.id}
        onOpenChange={(open) => {
          if (open) handedOn.current = false;
          setMenuFor(open ? tab.id : null);
        }}
      >
        <MenuItem
          icon={<ArrowLeft />}
          disabled={index <= leftmost}
          {...(moveKeys?.left === undefined ? {} : { keys: moveKeys.left })}
          onClick={() => onMove(tab.id, index - 1)}
        >
          Move tab left
        </MenuItem>
        <MenuItem
          icon={<ArrowRight />}
          disabled={index >= rightmost}
          {...(moveKeys?.right === undefined ? {} : { keys: moveKeys.right })}
          onClick={() => onMove(tab.id, index + 1)}
        >
          Move tab right
        </MenuItem>
        {onRename === undefined ? null : (
          <MenuItem
            icon={<Pencil />}
            onClick={() => {
              handedOn.current = true;
              onRename(tab.id);
            }}
          >
            Rename tab…
          </MenuItem>
        )}
        {onNew === undefined ? null : (
          <MenuItem
            icon={<Plus />}
            onClick={() => {
              handedOn.current = true;
              onNew();
            }}
          >
            New tab
          </MenuItem>
        )}
        {onPin === undefined ? null : (
          <MenuItem icon={pinned ? <PinOff /> : <Pin />} onClick={() => onPin(tab.id, !pinned)}>
            {pinned ? "Unpin tab" : "Pin tab"}
          </MenuItem>
        )}
        {onClose === undefined || pinned ? null : (
          <MenuItem icon={<X />} onClick={() => onClose(tab.id)}>
            Close tab
          </MenuItem>
        )}
        {onCloseSet === undefined ? null : (
          <>
            <MenuSeparator />
            <MenuItem
              icon={<ArrowRightToLine />}
              disabled={!tabs.slice(index + 1).some((each) => each.pinned !== true)}
              onClick={() => onCloseSet(tab.id, "right")}
            >
              Close tabs to the right
            </MenuItem>
            <MenuItem
              icon={<CopyX />}
              disabled={!tabs.some((each, at) => at !== index && each.pinned !== true)}
              onClick={() => onCloseSet(tab.id, "others")}
            >
              Close other tabs
            </MenuItem>
          </>
        )}
      </ContextMenu>
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
          onClick={onNew}
        />
      ) : (
        <Menu
          trigger={
            <IconButton label="New tab" {...(newTabKeys === undefined ? {} : { keys: newTabKeys })} icon={<Plus />} />
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

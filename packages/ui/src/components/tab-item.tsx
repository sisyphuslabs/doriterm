import { ArrowLeft, ArrowRight, ArrowRightToLine, CopyX, Pencil, Pin, PinOff, Plus, X } from "lucide-react";
import { memo, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./icon-button.tsx";
import { ContextMenu, MenuItem, MenuSeparator, skipMenuHandler } from "./menu.tsx";
import { StatusIndicator, type AgentStatus } from "./status.tsx";

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

/** What a tab asks of its strip, by tab id: one object for every tab, the same on every render. */
export interface TabActions {
  readonly select: (id: string) => void;
  readonly close: (id: string) => void;
  readonly rename: (id: string) => void;
  readonly move: (id: string, to: number) => void;
  readonly pin: (id: string, pinned: boolean) => void;
  readonly closeSet: (id: string, which: "right" | "others") => void;
  readonly newTab: () => void;
  readonly pointerDown: (event: PointerEvent<HTMLElement>, id: string, local: number, pinned: boolean) => void;
  readonly touching: () => boolean;
  readonly button: (id: string, element: HTMLButtonElement | null) => void;
  readonly finalFocus: (id: string) => HTMLElement | boolean;
  readonly menuOpenChange: (id: string, open: boolean) => void;
  readonly handOn: () => void;
}

/** Which of the strip's callbacks were given: an item it was not given is not offered. */
export interface TabOffers {
  readonly move: boolean;
  readonly rename: boolean;
  readonly newTab: boolean;
  readonly pin: boolean;
  readonly close: boolean;
  readonly closeSet: boolean;
}

export interface TabItemProps {
  readonly tab: WorkspaceTab;
  /** Its place among all the tabs, which the menu's moves use. */
  readonly index: number;
  /** Its place within its group (pinned or not), which a drag uses. */
  readonly local: number;
  readonly active: boolean;
  /** How far its menu may move it: a move never crosses the last pinned tab (#1561). */
  readonly leftmost: number;
  readonly rightmost: number;
  readonly closesRight: boolean;
  readonly closesOthers: boolean;
  readonly dragging: boolean;
  readonly lifted: boolean;
  /** Drawn before the strip's last change of tabs, so a reorder does not replay its arrival. */
  readonly arrived: boolean;
  readonly offset: number;
  readonly placeClass: string | undefined;
  readonly menuOpen: boolean;
  readonly moveLeftKeys: readonly string[] | undefined;
  readonly moveRightKeys: readonly string[] | undefined;
  readonly offers: TabOffers;
  readonly actions: TabActions;
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

const sameTab = (a: WorkspaceTab, b: WorkspaceTab): boolean =>
  a.id === b.id &&
  a.title === b.title &&
  a.icon === b.icon &&
  a.status === b.status &&
  a.controls === b.controls &&
  a.pinned === b.pinned;

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.join("\u0000") === b.join("\u0000"));

/**
 * A strip draws its tabs afresh on every render, and a terminal event renders the strip; a tab whose own fields and
 * place did not change draws nothing again, so one tab's title costs one tab, not every tab of the space (#2086).
 */
function sameItem(a: TabItemProps, b: TabItemProps): boolean {
  return (
    sameTab(a.tab, b.tab) &&
    a.index === b.index &&
    a.local === b.local &&
    a.active === b.active &&
    a.leftmost === b.leftmost &&
    a.rightmost === b.rightmost &&
    a.closesRight === b.closesRight &&
    a.closesOthers === b.closesOthers &&
    a.dragging === b.dragging &&
    a.lifted === b.lifted &&
    a.arrived === b.arrived &&
    a.offset === b.offset &&
    a.placeClass === b.placeClass &&
    a.menuOpen === b.menuOpen &&
    sameKeys(a.moveLeftKeys, b.moveLeftKeys) &&
    sameKeys(a.moveRightKeys, b.moveRightKeys) &&
    a.offers === b.offers &&
    a.actions === b.actions
  );
}

export const TabItem = memo(function TabItem(props: TabItemProps) {
  const { tab, index, local, active, leftmost, rightmost, closesRight, closesOthers, offers, actions } = props;
  const pinned = tab.pinned === true;
  const item = (
    <div
      data-tab-id={tab.id}
      {...(props.dragging ? { "data-dragging": "" } : {})}
      {...(props.lifted ? { "data-lifted": "" } : {})}
      {...(props.arrived ? { "data-arrived": "" } : {})}
      onPointerDown={(event) => actions.pointerDown(event, tab.id, local, pinned)}
      onTouchStart={skipMenuHandler}
      onContextMenu={(event) => {
        if (!actions.touching()) return;
        skipMenuHandler(event);
        event.preventDefault();
      }}
      style={props.offset === 0 ? undefined : { translate: `${props.offset}px 0` }}
      className={cn(
        "group relative motion-arrive flex h-[29px] shrink-0 items-center gap-[7px] rounded-[7px] border pl-2.5 text-[0.8rem] select-none [--arrive-duration:var(--duration-micro)]",
        // A pinned tab has no close button, so it keeps one padding selected or not: selecting it never resizes it.
        active
          ? cn("border-border bg-raised text-foreground", pinned ? "pr-2.5" : "pr-1")
          : "border-transparent pr-2.5 text-muted-foreground hover:bg-hover",
        props.lifted && "border-border bg-raised shadow-overlay hover:bg-raised",
        props.placeClass,
      )}
    >
      <button
        ref={(element) => actions.button(tab.id, element)}
        type="button"
        role="tab"
        aria-selected={active}
        aria-controls={tab.controls}
        onClick={() => actions.select(tab.id)}
        onDoubleClick={() => actions.rename(tab.id)}
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
            if (event.detail > 1) actions.rename(tab.id);
            else actions.close(tab.id);
          }}
          className="size-5 [&_svg:not([data-slot=spinner])]:size-3"
        />
      ) : null}
    </div>
  );
  if (!offers.move) return item;
  return (
    <ContextMenu
      trigger={item}
      // An item that opened a dialog (Rename tab…) has given it the keyboard, and the menu closes a moment
      // later: taking focus back to the tab would lose the name typed meanwhile. The question's first paint can
      // come after that close, so what the item chose decides, not who holds the keyboard as the menu goes.
      finalFocus={() => actions.finalFocus(tab.id)}
      open={props.menuOpen}
      onOpenChange={(open) => actions.menuOpenChange(tab.id, open)}
    >
      <MenuItem
        icon={<ArrowLeft />}
        disabled={index <= leftmost}
        {...(props.moveLeftKeys === undefined ? {} : { keys: props.moveLeftKeys })}
        onClick={() => actions.move(tab.id, index - 1)}
      >
        Move tab left
      </MenuItem>
      <MenuItem
        icon={<ArrowRight />}
        disabled={index >= rightmost}
        {...(props.moveRightKeys === undefined ? {} : { keys: props.moveRightKeys })}
        onClick={() => actions.move(tab.id, index + 1)}
      >
        Move tab right
      </MenuItem>
      {offers.rename ? (
        <MenuItem
          icon={<Pencil />}
          onClick={() => {
            actions.handOn();
            actions.rename(tab.id);
          }}
        >
          Rename tab…
        </MenuItem>
      ) : null}
      {offers.newTab ? (
        <MenuItem
          icon={<Plus />}
          onClick={() => {
            actions.handOn();
            actions.newTab();
          }}
        >
          New tab
        </MenuItem>
      ) : null}
      {offers.pin ? (
        <MenuItem icon={pinned ? <PinOff /> : <Pin />} onClick={() => actions.pin(tab.id, !pinned)}>
          {pinned ? "Unpin tab" : "Pin tab"}
        </MenuItem>
      ) : null}
      {offers.close && !pinned ? (
        <MenuItem icon={<X />} onClick={() => actions.close(tab.id)}>
          Close tab
        </MenuItem>
      ) : null}
      {offers.closeSet ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<ArrowRightToLine />}
            disabled={!closesRight}
            onClick={() => actions.closeSet(tab.id, "right")}
          >
            Close tabs to the right
          </MenuItem>
          <MenuItem icon={<CopyX />} disabled={!closesOthers} onClick={() => actions.closeSet(tab.id, "others")}>
            Close other tabs
          </MenuItem>
        </>
      ) : null}
    </ContextMenu>
  );
}, sameItem);

import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Check } from "lucide-react";
import {
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { Kbd } from "./kbd.tsx";
import { fitsViewportWidth, overlaySurface } from "./overlay.ts";

export interface MenuProps {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly className?: string;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Keeps the requested side even near a viewport edge; for static previews. */
  readonly fixedSide?: boolean;
  /** Where focus goes once it closes (Base UI's finalFocus); by default back to the trigger. */
  readonly finalFocus?: ComponentProps<typeof BaseMenu.Popup>["finalFocus"];
  /** false: the page stays live while it is open, so what an item starts can take the keyboard at once. */
  readonly modal?: boolean;
  /** The trigger cannot open the menu now: Base UI's trigger owns the button's disabled state, so it is set here. */
  readonly disabled?: boolean;
}

/**
 * A popup never grows past the room the viewport leaves it: it is capped at the positioner's available height and
 * width, and scrolls inside. Fixed positioning measures that room against the visual viewport, so a phone's soft keyboard counts.
 */
const bounded = cn("max-h-(--available-height) overflow-y-auto overscroll-contain", fitsViewportWidth);

/** Brings the item marked `aria-current` (the session open now) into view inside an opened menu. */
function revealCurrent(popup: HTMLElement | null): void {
  popup?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
}

export function Menu(props: MenuProps) {
  const {
    trigger,
    children,
    align = "start",
    className,
    defaultOpen,
    onOpenChange,
    fixedSide = false,
    finalFocus,
    modal,
    disabled = false,
  } = props;
  const popup = useRef<HTMLDivElement | null>(null);
  return (
    <BaseMenu.Root
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(modal === undefined ? {} : { modal })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (open: boolean) => onOpenChange(open) })}
      onOpenChangeComplete={(open) => open && revealCurrent(popup.current)}
    >
      <BaseMenu.Trigger render={trigger} disabled={disabled} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          {...(fixedSide ? { collisionAvoidance: { side: "none" } } : {})}
          align={align}
          sideOffset={6}
          positionMethod="fixed"
        >
          <BaseMenu.Popup
            ref={popup}
            {...(finalFocus === undefined ? {} : { finalFocus })}
            className={cn(overlaySurface, "min-w-48 p-1", bounded, className)}
          >
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export interface ContextMenuProps {
  /** The element whose right-click, Menu key or touch long-press opens the menu at the pointer. */
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  /** Controls the menu; uncontrolled when left out. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Where focus goes when the menu closes (Base UI's finalFocus); its default otherwise. */
  readonly finalFocus?: ComponentProps<typeof BaseContextMenu.Popup>["finalFocus"];
}

/**
 * Keeps Base UI's own handler for this event from running, from a handler on the element a menu renders as its
 * trigger: e.g. a strip that opens the menu on a held touch itself instead of Base UI's long-press timer.
 */
export function skipMenuHandler(event: SyntheticEvent): void {
  const prevent: unknown = Reflect.get(event, "preventBaseUIHandler");
  if (typeof prevent === "function") Reflect.apply(prevent, event, []);
}

/**
 * Leaves a touch's contextmenu (a held press, as Android Chrome sends it) to the trigger's own press: a held row lifts
 * for a drag, a held pane header drags the pane. Only a mouse, a pen or a key opens the menu.
 */
export function skipTouchMenu(event: MouseEvent): void {
  const press = event.nativeEvent;
  if (press instanceof PointerEvent && press.pointerType === "touch") skipMenuHandler(event);
}

export function ContextMenu({ trigger, children, open, onOpenChange, finalFocus }: ContextMenuProps) {
  return (
    <BaseContextMenu.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (next) => onOpenChange(next) })}
    >
      <BaseContextMenu.Trigger render={trigger} />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner positionMethod="fixed">
          <BaseContextMenu.Popup
            {...(finalFocus === undefined ? {} : { finalFocus })}
            className={cn(overlaySurface, "min-w-48 p-1", bounded)}
          >
            {children}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}

export interface PointMenuProps {
  /** Where the menu opens, in viewport px; null keeps it closed. */
  readonly at: { readonly x: number; readonly y: number } | null;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Names the menu for assistive tech. */
  readonly label: string;
}

/**
 * A menu that opens at a point rather than from a trigger: e.g. a link tapped inside a terminal.
 *
 * Closed, it mounts nothing. A closed Base UI menu root still runs its floating, dismiss and list-navigation hooks each
 * time its parent renders, and every terminal pane holds two of these menus (a link's and a held selection's), so 50
 * panes streaming output re-ran 100 closed menus on every pane render (#842). The root is mounted from the moment the
 * menu opens until its close has finished.
 *
 * Base UI runs a menu's enter transition only when its root goes from closed to open, not when it mounts open, so an
 * opening menu first commits its root closed and opens it in a layout effect, before the browser paints: the popup
 * still scales and fades in, and the close still animates out.
 */
export function PointMenu({ at, onClose, children, label }: PointMenuProps) {
  const open = at !== null;
  /** The root has been committed for this opening and its close has not finished yet. */
  const [shown, setShown] = useState(false);
  useLayoutEffect(() => {
    if (open) setShown(true);
  }, [open]);
  if (!open && !shown) return null;
  const anchor =
    at === null ? null : { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }) };
  return (
    <BaseMenu.Root
      open={open && shown}
      onOpenChange={(next) => !next && onClose()}
      onOpenChangeComplete={(next) => !next && !open && setShown(false)}
    >
      <BaseMenu.Portal>
        <BaseMenu.Positioner anchor={anchor} sideOffset={6} positionMethod="fixed">
          <BaseMenu.Popup aria-label={label} className={cn(overlaySurface, "min-w-48 p-1", bounded)}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/** A line of text at the head of a menu, not an item: e.g. where a link really goes. */
export function MenuCaption({ children }: { readonly children: ReactNode }) {
  return <div className="max-w-80 px-2 pt-1 pb-1.5 font-mono text-xs break-all text-muted-foreground">{children}</div>;
}

export interface MenuItemProps extends Omit<ComponentProps<typeof BaseMenu.Item>, "className" | "children"> {
  readonly icon?: ReactNode;
  readonly keys?: readonly string[];
  readonly destructive?: boolean;
  readonly children: ReactNode;
}

export function MenuItem({ icon, keys, destructive = false, children, ...props }: MenuItemProps) {
  return (
    <BaseMenu.Item
      {...props}
      className={cn(
        // A label too long for the menu's width wraps, so the row grows from its usual height instead of running out.
        "flex min-h-(--row) cursor-default items-center gap-2.5 rounded-md px-2 py-1 text-sm outline-none select-none",
        "data-highlighted:bg-hover [&_svg:not([data-slot=spinner])]:size-3.5 [&_svg]:text-muted-foreground",
        destructive && "text-destructive [&_svg]:text-destructive",
        "data-disabled:text-muted-foreground data-disabled:[&_svg]:text-muted-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">{children}</span>
      {keys === undefined ? null : <Kbd keys={keys} />}
    </BaseMenu.Item>
  );
}

export interface MenuRadioGroupProps {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Names the choice, e.g. "Sort agents"; shown as the group's caption. */
  readonly label: string;
  readonly children: ReactNode;
}

/** One choice among menu items: the chosen one carries a check. */
export function MenuRadioGroup({ value, onValueChange, label, children }: MenuRadioGroupProps) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">{label}</BaseMenu.GroupLabel>
      <BaseMenu.RadioGroup value={value} onValueChange={(next: unknown) => onValueChange(String(next))}>
        {children}
      </BaseMenu.RadioGroup>
    </BaseMenu.Group>
  );
}

export function MenuRadioItem({
  value,
  icon,
  children,
}: {
  readonly value: string;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <BaseMenu.RadioItem
      value={value}
      closeOnClick
      className={cn(
        "flex h-(--row) cursor-default items-center gap-2.5 rounded-md px-2 text-sm outline-none select-none",
        "data-highlighted:bg-hover [&_svg:not([data-slot=spinner])]:size-3.5 [&_svg]:text-muted-foreground",
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      <BaseMenu.RadioItemIndicator className="[&_svg]:text-foreground">
        <Check aria-hidden />
      </BaseMenu.RadioItemIndicator>
    </BaseMenu.RadioItem>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="my-1 h-px bg-border" />;
}

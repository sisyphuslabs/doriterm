import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps, ReactElement, ReactNode, RefObject, SyntheticEvent } from "react";
import { cn } from "../lib/cn.ts";
import { Kbd } from "./kbd.tsx";
import { overlaySurface } from "./overlay.ts";

export interface MenuProps {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly align?: "start" | "center" | "end";
  readonly className?: string;
  readonly defaultOpen?: boolean;
  /** Keeps the requested side even near a viewport edge; for static previews. */
  readonly fixedSide?: boolean;
}

export function Menu({ trigger, children, align = "start", className, defaultOpen, fixedSide = false }: MenuProps) {
  return (
    <BaseMenu.Root {...(defaultOpen === undefined ? {} : { defaultOpen })}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          {...(fixedSide ? { collisionAvoidance: { side: "none" } } : {})}
          align={align}
          sideOffset={6}
        >
          <BaseMenu.Popup className={cn(overlaySurface, "min-w-48 p-1", className)}>{children}</BaseMenu.Popup>
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
  /** Where focus goes when the menu closes; Base UI's default otherwise. */
  readonly finalFocus?: RefObject<HTMLElement | null>;
}

/**
 * Keeps Base UI's own handler for this event from running, from a handler on the element a menu renders as its
 * trigger: e.g. a strip that opens the menu on a held touch itself instead of Base UI's long-press timer.
 */
export function skipMenuHandler(event: SyntheticEvent): void {
  const prevent: unknown = Reflect.get(event, "preventBaseUIHandler");
  if (typeof prevent === "function") Reflect.apply(prevent, event, []);
}

export function ContextMenu({ trigger, children, open, onOpenChange, finalFocus }: ContextMenuProps) {
  return (
    <BaseContextMenu.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange: (next) => onOpenChange(next) })}
    >
      <BaseContextMenu.Trigger render={trigger} />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner>
          <BaseContextMenu.Popup
            {...(finalFocus === undefined ? {} : { finalFocus })}
            className={cn(overlaySurface, "min-w-48 p-1")}
          >
            {children}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
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
        "flex h-(--row) cursor-default items-center gap-2.5 rounded-md px-2 text-sm outline-none select-none",
        "data-highlighted:bg-hover data-disabled:opacity-45 [&_svg]:size-3.5 [&_svg]:text-muted-foreground",
        destructive && "text-destructive [&_svg]:text-destructive",
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {keys === undefined ? null : <Kbd keys={keys} />}
    </BaseMenu.Item>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="my-1 h-px bg-border" />;
}

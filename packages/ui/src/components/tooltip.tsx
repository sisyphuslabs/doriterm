import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Kbd } from "./kbd.tsx";
import { wrapAnywhere } from "./overlay.ts";

export const TooltipProvider = BaseTooltip.Provider;

export interface TooltipProps {
  readonly label: ReactNode;
  /** Shortcut shown after the label, e.g. ["⌘", "B"]. */
  readonly keys?: readonly string[];
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly children: ReactElement;
  readonly className?: string;
  readonly defaultOpen?: boolean;
}

/** A short label for an icon or truncated control. Never the only way to learn an action. */
export function Tooltip({ label, keys, side = "bottom", children, className, defaultOpen }: TooltipProps) {
  return (
    <BaseTooltip.Root {...(defaultOpen === undefined ? {} : { defaultOpen })}>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6}>
          <BaseTooltip.Popup
            className={cn(
              "flex items-center gap-2 rounded-sm border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-overlay",
              // A real name stays on one line as before (a 31-character Korean one is 352 px); a longer label wraps at
              // 28rem, or sooner where the viewport leaves less room.
              "max-w-[min(28rem,var(--available-width))]",
              wrapAnywhere,
              "origin-(--transform-origin) transition-[opacity,transform] duration-(--duration-micro)",
              "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0",
              className,
            )}
          >
            {label}
            {keys === undefined ? null : <Kbd keys={keys} variant="plain" />}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

import { ScrollArea as BaseScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode, Ref } from "react";
import { cn } from "../lib/cn.ts";

export interface ScrollAreaProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly viewportClassName?: string;
  /** Marks this as the region's one scroll owner, for layout checks. */
  readonly slot?: string;
  /** The element that scrolls, for a screen that keeps its offset across a remount. */
  readonly viewportRef?: Ref<HTMLDivElement>;
}

/**
 * An overlay scrollbar that appears while scrolling; content never loses a gutter to it. The viewport scrolls only
 * vertically, and as `auto` over Base UI's inline `scroll`, which draws classic scrollbars with nothing to scroll (#343).
 */
export function ScrollArea({ children, className, viewportClassName, slot, viewportRef }: ScrollAreaProps) {
  return (
    <BaseScrollArea.Root className={cn("relative min-h-0 overflow-hidden", className)}>
      <BaseScrollArea.Viewport
        ref={viewportRef}
        data-slot={slot}
        className={cn(
          "size-full overflow-x-hidden! overflow-y-auto! overscroll-contain outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
          viewportClassName,
        )}
      >
        {children}
      </BaseScrollArea.Viewport>
      <BaseScrollArea.Scrollbar
        orientation="vertical"
        className="flex w-2 justify-center p-0.5 opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100"
      >
        <BaseScrollArea.Thumb className="w-full rounded-full bg-input" />
      </BaseScrollArea.Scrollbar>
    </BaseScrollArea.Root>
  );
}

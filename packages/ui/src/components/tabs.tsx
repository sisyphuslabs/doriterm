import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ComponentProps, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { useScrollEdges } from "../lib/scroll-edges.ts";

type ClassNameless<T> = Omit<T, "className"> & { readonly className?: string };

export const Tabs = BaseTabs.Root;

/** Fades only the edges that hide tabs, so a label that fits is never under a fade. */
const MASK = {
  none: "",
  start: "[mask-image:linear-gradient(to_right,transparent,black_2.5rem)]",
  end: "[mask-image:linear-gradient(to_left,transparent,black_2.5rem)]",
  both: "[mask-image:linear-gradient(to_right,transparent,black_2.5rem,black_calc(100%-2.5rem),transparent)]",
} as const;

/**
 * A pointer cue that more tabs lie past an edge, and a way to reach them; keyboard users move between tabs with the
 * arrow keys, which scroll the focused tab into view, so the cue stays out of the tab order.
 */
function EdgeCue({ side, onPage }: { readonly side: "start" | "end"; readonly onPage: () => void }) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      data-tab-edge={side}
      onClick={onPage}
      className={cn(
        "absolute top-0 bottom-px z-10 flex w-8 items-center justify-center bg-background text-muted-foreground hover:text-foreground",
        side === "start" ? "left-0" : "right-0",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

export function TabList({ className, ...props }: ClassNameless<ComponentProps<typeof BaseTabs.List>>) {
  const list = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(list);
  const page = (direction: 1 | -1) => () => {
    const element = list.current;
    if (element !== null) element.scrollBy({ left: direction * element.clientWidth * 0.8, behavior: "smooth" });
  };
  const mask = edges.start && edges.end ? "both" : edges.start ? "start" : edges.end ? "end" : "none";
  return (
    <div className="relative" data-tab-overflow={mask}>
      <BaseTabs.List
        {...props}
        ref={list}
        className={cn(
          "flex snap-x snap-proximity items-center gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]",
          MASK[mask],
          className,
        )}
      />
      {edges.start ? <EdgeCue side="start" onPage={page(-1)} /> : null}
      {edges.end ? <EdgeCue side="end" onPage={page(1)} /> : null}
    </div>
  );
}

/** A noun-labelled section switch. The active tab carries weight and a raised tone, never a coloured underline. */
export function Tab({ className, ...props }: ClassNameless<ComponentProps<typeof BaseTabs.Tab>>) {
  return (
    <BaseTabs.Tab
      {...props}
      className={cn(
        "-mb-px inline-flex h-(--control) shrink-0 snap-start items-center gap-1.5 rounded-t-sm px-3 text-sm text-muted-foreground outline-none",
        "hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
        "data-active:bg-raised data-active:font-medium data-active:text-foreground",
        className,
      )}
    />
  );
}

export function TabPanel({ className, ...props }: ClassNameless<ComponentProps<typeof BaseTabs.Panel>>) {
  return <BaseTabs.Panel {...props} className={cn("outline-none", className)} />;
}

import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ComponentProps, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { useScrollEdges } from "../lib/scroll-edges.ts";

type ClassNameless<T> = Omit<T, "className"> & { readonly className?: string };

export const Tabs = BaseTabs.Root;

const CUE_SLOT = "flex w-8 shrink-0 items-center justify-center";

/**
 * A pointer cue that more tabs lie past an edge, and a way to reach them; keyboard users move between tabs with the
 * arrow keys, which scroll the focused tab into view, so the cue stays out of the tab order. It sits beside the
 * scrolling list, not over it, so no tab label is ever under it.
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
      className={cn(CUE_SLOT, "text-muted-foreground hover:text-foreground")}
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
  const overflow = edges.start && edges.end ? "both" : edges.start ? "start" : edges.end ? "end" : "none";
  return (
    // While the strip overflows both slots stay, so a cue that comes or goes never changes the list's width. The rule
    // under the strip is drawn once, under the slots and the list together.
    <div className="flex border-b border-border" data-tab-overflow={overflow}>
      {edges.start ? (
        <EdgeCue side="start" onPage={page(-1)} />
      ) : overflow === "none" ? null : (
        <span className={CUE_SLOT} />
      )}
      <BaseTabs.List
        {...props}
        ref={list}
        className={cn(
          "flex min-w-0 flex-1 snap-x snap-proximity items-center gap-1 overflow-x-auto [scrollbar-width:none]",
          className,
        )}
      />
      {edges.end ? <EdgeCue side="end" onPage={page(1)} /> : overflow === "none" ? null : <span className={CUE_SLOT} />}
    </div>
  );
}

/** A noun-labelled section switch. The active tab carries weight and a raised tone, never a coloured underline. */
export function Tab({ className, ...props }: ClassNameless<ComponentProps<typeof BaseTabs.Tab>>) {
  return (
    <BaseTabs.Tab
      {...props}
      className={cn(
        "inline-flex h-(--control) shrink-0 snap-start items-center gap-1.5 rounded-t-sm px-3 text-sm text-muted-foreground outline-none",
        // The ring is drawn inside the tab: the scrolling list clips anything outside it.
        "hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring",
        "data-active:bg-raised data-active:font-medium data-active:text-foreground",
        className,
      )}
    />
  );
}

export function TabPanel({ className, ...props }: ClassNameless<ComponentProps<typeof BaseTabs.Panel>>) {
  return <BaseTabs.Panel {...props} className={cn("outline-none", className)} />;
}

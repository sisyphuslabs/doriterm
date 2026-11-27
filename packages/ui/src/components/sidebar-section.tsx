import { type ReactNode, type Ref, useId } from "react";
import { cn } from "../lib/cn.ts";

export interface SidebarSectionProps {
  readonly title: ReactNode;
  readonly count?: number;
  /** Top-level sidebar region ("Spaces", "Agents") vs nested status/space sub-group. */
  readonly variant?: "region" | "group";
  /** Text colour class for the title, e.g. a status colour for "Needs you". */
  readonly tone?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /** The section element, e.g. for a list that measures its rows to drag them. */
  readonly ref?: Ref<HTMLElement>;
}

/** A labelled group in the sidebar. The label names the group; the count is its size. */
export function SidebarSection({
  title,
  count,
  variant = "group",
  tone,
  action,
  children,
  className,
  ref,
}: SidebarSectionProps) {
  const heading = useId();
  const isRegion = variant === "region";
  return (
    <section ref={ref} aria-labelledby={heading} className={cn("flex flex-col gap-px", className)}>
      {/* The header aligns to its rows' left edge (px-2), with the count 6 px after the title and action at the end. Its
          text sits at the header's foot, nearer its own rows than the section above (#1496, #2864). */}
      <header
        className={cn(
          "flex min-h-7 items-center justify-between gap-2 pl-2 pr-2",
          isRegion ? "text-[11px] font-semibold" : "text-xs font-medium",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <h2
            id={heading}
            className={cn(
              "min-w-0 truncate",
              isRegion ? "tracking-[0.06em] text-muted-foreground/80 uppercase" : "text-muted-foreground",
              tone,
            )}
          >
            {title}
          </h2>
          {count === undefined ? null : (
            <span data-numeric className="shrink-0 font-normal text-muted-foreground/70">
              {count}
            </span>
          )}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

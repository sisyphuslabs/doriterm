import { type ReactNode, type Ref, useId } from "react";
import { cn } from "../lib/cn.ts";

export interface SidebarSectionProps {
  readonly title: ReactNode;
  readonly count?: number;
  /** Text colour class for the title, e.g. a status colour for "Needs you". */
  readonly tone?: string;
  readonly action?: ReactNode;
  /** The rows reserve a leading fold column: the title moves right with their label column (18 px and its 4 px gap). */
  readonly indent?: boolean;
  /** The rows draw a mark before their label (an agent's): the title moves right by it (14 px and the 2 px before it). */
  readonly marked?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  /** The section element, e.g. for a list that measures its rows to drag them. */
  readonly ref?: Ref<HTMLElement>;
}

/** The title's left pad, by [fold column reserved][rows draw a mark]: 34 px, then 22 px for the column, 16 px for the mark. */
const TITLE_PAD = [
  ["pl-8.5", "pl-12.5"],
  ["pl-14", "pl-18"],
] as const;

/** A labelled group in the sidebar. The label names the group; the count is its size. */
export function SidebarSection({
  title,
  count,
  tone,
  action,
  indent = false,
  marked = false,
  children,
  className,
  ref,
}: SidebarSectionProps) {
  const heading = useId();
  return (
    <section ref={ref} aria-labelledby={heading} className={cn("flex flex-col gap-px", className)}>
      {/* The title starts on its rows' label column (a row's px-2, size-4 glyph and gap-2.5), so it heads them. */}
      <header
        className={cn(
          "flex min-h-7 items-center gap-2 pr-2 text-xs font-medium",
          TITLE_PAD[Number(indent)]?.[Number(marked)],
        )}
      >
        <h2 id={heading} className={cn("min-w-0 flex-1 truncate text-muted-foreground", tone)}>
          {title}
        </h2>
        {count === undefined ? null : (
          <span data-numeric className="text-muted-foreground">
            {count}
          </span>
        )}
        {action}
      </header>
      {children}
    </section>
  );
}

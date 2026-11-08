import { type ReactNode, type Ref, useId } from "react";
import { cn } from "../lib/cn.ts";

export interface SidebarSectionProps {
  readonly title: ReactNode;
  readonly count?: number;
  /** Text colour class for the title, e.g. a status colour for "Needs you". */
  readonly tone?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  /** The section element, e.g. for a list that measures its rows to drag them. */
  readonly ref?: Ref<HTMLElement>;
}

/** A labelled group in the sidebar. The label names the group; the count is its size. */
export function SidebarSection({ title, count, tone, action, children, className, ref }: SidebarSectionProps) {
  const heading = useId();
  return (
    <section ref={ref} aria-labelledby={heading} className={cn("flex flex-col gap-px", className)}>
      {/* The title starts on its rows' label column (a row's px-2, size-4 glyph and gap-2.5), so it heads them. */}
      <header className="flex min-h-7 items-center gap-2 pr-2 pl-8.5 text-xs font-medium">
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

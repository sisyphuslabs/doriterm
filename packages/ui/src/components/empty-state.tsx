import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** The next step: usually one primary button and at most one secondary. */
  readonly actions?: ReactNode;
  /** Extra evidence, e.g. a fingerprint comparison. */
  readonly children?: ReactNode;
  /** "screen" makes the title a 2xl screen title, for empty states that are a whole step or page. */
  readonly size?: "panel" | "screen";
  readonly className?: string;
}

/** What happened and what to do next, centred in the region that is empty. */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  children,
  size = "panel",
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn("mx-auto flex w-full max-w-md flex-col items-center gap-3 px-6 py-10 text-center", className)}
    >
      {icon === undefined ? null : (
        <span className="flex text-muted-foreground [&_svg:not([data-slot=spinner])]:size-8 [&_svg:not([data-slot=spinner])]:stroke-[1.5]">
          {icon}
        </span>
      )}
      {size === "screen" ? (
        <h1 className="text-2xl font-semibold text-balance text-foreground">{title}</h1>
      ) : (
        <h2 className="text-lg font-semibold text-balance text-foreground">{title}</h2>
      )}
      {description === undefined ? null : <p className="text-base text-pretty text-muted-foreground">{description}</p>}
      {children}
      {actions === undefined ? null : <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

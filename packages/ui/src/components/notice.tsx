import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";

export interface NoticeProps {
  readonly tone?: "info" | "warning" | "error";
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

const TINT = {
  info: "bg-selected",
  warning: "bg-raised",
  error: "bg-status-blocked/12",
} as const;

/** Secondary words on the red wash are the ink at reduced alpha, which takes on the wash; a neutral gray reads dirty. */
const BODY = {
  info: "text-muted-foreground",
  warning: "text-muted-foreground",
  error: "text-foreground/80",
} as const;

const ICON = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;
const ICON_TONE = {
  info: "text-muted-foreground",
  warning: "text-foreground",
  error: "text-status-blocked-text",
} as const;

/**
 * An inline problem next to the thing it affects: a tonal wash, a glyph, words and the fix.
 * Warning stays neutral so amber keeps meaning "working".
 */
export function Notice({ tone = "info", title, children, actions, className }: NoticeProps) {
  const Icon = ICON[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-3 rounded-lg p-3", TINT[tone], className)}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", ICON_TONE[tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-prose font-semibold text-foreground">{title}</p>
        {children === undefined ? null : <div className={cn("mt-0.5 text-prose", BODY[tone])}>{children}</div>}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

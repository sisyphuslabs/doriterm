import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export const badgeVariants = cva(
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs px-1.5 text-2xs font-semibold whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-selected text-muted-foreground",
        working: "bg-status-working/15 text-status-working-text",
        blocked: "bg-status-blocked/15 text-status-blocked-text",
        done: "bg-status-done/15 text-status-done-text",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  readonly children: ReactNode;
  readonly className?: string;
}

/** A value that can change: a count, a state. Never decoration. */
export function Badge({ tone, children, className }: BadgeProps) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ tone }), className)}>
      {children}
    </span>
  );
}

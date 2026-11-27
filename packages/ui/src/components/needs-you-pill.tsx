import type { JSX } from "react";
import { cn } from "../lib/cn.ts";
import { StatusIndicator } from "./status.tsx";

export interface NeedsYouPillProps {
  readonly count: number;
  readonly compact?: boolean;
  readonly onOpen: () => void;
  readonly className?: string;
}

/**
 * Top-bar attention pill: jumps to the next terminal waiting on the user.
 * Renders nothing while count <= 0.
 */
export function NeedsYouPill({ count, compact = false, onOpen, className }: NeedsYouPillProps): JSX.Element | null {
  if (count <= 0) return null;
  const ariaLabel = `${count} needs you, open the next`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={ariaLabel}
      title="Open the next terminal that needs you"
      className={cn(
        "motion-arrive relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full text-2xs font-semibold whitespace-nowrap tabular-nums select-none",
        "bg-status-blocked/15 text-status-blocked-text hover:bg-status-blocked/20",
        "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring",
        "[--arrive-from:scale(0.97)] transition-transform duration-(--duration-press) ease-out active:scale-[0.97] motion-reduce:active:scale-none",
        "after:absolute after:-inset-1 coarse:after:inset-[min(-0.25rem,calc(50%-1.375rem))]",
        compact ? "px-2" : "px-2.5",
        className,
      )}
    >
      <StatusIndicator status="blocked" decorative />
      {compact ? String(count) : `${count} needs you`}
    </button>
  );
}

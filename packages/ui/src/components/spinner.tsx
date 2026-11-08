import { cn } from "../lib/cn.ts";

export interface SpinnerProps {
  readonly className?: string;
  /** Accessible label; omit when a visible label sits next to it. */
  readonly label?: string;
}

/** herdr-app's working glyph: one turn per 900 ms, or a gentle opacity pulse under reduced motion. */
export function Spinner({ className, label }: SpinnerProps) {
  return (
    <svg
      data-slot="spinner"
      viewBox="0 0 16 16"
      fill="none"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn("size-3 shrink-0 animate-spin-status", className)}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

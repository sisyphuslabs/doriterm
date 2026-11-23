import { cn } from "../lib/cn.ts";

export interface MatchCodeProps {
  readonly code: string;
  readonly label: string;
  readonly className?: string;
}

/**
 * Six-digit verification code shown in large tabular monospace digits, grouped 3+3.
 * Assistive tech hears the label followed by each digit spaced one by one so it is never read as a large number.
 */
export function MatchCode({ code, label, className }: MatchCodeProps) {
  const compact = code.replaceAll(/\s+/g, "");
  const groups = compact.match(/.{1,3}/g) ?? [];
  const spoken = `${label}: ${[...compact].join(" ")}`;
  return (
    <div
      role="img"
      aria-label={spoken}
      className={cn(
        "flex flex-col items-center gap-1 rounded-lg border border-border bg-raised px-4 py-3 text-center",
        className,
      )}
    >
      <span aria-hidden="true" className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <span
        aria-hidden="true"
        data-numeric=""
        className="font-mono text-2xl font-semibold tracking-widest text-foreground tabular-nums select-all"
      >
        {groups.join(" ")}
      </span>
    </div>
  );
}

import { cn } from "../lib/cn.ts";

export interface KbdProps {
  /** One entry per key, e.g. ["⌘", "⇧", "P"]. */
  readonly keys: readonly string[];
  /** Keep the chips on touch layouts too, where a value (a binding) rather than a hint is shown. */
  readonly persistent?: boolean;
  /** "chip" draws slim bordered keycaps (Keybindings, empty states); "plain" draws quiet macOS-style inline hints. */
  readonly variant?: "chip" | "plain";
  readonly className?: string;
}

/** Keyboard shortcut hints. Touch layouts hide them unless `persistent`. */
export function Kbd({ keys, persistent = false, variant = "chip", className }: KbdProps) {
  const plain = variant === "plain";
  return (
    <kbd
      className={cn(
        "inline-flex items-center font-sans",
        plain ? "gap-px text-[11px] font-medium tracking-[0.02em] text-muted-foreground/80" : "gap-[3px]",
        !persistent && "coarse:hidden",
        className,
      )}
    >
      {keys.map((key) => (
        <span
          key={key}
          className={
            plain
              ? "inline-flex items-center justify-center leading-none"
              : "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-border/80 bg-surface/80 px-1 font-sans text-[11px] leading-none font-medium text-muted-foreground"
          }
        >
          {key}
        </span>
      ))}
    </kbd>
  );
}

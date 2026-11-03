import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export interface ExtraKey {
  readonly id: string;
  readonly label: ReactNode;
  /** Spoken name, e.g. "Escape". */
  readonly name: string;
  /** Sticky modifiers stay pressed for the next key. */
  readonly modifier?: boolean;
}

export const DEFAULT_EXTRA_KEYS: readonly ExtraKey[] = [
  { id: "esc", label: "esc", name: "Escape" },
  { id: "tab", label: "tab", name: "Tab" },
  { id: "ctrl", label: "ctrl", name: "Control", modifier: true },
  { id: "alt", label: "alt", name: "Option", modifier: true },
  { id: "left", label: <ArrowLeft />, name: "Left arrow" },
  { id: "up", label: <ArrowUp />, name: "Up arrow" },
  { id: "down", label: <ArrowDown />, name: "Down arrow" },
  { id: "right", label: <ArrowRight />, name: "Right arrow" },
];

export interface ExtraKeysBarProps {
  readonly keys?: readonly ExtraKey[];
  /** Ids of modifiers currently latched. */
  readonly latched?: readonly string[];
  readonly onKey?: (id: string) => void;
  readonly className?: string;
}

/**
 * Keys a phone keyboard lacks, docked above it. Each key is a 44 pt target. A latched modifier
 * inverts to solid ink and gains a bar under its label, so it reads as on in both themes.
 */
export function ExtraKeysBar({ keys = DEFAULT_EXTRA_KEYS, latched = [], onKey, className }: ExtraKeysBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      className={cn(
        "flex shrink-0 gap-1 border-t border-border bg-chrome px-1.5 pt-1 pb-[max(0.25rem,var(--safe-bottom))]",
        className,
      )}
    >
      {keys.map((key) => {
        const on = latched.includes(key.id);
        return (
          <button
            key={key.id}
            type="button"
            aria-label={key.name}
            aria-pressed={key.modifier === true ? on : undefined}
            onClick={() => onKey?.(key.id)}
            className={cn(
              "relative flex h-11 min-w-0 flex-1 items-center justify-center rounded-md font-mono text-sm outline-none [&_svg]:size-4",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
              on
                ? "bg-primary font-semibold text-primary-foreground after:absolute after:bottom-1.5 after:h-0.5 after:w-3 after:rounded-full after:bg-current active:opacity-80"
                : "bg-raised text-foreground active:bg-selected",
            )}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}

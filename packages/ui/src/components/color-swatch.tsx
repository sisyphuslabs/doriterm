import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export interface ColorSwatchProps extends Omit<ComponentProps<"button">, "className" | "children" | "color"> {
  /** Any CSS colour; the chip shows it, the label below names it. */
  readonly color: string;
  /** Visible name, e.g. "0" for ansi0 or "selection-background". */
  readonly label: string;
  /** The colour value as text, e.g. "#2a2723". */
  readonly value?: string;
  readonly selected?: boolean;
  readonly className?: string;
}

/**
 * One editable colour: a chip of the colour on a hairline frame, its name and value below.
 * Selected is a wash plus a check over the chip; the chip itself never changes size.
 */
export function ColorSwatch({ color, label, value, selected = false, className, ...props }: ColorSwatchProps) {
  return (
    <button
      {...props}
      type="button"
      aria-pressed={selected}
      className={cn(
        "group flex min-w-0 flex-col items-stretch gap-1 rounded-md p-1 text-left outline-none",
        "hover:bg-hover active:bg-selected focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:pointer-events-none",
        selected && "bg-selected",
        className,
      )}
    >
      <span
        aria-hidden
        className="relative flex h-8 items-center justify-center rounded-sm border border-input coarse:h-11"
        style={{ background: color }}
      >
        {selected ? (
          <span className="flex size-4 items-center justify-center rounded-full bg-popover text-foreground">
            <Check className="size-3" />
          </span>
        ) : null}
      </span>
      <span className="truncate text-2xs text-foreground group-disabled:text-muted-foreground">{label}</span>
      {value === undefined ? null : <span className="truncate font-mono text-2xs text-muted-foreground">{value}</span>}
    </button>
  );
}

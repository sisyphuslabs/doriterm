import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onValueChange?: (value: T) => void;
  readonly label: string;
  readonly disabled?: boolean;
  /** Tighter segments, for a row that must fit a phone at its narrowest (the palette's state row, #1454). */
  readonly compact?: boolean;
  readonly className?: string;
}

/** One choice among two to four peers. The selected segment is a raised tone, not an accent fill. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  label,
  disabled = false,
  compact = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      aria-label={label}
      disabled={disabled}
      value={[value]}
      onValueChange={(next) => {
        const picked = options.find((option) => next.includes(option.value));
        if (picked !== undefined && onValueChange !== undefined) onValueChange(picked.value);
      }}
      className={cn("inline-flex gap-0.5 rounded-md border border-border bg-chrome p-0.5", className)}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className={cn(
            "inline-flex h-[calc(var(--control)-6px)] flex-1 coarse:h-(--control) items-center justify-center gap-1.5 rounded-sm text-sm whitespace-nowrap text-muted-foreground",
            compact ? "px-1.5 coarse:min-w-[max(var(--hit),min-content)]" : "px-3",
            "outline-none transition-colors duration-(--duration-micro) hover:text-foreground",
            "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-pressed:bg-popover data-pressed:text-foreground data-pressed:shadow-[0_0_0_1px_var(--border)]",
          )}
        >
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

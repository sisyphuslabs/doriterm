import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Check } from "lucide-react";
import { cn } from "../lib/cn.ts";
import type { ResolvedTheme } from "../theme/resolve.ts";

export interface ThemeOption {
  readonly id: string;
  readonly name: string;
  readonly source: string;
  readonly theme: ResolvedTheme;
  /** Set for an option that follows the system appearance: `theme` is its light side, this its dark side. */
  readonly dark?: ResolvedTheme;
}

export interface ThemePickerProps {
  readonly options: readonly ThemeOption[];
  readonly value: string;
  readonly onValueChange?: (id: string) => void;
  /** The group's accessible name. */
  readonly label?: string;
  readonly className?: string;
}

function Preview({ theme, className }: { readonly theme: ResolvedTheme; readonly className?: string }) {
  const r = theme.roles;
  return (
    <span className={cn("flex min-w-0", className)} style={{ background: r.chrome }}>
      <span className="w-1/3" style={{ background: r.chrome }} />
      <span className="flex flex-1 flex-col justify-center gap-1 px-2" style={{ background: r.background }}>
        {[r.accent, r.working, r.blocked, r.done].map((color, index) => (
          <span key={index} className="h-1 rounded-full" style={{ background: color, width: "70%" }} />
        ))}
      </span>
    </span>
  );
}

/**
 * Theme swatches drawn from each theme's own colours. A system-following option shows its light and
 * dark sides split down the middle. Selection is a wash plus a check, not a coloured ring.
 */
export function ThemePicker({ options, value, onValueChange, label = "Theme", className }: ThemePickerProps) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") onValueChange?.(next);
      }}
      className={cn("grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2", className)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.id}
          value={option.id}
          className={cn(
            "group flex flex-col gap-2 rounded-lg border border-border p-2 text-left outline-none",
            "hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-checked:bg-selected",
          )}
        >
          <span aria-hidden className="flex h-11 overflow-hidden rounded-md border border-border">
            <Preview theme={option.theme} className="flex-1" />
            {option.dark === undefined ? null : <Preview theme={option.dark} className="flex-1" />}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1">
              <span title={option.name} className="block truncate text-sm text-foreground">
                {option.name}
              </span>
              <span title={option.source} className="block truncate text-xs text-muted-foreground">
                {option.source}
              </span>
            </span>
            <Radio.Indicator className="flex size-4 items-center justify-center text-foreground">
              <Check className="size-3.5" />
            </Radio.Indicator>
          </span>
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

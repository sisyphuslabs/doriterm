import { Switch as BaseSwitch } from "@base-ui/react/switch";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn.ts";

export interface SwitchProps extends Omit<ComponentProps<typeof BaseSwitch.Root>, "className"> {
  readonly className?: string;
}

/** On and off differ by position and fill, never colour alone. */
export function Switch({ className, ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root
      {...props}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input bg-hover p-0.5 outline-none",
        "transition-colors duration-(--duration-micro) data-checked:border-transparent data-checked:bg-brand",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring data-disabled:opacity-45",
        "after:absolute after:-inset-2 coarse:after:-inset-3",
        className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          "size-3.5 rounded-full bg-muted-foreground transition-transform duration-(--duration-micro) ease-out",
          "data-checked:translate-x-4 data-checked:bg-brand-foreground",
        )}
      />
    </BaseSwitch.Root>
  );
}

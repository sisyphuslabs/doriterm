import { NumberField } from "@base-ui/react/number-field";
import { Minus, Plus } from "lucide-react";
import { cn } from "../lib/cn.ts";

export interface NumberStepperProps {
  readonly label: string;
  readonly value?: number;
  readonly defaultValue?: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly onValueChange?: (value: number | null) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

const stepButton = cn(
  "flex size-(--control) items-center justify-center text-muted-foreground outline-none hover:bg-hover hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5",
  "data-disabled:pointer-events-none data-disabled:text-disabled-glyph",
);

/** − value + for small bounded numbers such as font size. */
export function NumberStepper({ label, className, ...props }: NumberStepperProps) {
  return (
    <NumberField.Root {...props} className={cn("inline-flex", className)}>
      <NumberField.Group className="inline-flex items-center overflow-hidden rounded-md border border-input bg-raised data-disabled:border-border">
        <NumberField.Decrement aria-label={`Decrease ${label}`} className={stepButton}>
          <Minus />
        </NumberField.Decrement>
        <NumberField.Input
          aria-label={label}
          className="h-(--control) w-12 border-x border-border bg-transparent text-center text-base text-foreground outline-none tabular-nums data-disabled:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
        />
        <NumberField.Increment aria-label={`Increase ${label}`} className={stepButton}>
          <Plus />
        </NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  );
}

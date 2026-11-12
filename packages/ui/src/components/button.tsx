import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { useDelayedTrue } from "../lib/spinner-delay.ts";
import { Spinner } from "./spinner.tsx";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium",
    "outline-none transition-[background-color,color,opacity,transform] duration-(--duration-micro) ease-out",
    "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
    // Disabled is dimmed with its own colours, never a fade of the whole button, which fades the label with its fill
    // (#1031): a label of at least 4.5:1 on every variant (#1496) and a ghost icon of 3:1, on every surface in both themes.
    // Loading also sets disabled, but a working button is busy, not unavailable: it keeps its colours (aria-busy).
    "active:scale-[0.97] data-disabled:pointer-events-none",
    "[&_svg:not([data-slot=spinner])]:size-4 [&_svg]:shrink-0",
    "after:absolute after:-inset-1 coarse:after:min-h-11 coarse:after:min-w-11",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:opacity-88 data-disabled:not-aria-busy:bg-selected data-disabled:not-aria-busy:text-foreground/70",
        secondary:
          "border border-border bg-raised text-foreground hover:bg-selected data-disabled:not-aria-busy:bg-transparent data-disabled:not-aria-busy:text-muted-foreground",
        ghost:
          "text-foreground/85 hover:bg-hover hover:text-foreground data-disabled:not-aria-busy:text-muted-foreground data-disabled:not-aria-busy:[&_svg]:text-disabled-glyph",
        destructive:
          "bg-destructive text-destructive-foreground hover:opacity-88 data-disabled:not-aria-busy:bg-selected data-disabled:not-aria-busy:text-foreground/70",
      },
      size: {
        sm: "h-(--control-sm) px-2.5 text-sm",
        md: "h-(--control) px-3 text-base",
        lg: "h-(--control-lg) px-4 text-base",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends Omit<ComponentProps<typeof BaseButton>, "className" | "children">, VariantProps<typeof buttonVariants> {
  readonly className?: string;
  readonly children?: ReactNode;
  /** Blocks input at once; after one second a spinner replaces the label without changing its box. */
  readonly loading?: boolean;
}

export function Button({ className, variant, size, loading = false, disabled, children, ...props }: ButtonProps) {
  const spinning = useDelayedTrue(loading);
  return (
    <BaseButton
      {...props}
      disabled={disabled === true || loading}
      focusableWhenDisabled={loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {spinning ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      ) : null}
      <span className={cn("inline-flex items-center justify-center gap-[inherit]", spinning && "opacity-0")}>
        {children}
      </span>
    </BaseButton>
  );
}

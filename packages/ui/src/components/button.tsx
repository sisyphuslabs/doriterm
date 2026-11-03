import { Button as BaseButton } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Spinner } from "./spinner.tsx";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium",
    "outline-none transition-[background-color,color,opacity,transform] duration-(--duration-micro) ease-out",
    "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring",
    "active:scale-[0.97] data-disabled:pointer-events-none data-disabled:opacity-45",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    "after:absolute after:-inset-1 coarse:after:min-h-11 coarse:after:min-w-11",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:opacity-88",
        secondary: "border border-border bg-raised text-foreground hover:bg-selected",
        ghost: "text-muted-foreground hover:bg-hover hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:opacity-88",
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
  /** Keeps the label's box, swaps the leading icon for a spinner and blocks input. */
  readonly loading?: boolean;
}

export function Button({ className, variant, size, loading = false, disabled, children, ...props }: ButtonProps) {
  return (
    <BaseButton
      {...props}
      disabled={disabled === true || loading}
      focusableWhenDisabled={loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {loading ? <Spinner /> : null}
      {children}
    </BaseButton>
  );
}

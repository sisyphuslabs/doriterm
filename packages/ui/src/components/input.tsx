import { Input as BaseInput } from "@base-ui/react/input";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/cn.ts";

export interface InputProps extends Omit<ComponentProps<typeof BaseInput>, "className"> {
  readonly className?: string;
  /** Monospace for codes, hosts and paths. */
  readonly mono?: boolean;
  readonly invalid?: boolean;
}

export const inputClass = cn(
  "h-(--control) w-full min-w-0 rounded-md border border-input bg-surface px-2.5 text-base text-foreground",
  "placeholder:text-muted-foreground outline-none transition-[border-color,box-shadow] duration-(--duration-micro)",
  "hover:border-ring/60 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-1 focus-visible:outline-ring/40",
  "data-disabled:border-border data-disabled:bg-muted data-disabled:text-muted-foreground data-disabled:hover:border-border",
  "aria-invalid:border-destructive",
);

/** A compact label kept visible over a field where Field's full label would crowd the surface (a bar, a row, a strip). */
export const fieldLabelClass = "text-xs font-medium text-muted-foreground";

/** A group's heading under a section's: small capitals set a step below the body, so the steps stay 1.25x apart (#1578). */
export const groupHeadingClass = "text-2xs font-semibold tracking-wide text-muted-foreground uppercase";

export function Input({ className, mono = false, invalid, ...props }: InputProps) {
  return (
    <BaseInput
      {...props}
      aria-invalid={invalid === true || undefined}
      className={cn(inputClass, mono && "font-mono tracking-wide", className)}
    />
  );
}

export interface FieldProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A visible label above its control, with a format hint or an error below it. */
export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {error === undefined ? null : <p className="text-prose text-destructive">{error}</p>}
      {error === undefined && hint !== undefined ? <p className="text-prose text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

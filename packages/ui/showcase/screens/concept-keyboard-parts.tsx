import { ChevronLeft, ChevronRight, ClipboardPaste, GamepadDirectional, KeyboardOff, List, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../src/index.ts";

/** Concept renders for Settings ▸ Keyboard. NOT PRODUCT CODE: a scratch screen for the owner to pick a direction. */

export const KEYS = [
  "ctrl",
  "cmd",
  "shift",
  "alt",
  "tab",
  "esc",
  "^C",
  "←",
  "↑",
  "↓",
  "→",
  "~",
  "|",
  "/",
  "-",
] as const;
export const LATENT = new Set(["ctrl"]);

export const KEY =
  "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-1.5 text-[0.8125rem] font-medium";
export const LATCHED = "bg-primary font-semibold text-primary-foreground";
export const IDLE = "text-foreground";

export function BarKey({
  label,
  editing,
  lifted,
}: {
  readonly label: string;
  readonly editing: boolean;
  readonly lifted?: boolean;
}) {
  const latched = LATENT.has(label);
  return (
    <span className="relative shrink-0">
      {editing ? (
        <span
          aria-hidden
          className="absolute top-0.5 left-0.5 z-10 flex size-4 items-center justify-center rounded-full bg-destructive text-background"
        >
          <Minus className="size-2.5" />
        </span>
      ) : null}
      <span
        className={cn(
          KEY,
          latched ? LATCHED : IDLE,
          lifted === true && "-translate-y-1 shadow-overlay",
          editing && "opacity-90",
        )}
      >
        {label}
      </span>
    </span>
  );
}

export function RealBar({ editing = false }: { readonly editing?: boolean }) {
  return (
    <div className="flex h-[3.25rem] items-center rounded-full border border-border bg-chrome/95 p-1 shadow-lg">
      <div className="flex min-w-0 flex-1 items-center overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]">
        {KEYS.slice(0, 7).map((label) => (
          <BarKey key={label} label={label} editing={editing} lifted={editing && label === "tab"} />
        ))}
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        <BarKey label="←" editing={editing} />
        <BarKey label="↑" editing={editing} />
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        <span className={cn(KEY, IDLE)}>
          <GamepadDirectional className="size-5" />
        </span>
        <span className={cn(KEY, IDLE)}>
          <List className="size-5" />
        </span>
        <span className={cn(KEY, IDLE)}>
          <ClipboardPaste className="size-5" />
        </span>
      </div>
      <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-border" />
      <div className="flex shrink-0 items-center">
        <span className="mx-1 flex h-9 w-[7.5rem] items-center rounded-full border border-input px-3 text-xs text-muted-foreground">
          Type
        </span>
        <span className={cn(KEY, IDLE)}>
          <KeyboardOff className="size-5" />
        </span>
      </div>
    </div>
  );
}

export function Hero({ editing = false, hint }: { readonly editing?: boolean; readonly hint: string }) {
  return (
    <div className="border-y border-border bg-card px-2 pt-3 pb-2">
      <p className="px-2 pb-2 font-mono text-[0.6875rem] text-muted-foreground">$ herdr --agent</p>
      <RealBar editing={editing} />
      <p className="px-2 pt-2 text-[0.6875rem] text-muted-foreground">{hint}</p>
    </div>
  );
}

export function Toolbar({ action }: { readonly action: ReactNode }) {
  return (
    <header data-titlebar className="flex h-12 items-center gap-1 border-b border-border px-2">
      <span className="flex size-11 items-center justify-center rounded-full text-foreground">
        <ChevronLeft className="size-5" />
      </span>
      <span className="flex-1 text-base font-semibold text-foreground">Keyboard</span>
      {action}
    </header>
  );
}

export function Group({ children }: { readonly children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>;
}

export function Row({
  title,
  value,
  last = false,
}: {
  readonly title: string;
  readonly value: string;
  readonly last?: boolean;
}) {
  return (
    <div className={cn("flex min-h-12 items-center gap-2 px-4", !last && "border-b border-border")}>
      <span className="flex-1 text-base text-foreground">{title}</span>
      <span className="text-sm text-muted-foreground">{value}</span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </div>
  );
}

export function Chip({
  label,
  on = false,
  muted = false,
}: {
  readonly label: string;
  readonly on?: boolean;
  readonly muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex h-9 items-center rounded-full border px-3 text-[0.8125rem] font-medium",
        on ? "border-transparent bg-primary text-primary-foreground" : "border-border text-foreground",
        muted && "opacity-45",
      )}
    >
      {label}
    </span>
  );
}

export function Caption({ children }: { readonly children: ReactNode }) {
  return <p className="px-1 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</p>;
}

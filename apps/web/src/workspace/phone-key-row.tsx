import { cn } from "@doriface/ui";
import type { CSSProperties } from "react";
import { activeEntries, specialEntries } from "../keybar/entries.ts";
import { toExtra } from "../keybar/render.tsx";
import { useKeyBarSettings } from "../keybar/store.ts";
import type { HostPlatform } from "../terminal/keys.ts";
import type { StickyKeys } from "./use-sticky-keys.ts";

export interface PhoneKeyRowProps {
  readonly host: HostPlatform;
  readonly sticky: StickyKeys;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * The keys Settings > Keyboard picked, in a row under the terminal while the soft keyboard is down (#1526): Esc, an
 * arrow or ^C answers a program in one tap without raising the keyboard. A press never takes the focus, so the keyboard
 * stays down; with it up, the keys bar on the keyboard carries the same keys instead.
 */
export function PhoneKeyRow({ host, sticky, className, style }: PhoneKeyRowProps) {
  const settings = useKeyBarSettings();
  const entries = [...specialEntries(settings, host), ...activeEntries(settings)];
  return (
    <div
      role="toolbar"
      aria-label="Quick keys"
      className={cn(
        "flex shrink-0 gap-1 overflow-x-auto overscroll-x-contain px-2 py-1 [scrollbar-width:none]",
        className,
      )}
      style={style}
    >
      {entries.map((entry) => {
        const shown = toExtra(entry);
        const latched = sticky.latched.has(entry.id);
        return (
          <button
            key={entry.id}
            type="button"
            aria-label={entry.name}
            aria-pressed={entry.bytes === null ? latched : undefined}
            // The terminal keeps the focus it had: a focused field here would raise the keyboard this row stands in for.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => (entry.bytes === null ? sticky.press(entry.id) : sticky.send(entry.bytes))}
            className={cn(
              "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-raised px-2.5 font-mono text-sm text-foreground select-none [&_svg]:size-4",
              latched && "border-primary bg-selected",
            )}
          >
            {shown.label}
          </button>
        );
      })}
    </div>
  );
}

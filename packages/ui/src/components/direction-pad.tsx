import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Delete, Eraser } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { keepFocus } from "./extra-keys-bar.tsx";

interface PadKey {
  readonly id: string;
  readonly name: string;
  readonly icon: ReactNode;
}

const PAD: readonly (PadKey | null)[] = [
  { id: "backspace", name: "Delete", icon: <Delete /> },
  { id: "up", name: "Up arrow", icon: <ArrowUp /> },
  { id: "clear", name: "Clear screen", icon: <Eraser /> },
  { id: "left", name: "Left arrow", icon: <ArrowLeft /> },
  { id: "enter", name: "Return", icon: <CornerDownLeft /> },
  { id: "right", name: "Right arrow", icon: <ArrowRight /> },
  null,
  { id: "down", name: "Down arrow", icon: <ArrowDown /> },
  null,
];

export interface DirectionPadProps {
  readonly onKey?: (id: string) => void;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** The arrow keys as a translucent 3x3 pad over the terminal, opened from the keys bar; 48 pt keys. */
export function DirectionPad({ onKey, className, style }: DirectionPadProps) {
  return (
    <div
      role="group"
      aria-label="Arrow keys"
      style={style}
      className={cn(
        "grid grid-cols-3 gap-1 rounded-2xl border border-border bg-chrome/70 p-1.5 shadow-lg backdrop-blur-md",
        "transition-[opacity,scale] duration-(--duration-standard) ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
        className,
      )}
    >
      {PAD.map((key, index) =>
        key === null ? (
          <span key={`blank-${index}`} aria-hidden className="size-12" />
        ) : (
          <button
            key={key.id}
            type="button"
            aria-label={key.name}
            onMouseDown={keepFocus}
            onClick={() => onKey?.(key.id)}
            className={cn(
              "flex size-12 items-center justify-center rounded-xl border border-border bg-raised/90 text-foreground shadow-xs outline-none active:bg-selected [&_svg:not([data-slot=spinner])]:size-5",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
            )}
          >
            {key.icon}
          </button>
        ),
      )}
    </div>
  );
}

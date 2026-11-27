import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Delete, Eraser } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { keepFocus } from "./extra-key-button.tsx";

interface PadKey {
  readonly id: string;
  readonly name: string;
  readonly icon: ReactNode;
}

/**
 * Doriterm's own 3x3 pad (#238): Delete, Up and Clear over Left, Enter and Right, with Down under Enter. Enter is the
 * action pill's Return key, named apart so the two buttons never share a name.
 */
const PAD: readonly (PadKey | null)[] = [
  { id: "backspace", name: "Delete", icon: <Delete /> },
  { id: "up", name: "Up arrow", icon: <ArrowUp /> },
  { id: "clear", name: "Clear screen", icon: <Eraser /> },
  { id: "left", name: "Left arrow", icon: <ArrowLeft /> },
  { id: "enter", name: "Enter", icon: <CornerDownLeft /> },
  { id: "right", name: "Right arrow", icon: <ArrowRight /> },
  null,
  { id: "down", name: "Down arrow", icon: <ArrowDown /> },
  null,
];

/** The pad's drawn width: three 48 pt keys, two 4 px gaps, 6 px padding and the 1 px border on each side. */
export const DIRECTION_PAD_WIDTH_PX = 166;

export interface DirectionPadProps {
  readonly onKey?: (id: string) => void;
  /** Where the tail under the bubble points, in px from the pad's left edge: the centre of the key that opened it. */
  readonly tail?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * The arrow keys as Doriterm's own 3x3 pad (Q, 2026-11-26: the Herdr app's inverted T read worse), in the bubble over
 * the key that opened it, with a tail pointing at that key (#2778). 48 pt keys, so every key is a thumb's target.
 */
export function DirectionPad({ onKey, tail, className, style }: DirectionPadProps) {
  return (
    <div
      role="group"
      aria-label="Arrow keys"
      // A press anywhere in the bubble, an empty cell or its padding as well as a key, keeps the keyboard up (#2871).
      onMouseDown={keepFocus}
      style={style}
      className={cn(
        "relative grid grid-cols-3 gap-1 rounded-2xl border border-border bg-popover p-1.5 shadow-lg",
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
            onClick={() => onKey?.(key.id)}
            className={cn(
              "flex size-12 items-center justify-center rounded-xl bg-raised text-foreground outline-none active:bg-selected [&_svg:not([data-slot=spinner])]:size-5",
              "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
            )}
          >
            {key.icon}
          </button>
        ),
      )}
      {tail === undefined ? null : (
        <span
          aria-hidden
          data-slot="pad-tail"
          style={{ left: tail }}
          className="absolute top-full size-3 -translate-x-1/2 -translate-y-1.5 rotate-45 border-r border-b border-border bg-popover"
        />
      )}
    </div>
  );
}

import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { keepFocus } from "./extra-key-button.tsx";

interface PadKey {
  readonly id: string;
  readonly name: string;
  readonly icon: ReactNode;
  readonly cell: string;
}

const PAD: readonly PadKey[] = [
  { id: "up", name: "Up arrow", icon: <ChevronUp />, cell: "col-start-2 row-start-1" },
  { id: "left", name: "Left arrow", icon: <ChevronLeft />, cell: "col-start-1 row-start-2" },
  { id: "down", name: "Down arrow", icon: <ChevronDown />, cell: "col-start-2 row-start-2" },
  { id: "right", name: "Right arrow", icon: <ChevronRight />, cell: "col-start-3 row-start-2" },
];

export interface DirectionPadProps {
  readonly onKey?: (id: string) => void;
  /** Where the tail under the bubble points, in px from the pad's left edge: the centre of the key that opened it. */
  readonly tail?: number;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * The arrow keys as the Herdr app draws them (#2778): an inverted T in a bubble over the key that opened it, with a tail
 * pointing at that key. 48 pt keys, so every arrow is a thumb's target.
 */
export function DirectionPad({ onKey, tail, className, style }: DirectionPadProps) {
  return (
    <div
      role="group"
      aria-label="Arrow keys"
      style={style}
      className={cn(
        "relative grid grid-cols-3 grid-rows-2 gap-1.5 rounded-[1.375rem] border border-border bg-popover p-2 shadow-lg",
        "transition-[opacity,scale] duration-(--duration-standard) ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
        className,
      )}
    >
      {PAD.map((key) => (
        <button
          key={key.id}
          type="button"
          aria-label={key.name}
          onMouseDown={keepFocus}
          onClick={() => onKey?.(key.id)}
          className={cn(
            key.cell,
            "flex h-12 w-14 items-center justify-center rounded-2xl bg-raised text-foreground outline-none active:bg-selected [&_svg:not([data-slot=spinner])]:size-5",
            "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
          )}
        >
          {key.icon}
        </button>
      ))}
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

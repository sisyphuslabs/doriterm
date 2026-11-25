import { Keyboard } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { keepFocus } from "./extra-key-button.tsx";

export interface KeyboardButtonProps {
  readonly onPress?: () => void;
  /**
   * The press as it lands (pointerdown), a task before `onPress`: what has to be let go before the click runs. Only a
   * primary press, the one that clicks, starts one; `pointerId` is its pointer (#2048).
   */
  readonly onPressStart?: (button: HTMLButtonElement, pointerId: number) => void;
  readonly className?: string;
  /** Show keyboard by default; Show keys where the button opens the keys bar itself (no soft keyboard to raise). */
  readonly label?: string;
  /** The keyboard glyph by default; another round control over the terminal (read-only browsing) brings its own. */
  readonly icon?: ReactNode;
  /** A toggle's state, when the button is one: drawn as a latched key while on. */
  readonly pressed?: boolean;
}

export function KeyboardButton({
  onPress,
  onPressStart,
  className,
  label = "Show keyboard",
  icon,
  pressed,
}: KeyboardButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onPointerDown={
        onPressStart === undefined
          ? undefined
          : (event) => {
              // A secondary press (a trackpad right-click) ends in contextmenu or auxclick and a second finger clicks
              // nothing, so neither brings the click that ends what a press start let go (#2048).
              if (event.button !== 0 || !event.isPrimary) return;
              onPressStart(event.currentTarget, event.pointerId);
            }
      }
      // The keyboard button leaves the focus on the terminal it asks the keyboard for, as the keys do: a press that took
      // the focus would tell the program the terminal lost it (#1519). Another round control is left as it was.
      onMouseDown={icon === undefined ? keepFocus : undefined}
      onClick={onPress}
      className={cn(
        "flex size-12 items-center justify-center rounded-full border border-border shadow-lg backdrop-blur-md outline-none [&_svg:not([data-slot=spinner])]:size-5",
        pressed === true
          ? "bg-primary text-primary-foreground active:opacity-80"
          : "bg-chrome/90 text-foreground active:bg-selected",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
        className,
      )}
    >
      {icon ?? <Keyboard />}
    </button>
  );
}

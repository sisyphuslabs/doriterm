import { ClipboardPaste, CornerDownLeft, Keyboard, KeyboardOff, List, Move, SquarePen } from "lucide-react";
import { type CSSProperties, type ReactElement, type ReactNode, type Ref, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { DIRECTION_PAD_WIDTH_PX as PAD_WIDTH_PX, DirectionPad } from "./direction-pad.tsx";
import { DEFAULT_EXTRA_KEYS } from "./extra-keys-defaults.tsx";
import { idleKey, keepFocus, KeyButton, keyTarget as key, latchedKey } from "./extra-key-button.tsx";
import { KeyPages } from "./key-pages.tsx";

export { keepFocus };
export { KeyboardButton, type KeyboardButtonProps } from "./keyboard-button.tsx";

export interface ExtraKey {
  readonly id: string;
  readonly label: ReactNode;
  /** Spoken name, e.g. "Escape". */
  readonly name: string;
  /** Sticky one-shot modifiers stay pressed for the next key, then let go. */
  readonly modifier?: boolean;
}

export interface ExtraKeysBarProps {
  /**
   * The person's keys, in their order. Unset falls back to `DEFAULT_EXTRA_KEYS`, the row this bar drew before keys
   * became configurable; a fresh phone passes its catalogue's own row, which differs (Alt sits fifth there, and the
   * swipe characters follow the fixed slots here as ordinary keys).
   */
  readonly keys?: readonly ExtraKey[];
  /** The active pack's keys, drawn before the person's own so picking a pack shows its keys at once. */
  readonly packKeys?: readonly ExtraKey[];
  /** Ids of modifiers currently latched. */
  readonly latched?: readonly string[];
  readonly onKey?: (id: string) => void;
  /** A key held down, by id. Ctrl's hold opens the packs panel. */
  readonly onKeyHold?: (id: string) => void;
  readonly padOpen?: boolean;
  readonly onPad?: () => void;
  /** An arrow of the open pad, by id (up, down, left, right). */
  readonly onPadKey?: (id: string) => void;
  readonly onPaste?: () => void;
  /** The action pill's Return: a terminal key that presses Return in the program, never a send of the card's draft. */
  readonly onReturn?: () => void;
  /** The input card is open; its toggle reads pressed. */
  readonly inputBox?: boolean;
  /** The input card's toggle, the action pill's last slot. Unset where there is no card to open. */
  readonly onInputBox?: () => void;
  readonly ref?: Ref<HTMLDivElement>;
  readonly onHideKeyboard?: () => void;
  /** The hide button's name: Hide keyboard by default; Hide keys where the bar shows without a soft keyboard. */
  readonly hideLabel?: string;
  /**
   * The soft keyboard is down while the bar stays on screen (#2499): the slot that hides the keyboard reads Show keyboard
   * and raises it instead, and nothing else about the bar changes.
   */
  readonly keyboardDown?: boolean;
  readonly onShowKeyboard?: () => void;
  /** Show keyboard's press as it lands (a primary pointerdown), a task before `onShowKeyboard` (#2048). */
  readonly onShowKeyboardStart?: (button: HTMLButtonElement, pointerId: number) => void;
  /** Wraps the Switch session button, e.g. in the menu it opens. */
  readonly renderSessions?: (trigger: ReactElement) => ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const pill = "relative h-[3.25rem] rounded-full border border-border bg-chrome/95 shadow-lg backdrop-blur-md";

/** Where the open pad sits over the key pill, and where its tail points: centred over its key, kept inside the pill. */
function padPlace(anchor: HTMLElement | null, scrolled: number, pillWidth: number): { left: number; tail: number } {
  const centre = anchor === null ? pillWidth / 2 : anchor.offsetLeft + anchor.offsetWidth / 2 - scrolled;
  const left = Math.max(0, Math.min(pillWidth - PAD_WIDTH_PX, centre - PAD_WIDTH_PX / 2));
  return { left, tail: centre - left };
}

/**
 * The phone's terminal keys as the Herdr app draws them (#2778): two pills in one row. The key pill on the left holds the
 * active pack's keys, the person's own, the arrow pad's key, Switch session and Paste, in pages a swipe turns, with a dot
 * per page. The action pill on the right never moves: Return, the keyboard's toggle and the input card's toggle. Every key
 * is a 44 pt target, and pressing one leaves the text focus (and so the keyboard) where it was. A latched modifier
 * inverts to solid ink with a bar under its label, so it reads as on in both themes.
 */
export function ExtraKeysBar(props: ExtraKeysBarProps) {
  const { keys = DEFAULT_EXTRA_KEYS, packKeys = [], latched = [], onKey, onKeyHold, padOpen = false } = props;
  const { inputBox = false, keyboardDown = false, onShowKeyboardStart } = props;
  const arrows = useRef<HTMLButtonElement | null>(null);
  const keysPill = useRef<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(0);
  const textKey = (entry: ExtraKey) => (
    <KeyButton
      key={entry.id}
      entry={entry}
      latched={latched.includes(entry.id)}
      onKey={onKey}
      onHold={entry.id === "ctrl" ? onKeyHold : undefined}
    />
  );
  const sessions = (
    <button type="button" aria-label="Switch session" onMouseDown={keepFocus} className={cn(key, idleKey)}>
      <List />
    </button>
  );
  const items = [
    ...packKeys.map(textKey),
    ...keys.map(textKey),
    <button
      key="arrows"
      ref={arrows}
      type="button"
      aria-label="Arrow keys"
      aria-pressed={padOpen}
      onMouseDown={keepFocus}
      onClick={props.onPad}
      className={cn(key, padOpen ? latchedKey : idleKey)}
    >
      <Move />
    </button>,
    <span key="sessions" className="contents">
      {props.renderSessions === undefined ? sessions : props.renderSessions(sessions)}
    </span>,
    <button
      key="paste"
      type="button"
      aria-label="Paste"
      onMouseDown={keepFocus}
      onClick={props.onPaste}
      className={cn(key, idleKey)}
    >
      <ClipboardPaste />
    </button>,
  ];
  const place = padOpen ? padPlace(arrows.current, scrolled, keysPill.current?.clientWidth ?? PAD_WIDTH_PX) : null;
  return (
    <div
      ref={props.ref}
      role="toolbar"
      aria-label="Terminal keys"
      style={props.style}
      className={cn(
        "flex items-center gap-2 px-1.5 py-1 transition-[bottom] duration-(--duration-standard) ease-out motion-reduce:transition-none motion-reduce:duration-0",
        props.className,
      )}
    >
      <div ref={keysPill} role="group" aria-label="Keys" className={cn(pill, "min-w-0 flex-1 px-1")}>
        {place === null ? null : (
          <DirectionPad
            {...(props.onPadKey === undefined ? {} : { onKey: props.onPadKey })}
            tail={place.tail}
            style={{ left: place.left, width: PAD_WIDTH_PX }}
            className="absolute bottom-full z-10 mb-3"
          />
        )}
        <KeyPages items={items} onScroll={setScrolled} />
      </div>
      <div role="group" aria-label="Actions" className={cn(pill, "flex shrink-0 items-center px-1")}>
        <button
          type="button"
          aria-label="Return"
          onMouseDown={keepFocus}
          onClick={props.onReturn}
          className={cn(key, "text-ring active:bg-selected")}
        >
          <CornerDownLeft />
        </button>
        <button
          type="button"
          aria-label={keyboardDown ? "Show keyboard" : (props.hideLabel ?? "Hide keyboard")}
          onPointerDown={
            !keyboardDown || onShowKeyboardStart === undefined
              ? undefined
              : (event) => {
                  if (event.button !== 0 || !event.isPrimary) return;
                  onShowKeyboardStart(event.currentTarget, event.pointerId);
                }
          }
          onMouseDown={keepFocus}
          onClick={keyboardDown ? props.onShowKeyboard : props.onHideKeyboard}
          className={cn(key, idleKey)}
        >
          {keyboardDown ? <Keyboard /> : <KeyboardOff />}
        </button>
        {props.onInputBox === undefined ? null : (
          <button
            type="button"
            aria-label="Type in a field"
            aria-pressed={inputBox}
            onMouseDown={keepFocus}
            onClick={props.onInputBox}
            className={cn(key, inputBox ? latchedKey : idleKey)}
          >
            <SquarePen />
          </button>
        )}
      </div>
    </div>
  );
}

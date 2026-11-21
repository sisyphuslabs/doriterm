import { ClipboardPaste, GamepadDirectional, Keyboard, KeyboardOff, List, TextCursorInput } from "lucide-react";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { DEFAULT_EXTRA_KEYS } from "./extra-keys-defaults.tsx";
import { idleKey, keepFocus, KeyButton, keyTarget as key, latchedKey } from "./extra-key-button.tsx";

export { keepFocus };

export interface ExtraKey {
  readonly id: string;
  readonly label: ReactNode;
  /** Spoken name, e.g. "Escape". */
  readonly name: string;
  /** Sticky one-shot modifiers stay pressed for the next key, then let go. */
  readonly modifier?: boolean;
}

const divider = (height: string): ReactElement => (
  <span aria-hidden className={cn("mx-1 w-px shrink-0 bg-border", height)} />
);

type Fade = "none" | "start" | "end" | "both";

function fadeOf(el: HTMLElement): Fade {
  const start = el.scrollLeft > 1;
  const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return start && end ? "both" : start ? "start" : end ? "end" : "none";
}

function useEdgeFade(): [Fade, (el: HTMLDivElement | null) => void] {
  const [fade, setFade] = useState<Fade>("none");
  const node = useRef<HTMLDivElement | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    node.current = el;
    if (el !== null) setFade(fadeOf(el));
  }, []);
  useEffect(() => {
    const el = node.current;
    if (el === null) return undefined;
    const update = (): void => setFade(fadeOf(el));
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);
  return [fade, ref];
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
  readonly onPaste?: () => void;
  /**
   * The input field's toggle: a slot of its own, fixed beside the keyboard key so the two never scroll away. Unset
   * where there is no field to open (the desktop's keys never show it).
   */
  readonly inputBox?: boolean;
  readonly onInputBox?: () => void;
  /** A real input field in the first fixed column, in place of the field toggle. */
  readonly inputField?: ReactNode;
  /** The input field is in use: it takes a row of its own across the bar, above the keys, which keep their width. */
  readonly inputActive?: boolean;
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

/**
 * The phone's terminal keys, one rounded pill riding on the soft keyboard. Everything that scrolls sits in the row on
 * the left: the active pack's keys, the person's own keys behind a divider, the arrow-pad toggle, Switch session and
 * Paste. The two slots on the right never scroll: the input field and the keyboard's toggle. Every key is
 * a 44 pt target, and pressing one leaves the text focus (and so the keyboard) where it was. A latched modifier inverts
 * to solid ink with a bar under its label, so it reads as on in both themes.
 */
export function ExtraKeysBar(props: ExtraKeysBarProps) {
  const {
    keys = DEFAULT_EXTRA_KEYS,
    packKeys = [],
    latched = [],
    onKey,
    onKeyHold,
    padOpen = false,
    inputBox = false,
    inputActive = false,
    keyboardDown = false,
  } = props;
  const { onShowKeyboardStart } = props;
  const [fade, scroller] = useEdgeFade();
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
  return (
    <div
      ref={props.ref}
      role="toolbar"
      aria-label="Terminal keys"
      style={props.style}
      className={cn("px-1.5 py-1", props.className)}
    >
      <div
        className={cn(
          "border border-border bg-chrome/95 p-1 shadow-lg backdrop-blur-md",
          inputActive
            ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-1 rounded-[1.625rem]"
            : "flex h-[3.25rem] items-center rounded-full",
        )}
      >
        <div
          ref={scroller}
          data-slot="terminal-keys-scroll"
          data-fade={fade}
          className={cn(
            inputActive && "col-start-1 row-start-2 h-11",
            "flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "data-[fade=end]:[mask-image:linear-gradient(to_right,black_calc(100%-0.75rem),transparent)]",
            "data-[fade=start]:[mask-image:linear-gradient(to_left,black_calc(100%-0.75rem),transparent)]",
            "data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)]",
          )}
        >
          {packKeys.map(textKey)}
          {packKeys.length > 0 ? divider("h-5") : null}
          {keys.map(textKey)}
          {divider("h-5")}
          <button
            type="button"
            aria-label="Arrow keys"
            aria-pressed={padOpen}
            onMouseDown={keepFocus}
            onClick={props.onPad}
            className={cn(key, padOpen ? latchedKey : idleKey)}
          >
            <GamepadDirectional />
          </button>
          {props.renderSessions === undefined ? sessions : props.renderSessions(sessions)}
          <button
            type="button"
            aria-label="Paste"
            onMouseDown={keepFocus}
            onClick={props.onPaste}
            className={cn(key, idleKey)}
          >
            <ClipboardPaste />
          </button>
        </div>
        {inputActive ? null : divider("h-6")}
        <div className={inputActive ? "contents" : "flex shrink-0 items-center"}>
          <div className={inputActive ? "col-span-2 row-start-1 min-w-0" : "contents"}>{props.inputField}</div>
          {props.inputField !== undefined || props.onInputBox === undefined ? null : (
            <button
              type="button"
              aria-label="Type in a field"
              aria-pressed={inputBox}
              onMouseDown={keepFocus}
              onClick={props.onInputBox}
              className={cn(key, inputBox ? latchedKey : idleKey)}
            >
              <TextCursorInput />
            </button>
          )}
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
            className={cn(key, idleKey, inputActive && "col-start-2 row-start-2")}
          >
            {keyboardDown ? <Keyboard /> : <KeyboardOff />}
          </button>
        </div>
      </div>
    </div>
  );
}

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

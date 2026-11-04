import { ClipboardPaste, GamepadDirectional, Keyboard, KeyboardOff, List } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";

export interface ExtraKey {
  readonly id: string;
  readonly label: ReactNode;
  /** Spoken name, e.g. "Escape". */
  readonly name: string;
  /** Sticky one-shot modifiers stay pressed for the next key, then let go. */
  readonly modifier?: boolean;
}

const CTRL: ExtraKey = { id: "ctrl", label: "ctrl", name: "Control", modifier: true };
const CMD: ExtraKey = { id: "cmd", label: "cmd", name: "Command", modifier: true };
const REST: readonly ExtraKey[] = [
  { id: "shift", label: "shift", name: "Shift", modifier: true },
  { id: "tab", label: "tab", name: "Tab" },
  { id: "esc", label: "esc", name: "Escape" },
];

export function extraKeys(command: boolean): readonly ExtraKey[] {
  return command ? [CTRL, CMD, ...REST] : [CTRL, ...REST];
}

export const DEFAULT_EXTRA_KEYS: readonly ExtraKey[] = extraKeys(false);

export const SWIPE_KEYS: readonly ExtraKey[] = [
  { id: "tilde", label: "~", name: "Tilde" },
  { id: "pipe", label: "|", name: "Vertical bar" },
  { id: "slash", label: "/", name: "Slash" },
  { id: "dash", label: "-", name: "Hyphen" },
  { id: "alt", label: "alt", name: "Option", modifier: true },
];

/** A mousedown that would move focus off the terminal would also drop the soft keyboard. */
export function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

const key =
  "relative flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-1.5 outline-none [&_svg]:size-5 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring";
const latchedKey =
  "bg-primary font-semibold text-primary-foreground after:absolute after:bottom-1.5 after:h-0.5 after:w-3 after:rounded-full after:bg-current active:opacity-80";
const idleKey = "text-foreground active:bg-selected";

const symbol = (entry: ExtraKey): boolean => typeof entry.label === "string" && entry.label.length === 1;

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
  readonly keys?: readonly ExtraKey[];
  readonly swipeKeys?: readonly ExtraKey[];
  /** Ids of modifiers currently latched. */
  readonly latched?: readonly string[];
  readonly onKey?: (id: string) => void;
  readonly padOpen?: boolean;
  readonly onPad?: () => void;
  readonly onPaste?: () => void;
  readonly onHideKeyboard?: () => void;
  /** Wraps the Switch session button, e.g. in the menu it opens. */
  readonly renderSessions?: (trigger: ReactElement) => ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/**
 * The phone's terminal keys, one rounded pill riding on the soft keyboard: modifiers and Tab/Esc on the left (swipe for
 * more, behind an edge fade), then the arrow pad toggle, Paste, Switch session and Hide keyboard. Every key is a 44 pt
 * target, and pressing one leaves the text focus (and so the keyboard) where it was. A latched modifier inverts to
 * solid ink with a bar under its label, so it reads as on in both themes.
 */
export function ExtraKeysBar(props: ExtraKeysBarProps) {
  const { keys = DEFAULT_EXTRA_KEYS, swipeKeys = SWIPE_KEYS, latched = [], onKey, padOpen = false } = props;
  const [fade, scroller] = useEdgeFade();
  const textKey = (entry: ExtraKey) => {
    const on = latched.includes(entry.id);
    return (
      <button
        key={entry.id}
        type="button"
        aria-label={entry.name}
        aria-pressed={entry.modifier === true ? on : undefined}
        onMouseDown={keepFocus}
        onClick={() => onKey?.(entry.id)}
        className={cn(
          key,
          symbol(entry) ? "font-mono text-base" : "text-[0.8125rem] font-medium",
          on ? latchedKey : idleKey,
        )}
      >
        {entry.label}
      </button>
    );
  };
  const sessions = (
    <button type="button" aria-label="Switch session" onMouseDown={keepFocus} className={cn(key, idleKey)}>
      <List />
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      style={props.style}
      className={cn(
        "px-1.5 py-1 transition-[bottom] duration-(--duration-standard) ease-out motion-reduce:transition-none motion-reduce:duration-0",
        props.className,
      )}
    >
      <div className="flex h-[3.25rem] items-center rounded-full border border-border bg-chrome/95 p-1 shadow-lg backdrop-blur-md">
        <div
          ref={scroller}
          data-slot="terminal-keys-scroll"
          data-fade={fade}
          className={cn(
            "flex min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "data-[fade=end]:[mask-image:linear-gradient(to_right,black_calc(100%-0.75rem),transparent)]",
            "data-[fade=start]:[mask-image:linear-gradient(to_left,black_calc(100%-0.75rem),transparent)]",
            "data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)]",
          )}
        >
          {keys.map(textKey)}
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
          {swipeKeys.map(textKey)}
        </div>
        <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-border" />
        <div className="flex shrink-0 items-center">
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
          <button
            type="button"
            aria-label="Paste"
            onMouseDown={keepFocus}
            onClick={props.onPaste}
            className={cn(key, idleKey)}
          >
            <ClipboardPaste />
          </button>
          {props.renderSessions === undefined ? sessions : props.renderSessions(sessions)}
          <button
            type="button"
            aria-label="Hide keyboard"
            onMouseDown={keepFocus}
            onClick={props.onHideKeyboard}
            className={cn(key, idleKey)}
          >
            <KeyboardOff />
          </button>
        </div>
      </div>
    </div>
  );
}

export interface KeyboardButtonProps {
  readonly onPress?: () => void;
  readonly className?: string;
}

export function KeyboardButton({ onPress, className }: KeyboardButtonProps) {
  return (
    <button
      type="button"
      aria-label="Show keyboard"
      onClick={onPress}
      className={cn(
        "flex size-12 items-center justify-center rounded-full border border-border bg-chrome/90 text-foreground shadow-lg backdrop-blur-md outline-none active:bg-selected [&_svg]:size-5",
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
        className,
      )}
    >
      <Keyboard />
    </button>
  );
}

import { DirectionPad, ExtraKeysBar, KeyboardButton, keepFocus, Menu, MenuItem } from "@doriface/ui";
import { Plus, TextSelect, X } from "lucide-react";
import { type CSSProperties, type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { activeEntries, specialEntries } from "../keybar/entries.ts";
import { toExtra } from "../keybar/render.tsx";
import { useKeyBarSettings } from "../keybar/store.ts";
import type { HostPlatform } from "../terminal/keys.ts";
import type { TerminalPort } from "../terminal/terminal-port.ts";
import { InputBox } from "./input-box.tsx";
import { machineOf, type Session, terminalTitle } from "./model.ts";
import type { StickyKeys } from "./use-sticky-keys.ts";

export function keysBottom(inset: number): string {
  return inset > 0 ? `${inset}px` : "var(--safe-bottom)";
}

/**
 * The keys bar's own height at rest, which the terminal keeps clear until the bar reports its drawn one: its one row of
 * keys in a 3.25rem pill, and 0.25rem above and below it (#2604).
 */
export const KEYS_BAR_HEIGHT = "3.75rem";

/** How far up from the terminal's bottom the round keyboard button reaches: its 3rem and the gap below it. */
export const KEYBOARD_BUTTON_CLEARANCE = "calc(max(1rem, calc(var(--safe-bottom) + 0.5rem)) + 3rem)";

/** The round button's corner: Read-only on a touch phone, the keyboard button on a mouse-only one. */
const CORNER =
  "absolute right-[max(1rem,calc(var(--safe-right)+0.5rem))] bottom-[max(1rem,calc(var(--safe-bottom)+0.5rem))] z-10";

/**
 * How far in from its right edge a bar level with the round button (the tabs bar) keeps clear of it: the corner's inset
 * past the safe area, then the button's 3rem and a 0.5rem gap. One slot: the keys panel carries the keyboard's toggle
 * on a touch phone (#2499), so only one round button is ever at the corner.
 */
export const ROUND_BUTTON_CLEARANCE = "calc(max(1rem, calc(var(--safe-right) + 0.5rem)) - var(--safe-right) + 3.5rem)";

/** How far up from the terminal's bottom the arrow pad reaches: its 0.5rem gap, three 3rem rows with their gaps and padding. */
export const DIRECTION_PAD_CLEARANCE = "calc(0.5rem + 9rem + 0.5rem + 0.75rem + 2px)";

export interface PhoneKeysProps {
  readonly port: RefObject<TerminalPort | null>;
  /** The keys ride on the soft keyboard (or, mouse-only, were opened by hand). */
  readonly open: boolean;
  /**
   * With the keyboard down on a touch phone, the same keys panel sits under the terminal (#2499); this is the room it
   * keeps below itself (0px over the tabs bar, the round button's row without one). Null where it does not show.
   */
  readonly docked: string | null;
  readonly inset: number;
  readonly host: HostPlatform;
  readonly sticky: StickyKeys;
  readonly terminals: readonly Session[];
  readonly current: string;
  readonly onOpen: (address: string) => void;
  readonly onMenu: (open: boolean) => void;
  /** The arrow pad is open over the keys bar; the terminal keeps its own controls above it. */
  readonly pad: boolean;
  readonly onPad: (open: boolean) => void;
  /** Opens the packs panel: the bar's pack button, or Ctrl held down. */
  readonly onPacks: () => void;
  /**
   * Set where the bar opens without a soft keyboard (a mouse-only device, #287): the round button reads Show keys and
   * calls this with true, and the bar's last key reads Hide keys and calls it with false. Unset, the button raises the
   * soft keyboard and the bar's key puts it down.
   */
  readonly onKeys?: (shown: boolean) => void;
  /** The bar's height in px as it is drawn (taller while the field has a row of its own); 0 while it is closed. */
  readonly onBarHeight?: (px: number) => void;
  /** The terminal is browsed read-only (browse-mode.ts); the keys are closed and the browse button reads pressed. */
  readonly browsing?: boolean;
  /** Set on a touch device: a round Read-only button beside the keyboard button turns browsing on and off. */
  readonly onBrowse?: (on: boolean) => void;
}

/** Reports an element's border-box height as it changes, and 0 once it is gone. */
function useHeightReport(report: ((px: number) => void) | undefined): (element: HTMLDivElement | null) => void {
  return useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null || report === undefined) return undefined;
      const observer = new ResizeObserver(() => report(element.getBoundingClientRect().height));
      observer.observe(element);
      report(element.getBoundingClientRect().height);
      return () => {
        observer.disconnect();
        report(0);
      };
    },
    [report],
  );
}

function hideKeyboard(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/**
 * The phone terminal's keys (after t3code's terminal screen): the active pack's keys, then the person's own from Settings
 * > Keyboard, then the controls that never move (the arrow pad, Switch session, Paste, and the fixed slots). With the soft
 * keyboard up the bar rides on it; with it down, only a round keyboard button stays, at the bottom right.
 */
export function PhoneKeys(props: PhoneKeysProps) {
  const {
    port,
    open,
    docked,
    inset,
    host,
    sticky,
    terminals,
    current,
    onOpen,
    onMenu,
    pad,
    onPad,
    onPacks,
    onKeys,
    onBarHeight,
    browsing = false,
    onBrowse,
  } = props;
  const barRef = useHeightReport(onBarHeight);
  // Set as the menu closes: the focus went somewhere on its own (the terminal took it, or a pick opens another session).
  const settled = useRef(false);
  // The same answer as a boolean prop: Base UI keeps a focus that moved elsewhere during the close only for a boolean
  // finalFocus, never for a function's answer (#2174).
  const [returnFocus, setReturnFocus] = useState(false);
  const settings = useKeyBarSettings();
  const own = specialEntries(settings, host);
  const packed = activeEntries(settings);
  const entries = new Map([...own, ...packed].map((entry) => [entry.id, entry]));
  const press = (id: string): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;
    if (entry.bytes === null) sticky.press(id);
    else sticky.send(entry.bytes);
  };
  // The field is let go as the press lands, a task before the click asks for the keyboard: on iOS a field a tap focused,
  // let go and taken back inside one click, raises nothing (#1940).
  const letGo = (button: HTMLButtonElement, pointerId: number): void => port.current?.letGo(button, pointerId);
  const raise = (): void => {
    onKeys?.(true);
    port.current?.focus();
  };
  // Chat swaps the keys for the composer and takes its field inside the tap, so a phone raises its keyboard for it (#2604).
  const [chat, setChat] = useState(false);
  // The pad's left edge, so its middle sits over the Arrow keys button; held inside the screen.
  const [padAt, setPadAt] = useState<CSSProperties>({ right: 12 });
  useLayoutEffect(() => {
    if (!pad) return;
    const toggle = document.querySelector<HTMLElement>('[aria-label="Terminal keys"] [aria-label="Arrow keys"]');
    const holder = toggle?.closest<HTMLElement>("[data-keys-place]");
    if (toggle === null || toggle === undefined || holder === null || holder === undefined) return;
    const PAD_WIDTH = 168;
    const box = toggle.getBoundingClientRect();
    const frame = holder.getBoundingClientRect();
    const middle = box.left + box.width / 2 - frame.left;
    setPadAt({ left: Math.max(8, Math.min(frame.width - PAD_WIDTH - 8, middle - PAD_WIDTH / 2)) });
  }, [pad, open]);
  const files = useRef<HTMLInputElement | null>(null);
  const openChat = (): void => {
    flushSync(() => setChat(true));
    document.querySelector<HTMLTextAreaElement>('[data-slot="chat-composer"] textarea')?.focus();
  };
  const composer = (
    <div ref={barRef} role="group" aria-label="Chat" data-slot="chat-composer" className="px-1.5 py-1">
      <div className="flex flex-col gap-1 rounded-[1.625rem] border border-border bg-chrome/95 p-1 shadow-lg backdrop-blur-md">
        <InputBox className="w-full p-0" draftKey={current} onSend={(text) => port.current?.send(`${text}\r`)} />
        <div className="flex items-center">
          <input
            ref={files}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const picked = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              if (picked.length > 0) port.current?.pasteFiles(picked);
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            onMouseDown={keepFocus}
            onClick={() => files.current?.click()}
            className="flex size-11 items-center justify-center rounded-full text-foreground outline-none active:bg-selected focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-5"
          >
            <Plus />
          </button>
          <button
            type="button"
            aria-label="Close chat"
            onMouseDown={keepFocus}
            onClick={() => setChat(false)}
            className="flex size-11 items-center justify-center rounded-full text-foreground outline-none active:bg-selected focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-5"
          >
            <X />
          </button>
        </div>
      </div>
    </div>
  );
  const panel = (
    <ExtraKeysBar
      ref={barRef}
      // One row of keys, with the keyboard up or down; Chat swaps it for the composer (#2604).
      keyboardDown={!open}
      onChat={openChat}
      onShowKeyboard={raise}
      onShowKeyboardStart={letGo}
      keys={own.map(toExtra)}
      packKeys={packed.map(toExtra)}
      latched={[...sticky.latched]}
      onKey={press}
      onKeyHold={() => onPacks()}
      padOpen={pad}
      onPad={() => onPad(!pad)}
      onPaste={sticky.paste}
      {...(onKeys === undefined
        ? { onHideKeyboard: hideKeyboard }
        : { hideLabel: "Hide keys", onHideKeyboard: () => onKeys(false) })}
      renderSessions={(trigger) => (
        <Menu
          trigger={trigger}
          align="end"
          // The terminal takes the focus back itself, in the tap that closes the menu: a phone raises its keyboard only
          // for a focus made inside the tap, so the menu hands the focus to nothing (not its trigger) as it closes. A
          // pick of another session leaves the focus to that one (#1985); with no terminal field to take it, the trigger
          // gets it back (#1986).
          finalFocus={returnFocus}
          onOpenChange={(shown) => {
            if (shown) settled.current = false;
            else if (!settled.current) {
              const before = document.activeElement;
              port.current?.focus();
              settled.current = document.activeElement !== before;
            }
            setReturnFocus(!shown && !settled.current);
            onMenu(shown);
          }}
        >
          {terminals.map((entry) => (
            <MenuItem
              key={entry.address}
              aria-current={entry.address === current ? "true" : undefined}
              onClick={() => {
                if (entry.address !== current) settled.current = true;
                onOpen(entry.address);
              }}
            >
              {terminalTitle(entry)}
              {machineOf(entry.address) === undefined ? null : (
                <span className="ml-2 text-xs text-muted-foreground">{machineOf(entry.address)}</span>
              )}
            </MenuItem>
          ))}
        </Menu>
      )}
    />
  );
  const visible = open || docked !== null;
  // One element in both places, so the Type field keeps its focus and draft as the keyboard comes and goes (#2499).
  const place: { className: string; style: CSSProperties } = open
    ? { className: "absolute inset-x-0 z-10", style: { bottom: keysBottom(inset) } }
    : { className: "relative z-10 shrink-0", style: { paddingBottom: docked ?? undefined } };
  return (
    <>
      {visible ? (
        <div data-keys-place className={place.className} style={place.style}>
          {pad && !chat ? (
            // The pad floats over the row, centred on its own button (#2604).
            <DirectionPad onKey={sticky.press} className="absolute bottom-full z-10 mb-2" style={padAt} />
          ) : null}
          {chat ? composer : panel}
        </div>
      ) : null}
      {open || onBrowse === undefined ? null : (
        // The button stays in its slot while on, so the tap that ends browsing lands where the one that began it did.
        <KeyboardButton
          label="Read-only"
          icon={<TextSelect />}
          pressed={browsing}
          onPress={() => onBrowse(!browsing)}
          className={CORNER}
        />
      )}
      {open || docked !== null || browsing ? null : (
        <KeyboardButton
          {...(onKeys === undefined ? {} : { label: "Show keys" })}
          onPressStart={letGo}
          onPress={raise}
          className={CORNER}
        />
      )}
    </>
  );
}

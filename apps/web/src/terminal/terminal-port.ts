import type { TerminalHandle } from "@wterm/react";
import { type RefObject, useEffect, useMemo } from "react";
import type { TerminalInput } from "./terminal-view-props.ts";

export interface TerminalPort {
  /** The view's input path, so keys queue through a reconnect in order with typed input. */
  readonly send: (data: TerminalInput) => void;
  /** Pastes as a clipboard paste does: bracketed when the program asked, and through clipboard-paste-protection. */
  readonly paste: (text: string) => void;
  /** Puts files on the terminal's machine and pastes their paths, as a pasted image does (#701). */
  readonly pasteFiles: (files: readonly File[]) => void;
  /**
   * Sends a syllable still composing in the terminal's field now, as typed, and ends that composition (#652): a
   * modifier latched after it applies to the next key only. `send`, `paste` and `pasteFiles` do this first themselves.
   */
  readonly commitComposition: () => void;
  readonly focus: () => void;
  /**
   * Lets the field go ahead of a press that will ask for the keyboard, so that the press's own focus is a fresh one:
   * on iOS a field a tap focused, let go and focused again inside one click, raises nothing (#1940). A surface with no
   * soft keyboard keeps its field, and so does a field that has no focus to let go of. `button` is the pressed control:
   * a press that lifts off it gives the field back. `pointerId` is the press's pointer: another one lifting or cancelled
   * during the press is not its end (#2048).
   */
  readonly letGo: (button?: Element, pointerId?: number) => void;
  /** Puts the soft keyboard down: the field asks for none again until the keys ask for one (#1375). */
  readonly quiet: () => void;
}

export function pasteInto(element: HTMLElement, text: string): void {
  const data = new DataTransfer();
  data.setData("text/plain", text);
  const target = element.querySelector("textarea") ?? element;
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

/** The renderer's own field, which @wterm/dom creates inside the terminal's element: the one a soft keyboard follows. */
const fieldOf = (handle: RefObject<TerminalHandle | null>): HTMLTextAreaElement | null => {
  const element = handle.current?.instance?.element;
  return element?.querySelector("textarea") ?? null;
};

/** Fields let go only to be focused again in the same press: the program is told neither half of that (#1519). */
const regaining = new WeakSet<EventTarget>();

/** Whether a focus change of this field is the port taking it again for the keyboard, which the program is not told. */
export const regainingFocus = (target: EventTarget | null): boolean => target !== null && regaining.has(target);

/**
 * Whether input from the renderer is the focus report (mode 1004) its own field writes as the port lets it go and takes
 * it again: the renderer reports its field's blur and focus to the program itself, besides the view's.
 */
export const isRegainingReport = (handle: RefObject<TerminalHandle | null>, data: string): boolean =>
  (data === "\x1b[O" || data === "\x1b[I") && regainingFocus(fieldOf(handle));

/**
 * Lets the field under this terminal raise the soft keyboard, before the focus that reads it. On a surface that has one
 * the field carries `inputmode="none"`, so a press in the terminal raises nothing and only the keys ask for the keyboard
 * (#1375); a field that already has the focus is let go first, since a browser raises no keyboard for a focus it already
 * has. That holds even for a field already at `text`: on iOS one focused outside a tap (a picked session's attach) has
 * no keyboard up, and only a focus inside the tap raises it (#1519). One a tap focused has to be let go a task earlier,
 * which the keys' press does (`letGo`, #1940). The terminal keeps the focus throughout, so the blur and the focus that
 * follows it are marked as the port's own until this press is over. A surface with no soft keyboard to raise is left
 * alone, and so is a hardware keyboard: `inputmode` is the soft keyboard's own.
 */
export function askingForKeyboard(handle: RefObject<TerminalHandle | null>, softKeyboard: boolean): void {
  if (!softKeyboard) return;
  const field = fieldOf(handle);
  if (field === null) return;
  if (field.ownerDocument.activeElement === field) {
    regaining.add(field);
    // The caller focuses the field again synchronously, and both focus events are dispatched as it does.
    queueMicrotask(() => regaining.delete(field));
    field.blur();
  }
  field.inputMode = "text";
}

/**
 * Keeps the soft keyboard down under this terminal: while its field carries `inputmode="none"` a press in the terminal
 * raises nothing, which is what a touch surface wants (#1375). A field that has the focus is the one the keys just asked
 * for, so its mode is left to that ask.
 */
export function quietKeyboard(element: HTMLElement): void {
  const field = element.querySelector("textarea");
  if (!(field instanceof HTMLTextAreaElement)) return;
  if (field.ownerDocument.activeElement !== field) field.inputMode = "none";
}

/** Fields let go on a press's pointerdown, each with the detach that ends that press's hold. */
const pressing = new WeakMap<EventTarget, () => void>();

/**
 * Holds the field as the port's own from the press's pointerdown until the click takes it again, so the program hears
 * neither the blur nor the focus (#1519, #1940). A press that ends with no click on its button gives the field its focus
 * back, still marked, so the terminal is never left without the focus the program was not told it lost: the browser
 * cancelled it, the pointer lifted off the button, the press opened a context menu (a ctrl-click on macOS) and so never
 * clicks, or the click went to another element. A scroll is not an end: the
 * terminal scrolls itself while it follows output, and a tap the browser turns into a page scroll is cancelled. Nor is
 * another pointer lifting or cancelled (a second finger), when the press's own is known (#2048). Returns the release,
 * which ends the hold early as a press's end would, and does nothing once the hold is over.
 */
function holdForPress(
  field: HTMLTextAreaElement,
  refocus: () => void,
  button: Element | undefined,
  pointerId: number | undefined,
): () => void {
  const view = field.ownerDocument.defaultView;
  const release = (): void => {
    if (pressing.get(field) !== detach) return;
    detach();
    // A field no longer in the page (its pane unmounted mid-press) has no focus left to get back (#2048).
    if (field.isConnected && field.ownerDocument.activeElement !== field) refocus();
    queueMicrotask(() => regaining.delete(field));
  };
  const ours = (event: Event): boolean =>
    pointerId === undefined || !("pointerId" in event) || event.pointerId === pointerId;
  const cancelled = (event: Event): void => {
    if (ours(event)) release();
  };
  const lifted = (event: Event): void => {
    if (!ours(event)) return;
    if (!("clientX" in event) || typeof event.clientX !== "number" || !("clientY" in event)) return;
    if (typeof event.clientY !== "number") return;
    const under = field.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    if (button === undefined || under === null || !button.contains(under)) release();
  };
  const detach = (): void => {
    pressing.delete(field);
    view?.removeEventListener("pointercancel", cancelled, true);
    view?.removeEventListener("pointerup", lifted, true);
    view?.removeEventListener("contextmenu", release, true);
    view?.removeEventListener("click", release);
  };
  pressing.set(field, detach);
  regaining.add(field);
  view?.addEventListener("pointercancel", cancelled, true);
  view?.addEventListener("pointerup", lifted, true);
  view?.addEventListener("contextmenu", release, true);
  // Bubbling, after the button's own handler: a click the press's focus already took has ended the hold by then.
  view?.addEventListener("click", release);
  return release;
}

/** Ends a press's hold as its click takes the field: the focus that follows is the hold's last part (#1519). */
function endHold(field: HTMLTextAreaElement | null): boolean {
  if (field === null) return false;
  const detach = pressing.get(field);
  if (detach === undefined) return false;
  detach();
  return true;
}

/** A port as its view owns it: the view ends it as it lets the port go. */
export interface OwnedPort extends TerminalPort {
  /**
   * Ends a press's hold this port started and has not seen end, so no listener of it outlives the port (#2048): the
   * field gets its focus back as a press's early end gives it, unless its pane has gone with it.
   */
  readonly dispose: () => void;
}

/** The port over a terminal view: every paste sends a syllable still composing first, so it lands where it was typed. */
export function portOf(
  handle: RefObject<TerminalHandle | null>,
  send: (data: TerminalInput) => void,
  pasteFiles: (files: readonly File[]) => void,
  softKeyboard: boolean,
): OwnedPort {
  let releaseHold: (() => void) | undefined;
  const commitComposition = (): void => {
    const preedit = handle.current?.instance?.takeComposition() ?? "";
    if (preedit !== "") send(preedit);
  };
  return {
    send,
    paste: (text) => {
      const element = handle.current?.instance?.element;
      if (element === undefined) return;
      commitComposition();
      pasteInto(element, text);
    },
    pasteFiles: (files) => {
      commitComposition();
      pasteFiles(files);
    },
    commitComposition,
    focus: () => {
      // A syllable still composing is sent first: letting the field go for the keyboard would drop it (#1519).
      commitComposition();
      const field = fieldOf(handle);
      const held = endHold(field);
      askingForKeyboard(handle, softKeyboard);
      handle.current?.focus();
      // The press let the field go on its pointerdown; this focus was the last part the program is not told about.
      if (held && field !== null) queueMicrotask(() => regaining.delete(field));
    },
    letGo: (button, pointerId) => {
      if (!softKeyboard) return;
      const field = fieldOf(handle);
      if (field === null || field.ownerDocument.activeElement !== field) return;
      releaseHold = holdForPress(field, () => handle.current?.focus(), button, pointerId);
      field.blur();
    },
    dispose: () => {
      releaseHold?.();
      releaseHold = undefined;
    },
    quiet: () => {
      // A surface with no soft keyboard of its own (a mouse-only window) keeps its field as it is, for an OS on-screen
      // keyboard that reads it.
      if (!softKeyboard) return;
      const field = fieldOf(handle);
      // A field that has the focus is the one the keys just asked for: its mode is that ask's until it lets go.
      if (field !== null && field.ownerDocument.activeElement !== field) field.inputMode = "none";
    },
  };
}

export function useTerminalPort(
  handle: RefObject<TerminalHandle | null>,
  send: (data: TerminalInput) => void,
  onPort: ((port: TerminalPort | null) => void) | undefined,
  pasteFiles: (files: readonly File[]) => void,
  softKeyboard: boolean,
): void {
  const port = useMemo(() => portOf(handle, send, pasteFiles, softKeyboard), [handle, send, pasteFiles, softKeyboard]);
  useEffect(() => {
    onPort?.(port);
    return () => onPort?.(null);
  }, [onPort, port]);
  // Its own effect, so a new onPort alone does not end a press the same port is still holding.
  useEffect(() => () => port.dispose(), [port]);
}

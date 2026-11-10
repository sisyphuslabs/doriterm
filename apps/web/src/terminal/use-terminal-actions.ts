import { useToastManager } from "@doriface/ui";
import type { WTerm } from "@wterm/react";
import { useEffect, useRef, useState } from "react";
import { terminalConfigStore } from "../ghostty/config-store.ts";
import { rendererOptions } from "../ghostty/render-options.ts";
import { sendBytes } from "../keys/actions.ts";
import { copiedText } from "./copied-text.ts";
import { useActionHandler } from "../keys/dispatcher.ts";
import { ClipboardWaits } from "./clipboard-waits.ts";
import { heldSelection } from "./held-selection.ts";
import { pasteClipboardImage } from "./paste-files.ts";
import { scrollTerminal } from "./terminal-scroll.tsx";
import type { TerminalInputPath } from "./use-terminal-input.ts";

/** Select alls still being made, per terminal; Copy waits for its terminal's. */
const selectingAll = new WeakMap<WTerm, Promise<unknown>>();

/** Puts the terminal's selection on the clipboard, trimmed as the config says; false when nothing is selected. */
function copySelection(wt: WTerm): boolean {
  const text = wt.getSelectionText() ?? heldSelection(wt.element)?.text ?? null;
  if (text === null || text === "") return false;
  const { trimCopy } = rendererOptions(terminalConfigStore.config);
  void navigator.clipboard?.writeText(copiedText(text, trimCopy)).catch(() => undefined);
  return true;
}

/**
 * `input` is the view's input path, so bound keys queue through a reconnect in order with typed input. A view off the
 * screen (`shown` false: its tab left) or gone lets go of its Paste image presses still waiting on the clipboard.
 */
export function useTerminalActions(
  wt: WTerm | null,
  input: Pick<TerminalInputPath, "typed" | "typedLater" | "typedLate" | "pasteFiles">,
  focused: boolean,
  shown: boolean,
  openFind: () => void,
): void {
  const { typed: send, typedLater, typedLate, pasteFiles } = input;
  const toasts = useToastManager();
  const latestToasts = useRef(toasts);
  latestToasts.current = toasts;
  const [waits] = useState(() => new ClipboardWaits(() => latestToasts.current));
  useEffect(() => {
    if (!shown) waits.end();
  }, [waits, shown]);
  useEffect(() => () => waits.end(), [waits]);
  useActionHandler("terminal", (action) => {
    if (wt === null || !focused) return false;
    if (action.startsWith("send:")) return (send(sendBytes(action)), true);
    switch (action) {
      case "terminal.copy": {
        // A Select all still being made is waited for, so Copy right after it copies what it selects.
        const selecting = selectingAll.get(wt);
        if (selecting !== undefined) {
          void selecting.then(() => copySelection(wt));
          return true;
        }
        return copySelection(wt);
      }
      case "terminal.paste":
        // Not consumed: the browser's own paste event runs clipboard-paste-protection and works where
        // clipboard-read is denied (the desktop shell).
        return false;
      case "terminal.paste_image": {
        // herdr-app's Ctrl+V: the clipboard's image as a file on the terminal's machine, else the key. Keys typed while
        // the clipboard is read reach the program after its ^V, as herdr-app reads the clipboard before the next key, but
        // only for a short while (#1989): past it they go at once, and the clipboard's answer, when the person allows the
        // paste, is still pasted then. An image's path comes once its upload ends, after keys typed meanwhile. A late ^V
        // leaves a syllable the person is composing by then alone (typedLate).
        pasteClipboardImage(navigator.clipboard ?? {}, waits.press({ later: typedLater, send: typedLate, pasteFiles }));
        return true;
      }
      case "terminal.select_all": {
        const selecting = Promise.resolve(wt.selectAll()).finally(() => {
          if (selectingAll.get(wt) === selecting) selectingAll.delete(wt);
        });
        selectingAll.set(wt, selecting);
        return true;
      }
      case "terminal.search":
        openFind();
        return true;
      case "terminal.clear":
        send("\u000c");
        return true;
      case "terminal.scroll:top":
        return scrollTerminal(wt, { to: "top" });
      case "terminal.scroll:bottom":
        return scrollTerminal(wt, { to: "bottom" });
      case "terminal.scroll:page_up":
        return scrollTerminal(wt, { pages: -1 });
      case "terminal.scroll:page_down":
        return scrollTerminal(wt, { pages: 1 });
      case "terminal.scroll:line_up":
        return scrollTerminal(wt, { lines: -1 });
      case "terminal.scroll:line_down":
        return scrollTerminal(wt, { lines: 1 });
      case "terminal.prompt:prev":
        return wt.scrollToPrompt(-1);
      case "terminal.prompt:next":
        return wt.scrollToPrompt(1);
      default:
        return false;
    }
  });
}

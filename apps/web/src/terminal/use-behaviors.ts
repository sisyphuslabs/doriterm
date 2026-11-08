import type { TerminalStream } from "@doriface/client";
import type { WTerm } from "@wterm/react";
import { useEffect, type RefObject } from "react";
import type { RendererOptions } from "../ghostty/render-options.ts";
import { copiedText } from "./copied-text.ts";
import { heldSelection } from "./held-selection.ts";
import { choosePaste, filesOf } from "./paste-files.ts";

export interface PendingPaste {
  readonly text: string;
}

/**
 * copy-on-select, mouse-hide-while-typing and clipboard-paste-protection on one terminal element, and files: a pasted
 * image or copied files, or files dropped on it, go to `onFiles` instead of reaching the terminal as text (#701).
 */
export function useBehaviors(
  wt: WTerm | null,
  stream: RefObject<TerminalStream | null>,
  options: RendererOptions,
  onUnsafePaste: (paste: PendingPaste) => void,
  onFiles: (files: readonly File[]) => void,
): void {
  const { copyOnSelect, hideMouseWhileTyping, pasteProtection, trimCopy } = options;
  useEffect(() => {
    if (wt === null) return undefined;
    const element = wt.element;
    const abort = new AbortController();
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      capture = false,
    ) => element.addEventListener(type, listener, { signal: abort.signal, capture });

    // Listened for before clipboard-paste-protection, so copied files' names never ask to be pasted as lines.
    on(
      "paste",
      (event) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const choice = choosePaste(text, filesOf(event.clipboardData));
        if (choice.kind === "text") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        onFiles(choice.files);
      },
      true,
    );
    on("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files") !== true) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    on("drop", (event) => {
      const files = filesOf(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      onFiles(files);
    });
    if (copyOnSelect) {
      // A shift-drag's selection is the view's own (use-shift-drag-select.ts), not wterm's.
      on("mouseup", () => {
        const text = wt.getSelectionText() ?? heldSelection(element)?.text ?? null;
        if (text !== null && text !== "") {
          void navigator.clipboard?.writeText(copiedText(text, trimCopy)).catch(() => undefined);
        }
      });
    }
    if (trimCopy) {
      // The browser's own Copy (Ctrl/Cmd+C on a selection) puts the same trimmed text there as the Copy action.
      on(
        "copy",
        (event) => {
          const text = wt.getSelectionText();
          if (text === null || text === "" || event.clipboardData === null) return;
          event.clipboardData.setData("text/plain", copiedText(text, true));
          event.preventDefault();
          event.stopImmediatePropagation();
        },
        true,
      );
    }
    if (hideMouseWhileTyping) {
      on("keydown", () => element.classList.add("cursor-none"));
      on("mousemove", () => element.classList.remove("cursor-none"));
    }
    if (pasteProtection) {
      on(
        "paste",
        (event) => {
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const bracketed = wt.bridge?.bracketedPaste() ?? false;
          if (bracketed || !/[\r\n]/.test(text.replace(/[\r\n]+$/, ""))) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          onUnsafePaste({ text });
        },
        true,
      );
    }
    return () => {
      abort.abort();
      element.classList.remove("cursor-none");
    };
  }, [wt, stream, copyOnSelect, hideMouseWhileTyping, pasteProtection, trimCopy, onUnsafePaste, onFiles]);
}

import { MenuItem, PointMenu, useToastManager } from "@doriface/ui";
import type { TerminalHandle } from "@wterm/react";
import { ClipboardPaste, Copy } from "lucide-react";
import type { RefObject } from "react";
import { copiedText } from "./copied-text.ts";
import { heldSelection } from "./held-selection.ts";
import type { Point } from "./long-press.ts";
import { readClipboard } from "./paste-files.ts";
import { pasteInto } from "./terminal-port.ts";

interface SelectionMenuProps {
  /** Where a held touch lifted, while the menu is open. */
  readonly at: Point | null;
  readonly handle: RefObject<TerminalHandle | null>;
  readonly trimCopy: boolean;
  readonly pasteFiles: (files: readonly File[]) => void;
  readonly onClose: () => void;
  /** The terminal is browsed read-only (browse-mode.ts): Copy alone, since a paste would write to it. */
  readonly readOnly?: boolean;
}

/** The menu of Copy and Paste a held touch opens over the terminal's selection. */
export function SelectionMenu({ at, handle, trimCopy, pasteFiles, onClose, readOnly = false }: SelectionMenuProps) {
  const toasts = useToastManager();
  const copySelection = (): void => {
    const instance = handle.current?.instance;
    if (instance === null || instance === undefined) return;
    const held = heldSelection(instance.element);
    const text = held === null ? (instance.getSelectionText() ?? "") : held.text;
    if (text === "") return;
    void navigator.clipboard?.writeText(copiedText(text, trimCopy)).catch(() => undefined);
  };
  const pasteClipboard = (): void => {
    const instance = handle.current?.instance;
    if (instance === null || instance === undefined) return;
    // A browser without the clipboard API throws instead of rejecting, so the call runs inside the promise chain.
    void Promise.resolve()
      .then(() => readClipboard(navigator.clipboard))
      .then(
        (read) => ("files" in read ? pasteFiles(read.files) : pasteInto(instance.element, read.text)),
        () => toasts.add({ type: "warning", title: "Paste needs access to the clipboard" }),
      );
  };
  return (
    <PointMenu at={at} onClose={onClose} label="Selected text">
      <MenuItem
        icon={<Copy aria-hidden />}
        onClick={() => {
          copySelection();
          onClose();
        }}
      >
        Copy
      </MenuItem>
      {readOnly ? null : (
        <MenuItem
          icon={<ClipboardPaste aria-hidden />}
          onClick={() => {
            pasteClipboard();
            onClose();
          }}
        >
          Paste
        </MenuItem>
      )}
    </PointMenu>
  );
}

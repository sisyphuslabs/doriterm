import type { useToastManager } from "@doriface/ui";
import type { PasteImageInput } from "./paste-files.ts";

/** Shown while a Paste image's clipboard read outlasts its wait: a browser is asking the person to allow the paste. */
const CLIPBOARD_WAITING = {
  title: "Waiting for the clipboard",
  description: "Allow the paste to insert the image; otherwise Ctrl+V goes to the program.",
  timeout: 0,
};

/** Where the notice goes: the app's toasts. */
export type WaitNotices = Pick<ReturnType<typeof useToastManager>, "add" | "close">;

/**
 * One view's Paste image presses whose clipboard has not answered within the wait (#1938). They share one notice, up
 * while any of them waits, so a second press adds none. When the view goes or leaves the screen (its tab left), `end`
 * closes the notice and drops what those presses would still write: their ^V or image path never reaches a terminal
 * the person has left. A press after that is heard as usual.
 */
export class ClipboardWaits {
  #waiting = 0;
  #notice: string | undefined;
  #round = 0;
  readonly #notices: () => WaitNotices;

  constructor(notices: () => WaitNotices) {
    this.#notices = notices;
  }

  /** The input of one press: the view's, with its late writes dropped once `end` is called. */
  press(input: Omit<PasteImageInput, "waiting">): PasteImageInput {
    const round = this.#round;
    const live = (): boolean => round === this.#round;
    let waits = false;
    return {
      later: input.later,
      send: (data) => {
        if (live()) input.send(data);
      },
      pasteFiles: (files) => {
        if (live()) input.pasteFiles(files);
      },
      waiting: (waiting) => {
        if (!live() || waiting === waits) return;
        waits = waiting;
        this.#waiting += waiting ? 1 : -1;
        if (waiting) this.#notice ??= this.#notices().add(CLIPBOARD_WAITING);
        else if (this.#waiting === 0) this.#close();
      },
    };
  }

  /** Every press waiting now is let go: its notice closed, and its answer, whenever it comes, writes nothing. */
  end(): void {
    this.#round += 1;
    this.#waiting = 0;
    this.#close();
  }

  #close(): void {
    if (this.#notice === undefined) return;
    this.#notices().close(this.#notice);
    this.#notice = undefined;
  }
}

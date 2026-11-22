import { inviteLink } from "../config/invite-link.ts";
import type { PasteInviteAnswer } from "../shared/paste-invite.ts";

/** Input a person makes on purpose: a press, a key, a tap. A move, a scroll or a hover is not one. */
const GESTURES: ReadonlySet<string> = new Set([
  "mouseDown",
  "mouseUp",
  "rawKeyDown",
  "keyDown",
  "touchEnd",
  "gestureTap",
]);

/** How long a gesture lets a page ask once: Chromium's own transient user activation lasts 5 s. */
export const GESTURE_MS = 5_000;

/**
 * The last gesture the OS delivered to each page, as the main process saw it (`webContents` `input-event`), so a
 * page script cannot fake one. Paste invite reads the clipboard only on one, and each gesture allows one read (#2656).
 */
export class InputGestures {
  readonly #last = new Map<number, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  note(contentsId: number, type: string): void {
    if (GESTURES.has(type)) this.#last.set(contentsId, this.#now());
  }

  /** Whether the page had a gesture in the last {@link GESTURE_MS}; it is used up either way. */
  take(contentsId: number): boolean {
    const at = this.#last.get(contentsId);
    this.#last.delete(contentsId);
    return at !== undefined && this.#now() - at <= GESTURE_MS;
  }

  forget(contentsId: number): void {
    this.#last.delete(contentsId);
  }
}

/** What Paste invite reads through: the page's gesture, used up, and the clipboard's plain text in this process. */
export interface PasteInviteDeps {
  readonly takeGesture: (contentsId: number) => boolean;
  readonly readClipboard: () => Promise<string>;
}

/**
 * Paste invite for the page `contentsId` (#2656): without a gesture the clipboard is not read at all; with one, only an
 * invite link the shell rebuilt is answered, and any other text stays in this process.
 */
export async function pasteInvite(contentsId: number | undefined, deps: PasteInviteDeps): Promise<PasteInviteAnswer> {
  if (contentsId === undefined || !deps.takeGesture(contentsId)) return { refused: "gesture" };
  const link = inviteLink(await deps.readClipboard());
  return link === undefined ? { refused: "not-invite" } : { link };
}

import type { WTerm } from "@wterm/react";
import type { RefObject } from "react";
import { markHistoryGap } from "./history-gaps.ts";
import { type EndHolder, fromEndOf, holdFromEnd, readerInputOn } from "./hold-view-from-end.ts";
import type { KittyPngTranscoder } from "./kitty-png.ts";
import type { OutputPacer } from "./output-pacer.ts";

/**
 * Cursor home, then erase to the end of the screen (ED 0): clears the screen in use and leaves the scrollback alone. The
 * core's repaint starts with ESC[2J, which Ghostty answers over a prompt marked with OSC 133 (fish 4, shell integration)
 * by scrolling the screen into history; over a screen already blank there is nothing to scroll. Under a full-screen
 * program (vim, less, htop) this clears the alternate screen only: the repaint leaves it, and its ESC[2J scrolls the
 * primary screen behind it into history once when that screen ends at an OSC 133-marked prompt. The repaint does not draw
 * the primary screen again, so that is the only copy of the output above the program's command, and the primary screen
 * must not be erased here. Over an unmarked prompt the core's repaint erases that screen with no copy; that loss is the
 * core's, and belongs with the resume-cursor work in #2033.
 */
const CLEAR_SCREEN = "\u001b[H\u001b[J";

/**
 * Reattached after a reconnect: the core repaints the screen, and the history above it stays as the view holds it
 * (#1997). A view the core painted clears its screen first, so the repaint's ESC[2J has no marked prompt to scroll into
 * history, and marks the place: output that scrolled off the core's screen while the line was down is not in the history
 * there (#2033).
 */
export function keepViewOnReattach(
  ready: WTerm,
  pacer: OutputPacer,
  output: KittyPngTranscoder,
  keepsHistory: boolean,
  endHold: RefObject<EndHolder | null>,
): void {
  // Read the reader's place before the repaint (#1393).
  const fromEnd = fromEndOf(ready.element);
  // The repaint's first write would follow the output down: a reader who is away stays away until they scroll or type.
  if (fromEnd > 0) ready.holdScrollAway();
  pacer.drop();
  output.reset();
  if (keepsHistory) {
    markHistoryGap(ready);
    ready.write(CLEAR_SCREEN);
  }
  // The repaint lands where the reader was: at the end for one who was following, in history for one who was not.
  endHold.current?.stop();
  // Only the reader's own input lets go early: on the terminal or what overlays it, its scrollbar included.
  const reader = readerInputOn(ready.element.parentElement ?? ready.element);
  endHold.current = holdFromEnd(ready.element, pacer, fromEnd, reader);
}

import type { HcConnection, TerminalStream } from "@doriface/client";
import { useToastManager } from "@doriface/ui";
import type { WTerm } from "@wterm/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { terminalConfigStore } from "../ghostty/config-store.ts";
import { rendererOptions } from "../ghostty/render-options.ts";
import { CursorResets } from "./cursor-reset.ts";
import { readDisplay } from "./display.ts";
import { clearHistoryGap, noteHistoryGap } from "./history-gap-notice.ts";
import { type EndHolder, fromEndOf, holdFromEnd, readerInputOn } from "./hold-view-from-end.ts";
import type { KittyPngTranscoder } from "./kitty-png.ts";
import { openFailure } from "./open-failure.ts";
import { afterLeaving, dropOpeningAttach, noteLeaving } from "./leaving-attach.ts";
import { HISTORY_LINES, noteViewSize, viewAttach } from "./opening-attach.ts";
import type { OutputPacer, ReplayOptions } from "./output-pacer.ts";
import { type TerminalEnd, terminalEnd } from "./terminal-end.ts";
import {
  type CoreAnswer,
  restartOnReattach,
  type Settled,
  settled,
  type Unsent,
  unsentReason,
} from "./terminal-settle.ts";
import type { TerminalInput } from "./terminal-view-props.ts";
import { useReopenWhenMoved } from "./use-reopen-when-moved.ts";

const encoder = new TextEncoder();

/** What holds a terminal's paint: an attach replay settling (D5), or a synchronized update still coming in (#2040). */
export type PaintHold = "replay" | "update";
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

interface AttachSources {
  readonly connection: HcConnection;
  readonly address: string;
  readonly pid: number | null;
  readonly live: boolean;
  readonly shown: boolean;
  readonly wt: WTerm | null;
  readonly setWt: (wt: WTerm | null) => void;
  readonly stream: RefObject<TerminalStream | null>;
  readonly pending: RefObject<TerminalInput[]>;
  readonly pacer: OutputPacer;
  readonly output: KittyPngTranscoder;
  readonly isFocused: RefObject<boolean>;
  /** The view in use takes keyboard focus once it is ready, unless a modal is open over it. */
  readonly focusWhenFree: (ready: WTerm) => void;
  readonly onEnd: ((address: string, end: TerminalEnd) => void) | undefined;
  readonly onEnded: (() => void) | undefined;
  /** Called as each stream (first attach or reattach) starts, before what was typed meanwhile is written to it. */
  readonly onStream?: RefObject<(() => void) | null>;
  /**
   * Notes that a replay or a synchronized update holds the paint (true) or lets it go (false), and returns whether the
   * paint is still held by either. It keeps the view's `renderingPaused` prop in step: @wterm/react applies that prop on
   * every render, so a hold set on the terminal alone is let go by the next render of the view, mid-replay.
   */
  readonly holdPaint: (hold: PaintHold, held: boolean) => boolean;
}

/**
 * An attach's first paint holds its replay: written as it arrives with the paint held, then drawn once it has
 * settled (D5, #812). hc marks no end of the replay (the stream is its first paint, then live bytes), so the hold ends
 * on a quiet gap, bounded by the replay caps. A view mounted anew (a phone crossing the layout breakpoint, a pane
 * opened on a terminal already running) has no screen to keep, but its replay covers the last 2,000 history lines,
 * and paced into view it walks them past the person at the bottom; held, it lands whole. A first attach that waited
 * out of view (a background tab, #1187) is held the same way, so the tab appears at the end of its history (#1588).
 * The one exception is `fresh`, the attach sent with the run that started the terminal: it has no history to walk, so
 * its first prompt is drawn as it arrives rather than after the quiet window (#1928).
 */
export function replayOnAttach(pacer: OutputPacer, options: ReplayOptions, fresh = false): void {
  if (fresh) return;
  pacer.replay(options);
}

export interface Attachment {
  /** The first attach is unanswered: the pane says it is opening, not a ready shell with nothing in it (#483). */
  readonly opening: boolean;
  readonly restarting: boolean;
  readonly ended: boolean;
  /** Why attaching failed, in plain words; null once Try again clears it. */
  readonly unopened: string | null;
  readonly clearUnopened: () => void;
  /** The view's onEnd as it is now: an end acts on the tabs as they are by then. */
  readonly onEndNow: RefObject<((address: string, end: TerminalEnd) => void) | undefined>;
}

/** What a pane does when a connection arrives: attach, replay, settle what the core says is left, and report unsent input. */
export function useTerminalAttach(sources: AttachSources): Attachment {
  const { connection, address, pid, live, shown, wt, setWt, stream, pending, pacer, output } = sources;
  const { isFocused, focusWhenFree, onEnd, onEnded, onStream, holdPaint } = sources;
  const toasts = useToastManager();
  const [restarting, setRestarting] = useState(false);
  const [ended, setEnded] = useState(false);
  /** Counts the streams the core ended with the program still running; each is re-attached by the effect below. */
  const [lostStreams, setLostStreams] = useState(0);
  const reattachedFor = useRef(0);
  const endHold = useRef<EndHolder | null>(null);
  const [unopened, setUnopened] = useState<string | null>(null);
  const unopenedAt = useReopenWhenMoved(address, unopened, () => {
    setWt(null);
    setUnopened(null);
  });
  const [opening, setOpening] = useState(false);

  const unmounted = useRef(false);
  const unsent = useRef<() => void>(() => undefined);
  /** The last attach sent, settled once answered (and closed, when its view has gone by then). */
  const answering = useRef<{ connection: HcConnection; address: string; answered: Promise<unknown> } | null>(null);
  useEffect(
    () => () => {
      unmounted.current = true;
      // An attach still unanswered has no stream to close yet: the next view of this terminal waits for it (#2475).
      const left = answering.current;
      if (stream.current === null && left !== null) noteLeaving(left.connection, left.address, left.answered);
      void stream.current?.close();
      unsent.current();
    },
    [stream],
  );

  const attachedTo = useRef(connection);
  /** The renderer last attached: null until the first attach, which waits until the pane is shown (#1187). */
  const attachedView = useRef<WTerm | null>(null);
  const attachedBefore = useRef(false);
  /** The view the core last painted: a reattach to it keeps its history, a new one (Try again) has none to keep. */
  const paintedView = useRef<WTerm | null>(null);
  const program = useRef(pid);
  const reportUnsent = (why: Unsent): void => {
    const title = why === null ? "Typed input was not sent" : `Typed input was not sent because the program ${why}`;
    toasts.add({ type: "warning", title });
  };
  /** The core's answer about this terminal over `over`, as a CoreAnswer. */
  const askCore = (over: HcConnection): Promise<CoreAnswer> =>
    over.call("terminal.get", { terminal: address }).then(
      (terminal) => ({ terminal }),
      (cause: unknown) => ({ error: cause }),
    );
  // Input still queued when this view goes away (its program restarted or ended while the line was down) was never
  // sent; say so once the core says which, unless the reattach below already did.
  useEffect(() => {
    unsent.current = () => {
      const queued = pending.current.splice(0).length;
      const latest = attachedTo.current;
      if (queued === 0 || latest.closed) return;
      // A question the dropped line cannot answer still reports, without a reason.
      void askCore(latest).then((answer) => reportUnsent(unsentReason(answer, program.current)));
    };
  });
  // Read when the stream ends, not when it attached, so an end acts on the tabs as they are by then.
  const onEndNow = useRef(onEnd);
  useEffect(() => {
    onEndNow.current = onEnd;
  }, [onEnd]);

  /** The core ended the stream, or refused an attach, with the program not known to be over: ask it what is left. */
  const settle = (refusal: { readonly cause: unknown } | null): void => {
    void askCore(connection).then((answer) => {
      // The line dropped again: the next connection attaches anew.
      if (connection.closed || unmounted.current) return undefined;
      const then: Record<Settled, () => void> = {
        finished: () => onEndNow.current?.(address, "finished"),
        ended: () => {
          setEnded(true);
          onEnded?.();
        },
        restarting: () => setRestarting(true),
        reattach: () => setLostStreams((count) => count + 1),
        replaced: () => undefined,
        error: () => {
          unopenedAt(address);
          setUnopened(openFailure(address, "error" in answer ? answer.error : refusal?.cause));
        },
      };
      return then[settled(answer, program.current, !attachedBefore.current, refusal !== null)]();
    });
  };
  // Waiting for a restart that will not come: the program ended (killed during the grace, or the core gave up on it).
  useEffect(() => {
    if (restarting && !live) onEndNow.current?.(address, "finished");
  }, [restarting, live, address]);

  const attach = (ready: WTerm): void => {
    setWt(ready);
    // The same connection attaching again means the core ended this terminal's stream while the line stayed up.
    const sameConnection = attachedTo.current === connection;
    attachedTo.current = connection;
    attachedView.current = ready;
    // A test hook, as crash-probe is: a spec sets window.__dorifaceAttachLog and reads which terminal re-attached when
    // a link came back (#639). Inert in the product, where nothing sets it.
    const attachLog: unknown = Reflect.get(globalThis, "__dorifaceAttachLog");
    if (Array.isArray(attachLog)) attachLog.push(address);
    // wterm pins the row height it measured at mount inline, over the stylesheet's font-size-derived one; without this
    // a font-size change (zoom, Settings) keeps the old row height, so the grid gains columns but never rows.
    ready.element.style.removeProperty("--term-row-height");
    // wterm starts every grid at 80x24 and fits it later; the pty starts at the size the view renders.
    ready.fit();
    const { cols, rows } = ready;
    noteViewSize(cols, rows);
    const display = readDisplay(ready.element);
    // A reattach after a reconnect says so: the core applies its size only once this viewer is active again.
    const resumed = attachedBefore.current ? { resumed: true } : {};
    // A reattach to a view the core has painted keeps the history it holds and asks for the screen alone, as hc does
    // when it reattaches a viewer on another core: 2,000 lines again played the history back, over a MiB that a slow
    // link hands over for longer than the replay's paint hold, so the view climbed through all of it (#1997). Lines that
    // scrolled off the screen while the line was down are not added; the core has no cursor to resume from. A new view
    // (Try again after a refused reattach) holds no history, so it asks for it as a first attach does.
    const keepsHistory = paintedView.current === ready;
    const history = keepsHistory ? 0 : HISTORY_LINES;
    // A reattach after a reconnect keeps its screen and has the connection's own status; only a first attach says so.
    if (!attachedBefore.current) setOpening(true);
    const attachOwn = () =>
      connection.attach({ terminal: address, cols, rows, history, display, ...resumed }, { autoCredit: false });
    // A view gone while it waited sends no attach of its own, which would only resize the pty to its size (#2496
    // review). An attach sent ahead with the terminal's run is still taken and closed: left open, it holds the core's
    // viewer at the gone view's size, the very bug above.
    const asked = afterLeaving(connection, address).then(() => {
      if (!unmounted.current)
        return viewAttach(connection, address, !attachedBefore.current, { cols, rows, display }, attachOwn);
      return attachedBefore.current ? null : dropOpeningAttach(connection, address).then(() => null);
    });
    const answered = asked.then<unknown, void>(
      (opened) => {
        if (opened === null) return;
        const { stream: attached, cols: askedCols, rows: askedRows, fresh } = opened;
        if (unmounted.current) return attached.close();
        setOpening(false);
        // The program restarted while the line was down: what was typed for it must not reach the new one.
        const restart = restartOnReattach(
          attachedBefore.current,
          attached.terminal.pid,
          program.current,
          pending.current,
        );
        if (restart.close) {
          void attached.close();
          if (restart.unsent !== null) reportUnsent(restart.unsent);
          return undefined;
        }
        stream.current = attached;
        // The view in use (the focused pane, in a focused window) was the active viewer before the drop; a FOCUS frame
        // makes it active again, so the core applies its size now. Other views send no FOCUS, which would report
        // focus-in to their programs; their size applies when they are focused or resized.
        const inUse = isFocused.current && document.hasFocus() && ready.element.contains(document.activeElement);
        if (attachedBefore.current && inUse) attached.focus(true);
        // A fit while the attach was in flight had no stream to resize.
        if (ready.cols !== askedCols || ready.rows !== askedRows) attached.resize(ready.cols, ready.rows);
        // Reattached after a reconnect: the core repaints the screen, and the history above it stays as the view holds it
        // (#1997). The view clears its screen first, so the repaint's ESC[2J has no marked prompt to scroll into history.
        if (attachedBefore.current) {
          // Read the reader's place before the repaint (#1393).
          const fromEnd = fromEndOf(ready.element);
          // The repaint's first write would follow the output down: a reader who is away stays away until they scroll
          // or type.
          if (fromEnd > 0) ready.holdScrollAway();
          pacer.drop();
          output.reset();
          // Output that scrolled off the core's screen meanwhile is not in the kept history (#2033). A reconnect was
          // already noted as the line went down (below).
          if (keepsHistory) {
            noteHistoryGap(address, sameConnection ? "stream" : "reconnect");
            ready.write(CLEAR_SCREEN);
          }
          // The repaint lands where the reader was: at the end for one who was following, in history for one who was not.
          endHold.current?.stop();
          // Only the reader's own input lets go early: on the terminal or what overlays it, its scrollbar included.
          const reader = readerInputOn(ready.element.parentElement ?? ready.element);
          endHold.current = holdFromEnd(ready.element, pacer, fromEnd, reader);
        }
        // A view attached anew, a first attach included (a phone opens the terminal again as a new view), has its
        // history played back: nothing it shows is missing any more (#2279 review).
        if (!keepsHistory) clearHistoryGap(address);
        attachedBefore.current = true;
        paintedView.current = ready;
        // Every attach's first paint is its replay: written as it arrives with the paint held, then drawn once it has
        // settled, so a view mounted anew, or a tab first attached when switched to, does not walk its history past the
        // person (D5, #812, #1588). A terminal this page just started (`fresh`) is the exception: see replayOnAttach.
        replayOnAttach(
          pacer,
          {
            srtt: () => connection.rtt?.srtt,
            hold: (held) => ready.setRenderingPaused(holdPaint("replay", held)),
          },
          fresh,
        );
        // The terminal is paused at once, not at the view's next render: wterm's own hold of the update may run out first.
        pacer.holdSynchronized((held) => ready.setRenderingPaused(holdPaint("update", held)));
        onStream?.current?.();
        const resets = new CursorResets();
        const credit = (count: number): void => {
          if (stream.current === attached) attached.consumed(count);
        };
        attached.onData((bytes) => {
          pacer.push(bytes, credit);
          // A cursor reset (the attach replay starts with one) means the default shape: the configured cursor-style.
          if (resets.push(bytes))
            pacer.push(encoder.encode(rendererOptions(terminalConfigStore.config).cursorSequence));
        });
        attached.onClose((close) => {
          if (stream.current === attached) stream.current = null;
          const end = terminalEnd(close);
          // The line went down under a painted view: what it prints meanwhile may not reach the history. Said now, the
          // note takes over the phone's Reconnecting line as the connection comes back, at its height (#2257).
          if (end === "dropped" && paintedView.current === ready) noteHistoryGap(address, "reconnect");
          onEndNow.current?.(address, end);
          if (end === "lost") settle(null);
        });
        for (const data of pending.current.splice(0)) attached.write(data);
        focusWhenFree(ready);
        return attached;
      },
      (cause: unknown) => {
        // The connection dropped mid-attach: the next one attaches again (below).
        if (connection.closed || unmounted.current) return;
        setOpening(false);
        settle({ cause });
      },
    );
    answering.current = { connection, address, answered };
  };

  useEffect(() => {
    if (wt === null || !shown) return;
    // A renderer not attached yet (the first, or one mounted again by Try again) attaches here too, once shown.
    const attached = attachedView.current === wt && attachedTo.current === connection;
    if (attached && reattachedFor.current === lostStreams) return;
    reattachedFor.current = lostStreams;
    attach(wt);
  }, [wt, connection, shown, lostStreams]);

  return { opening, restarting, ended, unopened, clearUnopened: () => setUnopened(null), onEndNow };
}

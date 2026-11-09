import type { HcConnection, TerminalStream } from "@doriface/client";
import { useToastManager } from "@doriface/ui";
import type { TerminalHandle, WTerm } from "@wterm/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { terminalConfigStore } from "../ghostty/config-store.ts";
import { rendererOptions } from "../ghostty/render-options.ts";
import { CursorResets } from "./cursor-reset.ts";
import { readDisplay } from "./display.ts";
import { type EndHolder, holdAtEnd } from "./hold-view-at-end.ts";
import type { KittyPngTranscoder } from "./kitty-png.ts";
import { openFailure } from "./open-failure.ts";
import { HISTORY_LINES, noteViewSize, viewAttach } from "./opening-attach.ts";
import type { OutputPacer, ReplayOptions } from "./output-pacer.ts";
import { type TerminalEnd, terminalEnd } from "./terminal-end.ts";
import { type CoreAnswer, type Settled, settled, type Unsent, unsentReason } from "./terminal-settle.ts";
import type { TerminalInput } from "./terminal-view-props.ts";
import { useReopenWhenMoved } from "./use-reopen-when-moved.ts";

/** RIS: clears the screen and scrollback before an attach replay draws them again. */
const FULL_RESET = "\u001bc";
const encoder = new TextEncoder();

interface AttachSources {
  readonly connection: HcConnection;
  readonly address: string;
  readonly pid: number | null;
  readonly live: boolean;
  readonly shown: boolean;
  readonly wt: WTerm | null;
  readonly setWt: (wt: WTerm | null) => void;
  readonly handle: RefObject<TerminalHandle | null>;
  readonly stream: RefObject<TerminalStream | null>;
  readonly pending: RefObject<TerminalInput[]>;
  readonly pacer: OutputPacer;
  readonly output: KittyPngTranscoder;
  readonly isFocused: RefObject<boolean>;
  /** The view in use takes keyboard focus once it is ready, unless a modal is open over it. */
  readonly focusWhenFree: (ready: WTerm) => void;
  readonly onEnd: ((address: string, end: TerminalEnd) => void) | undefined;
  readonly onEnded: (() => void) | undefined;
}

/**
 * A reattach after a dropped connection holds its replay: written as it arrives with the paint held, then drawn once it
 * has settled (D5). hc marks no end of the replay (the stream is its first paint, then live bytes), so the hold ends on
 * a quiet gap, bounded by the replay caps. The first open of a terminal has no screen to keep and is not held.
 */
export function replayOnAttach(pacer: OutputPacer, reattach: boolean, options: ReplayOptions): void {
  if (reattach) pacer.replay(options);
}

export interface Attachment {
  readonly attach: (ready: WTerm) => void;
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
  const { connection, address, pid, live, shown, wt, setWt, handle, stream, pending, pacer, output } = sources;
  const { isFocused, focusWhenFree, onEnd, onEnded } = sources;
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
  useEffect(
    () => () => {
      unmounted.current = true;
      void stream.current?.close();
      unsent.current();
    },
    [stream],
  );

  const attachedTo = useRef(connection);
  const attachedBefore = useRef(false);
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
    attachedTo.current = connection;
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
    // A reattach after a reconnect keeps its screen and has the connection's own status; only a first attach says so.
    if (!attachedBefore.current) setOpening(true);
    const attachOwn = () =>
      connection.attach(
        { terminal: address, cols, rows, history: HISTORY_LINES, display, ...resumed },
        { autoCredit: false },
      );
    viewAttach(connection, address, !attachedBefore.current, { cols, rows, display }, attachOwn).then(
      ({ stream: attached, cols: askedCols, rows: askedRows }) => {
        if (unmounted.current) return void attached.close();
        setOpening(false);
        // The program restarted while the line was down: what was typed for it must not reach the new one.
        if (attachedBefore.current && attached.terminal.pid !== program.current) {
          void attached.close();
          if (pending.current.splice(0).length > 0) reportUnsent("restarted");
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
        // Reattached after a reconnect: the replay redraws everything, so the old screen and scrollback go first.
        if (attachedBefore.current) {
          pacer.drop();
          output.reset();
          handle.current?.write(FULL_RESET);
          // The reset leaves the scroller at the top, where the replay's rows climb past the reader (#1040).
          endHold.current?.stop();
          endHold.current = holdAtEnd(ready.element, () => pacer.busy);
        }
        const reattach = attachedBefore.current;
        attachedBefore.current = true;
        // A reattach's replay is drawn once it has settled, so the screen before it stays until then instead of climbing
        // a frame's bytes at a time (D5).
        replayOnAttach(pacer, reattach, {
          srtt: () => connection.rtt?.srtt,
          hold: (held) => ready.setRenderingPaused(held),
        });
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
  };

  useEffect(() => {
    if (wt === null || !shown) return;
    if (attachedTo.current === connection && reattachedFor.current === lostStreams) return;
    reattachedFor.current = lostStreams;
    attach(wt);
  }, [wt, connection, shown, lostStreams]);

  return { attach, opening, restarting, ended, unopened, clearUnopened: () => setUnopened(null), onEndNow };
}

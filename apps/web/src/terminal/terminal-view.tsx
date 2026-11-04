import type { HcConnection, TerminalStream } from "@doriface/client";
import { cn, useToastManager } from "@doriface/ui";
import { loadGhosttyCore } from "@doriface/ghostty-wasm";
import type { GhosttyCore } from "@wterm/ghostty";
import { Terminal, type TerminalHandle, type WTerm } from "@wterm/react";
import { type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenAwake } from "../device/keep-awake.ts";
import { terminalConfigStore, useTerminalConfig } from "../ghostty/config-store.ts";
import { rendererOptions } from "../ghostty/render-options.ts";
import { readDisplay } from "./display.ts";
import { mayTakeFocus } from "./may-take-focus.ts";
import { openFailure } from "./open-failure.ts";
import { PasteDialog } from "./paste-dialog.tsx";
import { CursorResets } from "./cursor-reset.ts";
import { readThemeColors } from "./theme-colors.ts";
import { useDarkScheme } from "./use-dark-scheme.ts";
import { useBehaviors, type PendingPaste } from "./use-behaviors.ts";
import { useFocusAfterSelect } from "./use-focus-after-select.ts";
import { type TerminalEnd, terminalEnd } from "./terminal-end.ts";
import { type CoreAnswer, type Settled, settled, type Unsent, unsentReason } from "./terminal-settle.ts";
import { Unopened } from "./unopened.tsx";
import { useTerminalActions } from "./use-terminal-actions.ts";

/** Typed text, or the bytes a bound key sends. */
export type TerminalInput = string | Uint8Array;

export interface TerminalViewProps {
  readonly connection: HcConnection;
  readonly address: string;
  /** The program this view was opened for; views are keyed by it, so a restarted program gets a new view. */
  readonly pid: number | null;
  /** Whether the core lists the terminal as live; a view waiting for a restart ends when it stops being live. */
  readonly live: boolean;
  readonly focused: boolean;
  readonly label: string;
  readonly className?: string;
  /** Rewrites typed input before it is sent (latched phone modifiers). */
  readonly transformInput?: (data: string) => string;
  /** The view's input path for keys pressed outside it (the phone's extra keys); null once it unmounts. */
  readonly onSend?: (send: ((data: TerminalInput) => void) | null) => void;
  /** Every time the stream ends, with why; see TerminalEnd. */
  readonly onEnd?: (address: string, end: TerminalEnd) => void;
}

const HISTORY_LINES = 2_000;
/** RIS: clears the screen and scrollback before an attach replay draws them again. */
const FULL_RESET = "\u001bc";

/**
 * Gives a focus event's focus back to the element that had it, unless that sits in a pane no longer focused (focus
 * moved on while this terminal started; the focused pane takes it as it attaches), or drops it when nothing had.
 */
function handBack(event: FocusEvent<HTMLElement>): void {
  const from = event.relatedTarget;
  const stale = from instanceof HTMLElement && from.closest('[data-focused="false"]') !== null;
  if (from instanceof HTMLElement && from.isConnected && !stale) from.focus();
  else if (event.target instanceof HTMLElement) event.target.blur();
}

/** One libghostty terminal attached to one hc channel; output credit returns once it is written. */
export function TerminalView(props: TerminalViewProps) {
  const { connection, address, pid, live, focused, label, className, transformInput, onSend, onEnd } = props;
  const config = useTerminalConfig();
  const options = useMemo(() => rendererOptions(config), [config]);
  const dark = useDarkScheme();
  useScreenAwake();
  const [core, setCore] = useState<GhosttyCore | null>(null);
  const [wt, setWt] = useState<WTerm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const toasts = useToastManager();
  /** Why attaching failed, in plain words; Try again clears it, which mounts the terminal and attaches again. */
  const [unopened, setUnopened] = useState<string | null>(null);
  const [paste, setPaste] = useState<PendingPaste | null>(null);
  const handle = useRef<TerminalHandle | null>(null);
  const stream = useRef<TerminalStream | null>(null);

  useEffect(() => {
    let mounted = true;
    // scrollback-limit applies to new terminals, so the core reads it once, after the stored config loads.
    terminalConfigStore.loaded
      .then(() => loadGhosttyCore({ scrollbackLimit: rendererOptions(terminalConfigStore.config).scrollbackBytes }))
      .then(
        (loaded) => (mounted ? setCore(loaded) : loaded.dispose()),
        (cause: unknown) => setError(`The terminal renderer failed to load: ${String(cause)}`),
      );
    return () => {
      mounted = false;
    };
  }, []);

  const unmounted = useRef(false);
  const unsent = useRef<() => void>(() => undefined);
  useEffect(
    () => () => {
      unmounted.current = true;
      void stream.current?.close();
      unsent.current();
    },
    [],
  );

  useEffect(() => {
    if (focused) handle.current?.focus();
  }, [focused]);

  // The default cursor shape is the terminal's own state, set locally; programs still override it.
  useEffect(() => handle.current?.write(options.cursorSequence), [wt, options.cursorSequence]);

  // After the stylesheet or the system's light/dark changes, tell libghostty and the core the colors programs
  // may query. The colors set last are inline on the element and would shadow the page's new ones, so they go first.
  useEffect(() => {
    if (wt === null) return undefined;
    const frame = requestAnimationFrame(() => {
      wt.setThemeColors(null);
      const colors = readThemeColors(wt.element);
      if (colors !== null) wt.setThemeColors(colors);
      stream.current?.facts(readDisplay(wt.element));
      wt.fit();
    });
    return () => cancelAnimationFrame(frame);
  }, [wt, config, dark]);

  const onUnsafePaste = useCallback((pending: PendingPaste) => setPaste(pending), []);
  // Input while no stream is open (attaching, or the connection dropped) waits here for the next stream.
  // Every human-input write goes through send, so keys pressed during a reconnect replay in the order pressed.
  const pending = useRef<TerminalInput[]>([]);
  const send = useCallback((data: TerminalInput): void => {
    if (stream.current?.write(data) !== true) pending.current.push(data);
  }, []);
  useEffect(() => {
    onSend?.(send);
    return () => onSend?.(null);
  }, [onSend, send]);
  useBehaviors(wt, stream, options, onUnsafePaste);
  useTerminalActions(wt, send, focused);
  useFocusAfterSelect(wt);
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
  const isFocused = useRef(focused);
  useEffect(() => {
    isFocused.current = focused;
  }, [focused]);
  /** The view in use takes keyboard focus once it is ready, unless a modal is open over it. */
  const focusWhenFree = (ready: WTerm): void => {
    if (isFocused.current && mayTakeFocus(ready.element)) ready.focus();
  };
  // Read when the stream ends, not when it attached, so an end acts on the tabs as they are by then.
  const onEndNow = useRef(onEnd);
  useEffect(() => {
    onEndNow.current = onEnd;
  }, [onEnd]);

  /** The core ended the stream, or refused an attach, with the program not known to be over: ask it what is left. */
  const settle = (ready: WTerm, refusal: { readonly cause: unknown } | null): void => {
    void askCore(connection).then((answer) => {
      // The line dropped again: the next connection attaches anew.
      if (connection.closed || unmounted.current) return undefined;
      const then: Record<Settled, () => void> = {
        finished: () => onEndNow.current?.(address, "finished"),
        restarting: () => setRestarting(true),
        reattach: () => attach(ready),
        replaced: () => undefined,
        error: () => setUnopened(openFailure(address, "error" in answer ? answer.error : refusal?.cause)),
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
    // wterm pins the row height it measured at mount inline, over the stylesheet's font-size-derived one; without this
    // a font-size change (zoom, Settings) keeps the old row height, so the grid gains columns but never rows.
    ready.element.style.removeProperty("--term-row-height");
    // wterm starts every grid at 80x24 and fits it later; the pty starts at the size the view renders.
    ready.fit();
    const { cols, rows } = ready;
    const display = readDisplay(ready.element);
    // A reattach after a reconnect says so: the core applies its size only once this viewer is active again.
    const resumed = attachedBefore.current ? { resumed: true } : {};
    connection
      .attach({ terminal: address, cols, rows, history: HISTORY_LINES, display, ...resumed }, { autoCredit: false })
      .then(
        (attached) => {
          if (unmounted.current) return void attached.close();
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
          if (ready.cols !== cols || ready.rows !== rows) attached.resize(ready.cols, ready.rows);
          // Reattached after a reconnect: the replay redraws everything, so the old screen and scrollback go first.
          if (attachedBefore.current) handle.current?.write(FULL_RESET);
          attachedBefore.current = true;
          const resets = new CursorResets();
          attached.onData((bytes) => {
            handle.current?.write(bytes);
            attached.consumed(bytes.byteLength);
            // A cursor reset (the attach replay starts with one) means the default shape: the configured cursor-style.
            if (resets.push(bytes)) handle.current?.write(rendererOptions(terminalConfigStore.config).cursorSequence);
          });
          attached.onClose((close) => {
            if (stream.current === attached) stream.current = null;
            const end = terminalEnd(close);
            onEndNow.current?.(address, end);
            if (end === "lost") settle(ready, null);
          });
          for (const data of pending.current.splice(0)) attached.write(data);
          focusWhenFree(ready);
          return attached;
        },
        (cause: unknown) => {
          // The connection dropped mid-attach: the next one attaches again (below).
          if (connection.closed || unmounted.current) return;
          settle(ready, { cause });
        },
      );
  };

  useEffect(() => {
    if (wt !== null && attachedTo.current !== connection) attach(wt);
  }, [wt, connection]);

  if (error !== null) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (restarting) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        The program in this terminal is restarting…
      </p>
    );
  }
  if (unopened !== null) return <Unopened why={unopened} className={className} onRetry={() => setUnopened(null)} />;
  if (core === null) return <div className={cn("min-h-0 flex-1 bg-term-bg", className)} aria-busy="true" />;
  return (
    <>
      <Terminal
        ref={handle}
        core={core}
        autoResize
        {...(options.cursorBlink === undefined ? {} : { cursorBlink: options.cursorBlink })}
        aria-label={label}
        data-slot="terminal-viewport"
        data-terminal={address}
        data-ready={wt !== null}
        className={cn("min-h-0 flex-1 bg-term-bg", options.hollowCursor && "cursor-hollow", className)}
        onReady={(ready) => {
          // The renderer no longer focuses itself as it starts (patches/@wterm%2Fdom@0.5.8.patch); the view decides.
          focusWhenFree(ready);
          attach(ready);
        }}
        onData={(data) => send(transformInput === undefined ? data : transformInput(data))}
        onResize={(cols, rows) => stream.current?.resize(cols, rows)}
        onFocus={(event) => {
          // wterm focuses every terminal as it starts (@wterm/dom 0.5.8 wterm.js:410). Only the focused pane's keeps
          // it; any other hands it back to where it was, so a pane another device adds never takes the keyboard.
          if (wt === null && !isFocused.current) return handBack(event);
          stream.current?.focus(true);
        }}
        onBlur={() => stream.current?.focus(false)}
      />
      <PasteDialog
        paste={paste}
        onCancel={() => setPaste(null)}
        onPaste={(text) => {
          send(text);
          setPaste(null);
        }}
      />
    </>
  );
}

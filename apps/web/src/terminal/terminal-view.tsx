import type { HcConnection, TerminalStream } from "@doriface/client";
import { cn, MenuItem, PointMenu, useToastManager } from "@doriface/ui";
import { loadGhosttyCore } from "@doriface/ghostty-wasm";
import type { GhosttyCore } from "@wterm/ghostty";
import { Terminal, type TerminalHandle, type WTerm } from "@wterm/react";
import { type EndHolder, holdAtEnd } from "./hold-view-at-end.ts";
import { ClipboardPaste, Copy } from "lucide-react";
import { type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenAwake } from "../device/keep-awake.ts";
import { terminalConfigStore, useTerminalConfig } from "../ghostty/config-store.ts";
import { rendererOptions } from "../ghostty/render-options.ts";
import { readDisplay } from "./display.ts";
import { HISTORY_LINES, noteViewSize, viewAttach } from "./opening-attach.ts";
import { keyboardIsIdle, mayTakeFocus } from "./may-take-focus.ts";
import { openFailure } from "./open-failure.ts";
import { PasteDialog } from "./paste-dialog.tsx";
import { CursorResets } from "./cursor-reset.ts";
import { copiedText } from "./copied-text.ts";
import { heldSelection } from "./held-selection.ts";
import { type Point } from "./long-press.ts";
import { KittyPngTranscoder } from "./kitty-png.ts";
import { OutputPacer } from "./output-pacer.ts";
import { readThemeColors } from "./theme-colors.ts";
import { useDarkScheme } from "./use-dark-scheme.ts";
import { useBehaviors, type PendingPaste } from "./use-behaviors.ts";
import { useFocusAfterSelect } from "./use-focus-after-select.ts";
import { useLongPressSelect } from "./use-long-press-select.ts";
import { useSelectionCells } from "./use-selection-cells.ts";
import { type TerminalEnd, terminalEnd } from "./terminal-end.ts";
import { type CoreAnswer, type Settled, settled, type Unsent, unsentReason } from "./terminal-settle.ts";
import { Ended } from "./ended.tsx";
import { type TerminalPort, pasteInto, useTerminalPort } from "./terminal-port.ts";
import { putFiles, quotePaths, readClipboard } from "./paste-files.ts";
import { Unopened } from "./unopened.tsx";
import { useReopenWhenMoved } from "./use-reopen-when-moved.ts";
import { JumpToBottom, scrollTerminal, TerminalScrollbar, useTerminalScroll } from "./terminal-scroll.tsx";
import { QuietBusy } from "./quiet-busy.tsx";
import { TerminalFind } from "./terminal-find.tsx";
import { TerminalLinks } from "./terminal-links.tsx";
import { useTerminalActions } from "./use-terminal-actions.ts";
import { useTerminalFont } from "./use-terminal-font.ts";
import { wideGlyphScaler } from "./face-scales.ts";
import { usePreedit } from "./use-preedit.ts";
import { GlyphWarmup } from "./glyph-warmup.ts";

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
  /**
   * This page asked for this terminal's pane (opened, split, picked it): starting, it takes the keyboard from wherever
   * it is. Unset where no other device edits what is shown (the phone shows one terminal at a time). Not asked for (a
   * view another device's layout edit mounts again, #332), it takes the keyboard only from nowhere.
   */
  readonly claimed?: boolean;
  readonly label: string;
  readonly className?: string;
  /** Rewrites typed input before it is sent (latched phone modifiers); an empty result sends nothing. */
  readonly transformInput?: (data: string) => string;
  /**
   * A composition is typed as it starts instead of when the input method ends it, through `transformInput`: set while a
   * phone modifier is latched, so ctrl and a Korean keyboard's ㅊ is ^C at once rather than waiting for the next jamo.
   */
  readonly typesComposition?: boolean;
  /** The view's port for keys pressed outside it (the phone's keys bar); null once it unmounts. */
  readonly onPort?: (port: TerminalPort | null) => void;
  /** Every time the stream ends, with why; see TerminalEnd. */
  readonly onEnd?: (address: string, end: TerminalEnd) => void;
  /** The action of a view whose program had ended before it attached, which reports it `finished` (default Close tab). */
  readonly closeLabel?: string;
  /** Once the view shows that its program had ended before it attached: there is no terminal left to type into. */
  readonly onEnded?: () => void;
  /** A CSS length the jump-to-bottom button keeps above the terminal's bottom, for controls floating over it. */
  readonly jumpClearance?: string;
}

/** RIS: clears the screen and scrollback before an attach replay draws them again. */
const FULL_RESET = "\u001bc";
const encoder = new TextEncoder();

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
  const { connection, address, pid, live, focused, label, className, transformInput, onPort, onEnd } = props;
  const { closeLabel = "Close tab", onEnded, jumpClearance, claimed = true, typesComposition = false } = props;
  const config = useTerminalConfig();
  const options = useMemo(() => rendererOptions(config), [config]);
  const dark = useDarkScheme();
  useScreenAwake();
  const [core, setCore] = useState<GhosttyCore | null>(null);
  const [wt, setWt] = useState<WTerm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [ended, setEnded] = useState(false);
  /**
   * Whether this view is on screen. A pane out of view keeps a stream it holds but opens none: every re-attach (a new
   * connection, or the core ending the stream of a program still running) waits until it is shown, so a hidden tab does
   * not fetch a replay nobody looks at (#639), and a program that ended meanwhile is found then (#906).
   */
  const [shown, setShown] = useState(true);
  /** Counts the streams the core ended with the program still running; each is re-attached by the effect below. */
  const [lostStreams, setLostStreams] = useState(0);
  const reattachedFor = useRef(0);
  const toasts = useToastManager();
  /** Why attaching failed, in plain words; Try again clears it, which mounts the terminal and attaches again. */
  const [unopened, setUnopened] = useState<string | null>(null);
  const unopenedAt = useReopenWhenMoved(address, unopened, () => {
    setWt(null);
    setUnopened(null);
  });
  /** The first attach is unanswered: the pane says it is opening, not a ready shell with nothing in it (#483). */
  const [opening, setOpening] = useState(false);
  const [paste, setPaste] = useState<PendingPaste | null>(null);
  /** Where a held touch lifted, while its menu of Copy and Paste is open. */
  const [selectAt, setSelectAt] = useState<Point | null>(null);
  /** The find bar's open count while it is open (each ask selects its query again), null while closed. */
  const [finding, setFinding] = useState<number | null>(null);
  const openFind = useCallback(() => setFinding((count) => (count ?? 0) + 1), []);
  const handle = useRef<TerminalHandle | null>(null);
  const endHold = useRef<EndHolder | null>(null);
  /** Counts the writes reaching the renderer, so a find reads the cells again only after new output. */
  const written = useRef(0);
  const stream = useRef<TerminalStream | null>(null);
  // The program's output reaches the core through this: Kitty images sent as PNG are decoded to RGBA on the way.
  const output = useMemo(() => new KittyPngTranscoder((bytes) => handle.current?.write(bytes)), []);
  // Output is written once a frame and credited only then, so a flood cannot starve clicks and keys (#560).
  const pacer = useMemo(
    () =>
      new OutputPacer((bytes) => {
        output.push(bytes);
        written.current += 1;
        warmup.current?.note(bytes);
        outputShown.current();
      }),
    [output],
  );
  useEffect(() => () => pacer.drop(), [pacer]);

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

  // The terminal's engine, with its scrollback and images, is freed once the view closes and its renderer is gone.
  useEffect(() => {
    if (core === null) return undefined;
    return () => queueMicrotask(() => core.dispose());
  }, [core]);

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

  const isClaimed = useRef(claimed);
  isClaimed.current = claimed;
  /** Whether this view may move the keyboard into itself now, on its own (see `claimed`). */
  const mayTakeKeyboard = (element: HTMLElement): boolean =>
    mayTakeFocus(element) && (isClaimed.current || keyboardIsIdle(element));

  // Becoming the focused pane (a tab closed, a split moved) takes keyboard focus, unless a modal is open over it.
  useEffect(() => {
    const instance = handle.current?.instance ?? null;
    if (focused && instance !== null && mayTakeKeyboard(instance.element)) instance.focus();
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
  // Input typed into the renderer, rewritten as the host asks (latched phone modifiers).
  const typedInto = (data: string): void => {
    const input = transformInput?.(data) ?? data;
    if (input !== "") send(input);
  };
  // Typed input from outside the renderer (the phone's keys, a bound key, a confirmed paste) scrolls to the bottom, as
  // wterm already does for keys typed into it. A syllable still composing in the renderer's field goes first, as typed:
  // the key must not overtake it (#652).
  const typed = useCallback(
    (data: TerminalInput): void => {
      const instance = handle.current?.instance;
      if (instance !== null && instance !== undefined) {
        const preedit = instance.takeComposition();
        if (preedit !== "") send(preedit);
        scrollTerminal(instance, { to: "bottom" });
      }
      send(data);
    },
    [send],
  );
  // herdr-app's send_image: files go to the terminal's machine (`terminal.put`), and where they landed is pasted there,
  // bracketed when the program asked, so an agent on any machine reads the image by its path (#701).
  const latestConnection = useRef(connection);
  latestConnection.current = connection;
  const pasteFiles = useCallback(
    (files: readonly File[]): void => {
      void putFiles(latestConnection.current, address, files).then(({ paths, refused }) => {
        for (const why of refused) toasts.add({ type: "warning", title: why });
        const element = handle.current?.instance?.element;
        if (paths.length > 0 && element !== undefined) pasteInto(element, quotePaths(paths));
        return paths;
      });
    },
    [address, toasts],
  );
  const typesCompositionNow = useRef(typedInto);
  typesCompositionNow.current = typedInto;
  useEffect(() => {
    if (wt === null || !typesComposition) return undefined;
    const onInput = (event: Event): void => {
      if (!(event instanceof InputEvent) || !event.isComposing) return;
      const preedit = wt.takeComposition();
      if (preedit !== "") typesCompositionNow.current(preedit);
    };
    wt.element.addEventListener("input", onInput);
    return () => wt.element.removeEventListener("input", onInput);
  }, [wt, typesComposition]);
  const scroll = useTerminalScroll(wt);
  const outputShown = useRef(scroll.changed);
  outputShown.current = scroll.changed;
  useTerminalPort(handle, typed, onPort, pasteFiles);
  useBehaviors(wt, stream, options, onUnsafePaste, pasteFiles);
  useTerminalFont(wt, config);
  usePreedit(wt);
  // Wide characters in the output are laid out in idle time, so scrolling back to them is not the first time (#286).
  const warmup = useRef<GlyphWarmup | null>(null);
  useEffect(() => {
    if (wt === null) return undefined;
    const made = new GlyphWarmup(wt.element, () => wideGlyphScaler(wt.element));
    warmup.current = made;
    return () => {
      made.stop();
      if (warmup.current === made) warmup.current = null;
    };
  }, [wt]);
  useTerminalActions(wt, typed, focused, pasteFiles, openFind);
  // A pane out of view (a hidden tab, a zoomed-away split) is not painted and takes no output until it shows (#560).
  useEffect(() => {
    if (wt === null) return undefined;
    const seen = new IntersectionObserver((entries) => {
      const visible = entries.at(-1)?.isIntersecting ?? true;
      setShown(visible);
      pacer.setVisible(visible);
      wt.setRenderingPaused(!visible);
    });
    seen.observe(wt.element);
    return () => {
      seen.disconnect();
      wt.setRenderingPaused(false);
    };
  }, [wt, pacer]);
  useFocusAfterSelect(wt, options.trimCopy);
  useLongPressSelect(wt, setSelectAt);
  useSelectionCells(wt);
  const trimCopy = options.trimCopy;
  const copySelection = useCallback((): void => {
    const instance = handle.current?.instance;
    if (instance === null || instance === undefined) return;
    const held = heldSelection(instance.element);
    const text = held === null ? (instance.getSelectionText() ?? "") : held.text;
    if (text === "") return;
    void navigator.clipboard?.writeText(copiedText(text, trimCopy)).catch(() => undefined);
  }, [trimCopy]);
  const pasteClipboard = useCallback((): void => {
    const instance = handle.current?.instance;
    if (instance === null || instance === undefined) return;
    // A browser without the clipboard API throws instead of rejecting, so the call runs inside the promise chain.
    void Promise.resolve()
      .then(() => readClipboard(navigator.clipboard))
      .then(
        (read) => ("files" in read ? pasteFiles(read.files) : pasteInto(instance.element, read.text)),
        () => toasts.add({ type: "warning", title: "Paste needs access to the clipboard" }),
      );
  }, [toasts, pasteFiles]);
  const closeSelectionMenu = useCallback((): void => {
    setSelectAt(null);
    handle.current?.focus();
  }, []);
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
    if (isFocused.current && mayTakeKeyboard(ready.element)) ready.focus();
  };
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
        attachedBefore.current = true;
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

  if (error !== null) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (restarting) {
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        The program in this terminal is restarting…
      </p>
    );
  }
  if (ended) {
    return (
      <Ended closeLabel={closeLabel} className={className} onClose={() => onEndNow.current?.(address, "finished")} />
    );
  }
  if (unopened !== null) {
    // Try again mounts a new terminal: until it attaches it is starting, so in a pane that is not focused its start-time
    // focus goes back where it was, as on the first start (#163).
    const retry = (): void => {
      setWt(null);
      setUnopened(null);
    };
    return <Unopened why={unopened} className={className} onRetry={retry} />;
  }
  if (core === null) return <div className={cn("min-h-0 flex-1 bg-term-bg", className)} aria-busy="true" />;
  return (
    // The scrollbar and the jump button overlay the terminal: neither takes room from the grid.
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" aria-busy={opening}>
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
          // The renderer no longer focuses itself as it starts (patches/@wterm%2Fdom@0.5.9.patch); the view decides.
          focusWhenFree(ready);
          attach(ready);
        }}
        onData={typedInto}
        onResize={(cols, rows) => stream.current?.resize(cols, rows)}
        onFocus={(event) => {
          // wterm focuses the terminal as it starts, and the patch drops that start call; a focus event can still
          // arrive for a pane the view did not choose. Only the focused pane's keeps it; any other hands it back to
          // where it was, so a pane another device adds never takes the keyboard.
          if (wt === null && !isFocused.current) return handBack(event);
          stream.current?.focus(true);
        }}
        onBlur={() => stream.current?.focus(false)}
      />
      {opening ? (
        <QuietBusy label="Opening terminal" text="Opening…" className="absolute inset-0 z-10 bg-term-bg" />
      ) : null}
      {wt === null ? null : (
        <>
          <TerminalScrollbar wt={wt} scroll={scroll} />
          <TerminalLinks wt={wt} />
          {finding === null ? null : (
            <TerminalFind
              wt={wt}
              address={address}
              scroll={scroll}
              written={written}
              opened={finding}
              onClose={() => {
                setFinding(null);
                wt.focus();
              }}
            />
          )}
          <JumpToBottom
            wt={wt}
            scroll={scroll}
            {...(jumpClearance === undefined ? {} : { clearance: jumpClearance })}
          />
        </>
      )}
      <PasteDialog
        paste={paste}
        onCancel={() => setPaste(null)}
        onPaste={(text) => {
          typed(text);
          setPaste(null);
          // The confirmed paste is the line now being typed: the terminal takes the keyboard back, as a tap in it does.
          handle.current?.focus();
        }}
      />
      <PointMenu at={selectAt} onClose={closeSelectionMenu} label="Selected text">
        <MenuItem
          icon={<Copy aria-hidden />}
          onClick={() => {
            copySelection();
            closeSelectionMenu();
          }}
        >
          Copy
        </MenuItem>
        <MenuItem
          icon={<ClipboardPaste aria-hidden />}
          onClick={() => {
            pasteClipboard();
            closeSelectionMenu();
          }}
        >
          Paste
        </MenuItem>
      </PointMenu>
    </div>
  );
}

import type { TerminalStream } from "@doriface/client";
import { cn } from "@doriface/ui";
import { Terminal, type TerminalHandle, type WTerm } from "@wterm/react";
import { type FocusEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useScreenAwake } from "../device/keep-awake.ts";
import { useTerminalConfig } from "../ghostty/config-store.ts";
import { rendererOptions } from "../ghostty/render-options.ts";
import { isBrowsing, useBrowseMode } from "./browse-mode.ts";
import { readDisplay } from "./display.ts";
import { PasteDialog } from "./paste-dialog.tsx";
import { type Point } from "./long-press.ts";
import { KittyPngTranscoder } from "./kitty-png.ts";
import { OutputPacer } from "./output-pacer.ts";
import { readThemeColors } from "./theme-colors.ts";
import { useDarkScheme } from "./use-dark-scheme.ts";
import { useBehaviors, type PendingPaste } from "./use-behaviors.ts";
import { useFocusAfterSelect } from "./use-focus-after-select.ts";
import { useLongPressSelect } from "./use-long-press-select.ts";
import { useTouchWheel } from "./touch-wheel.ts";
import { useSelectionCells } from "./use-selection-cells.ts";
import { useShiftDragSelect } from "./use-shift-drag-select.ts";
import {
  askingForKeyboard,
  isRegainingReport,
  quietKeyboard,
  regainingFocus,
  useTerminalPort,
} from "./terminal-port.ts";
import type { TerminalViewProps } from "./terminal-view-props.ts";
import { RecoveryFrame } from "./recovery-frame.tsx";
import { JumpToBottom, TerminalScrollbar, useTerminalScroll } from "./terminal-scroll.tsx";
import { TerminalFind } from "./terminal-find.tsx";
import { TerminalLinks } from "./terminal-links.tsx";
import { useTerminalActions } from "./use-terminal-actions.ts";
import { useTerminalFont } from "./use-terminal-font.ts";
import { usePreedit } from "./use-preedit.ts";
import { usePredictionOverlay } from "./use-prediction-overlay.ts";
import { predictionSeam } from "./prediction-seam.ts";
import { usePredictionMode } from "./prediction-mode.ts";
import { PredictorView } from "./prediction-view.ts";
import type { TerminalInput } from "./terminal-view-props.ts";
import { wideGlyphScaler } from "./face-scales.ts";
import { GlyphWarmup } from "./glyph-warmup.ts";
import { SelectionMenu } from "./selection-menu.tsx";
import { useTerminalCore } from "./use-terminal-core.ts";
import { useTerminalInput } from "./use-terminal-input.ts";
import { usePaneVisibility } from "./use-pane-visibility.ts";
import { type PaintHold, useTerminalAttach } from "./use-terminal-attach.ts";
import { useMachineLine } from "./use-machine-line.ts";
import { useKeyboardClaim } from "./use-keyboard-claim.ts";

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
  const {
    closeLabel = "Close tab",
    onEnded,
    jumpClearance,
    claimed = true,
    softKeyboard = false,
    typesComposition = false,
  } = props;
  const { browsing = false } = props;
  const config = useTerminalConfig();
  const options = useMemo(() => rendererOptions(config), [config]);
  const dark = useDarkScheme();
  useScreenAwake();
  const [wt, setWt] = useState<WTerm | null>(null);
  const recover = useRef<() => void>(() => undefined);
  const [paste, setPaste] = useState<PendingPaste | null>(null);
  /** Where a held touch lifted, while its menu of Copy and Paste is open. */
  const [selectAt, setSelectAt] = useState<Point | null>(null);
  /** The find bar's open count while it is open (each ask selects its query again), null while closed. */
  const [finding, setFinding] = useState<number | null>(null);
  const openFind = useCallback(() => setFinding((count) => (count ?? 0) + 1), []);
  const handle = useRef<TerminalHandle | null>(null);
  /**
   * Counts the changes to the core's cells: each write that reaches it (output held behind a Kitty PNG decode counts when
   * it is written, not when it arrived) and each resize, which reflows the scrollback. A find reads the cells again only
   * when it moves (#1207).
   */
  const written = useRef(0);
  const stream = useRef<TerminalStream | null>(null);
  // The program's output reaches the core through this: Kitty images sent as PNG are decoded to RGBA on the way.
  const output = useMemo(
    () =>
      new KittyPngTranscoder((bytes) => {
        handle.current?.write(bytes);
        written.current += 1;
        // Output held behind a decode is written after its frame: the overlays read the grid again for it.
        outputShown.current();
      }),
    [],
  );
  // Output is written once a frame and credited only then, so a flood cannot starve clicks and keys (#560).
  const pacer = useMemo(
    () =>
      new OutputPacer((bytes) => {
        output.push(bytes);
        warmup.current?.note(bytes);
      }),
    [output],
  );
  useEffect(() => () => pacer.drop(), [pacer]);
  const { core, error } = useTerminalCore();

  const { isFocused, focusWhenFree } = useKeyboardClaim(handle, focused, claimed, softKeyboard);

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
  const predict = useRef<((data: TerminalInput) => void) | null>(null);
  // Each stream, first or after a reconnect, starts the predictor over: what it predicted for the last one says nothing
  // about this one (Predictor.reset).
  const streamStarted = useRef<(() => void) | null>(null);
  const input = useTerminalInput({
    wt,
    handle,
    stream,
    connection,
    address,
    transformInput,
    typesComposition,
    predict,
    onInteract: () => recover.current(),
  });
  const { pending, typedInto, typed, pasteFiles, linkReady } = input;
  const scroll = useTerminalScroll(wt);
  const outputShown = useRef(scroll.changed);
  outputShown.current = scroll.changed;
  useTerminalPort(handle, typed, onPort, pasteFiles, softKeyboard);
  // A touch surface's field asks for no soft keyboard on its own: a press in the terminal leaves it down, and only the
  // keys that ask for one raise it (#1375).
  useEffect(() => {
    if (wt !== null && softKeyboard) quietKeyboard(wt.element);
  }, [wt, softKeyboard]);
  useBehaviors(wt, stream, options, onUnsafePaste, pasteFiles);
  useTerminalFont(wt, config);
  // The real predictor reads every input and write of this view (#1595); a spec's stand-in replaces it when installed.
  const seam = useMemo(() => predictionSeam(wt), [wt]);
  // One rule on every path: in adaptive the predictor's display gate reads its measured echo round trip (#2003).
  const predictMode = usePredictionMode();
  const predictModeNow = useRef(predictMode);
  predictModeNow.current = predictMode;
  const [predictor, setPredictor] = useState<PredictorView | null>(null);
  useEffect(() => {
    if (wt === null || seam !== null) return undefined;
    const made = new PredictorView(wt, { linkReady, mode: () => predictModeNow.current });
    predict.current = (data) => made.typed(data);
    streamStarted.current = () => made.reset();
    setPredictor(made);
    return () => {
      predict.current = null;
      streamStarted.current = null;
      made.dispose();
      setPredictor(null);
    };
  }, [wt, seam, linkReady]);
  useEffect(() => predictor?.refresh(), [predictor, predictMode]);
  // A reattach replay holds the paint until it has settled (D5), and a synchronized update until it has come in (#2040);
  // the paint is held while either holds it, and the prop carries that through the view's renders.
  const [paintHeld, setPaintHeld] = useState(false);
  const paintHolds = useRef<Record<PaintHold, boolean>>({ replay: false, update: false });
  const holdPaint = useCallback((hold: PaintHold, held: boolean): boolean => {
    paintHolds.current = { ...paintHolds.current, [hold]: held };
    const paused = paintHolds.current.replay || paintHolds.current.update;
    setPaintHeld(paused);
    return paused;
  }, []);
  const paintHeldNow = useCallback((): boolean => paintHolds.current.replay || paintHolds.current.update, []);
  const predictedCursor = usePredictionOverlay(wt, seam ?? predictor, paintHeldNow);
  usePreedit(wt, predictedCursor);
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
  const shown = usePaneVisibility(wt, pacer);
  useTerminalActions(wt, input, focused, shown, openFind);
  const away = useMachineLine(connection, address, shown);
  useFocusAfterSelect(wt, options.trimCopy);
  useLongPressSelect(wt, setSelectAt);
  useTouchWheel(wt);
  useShiftDragSelect(wt);
  useSelectionCells(wt);
  useBrowseMode(wt, browsing);
  const closeSelectionMenu = useCallback((): void => {
    setSelectAt(null);
    if (!browsing) handle.current?.focus();
  }, [browsing]);
  const attachment = useTerminalAttach({
    connection,
    address,
    pid,
    live,
    shown,
    wt,
    setWt,
    stream,
    pending,
    pacer,
    output,
    isFocused,
    focusWhenFree,
    onEnd,
    onEnded,
    onStream: streamStarted,
    holdPaint,
  });
  recover.current = attachment.interact;

  if (core === null && error === null)
    return <div className={cn("min-h-0 flex-1 bg-term-bg", className)} aria-busy="true" />;
  return (
    // The scrollbar and the jump button overlay the terminal: neither takes room from the grid.
    <RecoveryFrame
      attachment={attachment}
      error={error}
      closeLabel={closeLabel}
      className={className}
      onClose={() => attachment.onEndNow.current?.(address, "finished")}
    >
      {core === null ? null : (
        <Terminal
          ref={handle}
          core={core}
          autoResize
          renderingPaused={paintHeld}
          {...(options.cursorBlink === undefined ? {} : { cursorBlink: options.cursorBlink })}
          aria-label={label}
          data-slot="terminal-viewport"
          data-terminal={address}
          data-ready={wt !== null}
          className={cn("min-h-0 flex-1 bg-term-bg", options.hollowCursor && "cursor-hollow", className)}
          onReady={(ready) => {
            // The renderer no longer focuses itself as it starts (patches/@wterm%2Fdom@0.5.9.patch); the view decides.
            focusWhenFree(ready);
            // It attaches once it is shown (useTerminalAttach): a pane that mounts out of view opens no stream yet.
            setWt(ready);
          }}
          onData={(data) => {
            if (!isRegainingReport(handle, data)) typedInto(data);
          }}
          onResize={(cols, rows) => {
            // The core reflows its rows to the new width, with no output: the cells a find read have moved.
            written.current += 1;
            stream.current?.resize(cols, rows);
          }}
          onFocus={(event) => {
            // The field taken again for the soft keyboard never left the terminal, as far as the program knows (#1519).
            if (regainingFocus(event.target)) return;
            // wterm focuses the terminal as it starts, and the patch drops that start call; a focus event can still
            // arrive for a pane the view did not choose. Only the focused pane's keeps it; any other hands it back to
            // where it was, so a pane another device adds never takes the keyboard.
            if (wt === null && !isFocused.current) return handBack(event);
            stream.current?.focus(true);
          }}
          onBlur={(event) => {
            if (!regainingFocus(event.target)) stream.current?.focus(false);
          }}
        />
      )}
      {away === null ? null : (
        // Keys typed now wait for the machine (HeldInput, #1489); the line overlays the top row and takes no room.
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-muted/95 px-3 py-1 text-center text-prose text-muted-foreground"
        >
          Reconnecting to {away}. Your typing will be sent.
        </p>
      )}
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
                if (isBrowsing(wt.element)) return;
                askingForKeyboard(handle, softKeyboard);
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
          // The confirmed paste is the line now being typed: the terminal takes the keyboard back, as its keys do.
          askingForKeyboard(handle, softKeyboard);
          handle.current?.focus();
        }}
      />
      <SelectionMenu
        at={selectAt}
        handle={handle}
        trimCopy={options.trimCopy}
        pasteFiles={pasteFiles}
        onClose={closeSelectionMenu}
        readOnly={browsing}
      />
    </RecoveryFrame>
  );
}

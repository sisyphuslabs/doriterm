import type { HcConnection, TerminalStream } from "@doriface/client";
import { useToastManager } from "@doriface/ui";
import type { TerminalHandle, WTerm } from "@wterm/react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { unprovenLinks } from "../connection/wake.ts";
import { machineOf } from "../workspace/model.ts";
import { type Dropped, HeldInput, HOLD_MS } from "./held-input.ts";
import { inputOrder } from "./input-order.ts";
import { machineLines } from "./machine-lines.ts";
import { pasteInto } from "./terminal-port.ts";
import { putFiles, quotePaths } from "./paste-files.ts";
import { scrollTerminal } from "./terminal-scroll.tsx";
import type { TerminalInput } from "./terminal-view-props.ts";

export interface TerminalInputPath {
  /**
   * Input not written yet: typed while no stream was open (attaching, or the connection dropped), sent to the next stream
   * in order, or while a wake proved the link, sent to the same stream once it answers (#1370).
   */
  readonly pending: RefObject<TerminalInput[]>;
  /** Input typed into the renderer, rewritten as the host asks (latched phone modifiers). */
  readonly typedInto: (data: string) => void;
  /** Input from outside the renderer (the phone's keys, a bound key, a confirmed paste). */
  readonly typed: (data: TerminalInput) => void;
  /** Input from a bound key known only once `data` settles; what is typed meanwhile reaches the program after it. */
  readonly typedLater: (data: Promise<TerminalInput | null>) => void;
  /**
   * Input answering a bound key some time after it, as the person goes on typing (Paste image's late ^V): written in
   * order, and a syllable still composing in the field is left alone, unlike `typed`, which would end it (#1938).
   */
  readonly typedLate: (data: TerminalInput) => void;
  /** Files sent to the terminal's machine, their paths pasted there. */
  readonly pasteFiles: (files: readonly File[]) => void;
  /** Input sent now would be written at once (the predictor's P6). */
  readonly linkReady: () => boolean;
}

interface InputSources {
  readonly wt: WTerm | null;
  readonly handle: RefObject<TerminalHandle | null>;
  readonly stream: RefObject<TerminalStream | null>;
  readonly connection: HcConnection;
  readonly address: string;
  readonly transformInput: ((data: string) => string) | undefined;
  readonly typesComposition: boolean;
  readonly onInteract: () => void;
  /** Told of every input before it is sent or queued, in the order it reaches the program: the predictor (#1595). */
  readonly predict?: RefObject<((data: TerminalInput) => void) | null>;
}

/**
 * Why input that waited was not sent, as the person is told: for an added machine's line, or for this terminal's own
 * link, which may be one that has not opened yet (input typed while the terminal opens waits the same way).
 */
export function notSent(why: Dropped, machine: string | undefined): string {
  if (machine === undefined)
    return why === "expired"
      ? `Typed input was not sent because this terminal could not be reached for ${HOLD_MS / 1000} s`
      : "Typed input was not sent because too much was typed while this terminal could not be reached";
  return why === "expired"
    ? `Typed input was not sent because ${machine} did not reconnect within ${HOLD_MS / 1000} s`
    : `Typed input was not sent because too much was typed while ${machine} was reconnecting`;
}

/** What a pane does with what the person types: one ordered path to the program, queued while no stream is open. */
export function useTerminalInput(sources: InputSources): TerminalInputPath {
  const { wt, handle, stream, connection, address, transformInput, typesComposition, predict } = sources;
  const toasts = useToastManager();
  const latestConnection = useRef(connection);
  latestConnection.current = connection;
  const latestAddress = useRef(address);
  latestAddress.current = address;
  const latestToasts = useRef(toasts);
  latestToasts.current = toasts;
  const interact = useRef(sources.onInteract);
  interact.current = sources.onInteract;
  // Every human-input write goes through send, so keys pressed during a reconnect or a wake replay in the order pressed.
  const [held] = useState(
    () =>
      new HeldInput(
        unprovenLinks,
        () => latestConnection.current,
        () => stream.current,
        {
          lines: machineLines,
          machine: () => machineOf(latestAddress.current),
          dropped: (why, machine) => latestToasts.current.add({ type: "warning", title: notSent(why, machine) }),
        },
      ),
  );
  useEffect(() => held.watch(), [held]);
  const pending = useRef(held.pending);
  const latestPredict = useRef(predict);
  latestPredict.current = predict;
  const [order] = useState(() =>
    inputOrder((data) => {
      interact.current();
      latestPredict.current?.current?.(data);
      held.send(data);
    }),
  );
  const send = order.send;
  const linkReady = useCallback((): boolean => held.ready(), [held]);
  const typedInto = (data: string): void => {
    const input = transformInput?.(data) ?? data;
    if (input !== "") send(input);
  };
  // Typed input from outside the renderer scrolls to the bottom, as wterm already does for keys typed into it. A
  // syllable still composing in the renderer's field goes first, as typed: the key must not overtake it (#652).
  const typedFirst = useCallback((): void => {
    const instance = handle.current?.instance;
    if (instance === null || instance === undefined) return;
    const preedit = instance.takeComposition();
    if (preedit !== "") send(preedit);
    scrollTerminal(instance, { to: "bottom" });
  }, [handle, send]);
  const typed = useCallback(
    (data: TerminalInput): void => {
      typedFirst();
      send(data);
    },
    [typedFirst, send],
  );
  const typedLate = useCallback(
    (data: TerminalInput): void => {
      const instance = handle.current?.instance;
      if (instance !== null && instance !== undefined) scrollTerminal(instance, { to: "bottom" });
      send(data);
    },
    [handle, send],
  );
  const typedLater = useCallback(
    (data: Promise<TerminalInput | null>): void => {
      typedFirst();
      order.later(data);
    },
    [typedFirst, order],
  );
  // herdr-app's send_image: files go to the terminal's machine (`terminal.put`), and where they landed is pasted there,
  // bracketed when the program asked, so an agent on any machine reads the image by its path (#701).
  const pasteFiles = useCallback(
    (files: readonly File[]): void => {
      void putFiles(latestConnection.current, address, files).then(({ paths, refused }) => {
        for (const why of refused) toasts.add({ type: "warning", title: why });
        const element = handle.current?.instance?.element;
        if (paths.length > 0 && element !== undefined) pasteInto(element, quotePaths(paths));
        return paths;
      });
    },
    [address, toasts, handle],
  );
  // A composition is typed as it starts (see TerminalViewProps.typesComposition).
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
  return { pending, typedInto, typed, typedLater, typedLate, pasteFiles, linkReady };
}

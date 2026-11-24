import type { TerminalStream } from "@doriface/client";
import type { WTerm } from "@wterm/react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { single, type TerminalConfig } from "../ghostty/config.ts";
import { useTerminalConfig } from "../ghostty/config-store.ts";
import { HostSize } from "./host-size.ts";
import { pinchedConfig, usePinchFontSize } from "./pinch-font-store.ts";
import { useTerminalPinch } from "./use-terminal-pinch.ts";

const touchScreen = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export interface TerminalSizing {
  /** The config this view draws with: the device's, with the pinched size in place of font-size. */
  readonly config: TerminalConfig;
  /** When this view's grid may size the host (D1). */
  readonly hostSize: HostSize;
  /** The person is about to type here: this view's grid sizes the host from now on. */
  readonly inputStarts: () => void;
}

/**
 * Asking for the soft keyboard is starting to type (the keys bar's keyboard button, a key that raises it): every such
 * ask sets the field's `inputmode` to `text` (terminal-port.ts askingForKeyboard), so that change is watched here.
 */
function useKeyboardAsk(wt: WTerm | null, asked: RefObject<() => void>): void {
  useEffect(() => {
    const field = wt?.element.querySelector("textarea");
    if (!(field instanceof HTMLTextAreaElement)) return undefined;
    const watch = new MutationObserver(() => {
      if (field.inputMode === "text") asked.current();
    });
    watch.observe(field, { attributes: true, attributeFilter: ["inputmode"] });
    return () => watch.disconnect();
  }, [wt, asked]);
}

/** A view's size: the pinch on its terminal, the device's pinched size, and when its grid reaches the host. */
export function useTerminalSizing(
  wt: WTerm | null,
  address: string,
  stream: RefObject<TerminalStream | null>,
): TerminalSizing {
  const device = useTerminalConfig();
  const pinched = usePinchFontSize();
  const config = useMemo(() => pinchedConfig(device, pinched), [device, pinched]);
  const [hostSize] = useState(() => new HostSize(touchScreen()));
  const [host] = useState(() => ({ size: hostSize, stream }));
  useTerminalPinch(wt, address, Number(single(config, "font-size")), host);
  const inputStarts = useRef(() => {});
  inputStarts.current = () => {
    if (wt !== null) hostSize.inputStarts(stream.current, { cols: wt.cols, rows: wt.rows });
  };
  useKeyboardAsk(wt, inputStarts);
  const [starts] = useState(() => () => inputStarts.current());
  return { config, hostSize, inputStarts: starts };
}

import { afterEach, describe, expect, jest, test } from "bun:test";
import type { WTerm } from "@wterm/react";
import * as React from "react";
import { LONG_PRESS_MS } from "./long-press.ts";
import { type LongPressTerminal, longPressTerminal } from "./long-press-harness.test-support.ts";
import { useLongPressSelect } from "./use-long-press-select.ts";

const mounted: LongPressTerminal[] = [];
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  for (const terminal of mounted.splice(0)) terminal.restore();
  jest.useRealTimers();
});

/**
 * React's client internals object, which holds the dispatcher a hook finds its component in; its development name is the
 * long one.
 */
const exposed = (React as unknown as Record<string, { H: unknown } | undefined>)[
  "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE"
];
if (exposed === undefined) throw new Error("React exposes no client internals");
const clientInternals: { H: unknown } = exposed;

/**
 * Renders a terminal with the hook, the way the terminal view does. Bun has no renderer and no DOM, so this is React's
 * commit without the render: the hook is called once with React's dispatcher on its fiber, which records the effect, and
 * the effect then runs as the commit would run it, with what it returns kept for the unmount. React, the hook and the
 * DOM are the real ones; only the commit's call into them is made here.
 */
function terminalRenderingHook(): LongPressTerminal {
  jest.useFakeTimers();
  const terminal = longPressTerminal();
  mounted.push(terminal);
  const effects: { readonly create: () => (() => void) | undefined }[] = [];
  const saved = clientInternals.H;
  clientInternals.H = {
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: (create: () => (() => void) | undefined) => {
      effects.push({ create });
    },
  };
  try {
    function TerminalView(): void {
      useLongPressSelect(terminal.wt as unknown as WTerm, () => undefined);
    }
    TerminalView();
  } finally {
    clientInternals.H = saved;
  }
  for (const effect of effects) {
    const cleanup = effect.create();
    if (typeof cleanup === "function") unmounts.push(cleanup);
  }
  // The effect is what wires the terminal: a press now reaches its pointerdown listener, which nothing else adds.
  terminal.down();
  if (!terminal.handled("pointerdown")) throw new Error("the hook's effect did not mount");
  return terminal;
}

describe("the held-press mark lives for one touch (#854)", () => {
  test("a picked press cancels its own lift's tap", () => {
    const terminal = terminalRenderingHook();
    terminal.down();
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.up();
    expect(terminal.tapCancelled).toBe(true);
  });

  test("a press after that gesture makes the next touch a tap again", () => {
    const terminal = terminalRenderingHook();
    terminal.down();
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.up();
    expect(terminal.tapCancelled).toBe(true);

    terminal.down(2);
    terminal.up(2);
    expect(terminal.tapCancelled).toBe(false);
  });

  test("a second finger beside the first leaves that first lift cancelled", () => {
    const terminal = terminalRenderingHook();
    terminal.down(1);
    jest.advanceTimersByTime(LONG_PRESS_MS);
    terminal.down(2, false);
    terminal.up(1);
    expect(terminal.tapCancelled).toBe(true);
  });
});

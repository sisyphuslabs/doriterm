import { expect, spyOn, test } from "bun:test";
import { WTerm } from "@wterm/dom";
import * as React from "react";
import { ActionsPaused, runAction } from "../keys/dispatcher.ts";
import { useTerminalActions } from "../terminal/use-terminal-actions.ts";
import { availableActions } from "./shell-actions.ts";
import { noop } from "./shell-actions.fixture.ts";

const toastStore = {
  useState: () => [],
  addToast: () => "",
  closeToast: noop,
  updateToast: noop,
  promiseToast: noop,
};

test.each(["desktop", "phone"] as const)(
  "%s: the palette's terminal.search reaches only the focused terminal's handler through runAction",
  (shell) => {
    const cleanups: (() => void)[] = [];
    // Run the registration effects without a DOM; the dispatcher and terminal handler stay real.
    const effect = spyOn(React, "useEffect").mockImplementation((setup) => {
      const cleanup = setup();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    });
    const ref = spyOn(React, "useRef").mockImplementation((current) => ({ current }));
    const state = spyOn(React, "useState").mockImplementation(((initial?: unknown) => [
      typeof initial === "function" ? initial() : initial,
      noop,
    ]) as typeof React.useState);
    const memo = spyOn(React, "useMemo").mockImplementation((make) => make());
    // Actions are not paused; every other context (the toast provider's) gets a store search never calls.
    const context = spyOn(React, "useContext").mockImplementation(((of: unknown) =>
      of === ActionsPaused ? false : toastStore) as typeof React.useContext);
    const opened: string[] = [];
    const sent: unknown[] = [];
    const input = (from: string) => ({
      typed: (data: unknown) => void sent.push([from, data]),
      typedLater: noop,
      typedLate: noop,
      pasteFiles: noop,
    });
    try {
      // Search uses no terminal methods, so it needs no rendered instance.
      useTerminalActions(WTerm.prototype, input("background"), false, true, () => opened.push("background"));
      useTerminalActions(null, input("detached"), true, true, () => opened.push("detached"));
      useTerminalActions(WTerm.prototype, input("focused"), true, true, () => opened.push("focused"));

      const search = availableActions(shell, true).find(({ id }) => id === "terminal.search");
      expect(runAction(search?.id ?? "")).toBe(true);
      expect(opened).toEqual(["focused"]);
      expect(sent).toEqual([]);
    } finally {
      for (const cleanup of cleanups) cleanup();
      context.mockRestore();
      memo.mockRestore();
      state.mockRestore();
      ref.mockRestore();
      effect.mockRestore();
    }
  },
);

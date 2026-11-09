import { expect, spyOn, test } from "bun:test";
import { WTerm } from "@wterm/dom";
import * as React from "react";
import { runAction } from "../keys/dispatcher.ts";
import { useTerminalActions } from "../terminal/use-terminal-actions.ts";
import { availableActions } from "./shell-actions.ts";
import { noop } from "./shell-actions.fixture.ts";

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
    const context = spyOn(React, "useContext").mockReturnValue(false);
    const opened: string[] = [];
    const sent: unknown[] = [];
    try {
      // Search uses no terminal methods, so it needs no rendered instance.
      useTerminalActions(
        WTerm.prototype,
        (data) => sent.push(data),
        false,
        noop,
        () => opened.push("background"),
      );
      useTerminalActions(
        null,
        (data) => sent.push(data),
        true,
        noop,
        () => opened.push("detached"),
      );
      useTerminalActions(
        WTerm.prototype,
        (data) => sent.push(data),
        true,
        noop,
        () => opened.push("focused"),
      );

      const search = availableActions(shell, true).find(({ id }) => id === "terminal.search");
      expect(runAction(search?.id ?? "")).toBe(true);
      expect(opened).toEqual(["focused"]);
      expect(sent).toEqual([]);
    } finally {
      for (const cleanup of cleanups) cleanup();
      context.mockRestore();
      ref.mockRestore();
      effect.mockRestore();
    }
  },
);

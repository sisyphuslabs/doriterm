import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { type HcSocket, routeHcSocket } from "./hc-socket.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

endOwnTerminals();
test.use({ serviceWorkers: "block" });

/** An SGR mouse report, the form a program that asked for `?1006h` is sent a press, a motion or a release in. */
const MOUSE_REPORT = "\x1b[<";
/** The focus-in report a program that asked for `?1004h` is sent when the terminal's input takes focus. */
const FOCUS_IN = "\x1b[I";

/**
 * A terminal scrolled 50 rows back into its history, running a silent program that asked for every mouse movement
 * (`?1003h`, SGR encoded) and for focus reports (`?1004h`), as a TUI does: #1965's screen. The program prints five more
 * lines each time it is sent `request-output`.
 */
async function trackedHistory(page: Page): Promise<{ terminal: Locator; address: string }> {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("terminal has no address");
  hcOn("host", [
    "send",
    address,
    "stty -echo; for i in $(seq 1 300); do printf 'history-%03d-copy\\n' $i; done; " +
      "printf '\\033[?1004h\\033[?1003h\\033[?1006h'; while IFS= read -r line; do case \"$line\" in " +
      "*request-output*) for j in 1 2 3 4 5; do printf 'new-output-%s\\n' $j; done;; esac; done",
  ]);
  await expect(terminal).toContainText("history-300-copy", { timeout: 15_000 });
  await terminal.evaluate((element) => {
    const row = element.querySelector(".term-row");
    if (row === null) throw new Error("terminal has no row");
    element.scrollTop -= row.getBoundingClientRect().height * 50;
  });
  await expect(page.getByRole("button", { name: "Jump to bottom" })).toBeVisible();
  return { terminal, address };
}

const position = (terminal: Locator) => terminal.evaluate((element) => element.scrollTop);

/** A history row in the middle of the view: its text and the span of its glyphs. */
async function historyRow(terminal: Locator): Promise<{ text: string; left: number; right: number; y: number }> {
  return terminal.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const row = [...element.querySelectorAll(".term-row")].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top > bounds.top + 40 && rect.bottom < bounds.bottom - 40;
    });
    if (row === undefined) throw new Error("no history row in view");
    const range = document.createRange();
    range.selectNodeContents(row);
    const rect = range.getBoundingClientRect();
    return { text: row.textContent?.trim() ?? "", left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
}

const framesSent = (socket: HcSocket, from: number, needle: string) =>
  socket
    .sent()
    .slice(from)
    .filter((frame) => frame.includes(needle)).length;

/** Every frame's scroll position until `stop` resolves, and two frames after, so a move booked by the last event shows. */
function sampleFrames(terminal: Locator): { stop: () => Promise<number[]> } {
  const sampling = terminal.evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const positions: number[] = [];
        let after = -1;
        const sample = (): void => {
          positions.push(element.scrollTop);
          if (after < 0 && element.hasAttribute("data-stop-scroll-sample")) after = 2;
          if (after === 0) {
            element.removeAttribute("data-stop-scroll-sample");
            resolve(positions);
          } else {
            if (after > 0) after -= 1;
            requestAnimationFrame(sample);
          }
        };
        sample();
      }),
  );
  return {
    stop: async () => {
      await terminal.evaluate((element) => element.setAttribute("data-stop-scroll-sample", ""));
      return sampling;
    },
  };
}

for (const focus of ["in the terminal", "outside the terminal"] as const) {
  test(`with focus ${focus}, Shift and a drag select history under a program that tracks the mouse and focus, and the view stays (#1965)`, async ({
    page,
  }) => {
    const socket = await routeHcSocket(page);
    const { terminal, address } = await trackedHistory(page);
    const input = terminal.getByRole("textbox");
    const row = await historyRow(terminal);
    expect(row.text).toMatch(/^history-\d{3}-copy$/);
    const before = await position(terminal);
    const sent = socket.sent().length;
    // Moving focus out sends the program its focus-out report, and the release's click its focus-in: on v0.1.16 each
    // report pulled the reader to the live end, so the view then followed output and the drag selected a row below the
    // one the reader had been looking at.
    if (focus === "outside the terminal") {
      await input.evaluate((element) => {
        if (element instanceof HTMLElement) element.blur();
      });
      await expect(input).not.toBeFocused();
      expect.soft(await position(terminal), "focus leaving the terminal keeps the history position").toBe(before);
    }

    const frames = sampleFrames(terminal);
    let positions: number[] = [];
    try {
      await page.keyboard.down("Shift");
      try {
        await page.mouse.move(row.left + 1, row.y);
        await page.mouse.down();
        expect.soft(await position(terminal), "the Shift press keeps the history position").toBe(before);
        await page.mouse.move((row.left + row.right) / 2, row.y, { steps: 4 });
        // Output arriving mid-drag, as from an agent that keeps drawing, must not move the reader either.
        hcOn("host", ["send", address, "request-output"]);
        await expect(terminal).toContainText("new-output-5");
        await page.mouse.move(row.right - 1, row.y, { steps: 4 });
        expect.soft(await position(terminal), "the Shift drag keeps the history position").toBe(before);
        await page.mouse.up();
      } finally {
        await page.keyboard.up("Shift");
      }
      await expect(input).toBeFocused();
      if (focus === "outside the terminal")
        await expect.poll(() => framesSent(socket, sent, FOCUS_IN)).toBeGreaterThan(0);
    } finally {
      // Stopped and awaited on every exit, so a failed check above is the only error the run reports (#2118).
      positions = await frames.stop();
    }
    expect
      .soft(
        positions.filter((top) => top !== before),
        "no frame moves the view",
      )
      .toEqual([]);

    await expect(terminal.locator(".term-selection-cells > div").first()).toBeVisible();
    const copied = await terminal.evaluate((element) => {
      const clipboardData = new DataTransfer();
      element.dispatchEvent(new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }));
      return clipboardData.getData("text/plain");
    });
    expect(copied.trim()).toBe(row.text);
    expect(await position(terminal)).toBe(before);
    expect(framesSent(socket, sent, MOUSE_REPORT), "the program hears nothing of the Shift drag").toBe(0);

    // The program does track the mouse: back at the live screen (history is never reported), a plain press reaches it.
    await page.getByRole("button", { name: "Jump to bottom" }).click();
    const live = await terminal.evaluate((element) => {
      const rect = element.querySelector(".term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
      if (rect === undefined) throw new Error("terminal has no screen row");
      return { x: rect.left + 40, y: rect.top + rect.height / 2 };
    });
    const plain = socket.sent().length;
    await page.mouse.click(live.x, live.y);
    await expect.poll(() => framesSent(socket, plain, MOUSE_REPORT)).toBeGreaterThan(0);
  });
}

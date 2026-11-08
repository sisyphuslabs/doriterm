import type { CDPSession, Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { routeHcSocket } from "./hc-socket.ts";
import { PHONE, openPhoneTerminal } from "./phone-key-bar.ts";
import { painted, predictTyping, realCell } from "./prediction-probe.ts";
import { installPredictor } from "./prediction-stand-in.ts";

// Design review HIGH 3(b) (#1439): while predictions are drawn the real cursor lags the predicted one by every
// unconfirmed cell, so a composition anchored to the real cursor is drawn over the last prediction and jumps right a
// round trip later. It sits at the predicted cursor, and the committed syllable reaches the screen there.

const GA = "\u{AC00}";

/** Where the preedit and the predicted cells sit, in cells from the grid's first active cell. */
const layout = (element: HTMLElement) => {
  const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
  const first = element.querySelector(".term-grid .term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
  const at = (node: Element) => {
    const box = node.getBoundingClientRect();
    return {
      text: node.textContent ?? "",
      row: Math.round((box.top - (first?.top ?? 0)) / (first?.height ?? 1)),
      col: Math.round((box.left - (first?.left ?? 0)) / cell),
      cells: Math.round(box.width / cell),
    };
  };
  const preedit = element.querySelector(".term-preedit");
  return {
    preedit: preedit === null ? null : at(preedit),
    predicted: [...element.querySelectorAll(".term-prediction-cell")].map(at),
  };
};

for (const device of ["desktop", "phone"] as const) {
  test.describe(device, () => {
    test.use(device === "phone" ? { ...PHONE, serviceWorkers: "block" } : {});

    async function open(page: Page): Promise<Locator> {
      if (device === "phone") return openPhoneTerminal(page);
      await page.goto("/");
      return openNewTerminal(page);
    }

    test("a syllable composed while predictions are drawn sits at the predicted cursor and reaches the screen there", async ({
      page,
    }) => {
      const link = await routeHcSocket(page);
      await installPredictor(page);
      const terminal = await open(page);
      link.delay(300);
      await terminal.getByRole("textbox").focus();
      await predictTyping(page);
      const release = link.holdFromHost("");
      await page.keyboard.type("ab");
      await expect(terminal.locator(".term-prediction-cell")).toHaveText(["a", "b"]);
      const typed = await terminal.evaluate(layout);
      const [a, b] = typed.predicted;
      expect(b?.col).toBe((a?.col ?? 0) + 1);

      const cdp: CDPSession = await page.context().newCDPSession(page);
      await cdp.send("Input.imeSetComposition", { text: GA, selectionStart: 1, selectionEnd: 1 });
      await expect(terminal.locator(".term-preedit")).toHaveText(GA);
      const composing = await terminal.evaluate(layout);
      console.log(`preedit ${device}: ${JSON.stringify(composing)}`);
      // At the predicted cursor, after "ab", on their row: not over "ab", from where the real cursor still is.
      expect(composing.preedit).toMatchObject({ row: a?.row, col: (a?.col ?? 0) + 2, cells: 2 });
      expect((await terminal.evaluate(painted)).predictedCursor).not.toBeNull();

      await cdp.send("Input.insertText", { text: GA });
      await expect(terminal.locator(".term-preedit")).toHaveCount(0);
      await expect(terminal.locator(".term-prediction-cell")).toHaveText(["a", "b", GA]);
      const committed = await terminal.evaluate(layout);
      expect(committed.predicted[2]).toMatchObject({ row: a?.row, col: (a?.col ?? 0) + 2, cells: 2 });

      release();
      await expect.poll(() => realCell(page, a?.row ?? 0, (a?.col ?? 0) + 2)).toBe(GA);
      expect(await realCell(page, a?.row ?? 0, a?.col ?? 0)).toBe("a");
      expect(await realCell(page, a?.row ?? 0, (a?.col ?? 0) + 1)).toBe("b");
      await expect(terminal.locator(".term-prediction-cell")).toHaveCount(0);
    });
  });
}

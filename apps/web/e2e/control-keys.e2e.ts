import type { Locator, Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { newOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

endOwnTerminals();
test.use({ serviceWorkers: "block" });

// Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+\ and Ctrl+L reach the program in a pane as they do in a plain terminal: as their control
// bytes, so the tty turns them into SIGINT, EOF, SIGTSTP and SIGQUIT, in a terminal on this machine and in one on the
// added machine, whose bytes cross hc's line to that machine's core. Every marker is computed by the program, so the
// echoed command line never matches it.

type Where = "local" | "remote";

async function terminalOn(page: Page, where: Where): Promise<Locator> {
  await page.goto("/");
  if (where === "local") {
    const terminal = await openNewTerminal(page);
    await terminal.getByRole("textbox").focus();
    return terminal;
  }
  await newOn(page).click();
  const focused = page.locator('[data-focused="true"] [data-terminal]');
  await expect(focused).toHaveAttribute("data-terminal", new RegExp(`^${MACHINE_NAME}/t[0-9a-z]+$`), {
    timeout: 15_000,
  });
  const terminal = page.locator(`[data-terminal="${await focused.getAttribute("data-terminal")}"]`);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  await terminal.getByRole("textbox").focus();
  return terminal;
}

/** Runs a program that says `READY-42` once it waits, and `GOT-<signal>-42` and ends when the signal reaches it. */
async function trapping(page: Page, terminal: Locator, signal: string): Promise<void> {
  await page.keyboard.type(
    `sh -c 'trap "echo GOT-${signal}-\\$((6*7)); exit 0" ${signal}; echo READY-$((6*7)); while :; do sleep 0.1; done'`,
  );
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("READY-42", { timeout: 15_000 });
}

/** Drags across `text` on the terminal's screen and lets go, leaving it selected as a person copying it does. */
async function select(page: Page, terminal: Locator, text: string): Promise<void> {
  const box = await terminal.evaluate((root, wanted) => {
    for (const row of root.querySelectorAll(".term-row")) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const rect = range.getBoundingClientRect();
        return { left: rect.left + 1, right: rect.right - 1, y: rect.top + rect.height / 2 };
      }
    }
    throw new Error(`${wanted} is not on the terminal's screen`);
  }, text);
  await page.mouse.move(box.left, box.y);
  await page.mouse.down();
  await page.mouse.move(box.right, box.y, { steps: 8 });
  await page.mouse.up();
  // The terminal holds the range and paints it on its own cell layer (held-selection.ts, use-selection-cells.ts).
  await expect(terminal.locator(".term-selection-cells > *").first()).toBeAttached({ timeout: 5_000 });
}

for (const where of ["local", "remote"] as const) {
  test.describe(`${where} terminal`, () => {
    test(`Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+\\ and Ctrl+L reach a raw-mode program as their control bytes (${where})`, async ({
      page,
    }) => {
      const terminal = await terminalOn(page, where);
      const out = test.info().outputPath(`control-bytes-${where}.bin`);
      writeFileSync(out, "");
      await page.keyboard.type(
        `stty raw -echo; echo RAW-$((6*7)); head -c 5 > '${out}'; stty sane; echo DONE-$((6*7))`,
      );
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("RAW-42", { timeout: 15_000 });
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Control+d");
      await page.keyboard.press("Control+z");
      await page.keyboard.press("Control+Backslash");
      await page.keyboard.press("Control+l");
      await expect(terminal).toContainText("DONE-42", { timeout: 15_000 });
      expect(readFileSync(out).toString("hex")).toBe("03041a1c0c");
    });

    test(`Ctrl+C interrupts a running program (${where})`, async ({ page }) => {
      const terminal = await terminalOn(page, where);
      await trapping(page, terminal, "INT");
      await page.keyboard.press("Control+c");
      await expect(terminal).toContainText("GOT-INT-42", { timeout: 15_000 });
    });

    test(`Ctrl+\\ quits and Ctrl+Z stops a running program (${where})`, async ({ page }) => {
      const terminal = await terminalOn(page, where);
      await trapping(page, terminal, "QUIT");
      await page.keyboard.press("Control+Backslash");
      await expect(terminal).toContainText("GOT-QUIT-42", { timeout: 15_000 });
      await page.keyboard.type("sleep 101; echo SLEPT-$((6*7))");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Control+z");
      await expect(terminal).toContainText(/Stopped/, { timeout: 15_000 });
      await page.keyboard.type("kill -9 %1");
      await page.keyboard.press("Enter");
    });

    test(`Ctrl+D ends cat's input and a shell (${where})`, async ({ page }) => {
      const terminal = await terminalOn(page, where);
      await page.keyboard.type("cat; echo CAT-EOF-$((6*7))");
      await page.keyboard.press("Enter");
      await page.keyboard.type("typed-line");
      await page.keyboard.press("Enter");
      await expect(terminal.locator(".term-row").filter({ hasText: /^typed-line\s*$/ })).toHaveCount(2, {
        timeout: 15_000,
      });
      await page.keyboard.press("Control+d");
      await expect(terminal).toContainText("CAT-EOF-42", { timeout: 15_000 });
      await page.keyboard.type(`sh -c 'echo SUB-$((6*7)); exec sh -i'; echo SH-EOF-$((6*7))`);
      await page.keyboard.press("Enter");
      await expect(terminal).toContainText("SUB-42", { timeout: 15_000 });
      await page.keyboard.press("Control+d");
      await expect(terminal).toContainText("SH-EOF-42", { timeout: 15_000 });
    });
  });
}

// On a Mac copy is Cmd+C, so Ctrl+C stays the program's while a selection is held, as in every macOS terminal (#2625).
// Elsewhere a plain Ctrl+C on a held selection copies it (terminal-focus.e2e.ts).
test.describe("on a Mac", () => {
  test.use({ macPage: true, permissions: ["clipboard-read", "clipboard-write"] });

  for (const where of ["local", "remote"] as const) {
    test(`Cmd+C copies the selected output and Ctrl+C still interrupts the program (${where})`, async ({ page }) => {
      const terminal = await terminalOn(page, where);
      await trapping(page, terminal, "INT");
      await select(page, terminal, "READY-42");
      await page.keyboard.press("Meta+KeyC");
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("READY-42");
      await page.keyboard.press("Control+c");
      await expect(terminal).toContainText("GOT-INT-42", { timeout: 15_000 });
    });
  }

  test("Ctrl+Shift+C on a held selection interrupts the program, as Ctrl+C does", async ({ page }) => {
    const terminal = await terminalOn(page, "local");
    await trapping(page, terminal, "INT");
    await select(page, terminal, "READY-42");
    await page.keyboard.press("Control+Shift+KeyC");
    await expect(terminal).toContainText("GOT-INT-42", { timeout: 15_000 });
  });
});

// A Mac browser can report an empty navigator.platform; the app and wterm then both read the user agent.
test.describe("on a Mac known only by its user agent", () => {
  test.use({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36" });

  test("Ctrl+C on a held selection interrupts the program", async ({ page }) => {
    await page.addInitScript(() =>
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "", configurable: true }),
    );
    const terminal = await terminalOn(page, "local");
    await trapping(page, terminal, "INT");
    await select(page, terminal, "READY-42");
    await page.keyboard.press("Control+c");
    await expect(terminal).toContainText("GOT-INT-42", { timeout: 15_000 });
  });
});

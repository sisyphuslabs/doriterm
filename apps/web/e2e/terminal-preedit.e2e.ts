import type { CDPSession, Locator, Page } from "@playwright/test";
import { gridSize } from "./core-size.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";

// A syllable an input method is composing is drawn as Ghostty draws a preedit: as cells at the cursor, a wide one over
// two cells at the size its committed glyph has, underlined over the cells it hides, shifted left at the row's end, and
// with no cursor drawn meanwhile (#674).
test.use({ serviceWorkers: "block" });

const GA = "\u{AC01}";

/** The committed wide glyphs, the preedit and the cursor as painted, in cells from the grid's first cell. */
const painted = (element: HTMLElement) => {
  const cell = Number.parseFloat(getComputedStyle(element).getPropertyValue("--term-cell-width"));
  const origin = element.querySelector(".term-row:not(.term-scrollback-row)")?.getBoundingClientRect();
  const left = origin?.left ?? 0;
  const top = origin?.top ?? 0;
  const height = origin?.height ?? 1;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- evaluate sends this function as source, so its helpers live inside it
  const advance = (node: Element) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return range.getBoundingClientRect().width;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- as above
  const at = (box: DOMRect) => ({
    col: Math.round((box.left - left) / cell),
    row: Math.round((box.top - top) / height),
  });
  const committed = [...element.querySelectorAll(".term-row:not(.term-preedit) .term-wide")].at(-1);
  const preedit = element.querySelector(".term-preedit");
  const glyph = preedit?.querySelector(".term-wide");
  const cursor = element.querySelector(".term-cursor");
  const input = element.querySelector("textarea");
  return {
    cell,
    committed:
      committed === undefined ? null : { advance: advance(committed), fontSize: getComputedStyle(committed).fontSize },
    preedit:
      preedit === null || glyph === null || glyph === undefined
        ? null
        : {
            text: preedit.textContent,
            ...at(preedit.getBoundingClientRect()),
            cells: preedit.getBoundingClientRect().width / cell,
            advance: advance(glyph),
            width: glyph.getBoundingClientRect().width,
            fontSize: getComputedStyle(glyph).fontSize,
            underline: getComputedStyle(preedit).textDecorationLine,
            background: getComputedStyle(preedit).backgroundColor,
          },
    cursor:
      cursor === null
        ? null
        : (() => {
            const style = getComputedStyle(cursor);
            return {
              ...at(cursor.getBoundingClientRect()),
              background: style.backgroundColor,
              outline: style.outlineStyle,
              shadow: style.boxShadow,
              animation: style.animationName,
            };
          })(),
    inputOpacity: input === null ? null : getComputedStyle(input).opacity,
  };
};

/** Prints `text` with no newline, so the prompt follows it on the row: committed glyphs drawn from output. */
async function printBeforePrompt(page: Page, terminal: Locator, text: string): Promise<void> {
  const octal = [...new TextEncoder().encode(text)].map((byte) => `\\${byte.toString(8)}`).join("");
  await terminal.getByRole("textbox").focus();
  await page.keyboard.type(`printf '${octal}'`);
  await page.keyboard.press("Enter");
  await expect(terminal.locator(".term-row .term-wide").filter({ hasText: [...text].at(-1) ?? "" })).not.toHaveCount(0);
}

async function composeGa(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: GA, selectionStart: 1, selectionEnd: 1 });
  return cdp;
}

/** Commits the syllable, which ends the composition: the preedit goes and the glyph is in the row. */
async function commitGa(cdp: CDPSession, terminal: Locator): Promise<void> {
  await cdp.send("Input.insertText", { text: GA });
  await expect(terminal.locator(".term-preedit")).toHaveCount(0);
  await expect(terminal.locator(".term-row .term-wide").filter({ hasText: GA })).not.toHaveCount(0);
}

test("a composing syllable is drawn as cells at the cursor, sized as its committed glyph, underlined (#674)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  await printBeforePrompt(page, terminal, "\u{D55C}");
  const cdp = await composeGa(page);
  await expect(terminal.locator(".term-preedit")).toHaveText(GA);
  const shown = await terminal.evaluate(painted);
  console.log(`preedit: ${JSON.stringify(shown)}`);
  expect(shown.committed).not.toBeNull();
  expect(shown.preedit).not.toBeNull();
  // "한$ " puts the cursor at column 4: the preedit starts there, on the cursor's row, and fills two cells.
  expect(shown.cursor).toMatchObject({ col: 4 });
  expect(shown.preedit).toMatchObject({ col: 4, row: shown.cursor?.row });
  expect(shown.preedit?.width).toBeCloseTo(2 * shown.cell, 0);
  expect(shown.preedit?.fontSize).toBe(shown.committed?.fontSize);
  expect(Math.abs((shown.preedit?.advance ?? 0) - (shown.committed?.advance ?? 0))).toBeLessThan(1);
  expect(shown.preedit?.underline).toBe("underline");
  // The cells under it are hidden: its background is opaque.
  expect(shown.preedit?.background).toMatch(/^rgb\(/);
  expect(shown.inputOpacity).toBe("0");
  // No cursor is drawn while a preedit is: no block, outline, bar, underline or blink.
  expect(shown.cursor).toMatchObject({
    background: "rgba(0, 0, 0, 0)",
    outline: "none",
    shadow: "none",
    animation: "none",
  });

  await commitGa(cdp, terminal);
});

test("at the last column a composing wide syllable shifts left so both its cells are on the row (#674)", async ({
  page,
}) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const cols = Number((await gridSize(terminal)).split(" ")[1]);
  expect(cols).toBeGreaterThan(10);
  await terminal.getByRole("textbox").focus();
  // "$ " and cols - 3 letters leave the cursor on the last column.
  await page.keyboard.insertText("x".repeat(cols - 3));
  await expect.poll(async () => (await terminal.evaluate(painted)).cursor?.col).toBe(cols - 1);
  const cdp = await composeGa(page);
  await expect(terminal.locator(".term-preedit")).toHaveText(GA);
  const shown = await terminal.evaluate(painted);
  console.log(`preedit at the last column: ${JSON.stringify({ cols, preedit: shown.preedit })}`);
  expect(shown.preedit).toMatchObject({ col: cols - 2, row: shown.cursor?.row });
  expect(shown.preedit?.cells).toBeCloseTo(2, 1);

  await commitGa(cdp, terminal);
});

test("a composing syllable follows the cursor when output moves it (#674)", async ({ page }) => {
  await page.goto("/");
  const terminal = await openNewTerminal(page);
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("no terminal address");
  await terminal.getByRole("textbox").focus();
  const cdp = await composeGa(page);
  await expect(terminal.locator(".term-preedit")).toHaveText(GA);
  const before = await terminal.evaluate(painted);
  expect(before.preedit).toMatchObject({ col: 2, row: before.cursor?.row });
  // Output arrives while the syllable is still composing, as the echo of a key typed just before it does.
  hcOn("host", ["send", address, "printf 'moved:'"]);
  await expect(terminal.locator(".term-row:not(.term-scrollback-row)").filter({ hasText: /^moved:\$/ })).toHaveCount(1);
  // The command echoes on the cursor's row; its output and the next prompt take the row below.
  const row = (before.cursor?.row ?? 0) + 1;
  await expect.poll(async () => (await terminal.evaluate(painted)).cursor).toMatchObject({ col: 8, row });
  await expect.poll(async () => (await terminal.evaluate(painted)).preedit).toMatchObject({ col: 8, row });

  await commitGa(cdp, terminal);
});

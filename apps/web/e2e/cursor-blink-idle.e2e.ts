import type { Locator, Page } from "@playwright/test";
import { pickFile } from "./file-input.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

// An idle terminal must cost its renderer nothing per frame: a CSS animation on the cursor makes Chromium recalculate
// style and paint on every frame (60 a second) even though a blink changes only twice a second. The focused cursor
// still blinks, by data-cursor-off flipped every half second (cursor-blink.ts), and it must look exactly as wterm's
// keyframes drew it: on, then at 50% the cell as it is, with no block, bar, underline or outline.

/** How the cursor's span is drawn, as the browser computed it. */
interface Drawing {
  readonly background: string;
  readonly color: string;
  readonly boxShadow: string;
  readonly outlineStyle: string;
  readonly outlineColor: string;
}

interface Blink {
  readonly on: Drawing;
  readonly off: Drawing;
  /** The cell under the cursor drawn as wterm's 50% keyframe drew it: its own background and colour. */
  readonly cell: Drawing;
  readonly animations: readonly string[];
}

/** A flip that does not come within this is a failure: two phases take a second. */
const FLIP_WITHIN_MS = 5_000;

/**
 * Waits for the cursor to be drawn both on and off, reading its computed style the moment each flip lands, and the
 * cell's own drawing while it is off; fails if the two phases are not seen within {@link FLIP_WITHIN_MS}.
 */
function observeBlink(terminal: Locator): Promise<Blink> {
  return terminal.evaluate(
    (element, within) =>
      new Promise<Blink>((resolve, reject) => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- the page sees only this function's own body
        const draw = (span: Element): Drawing => {
          const style = getComputedStyle(span);
          return {
            background: style.backgroundColor,
            color: style.color,
            boxShadow: style.boxShadow,
            outlineStyle: style.outlineStyle,
            outlineColor: style.outlineColor,
          };
        };
        const cursor = (): Element => {
          const span = element.querySelector(".term-cursor");
          if (span === null) throw new Error("the terminal draws no cursor");
          return span;
        };
        const cellOf = (span: Element): Drawing => {
          const probe = span.cloneNode(true);
          if (!(probe instanceof HTMLElement)) throw new Error("the cursor is not an element");
          probe.classList.remove("term-cursor");
          probe.style.background = "var(--term-cell-bg, transparent)";
          probe.style.color = "var(--term-cell-fg, inherit)";
          span.after(probe);
          const drawn = draw(probe);
          probe.remove();
          return drawn;
        };
        const seen: { on?: Drawing; off?: Drawing; cell?: Drawing } = {};
        const give = setTimeout(() => {
          watch.disconnect();
          reject(new Error(`the cursor did not blink within ${within} ms: ${JSON.stringify(seen)}`));
        }, within);
        const watch = new MutationObserver(() => {
          const span = cursor();
          if (element.hasAttribute("data-cursor-off")) {
            seen.off = draw(span);
            seen.cell = cellOf(span);
          } else seen.on = draw(span);
          if (seen.on === undefined || seen.off === undefined || seen.cell === undefined) return;
          watch.disconnect();
          clearTimeout(give);
          const running = document.getAnimations().filter((animation) => animation.playState === "running");
          resolve({
            on: seen.on,
            off: seen.off,
            cell: seen.cell,
            animations: running.map((animation) => (animation instanceof CSSAnimation ? animation.animationName : "")),
          });
        });
        watch.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
      }),
    FLIP_WITHIN_MS,
  );
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

/** The off phase draws the cell as it is, in every shape: no block, no bar or underline, no outline. */
function expectOffIsTheCell(blink: Blink): void {
  expect(blink.animations).toEqual([]);
  expect(blink.off.background).toBe(blink.cell.background);
  expect(blink.off.color).toBe(blink.cell.color);
  expect(blink.off.boxShadow).toBe("none");
  expect(blink.off.outlineStyle === "none" || blink.off.outlineColor === TRANSPARENT).toBe(true);
}

/** Opens a terminal in the workspace on screen and focuses it. */
async function focusedTerminal(page: Page): Promise<Locator> {
  const terminal = await openNewTerminal(page);
  await terminal.getByRole("textbox").focus();
  await expect(terminal).toHaveClass(/\bfocused\b/);
  return terminal;
}

/** Runs a command in the terminal's shell, as typed. */
async function run(terminal: Locator, command: string): Promise<void> {
  await terminal.getByRole("textbox").pressSequentially(command);
  await terminal.getByRole("textbox").press("Enter");
}

/** Imports a Ghostty config through Settings, as a person does, and closes Settings back to the workspace. */
async function importConfig(page: Page, text: string): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Terminal" }).click();
  await pickFile(page, "Import Ghostty config…", "config", text);
  const preview = page.getByRole("dialog", { name: "Import this Ghostty config?" });
  await preview.getByRole("button", { name: "Import", exact: true }).click();
  await expect(preview).toHaveCount(0);
  await page.getByRole("button", { name: "Close settings" }).first().click();
}

test("an idle focused block cursor runs no CSS animation, and blinks off to the cell as it is", async ({ page }) => {
  await page.goto("/");
  const terminal = await focusedTerminal(page);
  const blink = await observeBlink(terminal);
  expectOffIsTheCell(blink);
  expect(blink.on.background).not.toBe(blink.cell.background);
});

test("a bar and an underline asked for by the program blink their line off", async ({ page }) => {
  await page.goto("/");
  const terminal = await focusedTerminal(page);
  const grid = terminal.locator(".term-grid");
  await run(terminal, String.raw`printf '\033[5 q'`);
  await expect(grid).toHaveAttribute("data-cursor-shape", "bar");
  const bar = await observeBlink(terminal);
  expectOffIsTheCell(bar);
  expect(bar.on.boxShadow).not.toBe("none");

  await run(terminal, String.raw`printf '\033[3 q'`);
  await expect(grid).toHaveAttribute("data-cursor-shape", "underline");
  const underline = await observeBlink(terminal);
  expectOffIsTheCell(underline);
  expect(underline.on.boxShadow).not.toBe("none");
});

test("a configured block_hollow cursor blinks its outline off", async ({ page }) => {
  await importConfig(page, "cursor-style = block_hollow\n");
  const terminal = await focusedTerminal(page);
  await expect(terminal).toHaveClass(/\bcursor-hollow\b/);
  const blink = await observeBlink(terminal);
  expectOffIsTheCell(blink);
  expect(blink.on.outlineStyle).toBe("solid");
  expect(blink.on.outlineColor).not.toBe(TRANSPARENT);
});

test("a configured cursor-text colour is not drawn in the off phase: the cell keeps its own", async ({ page }) => {
  await importConfig(page, "cursor-text = #ff00ff\n");
  const terminal = await focusedTerminal(page);
  const blink = await observeBlink(terminal);
  expectOffIsTheCell(blink);
  expect(blink.cell.color).not.toBe("rgb(255, 0, 255)");
});

// wterm rebuilds the cursor's span whenever its row is drawn again, and its CSS animation started over with the
// element: a cursor that has just moved shows on at once, never hidden for what was left of an off phase.
test("typing while the cursor is off draws it on as soon as it moves", async ({ page }) => {
  await page.goto("/");
  const terminal = await focusedTerminal(page);
  // Once the cursor is off, a watcher notes whether it is still drawn off the moment its span is rebuilt.
  await terminal.evaluate(
    (element, within) =>
      new Promise<void>((resolve, reject) => {
        const grid = element.querySelector(".term-grid");
        if (grid === null) throw new Error("the terminal has no grid");
        const watchRebuild = () => {
          const before = grid.querySelector(".term-cursor");
          const offAt = performance.now();
          const offWhenRebuilt = new Promise<{ off: boolean; afterMs: number }>((settle, fail) => {
            const give = setTimeout(() => fail(new Error(`the cursor did not move within ${within} ms`)), within);
            const rebuilt = new MutationObserver(() => {
              if (grid.querySelector(".term-cursor") === before) return;
              rebuilt.disconnect();
              clearTimeout(give);
              settle({ off: element.hasAttribute("data-cursor-off"), afterMs: Math.round(performance.now() - offAt) });
            });
            rebuilt.observe(grid, { childList: true, subtree: true });
          });
          Reflect.set(element, "offWhenRebuilt", offWhenRebuilt);
          resolve();
        };
        if (element.hasAttribute("data-cursor-off")) return watchRebuild();
        const give = setTimeout(() => reject(new Error(`no off phase within ${within} ms`)), within);
        const off = new MutationObserver(() => {
          if (!element.hasAttribute("data-cursor-off")) return;
          off.disconnect();
          clearTimeout(give);
          watchRebuild();
        });
        off.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
      }),
    FLIP_WITHIN_MS,
  );
  await terminal.getByRole("textbox").press("x");
  const rebuilt: unknown = await terminal.evaluate((element) => Reflect.get(element, "offWhenRebuilt"));
  expect(rebuilt, "the cursor is drawn on the moment its span is rebuilt").toMatchObject({ off: false });
});

/** Counts each time the terminal is drawn off from now on, for {@link offFlips} to read. */
function watchOff(terminal: Locator): Promise<void> {
  return terminal.evaluate((element) => {
    const flips = { count: 0 };
    new MutationObserver(() => {
      if (element.hasAttribute("data-cursor-off")) flips.count++;
    }).observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
    Reflect.set(element, "offFlips", flips);
  });
}

function offFlips(terminal: Locator): Promise<number> {
  return terminal.evaluate((element) => {
    const flips: unknown = Reflect.get(element, "offFlips");
    return typeof flips === "object" && flips !== null ? Number(Reflect.get(flips, "count")) : -1;
  });
}

test("an unfocused pane and a steady cursor are never drawn off", async ({ page }) => {
  await page.goto("/");
  const first = await focusedTerminal(page);
  await page.getByRole("button", { name: "Split right" }).first().click();
  const second = page.locator('[data-focused="true"] [data-terminal]');
  await expect(second).not.toHaveAttribute("data-terminal", (await first.getAttribute("data-terminal")) ?? "");
  await expect(second).toContainText("$", { timeout: 15_000 });
  await second.getByRole("textbox").focus();
  await expect(second).toHaveClass(/\bfocused\b/);

  // The focused pane's own blink is the clock: while it is drawn on and off, the other pane is never drawn off.
  await watchOff(first);
  expectOffIsTheCell(await observeBlink(second));
  expect(await offFlips(first)).toBe(0);
  await expect(first).not.toHaveAttribute("data-cursor-off");

  // A steady cursor asked for by the program is drawn on for as long as the shell takes to sleep through three phases.
  await run(second, String.raw`printf '\033[2 q'`);
  await expect(second.locator(".term-grid")).toHaveAttribute("data-cursor-blink", "false");
  await expect(second).not.toHaveAttribute("data-cursor-off");
  await watchOff(second);
  await run(second, "sleep 1.5; echo steady-$((40+2))");
  await expect(second).toContainText("steady-42", { timeout: 15_000 });
  expect(await offFlips(second)).toBe(0);
});

import type { Locator, Page } from "@playwright/test";
import { pickFile } from "./file-input.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";

test.use({ serviceWorkers: "block" });

// An idle terminal must cost its renderer nothing per frame: a CSS animation on the cursor makes Chromium recalculate
// style and paint on every frame (60 a second) even though a blink changes only twice a second. The focused cursor
// still blinks, by data-cursor-on and data-cursor-off flipped every half second (cursor-blink.ts), and it must look
// exactly as the keyframes drew it, per shape: a block (cursor-blink) in the cursor colour with the app background as
// its text, then the cell; a bar or underline (cursor-line-blink) its line, then none, its text untouched; a configured
// block_hollow (doriface-hollow-blink, render-css.ts) its outline, then a transparent one.

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
  /** The block's 0% keyframe: the cursor colour, with the app background as the text's colour. */
  readonly block: Drawing;
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
        // A copy of the cursor's cell, not a cursor, drawn in the given colours as the page resolves them there.
        const probe = (span: Element, background: string, color: string): Drawing => {
          const copy = span.cloneNode(true);
          if (!(copy instanceof HTMLElement)) throw new Error("the cursor is not an element");
          copy.classList.remove("term-cursor");
          copy.style.background = background;
          copy.style.color = color;
          span.after(copy);
          const drawn = draw(copy);
          copy.remove();
          return drawn;
        };
        const seen: { on?: Drawing; off?: Drawing; cell?: Drawing; block?: Drawing } = {};
        const give = setTimeout(() => {
          watch.disconnect();
          reject(new Error(`the cursor did not blink within ${within} ms: ${JSON.stringify(seen)}`));
        }, within);
        const watch = new MutationObserver(() => {
          const span = cursor();
          if (element.hasAttribute("data-cursor-off")) {
            seen.off = draw(span);
            seen.cell = probe(span, "var(--term-cell-bg, transparent)", "var(--term-cell-fg, inherit)");
            seen.block = probe(
              span,
              "var(--term-app-cursor, var(--term-cursor))",
              "var(--term-app-bg, var(--term-bg))",
            );
          } else seen.on = draw(span);
          if (seen.on === undefined || seen.off === undefined || seen.cell === undefined) return;
          if (seen.block === undefined) return;
          watch.disconnect();
          clearTimeout(give);
          const running = document.getAnimations().filter((animation) => animation.playState === "running");
          resolve({
            on: seen.on,
            off: seen.off,
            cell: seen.cell,
            block: seen.block,
            animations: running.map((animation) => (animation instanceof CSSAnimation ? animation.animationName : "")),
          });
        });
        watch.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
      }),
    FLIP_WITHIN_MS,
  );
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";
/** A bar or underline's off phase: cursor-line-blink's none, as Chromium computed it, matched to the line's inset. */
const NO_LINE = "rgba(0, 0, 0, 0) 0px 0px 0px 0px inset";

/** The off phase draws the cell as it is, in every shape: no block, no bar or underline, no outline. */
function expectOffIsTheCell(blink: Blink): void {
  expect(blink.animations).toEqual([]);
  expect(blink.off.background).toBe(blink.cell.background);
  expect(blink.off.color).toBe(blink.cell.color);
  expect(["none", NO_LINE]).toContain(blink.off.boxShadow);
  expect(blink.off.outlineStyle === "none" || blink.off.outlineColor === TRANSPARENT).toBe(true);
}

/** The cursor as drawn while it does not blink: the steady `shape` (DECSCUSR 2, 4 or 6), in the config's colours. */
async function steadyCursor(terminal: Locator, shape: "2" | "4" | "6"): Promise<Drawing> {
  await run(terminal, `printf '\\033[${shape} q'`);
  await expect(terminal.locator(".term-grid")).toHaveAttribute("data-cursor-blink", "false");
  await expect(terminal).not.toHaveAttribute("data-cursor-off");
  await expect(terminal).not.toHaveAttribute("data-cursor-on");
  return terminal.locator(".term-cursor").evaluate((span) => {
    const style = getComputedStyle(span);
    return {
      background: style.backgroundColor,
      color: style.color,
      boxShadow: style.boxShadow,
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor,
    };
  });
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

// The block's keyframes set the text's colour in both phases, over the config's cursor-text: a blinking block never
// showed it, a steady one does.
test("a blinking block draws the app background over the cursor colour, never cursor-text, then the cell", async ({
  page,
}) => {
  await importConfig(page, "cursor-text = #ff00ff\n");
  const terminal = await focusedTerminal(page);
  const blink = await observeBlink(terminal);
  expectOffIsTheCell(blink);
  expect(blink.on.background).toBe(blink.block.background);
  expect(blink.on.color).toBe(blink.block.color);
  const steady = await steadyCursor(terminal, "2");
  expect(steady.color, "the config's cursor-text reaches a steady block").toBe("rgb(255, 0, 255)");
  expect(blink.on.color).not.toBe(steady.color);
});

// The line's keyframes set only the box-shadow: the text keeps the config's cursor-text in both phases.
async function expectLineKeepsCursorText(
  terminal: Locator,
  blinking: "3" | "5",
  steady: "4" | "6",
  shape: "bar" | "underline",
): Promise<void> {
  const still = await steadyCursor(terminal, steady);
  expect(still.color, `the config's cursor-text reaches a steady ${shape}`).toBe("rgb(255, 0, 255)");
  await run(terminal, `printf '\\033[${blinking} q'`);
  await expect(terminal.locator(".term-grid")).toHaveAttribute("data-cursor-shape", shape);
  const blink = await observeBlink(terminal);
  expect(blink.animations).toEqual([]);
  expect(blink.on.color, shape).toBe(still.color);
  expect(blink.off.color, shape).toBe(still.color);
  expect(blink.on.boxShadow, shape).toBe(still.boxShadow);
  expect(blink.off.boxShadow, shape).toBe(NO_LINE);
  expect(blink.off.background, shape).toBe(blink.cell.background);
}

test("a blinking bar and underline keep the configured cursor-text colour in both phases", async ({ page }) => {
  await importConfig(page, "cursor-text = #ff00ff\n");
  const terminal = await focusedTerminal(page);
  await expectLineKeepsCursorText(terminal, "5", "6", "bar");
  await expectLineKeepsCursorText(terminal, "3", "4", "underline");
});

// A DECSCUSR from a block to a bar renamed wterm's animation (cursor-blink to cursor-line-blink), which started it over:
// vim entering insert mode showed its bar at once, never hidden for what was left of the block's off phase.
test("a block switched to a bar while it is off shows the bar on at once", async ({ page }) => {
  await page.goto("/");
  const terminal = await focusedTerminal(page);
  // With echo off the shell's read takes Enter without moving the cursor, so its span is kept (wterm changes only the
  // grid's data-cursor-shape for a new shape): what starts the phase over can only be the change of shape.
  // The marker is the shell's last output before it waits, so nothing else moves the cursor until Enter.
  await run(terminal, String.raw`stty -echo; echo waiting-$((6*7)); read line; printf '\033[5 q'; sleep 30`);
  await expect(terminal).toContainText("waiting-42", { timeout: 15_000 });
  await terminal.evaluate(
    (element, within) =>
      new Promise<void>((resolve, reject) => {
        const grid = element.querySelector(".term-grid");
        if (grid === null) throw new Error("the terminal has no grid");
        // Armed at the start of an off phase. The app's own observers were made first, so within the batch that brings
        // the new shape they have already run: the phase is read after whatever they did about it.
        const arm = (): void => {
          const span = grid.querySelector(".term-cursor");
          let offBefore = true;
          const atSwitch = new Promise<object>((settle, fail) => {
            const give = setTimeout(() => fail(new Error(`the shape did not change within ${within} ms`)), within);
            const watch = new MutationObserver((records) => {
              const off = element.hasAttribute("data-cursor-off");
              if (!records.some((record) => record.attributeName === "data-cursor-shape")) {
                offBefore = off;
                return;
              }
              watch.disconnect();
              clearTimeout(give);
              settle({ offBefore, off, rebuilt: grid.querySelector(".term-cursor") !== span });
            });
            watch.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
            watch.observe(grid, { attributes: true, attributeFilter: ["data-cursor-shape"] });
          });
          Reflect.set(element, "atSwitch", atSwitch);
          resolve();
        };
        const give = setTimeout(() => reject(new Error(`no off phase within ${within} ms`)), within);
        const off = new MutationObserver(() => {
          if (!element.hasAttribute("data-cursor-off")) return;
          off.disconnect();
          clearTimeout(give);
          arm();
        });
        off.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
      }),
    FLIP_WITHIN_MS,
  );
  await terminal.getByRole("textbox").press("Enter");
  const atSwitch: unknown = await terminal.evaluate((element) => Reflect.get(element, "atSwitch"));
  expect(atSwitch, "the bar came while the block was off, its span kept, and is drawn on").toEqual({
    offBefore: true,
    off: false,
    rebuilt: false,
  });
  await expect(terminal.locator(".term-grid")).toHaveAttribute("data-cursor-shape", "bar");
});

// wterm rebuilds the cursor's span whenever its row is drawn again, and its CSS animation started over with the
// element: a cursor that has just moved shows on at once, never hidden for what was left of an off phase.
test("typing while the cursor is off draws it on as soon as it moves", async ({ page }) => {
  await page.goto("/");
  const terminal = await focusedTerminal(page);
  // Armed at the start of an off phase, so the key lands within it; a key that came after the phase had ended would
  // find the cursor on whether or not anything started it over, and proves nothing. The app's own observers were made
  // first, so within the batch that rebuilds the span they have already run: the phase is read after what they did.
  await terminal.evaluate(
    (element, within) =>
      new Promise<void>((resolve, reject) => {
        const grid = element.querySelector(".term-grid");
        if (grid === null) throw new Error("the terminal has no grid");
        const arm = (): void => {
          const span = grid.querySelector(".term-cursor");
          let offBefore = true;
          const atRebuild = new Promise<object>((settle, fail) => {
            const give = setTimeout(() => fail(new Error(`the cursor did not move within ${within} ms`)), within);
            const watch = new MutationObserver(() => {
              const off = element.hasAttribute("data-cursor-off");
              if (grid.querySelector(".term-cursor") === span) {
                offBefore = off;
                return;
              }
              watch.disconnect();
              clearTimeout(give);
              settle({ offBefore, off });
            });
            watch.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
            watch.observe(grid, { childList: true, subtree: true });
          });
          Reflect.set(element, "atRebuild", atRebuild);
          resolve();
        };
        const give = setTimeout(() => reject(new Error(`no off phase within ${within} ms`)), within);
        const off = new MutationObserver(() => {
          if (!element.hasAttribute("data-cursor-off")) return;
          off.disconnect();
          clearTimeout(give);
          arm();
        });
        off.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
      }),
    FLIP_WITHIN_MS,
  );
  await terminal.getByRole("textbox").press("x");
  const rebuilt: unknown = await terminal.evaluate((element) => Reflect.get(element, "atRebuild"));
  expect(rebuilt, "the key came while the cursor was off, and it is drawn on the moment its span is rebuilt").toEqual({
    offBefore: true,
    off: false,
  });
});

// The hide rule (styles.css) stopped wterm's animation while a composition hid the cursor, and its removal started a
// fresh one: a composition cancelled with nothing typed showed the cursor on at once, for a whole on phase, never off for
// what was left of a phase. Nothing blinks meanwhile, as no animation ran.
test("a composition cancelled while the cursor is off shows it on at once, for a whole on phase", async ({ page }) => {
  await page.goto("/");
  const terminal = await focusedTerminal(page);
  const cdp = await page.context().newCDPSession(page);
  // Armed at the start of an off phase, so the composition starts and is cancelled within it. The app's own observers
  // were made first, so within each batch they have already run: what is read is what they did about it.
  await terminal.evaluate(
    (element, within) =>
      new Promise<void>((resolve, reject) => {
        const watchComposition = (): void => {
          let hidden = false;
          let marked = false;
          let shown: { at: number; on: boolean } | null = null;
          const result = new Promise<object>((settle, fail) => {
            const give = setTimeout(() => fail(new Error(`no off phase after the composition`)), 3 * within);
            const watch = new MutationObserver(() => {
              const on = element.hasAttribute("data-cursor-on");
              const off = element.hasAttribute("data-cursor-off");
              if (element.hasAttribute("data-preedit")) {
                hidden = true;
                marked ||= on || off;
              } else if (hidden && shown === null) shown = { at: performance.now(), on: on && !off };
              else if (shown !== null && off) {
                watch.disconnect();
                clearTimeout(give);
                const nextOffMs = Math.round(performance.now() - shown.at);
                settle({ markedWhileHidden: marked, onWhenShown: shown.on, wholeOnPhase: nextOffMs >= 480 });
              }
            });
            watch.observe(element, {
              attributes: true,
              attributeFilter: ["data-preedit", "data-cursor-on", "data-cursor-off"],
            });
          });
          Reflect.set(element, "afterComposition", result);
          resolve();
        };
        const give = setTimeout(() => reject(new Error(`no off phase within ${within} ms`)), within);
        const off = new MutationObserver(() => {
          if (!element.hasAttribute("data-cursor-off")) return;
          off.disconnect();
          clearTimeout(give);
          watchComposition();
        });
        off.observe(element, { attributes: true, attributeFilter: ["data-cursor-off"] });
      }),
    FLIP_WITHIN_MS,
  );
  await cdp.send("Input.imeSetComposition", { text: "\u{AC01}", selectionStart: 1, selectionEnd: 1 });
  await expect(terminal).toHaveAttribute("data-preedit", "");
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await expect(terminal).not.toHaveAttribute("data-preedit");
  const after: unknown = await terminal.evaluate((element) => Reflect.get(element, "afterComposition"));
  expect(after, "no blink while hidden, then on at once for a whole phase").toEqual({
    markedWhileHidden: false,
    onWhenShown: true,
    wholeOnPhase: true,
  });
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

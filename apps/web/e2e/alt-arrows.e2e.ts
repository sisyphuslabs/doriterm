// #1172: at the edge of a split, a pane key with no pane that way nudges the pane and leaves its key to the terminal's
// program, as a lone pane does; a Cmd chord, which a program never receives, stays the app's. A pane swap chosen from
// the palette has no key to leave, so it counts as handled and the palette closes (#2119). Alt+Up reaching the program
// is alt-arrow-passthrough.e2e.ts's (#1898).
import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { pressShortcut } from "./platform-keys.ts";

test.use({ serviceWorkers: "block" });
endOwnTerminals();

type Keymap = "mac" | "other";

/** The platform the page resolves, as Chromium reports it on that OS (currentPlatform, src/keys/trigger.ts). */
const PLATFORM: Readonly<Record<Keymap, string>> = { mac: "MacIntel", other: "Linux x86_64" };

/** Ctrl+Alt+ArrowUp: CSI 1;7A. */
const CTRL_ALT_UP_BYTES = "1b 5b 31 3b 37 41";
/** Alt+Shift+K, the pane swap key to the top: Meta-Shift-K, which the terminal sends as ESC K. */
const ALT_SHIFT_K_BYTES = "1b 4b";

/** Each read gets its own marker line, so a second read waits for its own program and not the one before it. */
let reads = 0;

/** The terminal that holds the keyboard, by its address, as split-focus.e2e.ts reads it. */
const keyboardAddress = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null);

/** The box of the pane that holds the terminal at `address`. */
const paneBox = (page: Page, address: string) =>
  page.locator("section", { has: page.locator(`[data-terminal="${address}"]`) }).boundingBox();

/** Up-nudges the panes played so far, counted by a wrapper on Element.animate installed before the app loads. */
const upNudges = (page: Page): Promise<number> => page.evaluate(() => Number(Reflect.get(window, "__upNudges") ?? 0));

const addressOf = async (terminal: Locator): Promise<string> => {
  const address = await terminal.getAttribute("data-terminal");
  if (address === null) throw new Error("the terminal has no address");
  return address;
};

async function onKeymap(page: Page, keymap: Keymap): Promise<void> {
  await page.addInitScript(
    (value) => Object.defineProperty(Navigator.prototype, "platform", { get: () => value }),
    PLATFORM[keymap],
  );
  // pane-motion.ts nudges a pane with no pane that way by animating it to translateY(-4px) and back.
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const [frames] = args;
      if (Array.isArray(frames) && frames[1]?.["transform"] === "translateY(-4px)")
        Reflect.set(window, "__upNudges", Number(Reflect.get(window, "__upNudges") ?? 0) + 1);
      return animate.apply(this, args);
    };
  });
  await page.goto("/");
}

/** Opens a terminal, focuses its program and returns both. */
async function terminalInFocus(page: Page): Promise<{ terminal: Locator; address: string }> {
  const terminal = await openNewTerminal(page);
  const address = await addressOf(terminal);
  await terminal.getByRole("textbox").focus();
  await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(address);
  return { terminal, address };
}

/**
 * Splits the focused pane to its right and returns the pane that takes the focus. The pane header's Split right button
 * runs the action on every host: on macOS the split chord's Cmd+D is the browser's bookmark, which a page never sees.
 */
async function splitRight(page: Page): Promise<{ terminal: Locator; address: string }> {
  const known = new Set(
    await page.locator("[data-terminal]").evaluateAll((each) => each.map((el) => el.getAttribute("data-terminal"))),
  );
  await page.getByRole("button", { name: "Split right" }).first().click();
  let address = "";
  await expect
    .poll(
      async () => {
        const shown = await page
          .locator("[data-terminal]")
          .evaluateAll((each) => each.map((el) => el.getAttribute("data-terminal")));
        const fresh = shown.filter((each): each is string => each !== null && !known.has(each));
        address = fresh[0] ?? "";
        return fresh.length;
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  const terminal = page.locator(`[data-terminal="${address}"]`);
  await expect(terminal).toContainText("$", { timeout: 15_000 });
  await terminal.getByRole("textbox").focus();
  await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(address);
  return { terminal, address };
}

/**
 * The page's answer to the next keydown with `key`: each `defaultPrevented`, read by a window listener installed
 * after the app's own. The app stops propagation once it takes a key; listeners on the same target still run after it.
 */
async function defaultPrevented(page: Page, key: string, press: () => Promise<void>): Promise<boolean[]> {
  await page.evaluate((held) => {
    const seen: boolean[] = [];
    Reflect.set(window, "__defaultPrevented", seen);
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === held) seen.push(event.defaultPrevented);
      },
      { capture: true },
    );
  }, key);
  await press();
  return page.evaluate<boolean[]>(() => Reflect.get(window, "__defaultPrevented"));
}

/**
 * Puts the program in raw mode reading `count` bytes and prints them as hex, as korean-ime-ctrl-chord.e2e.ts does:
 * `raw-<n>-5` is printed once the shell is raw, so a key after it is read by `head`, not by the shell's line editor.
 */
async function readBytes(page: Page, terminal: Locator, count: number): Promise<void> {
  reads += 1;
  await page.keyboard.type(`stty raw -echo; echo raw-${reads}-$((2+3)); head -c ${count} | od -An -tx1; stty sane\r`);
  await expect(terminal).toContainText(`raw-${reads}-5`, { timeout: 15_000 });
}

for (const keymap of ["mac", "other"] as const) {
  test(`${keymap}: a pane chord that is bound still moves focus between the split's panes`, async ({ page }) => {
    await onKeymap(page, keymap);
    const first = await terminalInFocus(page);
    const second = await splitRight(page);
    const left = keymap === "mac" ? "Meta+Alt+ArrowLeft" : "Control+Alt+ArrowLeft";
    const right = keymap === "mac" ? "Meta+Alt+ArrowRight" : "Control+Alt+ArrowRight";
    await page.keyboard.press(left);
    await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(first.address);
    await page.keyboard.press(right);
    await expect.poll(() => keyboardAddress(page), { timeout: 5_000 }).toBe(second.address);
  });
}

test("mac: a Cmd+Alt arrow with no pane that way stays cancelled, so the browser's shortcut cannot act", async ({
  page,
}) => {
  // A terminal program never receives a Cmd chord: @wterm/dom stops at every Meta chord without sending bytes or
  // cancelling it. At the top of a row split the pane still nudges, but the key stays the app's, as it did before #1302.
  await onKeymap(page, "mac");
  await terminalInFocus(page);
  const second = await splitRight(page);
  expect(await defaultPrevented(page, "ArrowUp", () => page.keyboard.press("Meta+Alt+ArrowUp"))).toEqual([true]);
  await expect.poll(() => upNudges(page)).toBe(1);
  // Swapping with no pane that way keeps its key too, and neither chord moves focus.
  expect(await defaultPrevented(page, "ArrowUp", () => page.keyboard.press("Meta+Alt+Shift+ArrowUp"))).toEqual([true]);
  await expect.poll(() => keyboardAddress(page)).toBe(second.address);
});

test("other: a pane chord with no pane that way reaches the program, not the app", async ({ page }) => {
  // The top of a row split has no pane above it. Ctrl+Alt+ArrowUp is bound to pane.go:up, and with no pane that way the
  // pane must still nudge but must not swallow the key (#1302, #1172).
  await onKeymap(page, "other");
  await terminalInFocus(page);
  const second = await splitRight(page);
  await readBytes(page, second.terminal, 6);
  await page.keyboard.press("Control+Alt+ArrowUp");
  await expect(second.terminal).toContainText(CTRL_ALT_UP_BYTES, { timeout: 10_000 });
  await expect.poll(() => upNudges(page)).toBe(1);
  await expect.poll(() => keyboardAddress(page)).toBe(second.address);

  // Swapping with no pane that way is the same promise: the key reaches the program and nothing moves.
  await readBytes(page, second.terminal, 2);
  await page.keyboard.press("Alt+Shift+KeyK");
  await expect(second.terminal).toContainText(ALT_SHIFT_K_BYTES, { timeout: 10_000 });
  await expect.poll(() => keyboardAddress(page)).toBe(second.address);
});

for (const keymap of ["mac", "other"] as const) {
  test(`${keymap}: "Swap pane up" chosen from the palette at a split's top edge closes the palette`, async ({
    page,
  }) => {
    // The palette offers the pane swaps (shell-actions.ts). At the top of a row split there is no pane to swap with;
    // the chosen action has no key to leave to a program, so it counts as handled and the palette closes, as it did
    // before #1600, and no pane moves.
    await onKeymap(page, keymap);
    const first = await terminalInFocus(page);
    const second = await splitRight(page);
    const placed = { first: await paneBox(page, first.address), second: await paneBox(page, second.address) };
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await pressShortcut(page, "app.palette");
    await expect(dialog).toBeVisible();
    await page.getByRole("combobox", { name: "Command" }).fill("Swap pane up");
    await page.getByRole("option", { name: /^Swap pane up/ }).click();
    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect.poll(() => keyboardAddress(page)).toBe(second.address);
    // A swap keeps focus on the pane it moved, so the boxes are what show that nothing swapped.
    expect(await paneBox(page, first.address)).toEqual(placed.first);
    expect(await paneBox(page, second.address)).toEqual(placed.second);
  });
}

// #1302: Alt+Up / Alt+Down are the answer keys an agent's question UI and many editors wait for, so the default keymap
// must leave them to a focused terminal's program. The program reads its terminal's own sequence and no pane moves; a
// chord that is bound still acts as a binding.
import type { Locator, Page } from "@playwright/test";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { endOwnTerminals } from "./own-terminals.ts";

test.use({ serviceWorkers: "block" });
endOwnTerminals();

type Keymap = "mac" | "other";

/** The platform the page resolves, as Chromium reports it on that OS (currentPlatform, src/keys/trigger.ts). */
const PLATFORM: Readonly<Record<Keymap, string>> = { mac: "MacIntel", other: "Linux x86_64" };

/** Alt+ArrowUp as the terminal's encoder sends it: CSI 1;3A, read as hex by `od`. */
const ALT_UP_BYTES = "1b 5b 31 3b 33 41";
/** Ctrl+Alt+ArrowUp: CSI 1;7A. */
const CTRL_ALT_UP_BYTES = "1b 5b 31 3b 37 41";
/** Alt+Shift+K, the pane swap key to the top: Meta-Shift-K, which the terminal sends as ESC K. */
const ALT_SHIFT_K_BYTES = "1b 4b";

/** Each read gets its own marker line, so a second read waits for its own program and not the one before it. */
let reads = 0;

/** The terminal that holds the keyboard, by its address, as split-focus.e2e.ts reads it. */
const keyboardAddress = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.closest("[data-terminal]")?.getAttribute("data-terminal") ?? null);

const paneOf = (page: Page, address: string): Locator =>
  page.locator("section", { has: page.locator(`[data-terminal="${address}"]`) });

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
  test(`${keymap}: Alt+ArrowUp reaches the program in a lone pane, as its terminal would send it`, async ({ page }) => {
    await onKeymap(page, keymap);
    const { terminal, address } = await terminalInFocus(page);
    await readBytes(page, terminal, 6);
    await page.keyboard.press("Alt+ArrowUp");
    await expect(terminal).toContainText(ALT_UP_BYTES, { timeout: 10_000 });
    await expect.poll(() => keyboardAddress(page)).toBe(address);
  });

  test(`${keymap}: Alt+ArrowUp reaches the program in a split tab, and no pane moves`, async ({ page }) => {
    await onKeymap(page, keymap);
    const first = await terminalInFocus(page);
    const second = await splitRight(page);
    const placed = {
      first: await paneOf(page, first.address).boundingBox(),
      second: await paneOf(page, second.address).boundingBox(),
    };
    await readBytes(page, second.terminal, 6);
    await page.keyboard.press("Alt+ArrowUp");
    await expect(second.terminal).toContainText(ALT_UP_BYTES, { timeout: 10_000 });
    // The key moved no focus and resized no pane: both panes still hold the boxes the split gave them.
    await expect.poll(() => keyboardAddress(page)).toBe(second.address);
    expect(await paneOf(page, first.address).boundingBox()).toEqual(placed.first);
    expect(await paneOf(page, second.address).boundingBox()).toEqual(placed.second);
  });

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
  await expect.poll(() => keyboardAddress(page)).toBe(second.address);

  // Swapping with no pane that way is the same promise: the key reaches the program and nothing moves.
  await readBytes(page, second.terminal, 2);
  await page.keyboard.press("Alt+Shift+KeyK");
  await expect(second.terminal).toContainText(ALT_SHIFT_K_BYTES, { timeout: 10_000 });
  await expect.poll(() => keyboardAddress(page)).toBe(second.address);
});

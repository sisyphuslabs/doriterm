// herdr-app's space keys: Ctrl+1-9 on a Mac and Alt+1-9 elsewhere show a space, and the bracket pair cycles them
// (defaults/keys.macos.json, keys.json). Every one of them is the app's from a focused terminal too (#1925); a program
// that needs a number chord gets that row unbound in Settings > Keybindings.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { paneOf, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { pagePlatform, shortcut } from "./platform-keys.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const selected = (page: Page) => page.getByRole("tab", { selected: true });
const spaceRow = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });
const mac = async (page: Page): Promise<boolean> => (await pagePlatform(page)) === "mac";

/** The number chord that shows a space by its place, as the platform binds it: Ctrl+N on a Mac, Alt+N elsewhere (#702). */
const spaceNumberChord = (page: Page, place: number): Promise<string> => shortcut(page, `space.select:${place}`);

/** The cycle chord as the platform binds it: Cmd+Alt+[ / ] on a Mac, Ctrl+Shift+PageUp / PageDown elsewhere (#702). */
const cycle = (page: Page, side: "[" | "]"): Promise<string> =>
  shortcut(page, side === "]" ? "space.next" : "space.prev");

/** A plain shell started straight on the core in `cwd`, named, so its tab reads that name. */
function shellIn(cwd: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  return String((JSON.parse(out) as { address: string }).address);
}

/** One space of one shell per name, in the order the sidebar reads them; each tab reads `<name>-one`. */
function spacesNamed<Name extends string>(names: readonly Name[]): Record<Name, string> {
  const root = mkdtempSync(join(tmpdir(), "space-keys-"));
  const shells = {} as Record<Name, string>;
  seedSpaces(
    names.map((name) => {
      const folder = mkdtempSync(join(root, `${name}-`));
      shells[name] = shellIn(folder, `space-${name}`);
      return {
        id: `spc-${name}`,
        name,
        folder,
        tabs: [{ id: `tb-${name}1`, name: `${name}-one`, terminal: shells[name] }],
      };
    }),
  );
  return shells;
}

const THREE = ["alpha", "beta", "gamma"] as const;
const NINE = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"] as const;

/** Three spaces of one shell each: alpha, beta, gamma. */
const threeSpaces = () => spacesNamed(THREE);

/** A number chord pressed with the keyboard on a sidebar row, outside every terminal. */
async function pressOutsideTerminal(page: Page, chord: string): Promise<void> {
  await spaceRow(page, "alpha").focus();
  await page.keyboard.press(chord);
}

/**
 * Records every keydown that gets past the app's capture listener into a terminal, before the terminal handles it. A
 * modifier pressed on its own (the Control of Ctrl+2) is not a chord and is left out.
 */
async function watchTerminalKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    Reflect.set(window, "terminalSaw", []);
    const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta"]);
    document.addEventListener(
      "keydown",
      (event: Event) => {
        const press = event as KeyboardEvent;
        if (MODIFIERS.has(press.key)) return;
        if (!(press.target instanceof Element) || press.target.closest(".wterm") === null) return;
        const seen = Reflect.get(window, "terminalSaw") as unknown[];
        seen.push({ ctrl: press.ctrlKey, alt: press.altKey, key: press.key });
      },
      true,
    );
  });
}

const terminalKeysSeen = (page: Page): Promise<unknown> => page.evaluate(() => Reflect.get(window, "terminalSaw"));

test("1: the number chord 2 shows the second space, and a number with no space in the sidebar leaves the space in view", async ({
  page,
}) => {
  threeSpaces();
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/alpha-one/], { timeout: 20_000 });

  await pressOutsideTerminal(page, await spaceNumberChord(page, 2));
  await expect(tabBar(page)).toHaveText([/beta-one/]);
  await expect(selected(page)).toHaveText(/beta-one/);

  // herdr-app's space.select: an index with no space behind it leaves the space in view alone.
  await pressOutsideTerminal(page, await spaceNumberChord(page, 9));
  await expect(tabBar(page)).toHaveText([/beta-one/]);

  await pressOutsideTerminal(page, await spaceNumberChord(page, 1));
  await expect(tabBar(page)).toHaveText([/alpha-one/]);
  await pressOutsideTerminal(page, await spaceNumberChord(page, 3));
  await expect(tabBar(page)).toHaveText([/gamma-one/]);
});

test("2: the cycle keys step through the spaces in order and wrap at either end, from a terminal too", async ({
  page,
}) => {
  const shells = threeSpaces();
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/alpha-one/], { timeout: 20_000 });
  await paneOf(page, shells.alpha).getByRole("textbox").focus();
  const next = await cycle(page, "]");
  const previous = await cycle(page, "[");

  await page.keyboard.press(next);
  await expect(tabBar(page)).toHaveText([/beta-one/]);
  await page.keyboard.press(next);
  await expect(tabBar(page)).toHaveText([/gamma-one/]);
  // The last space's next is the first, as herdr-app wraps.
  await page.keyboard.press(next);
  await expect(tabBar(page)).toHaveText([/alpha-one/]);
  await page.keyboard.press(previous);
  await expect(tabBar(page)).toHaveText([/gamma-one/]);
});

test("3: with a terminal focused, each number chord 1-9 shows its space, and a chord the app took never reaches the terminal (#1925)", async ({
  page,
}) => {
  const shells = spacesNamed(NINE);
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/alpha-one/], { timeout: 20_000 });
  await paneOf(page, shells.alpha).getByRole("textbox").focus();
  await expect(paneOf(page, shells.alpha).getByRole("textbox")).toBeFocused();
  await watchTerminalKeys(page);

  // Each chord is pressed with the keyboard in the terminal the last one showed: a space switch moves the keyboard into
  // the terminal it shows, as a tab switch does (#1704), so the whole run stays inside a terminal.
  for (const name of NINE.slice(1)) {
    // oxlint-disable-next-line no-await-in-loop -- each place is pressed from the terminal the previous one focused
    await page.keyboard.press(await spaceNumberChord(page, NINE.indexOf(name) + 1));
    // oxlint-disable-next-line no-await-in-loop
    await expect(tabBar(page)).toHaveText([new RegExp(`${name}-one`)]);
    // oxlint-disable-next-line no-await-in-loop
    await expect(paneOf(page, shells[name]).getByRole("textbox")).toBeFocused();
  }
  await page.keyboard.press(await spaceNumberChord(page, 1));
  await expect(tabBar(page)).toHaveText([/alpha-one/]);
  await expect(selected(page)).toHaveText(/alpha-one/);
  await expect(paneOf(page, shells.alpha).getByRole("textbox")).toBeFocused();
  // Every chord was the app's: its capture listener took each one before any terminal could see it.
  expect(await terminalKeysSeen(page)).toEqual([]);
});

test("4: Settings lists the space keys with the keys that run them", async ({ page }) => {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Keybindings" })
    .or(page.getByRole("button", { name: "Keybindings" }))
    .first()
    .click();
  const row = (action: string) => page.locator(`[id="keybinding-${action}"]`).locator("xpath=../..");
  const chips = (await mac(page))
    ? // A Mac lists modifiers in its own order, Control, Option, Shift, Command (⌃⌥⇧⌘), whatever order they are typed in.
      { select: "⌃2", next: "⌥⌘]", previous: "⌥⌘[", ninth: "⌃9" }
    : { select: "Alt2", next: "CtrlShiftPgDn", previous: "CtrlShiftPgUp", ninth: "Alt9" };

  await expect(row("space.select:2")).toContainText("Go to space 2");
  await expect(row("space.select:2")).toContainText(chips.select);
  await expect(row("space.select:9")).toContainText("Go to space 9");
  await expect(row("space.select:9")).toContainText(chips.ninth);
  await expect(row("space.next")).toContainText("Next space");
  await expect(row("space.next")).toContainText(chips.next);
  await expect(row("space.prev")).toContainText("Previous space");
  await expect(row("space.prev")).toContainText(chips.previous);
  await expect(row("space.select:1")).not.toContainText("A focused terminal program keeps this key");
});

test("5: with a terminal focused, Ctrl+C still interrupts the program: only the bound chords are the app's (#1925)", async ({
  page,
}) => {
  const shells = threeSpaces();
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/alpha-one/], { timeout: 20_000 });
  const terminal = page.locator(`[data-terminal="${shells.alpha}"]`);
  await paneOf(page, shells.alpha).getByRole("textbox").focus();
  await watchTerminalKeys(page);
  // armed-9 prints once the shell runs the line, so the interrupt lands on sleep or on the list it heads, never on a
  // line still being read. bash (macOS /bin/sh) can continue a semicolon list after SIGINT; && depends on sleep.
  await page.keyboard.type("echo armed-$((3*3)); sleep 30 && echo slept-$((1+1))\r");
  await expect(terminal).toContainText("armed-9", { timeout: 15_000 });
  await page.keyboard.press("Control+c");
  // The shell prints after-42 only once it runs the line, which it does only when sleep was interrupted.
  await page.keyboard.type("echo after-$((40+2))\r");
  await expect(terminal).toContainText("after-42", { timeout: 10_000 });
  await expect(terminal).not.toContainText("slept-2");
  await expect(tabBar(page)).toHaveText([/alpha-one/]);
  expect(await terminalKeysSeen(page)).toContainEqual({ ctrl: true, alt: false, key: "c" });
});

test("6: with a terminal focused, a number past the spaces changes nothing and is spent, never sent to the program (#1925)", async ({
  page,
}) => {
  const shells = threeSpaces();
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/alpha-one/], { timeout: 20_000 });
  await paneOf(page, shells.alpha).getByRole("textbox").focus();
  await watchTerminalKeys(page);
  // herdr-app's space.select past the list fails and the key is spent; Ctrl+9 reaching a shell would be a control code.
  await page.keyboard.press(await spaceNumberChord(page, 9));
  // The space in view is spent the same way.
  await page.keyboard.press(await spaceNumberChord(page, 1));
  await expect(tabBar(page)).toHaveText([/alpha-one/]);
  await expect(paneOf(page, shells.alpha).getByRole("textbox")).toBeFocused();
  expect(await terminalKeysSeen(page)).toEqual([]);
});

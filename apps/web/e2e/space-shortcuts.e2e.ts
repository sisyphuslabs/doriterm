// herdr-app's space keys: Ctrl+1-9 show a space, and the bracket pair cycles them (defaults/keys.macos.json, keys.json).
// Ctrl and a digit is a control key a focused terminal program reads, so the app keeps its hands off it there.
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

/** The cycle chord as the platform binds it: Cmd+Alt+[ / ] on a Mac, Ctrl+Alt+[ / ] elsewhere. */
const cycle = (page: Page, side: "[" | "]"): Promise<string> =>
  shortcut(page, side === "]" ? "space.next" : "space.prev");

/** A plain shell started straight on the core in `cwd`, named, so its tab reads that name. */
function shellIn(cwd: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  return String((JSON.parse(out) as { address: string }).address);
}

/** Three spaces of one shell each, in the order the sidebar reads them: alpha, beta, gamma. */
function threeSpaces(): Record<"alpha" | "beta" | "gamma", string> {
  const root = mkdtempSync(join(tmpdir(), "space-keys-"));
  const folder = (name: string) => mkdtempSync(join(root, `${name}-`));
  const dirs = { alpha: folder("alpha"), beta: folder("beta"), gamma: folder("gamma") };
  const shells = {
    alpha: shellIn(dirs.alpha, "space-a1"),
    beta: shellIn(dirs.beta, "space-b1"),
    gamma: shellIn(dirs.gamma, "space-g1"),
  };
  seedSpaces(
    (["alpha", "beta", "gamma"] as const).map((name) => ({
      id: `spc-${name}`,
      name,
      folder: dirs[name],
      tabs: [{ id: `tb-${name}1`, name: `${name}-one`, terminal: shells[name] }],
    })),
  );
  return shells;
}

/** A number chord is the app's only while the keyboard is outside a terminal: the sidebar row keeps it there. */
async function pressOutsideTerminal(page: Page, chord: string): Promise<void> {
  await spaceRow(page, "alpha").focus();
  await page.keyboard.press(chord);
}

test("1: Ctrl+2 shows the second space, and a number with no space in the sidebar leaves the space in view", async ({
  page,
}) => {
  threeSpaces();
  await page.goto("/");
  await expect(tabBar(page)).toHaveText([/alpha-one/], { timeout: 20_000 });

  await pressOutsideTerminal(page, "Control+2");
  await expect(tabBar(page)).toHaveText([/beta-one/]);
  await expect(selected(page)).toHaveText(/beta-one/);

  // herdr-app's space.select: an index with no space behind it leaves the space in view alone.
  await pressOutsideTerminal(page, "Control+9");
  await expect(tabBar(page)).toHaveText([/beta-one/]);

  await pressOutsideTerminal(page, "Control+1");
  await expect(tabBar(page)).toHaveText([/alpha-one/]);
  await pressOutsideTerminal(page, "Control+3");
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

test("3: a focused terminal program keeps Ctrl+1: the terminal sees it uncancelled and the space stays", async ({
  page,
}) => {
  const root = mkdtempSync(join(tmpdir(), "space-keys-kept-"));
  const [alpha, beta] = [mkdtempSync(join(root, "alpha-")), mkdtempSync(join(root, "beta-"))];
  const shells = {
    a1: shellIn(alpha, "kept-a1"),
    b1: shellIn(beta, "kept-b1"),
    b2: shellIn(beta, "kept-b2"),
  };
  seedSpaces([
    {
      id: "spc-kept-alpha",
      name: "alpha",
      folder: alpha,
      tabs: [{ id: "tb-kept-a", name: "a-one", terminal: shells.a1 }],
    },
    {
      id: "spc-kept-beta",
      name: "beta",
      folder: beta,
      tabs: [
        { id: "tb-kept-b1", name: "b-one", terminal: shells.b1 },
        { id: "tb-kept-b2", name: "b-two", terminal: shells.b2 },
      ],
    },
  ]);
  await page.goto("/");
  await spaceRow(page, "beta").click();
  await tabBar(page).filter({ hasText: "b-two" }).click();
  await paneOf(page, shells.b2).getByRole("textbox").focus();

  // The terminal's own listener sees the key after the page's capture listener has had it: `prevented` is whether the
  // app took it, and a key taken that way never reaches this listener at all.
  await page.evaluate(() => {
    const field = document.querySelector('[data-focused="true"] [data-terminal] textarea');
    Reflect.set(window, "spaceKeySeen", null);
    field?.addEventListener("keydown", (event: Event) => {
      const press = event as KeyboardEvent;
      Reflect.set(window, "spaceKeySeen", {
        ctrl: press.ctrlKey,
        key: press.key,
        prevented: press.defaultPrevented,
      });
    });
  });
  await page.keyboard.press("Control+1");
  expect(await page.evaluate(() => Reflect.get(window, "spaceKeySeen"))).toEqual({
    ctrl: true,
    key: "1",
    prevented: false,
  });
  await expect(selected(page)).toHaveText(/b-two/);
  await expect(tabBar(page)).toHaveText([/b-one/, /b-two/]);
});

test("4: Settings lists the space keys with the keys that run them, and says a terminal keeps the number chord", async ({
  page,
}) => {
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
    : { select: "Ctrl2", next: "CtrlAlt]", previous: "CtrlAlt[", ninth: "Ctrl9" };

  await expect(row("space.select:2")).toContainText("Go to space 2");
  await expect(row("space.select:2")).toContainText(chips.select);
  await expect(row("space.select:9")).toContainText("Go to space 9");
  await expect(row("space.select:9")).toContainText(chips.ninth);
  await expect(row("space.next")).toContainText("Next space");
  await expect(row("space.next")).toContainText(chips.next);
  await expect(row("space.prev")).toContainText("Previous space");
  await expect(row("space.prev")).toContainText(chips.previous);
  await expect(row("space.select:1")).toContainText("A focused terminal program keeps this key");
});

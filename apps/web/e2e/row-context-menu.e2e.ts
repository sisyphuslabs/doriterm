// A sidebar row's right-click (Ctrl+click on macOS, the Menu key elsewhere) opens the row's own menu at the pointer,
// with the items its "..." button holds (#699).
import type { Locator, Page } from "@playwright/test";
import { agentRow, endAgent, startAgent } from "./agents.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { commandModifier, pressShortcut, pressWithCommand } from "./platform-keys.ts";
import { hcOn } from "./machine-switch.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
const agents = (page: Page) => sidebar(page).getByRole("region", { name: "Agents", exact: true });
const spaceRow = (page: Page, name: string) =>
  sidebar(page).getByRole("button", { name: new RegExp(`^${name}(?: |$)`) });
const menu = (page: Page) => page.getByRole("menu");

const started: string[] = [];
// Each test ends what it started before the next one runs: a spec ends what it opens (#226).
test.afterEach(() => {
  for (const address of started.splice(0)) endAgent("host", address);
});

/** An idle agent in its own space, named after the test's repeat so a rerun never meets an earlier one. */
function idleAgent(name: string): string {
  const unique = `${name}-${test.info().repeatEachIndex}`;
  started.push(startAgent("host", unique, "idle", `sp-${unique}`));
  return unique;
}

/** The name a rename leaves in hc (the herdr.name label): what every client reads. */
function nameInHc(address: string): unknown {
  const got: unknown = JSON.parse(hcOn("host", ["get", address, "--json"]));
  const labels = typeof got === "object" && got !== null ? Reflect.get(got, "labels") : undefined;
  return typeof labels === "object" && labels !== null ? Reflect.get(labels, "herdr.name") : undefined;
}

test("right-clicking an agent row opens its menu, and a name typed at once into Rename… is kept", async ({ page }) => {
  const name = idleAgent("cm699-rename");
  await page.goto("/");
  const row = agentRow(agents(page), name, false);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Pin to top", "Rename…", "End session…"]);
  await menu(page).getByRole("menuitem", { name: "Rename…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Rename / });
  await expect(dialog).toBeVisible();
  // Typed before the menu's close finishes: the dialog keeps the keyboard, as the tab's menu leaves it (#590).
  await pressWithCommand(page, `${await commandModifier(page)}+a`, "selectAll");
  await page.keyboard.type(`${name}-renamed`);
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(agentRow(agents(page), `${name}-renamed`, false)).toBeVisible();
  const address = started.at(-1) ?? "";
  await expect.poll(() => nameInHc(address)).toBe(`${name}-renamed`);
});

test("Escape closes an agent row's menu and gives the keyboard back to the row", async ({ page }) => {
  const name = idleAgent("cm699-escape");
  await page.goto("/");
  const row = agentRow(agents(page), name, false);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(row).toBeFocused();
});

test("Shift+F10 and the Menu key open the same menu once, on every platform", async ({ page }) => {
  const name = idleAgent("cm699-keys");
  await page.goto("/");
  const row = agentRow(agents(page), name, false);
  await expect(row).toBeVisible({ timeout: 20_000 });
  const opensOnce = async (keys: string): Promise<void> => {
    await row.focus();
    await page.keyboard.press(keys);
    await expect(menu(page)).toHaveCount(1);
    await expect(menu(page).getByRole("menuitem", { name: "Rename…" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
  };
  await opensOnce("Shift+F10");
  await opensOnce("ContextMenu");
});

test("Ctrl+click opens the menu on macOS, where Blink makes it a right-click", async ({ page }) => {
  test.skip(process.platform !== "darwin", "Blink turns a Ctrl+click into the context menu on macOS only");
  const name = idleAgent("cm699-ctrl");
  await page.goto("/");
  const row = agentRow(agents(page), name, false);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ modifiers: ["Control"] });
  await expect(menu(page).getByRole("menuitem", { name: "Rename…" })).toBeVisible();
});

/** Narrows the sidebar to its icon rail, as Enter on its edge does. */
async function toRail(page: Page): Promise<void> {
  await page.getByRole("separator", { name: "Resize sidebar" }).focus();
  await page.keyboard.press("Enter");
  await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
}

test("on the icon rail, right-clicking an agent opens the same menu, and Rename… asks for the name", async ({
  page,
}) => {
  const name = idleAgent("cm-rail-agent");
  await page.goto("/");
  await expect(agentRow(agents(page), name, false)).toBeVisible({ timeout: 20_000 });
  await toRail(page);
  // The rail draws the status glyph alone; the agent's name is its label.
  const glyph = agentRow(agents(page), name, false);
  await expect(glyph).toBeVisible();
  await glyph.click({ button: "right" });
  await expect(menu(page).getByRole("menuitem")).toHaveText(["Pin to top", "Rename…", "End session…"]);
  await menu(page).getByRole("menuitem", { name: "Rename…" }).click();
  await expect(page.getByRole("dialog", { name: /^Rename / })).toBeVisible();
});

test("on the icon rail, right-clicking a space opens its menu, and Rename space… asks for the new name", async ({
  page,
}) => {
  const name = idleAgent("cm-rail-space");
  await page.goto("/");
  await expect(spaceRow(page, `sp-${name}`)).toBeVisible({ timeout: 20_000 });
  await toRail(page);
  const avatar = spaceRow(page, `sp-${name}`);
  await expect(avatar).toBeVisible();
  await avatar.click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Rename space…" })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Close space…" })).toBeVisible();
  await menu(page).getByRole("menuitem", { name: "Rename space…" }).click();
  await expect(page.getByRole("dialog", { name: new RegExp(`sp-${name}`) })).toBeVisible();
});

/** Splits a fresh tab in two, hands `body` the first pane's header, then closes that tab's shells (#226). */
async function inSplit(page: Page, body: (header: Locator) => Promise<void>): Promise<void> {
  await page.goto("/");
  // A second tab, so closing the split's tab at the end never closes its space (which asks first).
  await openNewTerminal(page);
  const first = await openNewTerminal(page);
  const before = await page.locator("[data-terminal]").count();
  await first.getByRole("textbox").focus();
  await page.getByRole("button", { name: "Split right" }).first().click();
  const panes = page.locator('[role="tabpanel"]:not([hidden]) section[data-split="true"]');
  await expect(panes).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("[data-terminal]")).toHaveCount(before + 1);
  await body(panes.first().locator("header"));
  // The split's shells are this test's own: close the tab so the worker's core keeps no terminal it opened (#226).
  await first.getByRole("textbox").focus();
  await pressShortcut(page, "tab.close");
  await expect(page.locator("[data-terminal]")).toHaveCount(before - 1, { timeout: 15_000 });
}

test("right-clicking a split pane's header opens its session menu, and Rename… asks for the name", async ({ page }) => {
  await inSplit(page, async (header) => {
    await header.getByRole("heading").click({ button: "right" });
    await expect(menu(page).getByRole("menuitem")).toHaveText(["Rename…", "End session…"]);
    await menu(page).getByRole("menuitem", { name: "Rename…" }).click();
    await expect(page.getByRole("dialog", { name: /^Rename / })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test("a held touch's contextmenu on a split pane's header stays its drag: no menu", async ({ page }) => {
  await inSplit(page, async (header) => {
    // Android Chrome sends a held touch as a contextmenu whose pointerType is touch; a menu opening on it would take
    // the press from the pane's drag. Each press is counted two frames after it, a point the mouse's press proves the
    // menu has reached by then, so the touch's zero is not read before a menu could appear.
    const menusAfter = (pointerType: string) =>
      header.getByRole("heading").evaluate(async (element, type) => {
        const box = element.getBoundingClientRect();
        const press = {
          bubbles: true,
          cancelable: true,
          pointerType: type,
          clientX: box.left + 4,
          clientY: box.top + 4,
        };
        element.dispatchEvent(new PointerEvent("contextmenu", press));
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return document.querySelectorAll('[role="menu"]').length;
      }, pointerType);
    expect(await menusAfter("touch"), "a touch's contextmenu opened the header's menu").toBe(0);
    expect(await menusAfter("mouse"), "the mouse's contextmenu had not opened the menu by the same point").toBe(1);
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
  });
});

test("right-clicking a space row opens its menu, and Rename space… there asks for the new name", async ({ page }) => {
  const name = idleAgent("cm699-space");
  await page.goto("/");
  const row = spaceRow(page, `sp-${name}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Rename space…" })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Close space…" })).toBeVisible();
  await menu(page).getByRole("menuitem", { name: "Rename space…" }).click();
  await expect(page.getByRole("dialog", { name: new RegExp(`sp-${name}`) })).toBeVisible();
});

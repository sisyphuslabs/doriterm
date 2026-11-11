import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ serviceWorkers: "block" });

/**
 * What a browser's page translator does to a page that does not opt out: Chrome replaces each text node with a <font>
 * holding the translation, and Whale's Papago translation rewrites the same nodes. The words are kept here, because what
 * breaks React is the node being moved out of its parent, not the translation itself.
 *
 * A translator that follows the opt-out leaves the page alone: Chromium's documented stop is the google notranslate
 * meta, and the HTML translate attribute says the same. Returns how many text nodes it wrapped.
 */
async function translate(page: Page): Promise<number> {
  return page.evaluate(() => {
    const optedOut =
      document.documentElement.getAttribute("translate") === "no" ||
      document.querySelector('meta[name="google"][content="notranslate"]') !== null;
    if (optedOut) return 0;
    const root = document.getElementById("root");
    if (root === null) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text) || !/\S/.test(node.nodeValue ?? "")) continue;
      // A terminal draws its own DOM, which React does not render: a translator wrapping it is wterm's business.
      if (node.parentElement?.closest(".wterm") !== null) continue;
      nodes.push(node);
    }
    for (const node of nodes) {
      const parent = node.parentNode;
      if (parent === null) continue;
      const font = document.createElement("font");
      font.setAttribute("translate", "yes");
      parent.replaceChild(font, node);
      font.appendChild(node);
    }
    return nodes.length;
  });
}

const keybindings = async (page: Page): Promise<void> => {
  await page.goto("/settings");
  await page
    .getByRole("tab", { name: "Keybindings" })
    .or(page.getByRole("button", { name: "Keybindings" }))
    .first()
    .click();
};

/** The Command palette row in Settings > Keybindings. */
const paletteRow = (page: Page) => page.locator('[id="keybinding-app.palette"]').locator("xpath=../..");

/**
 * The status bar's Commands button. Settings is a dialog over a mounted workspace here, and the workspace under it is
 * hidden from assistive tech, so the button is found in the DOM rather than by role.
 */
const commands = (page: Page) => page.locator("footer button", { hasText: "Commands" });

test("the document asks browser translators to leave its text alone (#1157)", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("translate", "no");
  await expect(page.locator('meta[name="google"]')).toHaveAttribute("content", "notranslate");
});

test("a translated page still has a React tree a rebind can insert into (#1157)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`));
  const crash = page.getByRole("alert").filter({ hasText: "Doriterm stopped drawing" });

  // Settings is a dialog over the live workspace at this width, so the status bar stays mounted while a shortcut is
  // unbound and bound again.
  await keybindings(page);
  const row = paletteRow(page);
  const remove = row.getByRole("button", { name: /^Remove .* from Command palette$/ });
  // oxlint-disable-next-line no-await-in-loop -- each removal changes the row the next click lands in
  while ((await remove.count()) > 0) await remove.first().click();
  // Unbound: the status bar's button is a bare "Commands" text node, the anchor React must insert a shortcut before.
  await expect(commands(page)).toHaveText("Commands");

  // A translator that honours the opt-out changes nothing. One that ignores it wraps "Commands" in <font>.
  await translate(page);

  // Binding a shortcut inserts a <kbd> before that text node. A wrapper took the node out of the button, and React's
  // insertBefore throws NotFoundError: Failed to execute 'insertBefore' on 'Node'. That is #1157's crash.
  await row.getByRole("button", { name: "Record a shortcut for Command palette" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Press keys…" })).toBeFocused();
  await page.keyboard.press("Control+Alt+P");
  // The rebind is one commit: the shortcut appears, or the app's crash screen does. Wait for whichever happened, so a
  // crash is reported as a crash rather than as a missing "Changed".
  await expect
    .poll(
      async () =>
        (await crash.count()) > 0 ? "crashed" : (await commands(page).locator("kbd").count()) > 0 ? "bound" : "waiting",
      { timeout: 10_000 },
    )
    .not.toBe("waiting");
  await expect(crash).toHaveCount(0);
  await expect(row.getByText("Changed")).toBeVisible();
  await expect(commands(page).locator("kbd")).toHaveCount(1);
  expect(errors).toEqual([]);

  // The window still answers: the new shortcut opens the palette over the workspace.
  await page.getByRole("button", { name: "Close settings" }).first().click();
  await page.keyboard.press("Control+Alt+P");
  await expect(page.getByRole("dialog")).toBeVisible();
});

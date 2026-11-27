// A tab's menu hands the keyboard to the question its item opened, and never takes it back: #590's own case lives in
// tabs-parity.e2e.ts beside the rename it broke, and this one holds the ordering that case cannot: the question's first
// paint landing after the menu's exit, as a loaded host produces.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });

endOwnTerminals();

const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const spaceRow = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** A plain shell started straight on the core in `cwd`, named, so its tab reads that name. */
function shellIn(cwd: string, name: string): string {
  const out = hcOn("host", ["run", "--bg", "--name", name, "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  return String((JSON.parse(out) as { address: string }).address);
}

/** One space of two tabs, each one shell started in the space's folder. */
function oneSpace(): void {
  const folder = mkdtempSync(join(tmpdir(), "tab-rename-menu-"));
  const first = shellIn(folder, "menu-a1");
  const second = shellIn(folder, "menu-a2");
  seedSpaces([
    {
      id: "spc-menu",
      name: "alpha",
      folder,
      tabs: [
        { id: "tb-m1", name: "a-one", terminal: first },
        { id: "tb-m2", name: "a-two", terminal: second },
      ],
    },
  ]);
}

test("a tab's menu hands the keyboard to the question its item opened, and never back to the strip", async ({
  page,
}) => {
  // The question's first paint can land after the menu's exit, as on a loaded host: until it takes the keyboard, focus
  // must not be handed back to the strip, where a key pressed meanwhile reaches a tab instead of the name.
  await page.addInitScript(() => {
    const held = { on: true };
    Reflect.set(window, "releaseQuestion", () => {
      held.on = false;
    });
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions): void {
      if (held.on && this.closest('[role="dialog"]') !== null) return;
      focus.call(this, options);
    };
  });
  oneSpace();
  await page.goto("/");
  await spaceRow(page, "alpha").click();
  await expect(tabBar(page)).toHaveText([/a-one/, /a-two/], { timeout: 20_000 });

  await tabBar(page).filter({ hasText: "a-one" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename tab…" }).click();
  const question = page.getByRole("dialog", { name: "Rename a-one" });
  const field = question.getByRole("textbox", { name: "Name" });
  await expect(field).toHaveValue("a-one");
  await expect(page.getByRole("menu")).toHaveCount(0);
  // The menu's hand-off runs with the commit that removes it; two frames put that behind this check. Asked of the
  // document rather than the strip, which a modal question hides from role locators.
  await page.evaluate(() => new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled))));
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-tab-id]") !== null)).toBe(false);

  // Once it has the keyboard, the question renames as any other: an empty name gives the tab its number back.
  await page.evaluate(() => {
    const release = Reflect.get(window, "releaseQuestion");
    if (typeof release === "function") Reflect.apply(release, window, []);
  });
  await field.fill("");
  await question.getByRole("button", { name: "Rename" }).click();
  await expect(tabBar(page)).toHaveText(["1", /a-two/], { timeout: 15_000 });
});

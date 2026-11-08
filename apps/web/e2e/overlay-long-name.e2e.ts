// Every overlay that shows a session's name keeps it inside the viewport, however long and unbroken the name (#152):
// the tooltip, the menus, the dialogs and the statement that a session already ended, on a phone and on a desktop.
import type { Locator, Page } from "@playwright/test";
import { agentRow, endAgent, startShell } from "./agents.ts";
import { setConfirmClose } from "./close-confirm.ts";
import { expect, test } from "./fixtures.ts";
import { hcOn } from "./machine-switch.ts";
import { fakeSoftKeyboard, key, PHONE } from "./phone-key-bar.ts";

/** 200 characters with no break opportunity: no space, hyphen or punctuation. */
const LONG = `unbroken${"x".repeat(192)}`;

/**
 * The overlay's box is inside the viewport, and so is every line of text in it, which also stays inside the box: a
 * text that cannot wrap overflows its box without moving the box itself.
 */
async function expectInside(overlay: Locator, what: string): Promise<void> {
  await expect(overlay, what).toBeVisible();
  const outside = await overlay.evaluate((element) => {
    const right = document.documentElement.clientWidth;
    const bottom = window.innerHeight;
    const box = element.getBoundingClientRect();
    const found: string[] = [];
    const rects: { readonly text: string | null; readonly rect: DOMRect }[] = [{ text: null, rect: box }];
    const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = texts.nextNode(); node !== null; node = texts.nextNode()) {
      const text = node.textContent ?? "";
      if (text.trim() === "") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) rects.push({ text, rect });
    }
    // A box that scrolls keeps lines above and below its fold; they still have to fit its width.
    const scrolls = element.scrollHeight > element.clientHeight + 1;
    for (const { text, rect } of rects) {
      // Inside the viewport, and a text also inside the overlay's box (1 px of rounding either way).
      const vertical = text === null || !scrolls;
      const inView =
        rect.left >= -1 && rect.right <= right + 1 && (!vertical || (rect.top >= -1 && rect.bottom <= bottom + 1));
      const inBox =
        text === null ||
        (rect.left >= box.left - 1 &&
          rect.right <= box.right + 1 &&
          (!vertical || (rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1)));
      if (inView && inBox) continue;
      const at = `${Math.round(rect.left)}..${Math.round(rect.right)} x ${Math.round(rect.top)}..${Math.round(rect.bottom)}`;
      found.push(
        text === null
          ? `box at ${at} in a ${right}x${bottom} viewport`
          : `"${text.slice(0, 24)}…" at ${at}, box ${Math.round(box.left)}..${Math.round(box.right)}`,
      );
    }
    return found;
  });
  // Soft, so one run names every overlay that overflows, not only the first.
  expect.soft(outside, what).toEqual([]);
}

/** The open tooltip whose whole text is `label`; the button it describes carries the label only as its name. */
const tooltip = (page: Page, label: string) => page.getByText(label, { exact: true });

let address = "";
let ended = false;
test.beforeEach(() => {
  // hc names stop at 32 characters; the name a rename sets (the herdr.name label) is what every overlay shows.
  address = startShell("host", "overlay-long-name");
  hcOn("host", ["label", address, `herdr.name=${LONG}`]);
  ended = false;
});
test.afterEach(() => {
  if (!ended) endAgent("host", address);
});

for (const width of [320, 390] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`on a ${width} px phone, ${colorScheme}`, () => {
      test.use({ ...PHONE, viewport: { width, height: 844 }, colorScheme, serviceWorkers: "block" });

      test("the tooltip, both menus, the dialogs and the ended statement keep a 200-character name inside", async ({
        page,
      }) => {
        await fakeSoftKeyboard(page);
        await page.goto("/");
        await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
        await agentRow(page, LONG, false).click({ timeout: 20_000 });
        const header = page.getByRole("banner");
        // The heading reads the tab (its number, #466 ruling A); the session actions carry the name.
        const actions = header.getByRole("button", { name: `Session actions for ${LONG}` });
        await expect(actions).toBeVisible({ timeout: 15_000 });

        await actions.hover();
        await expectInside(tooltip(page, `Session actions for ${LONG}`), "the session actions tooltip");

        await expect(page.getByRole("toolbar", { name: "Terminal keys" })).toBeVisible({ timeout: 15_000 });
        await key(page, "Switch session").click();
        const sessions = page.getByRole("menu");
        await expect(sessions.getByRole("menuitem", { name: new RegExp(LONG) })).toBeVisible();
        await expectInside(sessions, "the Switch session menu");
        await page.keyboard.press("Escape");
        await expect(sessions).toBeHidden();

        await actions.click();
        await page.getByRole("button", { name: "Rename…", exact: true }).click();
        const rename = page.getByRole("dialog", { name: `Rename ${LONG}` });
        await expectInside(rename, "the Rename dialog");
        await rename.getByRole("button", { name: "Cancel" }).click();
        await expect(rename).toBeHidden();

        await actions.click();
        await page.getByRole("button", { name: "End session…", exact: true }).click();
        await expectInside(page.getByRole("dialog", { name: `End ${LONG}?` }), "the End dialog");

        // The session ends while its question is open: the question becomes the statement that it already ended.
        endAgent("host", address);
        ended = true;
        const statement = page.getByRole("alertdialog", { name: `${LONG} already ended` });
        await expectInside(statement, "the already ended statement");
        await statement.getByRole("button", { name: "OK" }).click();
      });
    });
  }
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`on a short 320x360 phone, ${colorScheme}`, () => {
    test.use({ ...PHONE, viewport: { width: 320, height: 360 }, colorScheme, serviceWorkers: "block" });

    test("a question taller than the screen opens at its title, scrolls inside, sits above the keys, and End works", async ({
      page,
    }) => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
      await agentRow(page, LONG, false).click({ timeout: 20_000 });
      const header = page.getByRole("banner");
      await expect(header.getByRole("button", { name: `Session actions for ${LONG}` })).toBeVisible({
        timeout: 15_000,
      });
      const keyboard = page.getByRole("button", { name: "Show keyboard" });
      await expect(keyboard).toBeVisible({ timeout: 15_000 });
      const button = await keyboard.boundingBox();
      expect(button, "the Show keyboard button has a box").not.toBeNull();

      await header.getByRole("button", { name: `Session actions for ${LONG}` }).click();
      await page.getByRole("button", { name: "End session…", exact: true }).click();
      const ask = page.getByRole("dialog", { name: `End ${LONG}?` });
      await expectInside(ask, "the End dialog on a short screen");
      expect(
        await ask.evaluate((element) => element.scrollHeight > element.clientHeight),
        "the question is taller than the screen, so the dialog scrolls inside",
      ).toBe(true);

      // It opens at its title: focus is on the dialog itself, not on a button below the fold that scrolls it there.
      await expect(ask).toBeFocused();
      expect(await ask.evaluate((element) => element.scrollTop), "the dialog's scroll position as it opens").toBe(0);
      const title = await ask.getByText(`End ${LONG}?`).boundingBox();
      const box = await ask.boundingBox();
      expect(title !== null && box !== null && title.y >= box.y, "the title starts inside the dialog").toBe(true);

      // The keys' button stays under the modal layer: the point at its centre belongs to the dialog or its backdrop.
      const centre = {
        x: (button?.x ?? 0) + (button?.width ?? 0) / 2,
        y: (button?.y ?? 0) + (button?.height ?? 0) / 2,
      };
      const onTop = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.closest("[aria-label='Show keyboard']") !== null,
        centre,
      );
      expect(onTop, "the Show keyboard button is drawn above the open dialog").toBe(false);

      const end = ask.getByRole("button", { name: "End session" });
      await end.scrollIntoViewIfNeeded();
      await expectInside(end, "End session, scrolled into view");
      await end.click();
      ended = true;
      await expect(ask).toBeHidden({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 15_000 });
      await expect(agentRow(page, LONG, false)).toHaveCount(0, { timeout: 15_000 });
    });
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`on a 1440 px desktop, ${colorScheme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, colorScheme, serviceWorkers: "block" });

    // A tab reads its number, as herdr-app's, so its close button's tooltip names no session; the Close dialog does.
    test("the Close dialog keeps a 200-character name inside", async ({ page }) => {
      // A second shell in the same space, so closing the long-named tab is not the space's last (that asks Close space?).
      const partner = startShell("host", "overlay-partner");
      try {
        await setConfirmClose(page, "always");
        await agentRow(page, LONG, false).click({ timeout: 20_000 });
        await expect(page.locator(`[data-focused="true"] [data-terminal="${address}"]`)).toBeVisible({
          timeout: 15_000,
        });
        await expect(page.getByRole("tablist", { name: "Tabs" }).getByRole("tab")).toHaveCount(2, { timeout: 15_000 });
        await page
          .getByRole("tab", { selected: true })
          .locator("xpath=..")
          .getByRole("button", { name: /^Close / })
          .click();
        const ask = page.getByRole("dialog", { name: `Close ${LONG}?` });
        await expectInside(ask, "the Close dialog");
        await ask.getByRole("button", { name: "Cancel" }).click();
        await expect(ask).toBeHidden();
      } finally {
        endAgent("host", partner);
      }
    });
  });
}

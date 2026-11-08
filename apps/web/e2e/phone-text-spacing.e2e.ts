import { devices, type Page } from "@playwright/test";
import { expect, laidOutBox, test } from "./fixtures.ts";

const { defaultBrowserType: _browser, ...phone } = devices["iPhone 14"];
// The service worker reloads the page once it takes control; only pwa.e2e.ts tests it.
test.use({ ...phone, serviceWorkers: "block" });

/** WCAG 2.2 SC 1.4.12 Text Spacing: the four overrides a user stylesheet may set, all at once. */
const TEXT_SPACING = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

const header = (page: Page) => page.getByRole("banner");
const ACTION = "Header action";

async function openPhoneTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
  await header(page).getByRole("button", { name: "New tab" }).click();
  await expect(page.locator("[data-terminal]")).toContainText("$", { timeout: 15_000 });
  await expect(header(page).getByRole("button", { name: "Back to agents" })).toBeVisible();
}

/** Fills the header's action slot with one more 44 px header button, as the mic (#227) does: a copy of the session menu's. */
async function giveAction(page: Page): Promise<void> {
  await header(page)
    .locator("[data-header-action]")
    .evaluate((slot, name) => {
      const model = slot.closest("header")?.querySelector('button[aria-label^="Session actions for "]');
      const action = model?.cloneNode(true);
      if (!(action instanceof HTMLElement)) throw new Error("no header button to copy");
      action.setAttribute("aria-label", name);
      slot.append(action);
    }, ACTION);
  await expect(header(page).getByRole("button", { name: ACTION })).toBeVisible();
}

/** The header holds its content and grows for it: at least 48 px, nothing cut, nothing over the terminal. */
async function expectHeaderHolds(page: Page, width: number, withAction: boolean): Promise<void> {
  const bar = header(page);
  await expect(bar.getByRole("heading", { level: 1 })).toBeVisible();
  const box = await laidOutBox(bar);
  const bottom = box.y + box.height;
  expect(box.height).toBeGreaterThanOrEqual(48 - 0.5);

  // Every item of the header ends inside it, and none of its rows spills out of its own box vertically. (The header's
  // own scrollHeight is not compared: the buttons' larger hit areas reach past it by design, and nothing there is cut.)
  const spills = await bar.evaluate((el) => {
    const edge = el.getBoundingClientRect();
    const outside = [...el.children]
      .filter((child) => {
        const rect = child.getBoundingClientRect();
        return rect.height > 0 && (rect.top < edge.top - 0.5 || rect.bottom > edge.bottom + 0.5);
      })
      .map((child) => `${child.tagName.toLowerCase()} outside the header`);
    const spilled = [...el.querySelectorAll("h1, p, div")]
      .filter((node) => node.scrollHeight > node.clientHeight + 1)
      .map((node) => `${node.tagName.toLowerCase()} ${node.scrollHeight}>${node.clientHeight}`);
    return [...outside, ...spilled];
  });
  expect(spills).toEqual([]);

  // Every text row ends inside the header and the screen. (The tab's place, n/m, is the bottom tabs bar's since #466.)
  const parts = [bar.getByRole("heading", { level: 1 }), bar.locator("p")];
  const placed = await Promise.all(parts.map(laidOutBox));
  for (const part of placed) {
    expect(part.y + part.height).toBeLessThanOrEqual(bottom + 0.5);
    expect(part.x + part.width).toBeLessThanOrEqual(width + 0.5);
  }

  // The terminal begins below the header, never under it. It can hold its prompt text before it lays out its first
  // row, so each box is read once laid out.
  const terminal = await laidOutBox(page.locator("[data-terminal]"));
  expect(terminal.y).toBeGreaterThanOrEqual(bottom - 0.5);
  const firstRow = await laidOutBox(page.locator("[data-terminal] .term-row").first());
  expect(firstRow.y).toBeGreaterThanOrEqual(bottom - 0.5);

  // Every button stays a full touch target inside the header and the screen.
  const names = [/^Back to agents$/, /^Session actions for /];
  if (withAction) names.push(new RegExp(`^${ACTION}$`));
  const targets = await Promise.all(names.map((name) => laidOutBox(bar.getByRole("button", { name }))));
  for (const target of targets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
    expect(target.x + target.width).toBeLessThanOrEqual(width + 0.5);
    expect(target.y + target.height).toBeLessThanOrEqual(bottom + 0.5);
  }
}

for (const width of [390, 320]) {
  for (const withAction of [false, true]) {
    test(`at ${width} px${withAction ? " with a header action" : ""} the terminal header grows to hold its rows, with and without 1.4.12 text spacing`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openPhoneTerminal(page);
      if (withAction) await giveAction(page);
      await expectHeaderHolds(page, width, withAction);
      await page.addStyleTag({ content: TEXT_SPACING });
      await expectHeaderHolds(page, width, withAction);
    });
  }
}

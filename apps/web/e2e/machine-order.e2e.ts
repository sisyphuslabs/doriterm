import type { Page } from "@playwright/test";
import { getCoreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { MACHINE_NAME } from "./machine.ts";
import { machineRow } from "./machine-switch.ts";

const ORDER_DOC = "doriface";
const rows = (page: Page) => page.locator("[data-machine-row]");
const rowOf = (page: Page, name: string) =>
  page.locator("[data-machine-row]", { has: page.getByRole("button", { name: new RegExp(`^${name}\\b`) }) });
const status = (page: Page) =>
  page.getByRole("heading", { name: "Machines" }).locator("xpath=ancestor::section").getByRole("status");

const order = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((el) => el.querySelector("span[title]")?.getAttribute("title")));

async function openWorkspace(page: Page): Promise<string> {
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 30_000 });
  const local = await rows(page).first().locator("span[title]").getAttribute("title");
  if (local === null) throw new Error("no local machine row");
  await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
  return local;
}

/** Presses a row and moves it by `dy` in small steps, as a hand would; `drop` lets go. */
async function dragRow(page: Page, name: string, dy: number, drop = true): Promise<void> {
  const box = await rowOf(page, name).boundingBox();
  if (box === null) throw new Error(`no box for ${name}`);
  const x = box.x + box.width / 3;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + Math.sign(dy) * 6, { steps: 2 });
  await expect(rowOf(page, name)).toHaveAttribute("data-dragging", "");
  await page.mouse.move(x, y + dy, { steps: 8 });
  if (drop) await page.mouse.up();
}

test.use({ serviceWorkers: "block" });
test.beforeEach(() => setCoreDoc(ORDER_DOC, null));

test.describe("machine order", () => {
  test("a row dragged above another lands there, is announced, and keeps its place after a reload", async ({
    page,
  }) => {
    const local = await openWorkspace(page);
    const height = (await rowOf(page, MACHINE_NAME).boundingBox())?.height ?? 28;
    await dragRow(page, MACHINE_NAME, -height);
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    await expect(status(page)).toHaveText(new RegExp(`^Moved ${MACHINE_NAME} to position 1 of 2`));
    await expect(rows(page).locator("[data-dragging]")).toHaveCount(0);
    await expect.poll(() => getCoreDoc(ORDER_DOC)).toMatchObject({ machine_order: expect.any(Array) });
    await page.reload();
    await expect(machineRow(page)).toContainText("connected", { timeout: 30_000 });
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
  });

  test("a drag that Escape cancels leaves the order as it was and writes nothing", async ({ page }) => {
    const local = await openWorkspace(page);
    await dragRow(page, MACHINE_NAME, -40, false);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(rows(page).locator("[data-dragging]")).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    expect(getCoreDoc(ORDER_DOC)).toBeNull();
  });

  test("the move keys move the focused row, focus stays on it, and the order survives a reload", async ({ page }) => {
    const local = await openWorkspace(page);
    const mac = await page.evaluate(() => /mac/i.test(navigator.platform));
    const [up, down] = mac
      ? ["Meta+Shift+ArrowUp", "Meta+Shift+ArrowDown"]
      : ["Control+Shift+PageUp", "Control+Shift+PageDown"];
    const button = machineRow(page);
    await button.focus();
    await page.keyboard.press(up);
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    await expect(button).toBeFocused();
    await expect(status(page)).toHaveText(new RegExp(`^Moved ${MACHINE_NAME} to position 1 of 2`));
    await page.keyboard.press(down);
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await expect(button).toBeFocused();
    await page.keyboard.press(up);
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    await page.reload();
    await expect(machineRow(page)).toContainText("connected", { timeout: 30_000 });
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
  });

  test("the row menu moves a machine down and up, and offers no move past either end", async ({ page }) => {
    const local = await openWorkspace(page);
    await rowOf(page, local).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Move down" }).click();
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    await rowOf(page, local).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
  });

  test("an order another client writes reaches the open page live, and never pulls focus back to a moved row", async ({
    page,
  }) => {
    const local = await openWorkspace(page);
    await rowOf(page, local).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move down" }).click();
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    const written = getCoreDoc(ORDER_DOC);
    if (typeof written !== "object" || written === null || !("machine_order" in written)) throw new Error("no order");
    const ids = written.machine_order;
    if (!Array.isArray(ids)) throw new Error("not a list");
    const elsewhere = page.getByRole("button", { name: "Add a machine" });
    await elsewhere.focus();
    setCoreDoc(ORDER_DOC, { machine_order: ids.toReversed(), kept: { by: "another client" } });
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await expect(elsewhere).toBeFocused();
  });
});

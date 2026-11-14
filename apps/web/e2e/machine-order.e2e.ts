import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { E2E_HOST_ENV } from "./config.ts";
import { getCoreDoc, setCoreDoc } from "./core-doc.ts";
import { expect, openNewTerminal, test } from "./fixtures.ts";
import { pressShortcut, shortcut } from "./platform-keys.ts";
import { MACHINE_NAME, viaCommand } from "./machine.ts";
import { hcOn, machineRow } from "./machine-switch.ts";
import { readSavedEnv } from "./saved-env.ts";
import { domOrder, selectedIndex, tabs } from "./tab-strip.ts";

const ORDER_DOC = "doriface";
// Each machine heads its own spaces: its header row is the handle, and the whole group (header and spaces) moves.
const rows = (page: Page) => page.locator("[data-machine-row]");
const rowOf = (page: Page, name: string) =>
  page.locator("[data-machine-row]", { has: page.getByRole("button", { name: new RegExp(`^${name}\\b`) }) });
const groupOf = (page: Page, name: string) => page.locator("[data-drag-id]", { has: rowOf(page, name) });
const status = (page: Page) =>
  page.getByRole("heading", { name: "Spaces" }).locator("xpath=ancestor::section").getByRole("status");

const order = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((el) => el.querySelector("span[title]")?.getAttribute("title")));

/** Opens the workspace and returns this core's name: by name, the added machine (`build-box`) is listed above it (#2531). */
async function openWorkspace(page: Page): Promise<string> {
  await page.goto("/");
  await expect(machineRow(page)).toContainText("connected", { timeout: 30_000 });
  const local = await rows(page).nth(1).locator("span[title]").getAttribute("title");
  if (local === null) throw new Error("no local machine row");
  await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
  return local;
}

const rowButton = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(`^${name}\\b`) });

/** How far up `name`'s group must go for its centre to pass `above`'s: a group lands past a neighbour once it does. */
async function pastCentre(page: Page, name: string, above: string): Promise<number> {
  const [moving, other] = [await groupOf(page, name).boundingBox(), await groupOf(page, above).boundingBox()];
  if (moving === null || other === null) throw new Error(`no box for ${name} or ${above}`);
  return other.y + other.height / 2 - (moving.y + moving.height / 2) - 8;
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
  await expect(groupOf(page, name)).toHaveAttribute("data-dragging", "");
  await page.mouse.move(x, y + dy, { steps: 8 });
  if (drop) await page.mouse.up();
}

test.use({ serviceWorkers: "block" });
/** The order is kept on both cores (#2531), shared by every spec on this worker: none is left for the next one. */
function clearOrders(): void {
  setCoreDoc(ORDER_DOC, null);
  setCoreDoc(ORDER_DOC, null, undefined, "machine");
}
test.beforeEach(clearOrders);
test.afterEach(clearOrders);

test.describe("machine order", () => {
  test("a row dragged above another lands there, is announced, and keeps its place after a reload", async ({
    page,
  }) => {
    const local = await openWorkspace(page);
    await dragRow(page, local, await pastCentre(page, local, MACHINE_NAME));
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await expect(status(page)).toHaveText(new RegExp(`^Moved ${local} to position 1 of 2`));
    await expect(page.locator("[data-drag-id][data-dragging]")).toHaveCount(0);
    await expect.poll(() => getCoreDoc(ORDER_DOC)).toMatchObject({ machine_order: expect.any(Array) });
    await page.reload();
    await expect(rowButton(page, local)).toContainText("connected", { timeout: 30_000 });
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
  });

  test("under reduced motion the neighbours stay put and the landing line is drawn over the lifted row", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const local = await openWorkspace(page);
    const before = await rowOf(page, MACHINE_NAME).boundingBox();
    await dragRow(page, local, await pastCentre(page, local, MACHINE_NAME), false);
    const caret = page.locator("[data-row-drop-caret]");
    await expect(caret).toBeVisible();
    expect(await rowOf(page, MACHINE_NAME).boundingBox()).toEqual(before);
    // The row is lifted past the top of the list, over the line: the line must still be the topmost thing there.
    // Hit testing follows paint order but skips `pointer-events: none`, so the line takes hits only for this probe.
    const topmost = await caret.evaluate((line) => {
      const box = line.getBoundingClientRect();
      line.style.pointerEvents = "auto";
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      line.style.pointerEvents = "";
      return hit === line;
    });
    expect(topmost).toBe(true);
    await page.mouse.up();
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
  });

  test("a drag that Escape cancels leaves the order as it was and writes nothing", async ({ page }) => {
    const local = await openWorkspace(page);
    await dragRow(page, local, -40, false);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(page.locator("[data-drag-id][data-dragging]")).toHaveCount(0);
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    expect(getCoreDoc(ORDER_DOC)).toBeNull();
  });

  test("the move keys move the focused row, focus stays on it, and the order survives a reload", async ({ page }) => {
    const local = await openWorkspace(page);
    const [up, down] = await moveKeys(page);
    const button = rowButton(page, local);
    await button.focus();
    await page.keyboard.press(up);
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await expect(button).toBeFocused();
    await expect(status(page)).toHaveText(new RegExp(`^Moved ${local} to position 1 of 2`));
    await page.keyboard.press(down);
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    await expect(button).toBeFocused();
    await page.keyboard.press(up);
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await page.reload();
    await expect(rowButton(page, local)).toContainText("connected", { timeout: 30_000 });
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
  });

  test("with tabs that could move, the move keys on a focused row move the machine, never a tab", async ({ page }) => {
    const local = await openWorkspace(page);
    // The newest tab is selected and sits last, so the tab strip's own move-left would take the key if it could.
    await openNewTerminal(page);
    if ((await tabs(page).count()) < 2) await openNewTerminal(page);
    expect(await selectedIndex(page)).toBeGreaterThan(0);
    const strip = await domOrder(page);
    const button = rowButton(page, local);
    await button.focus();
    await pressShortcut(page, "tab.move:left");
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await expect(button).toBeFocused();
    expect(await domOrder(page)).toEqual(strip);
  });

  test("the row menu moves a machine down and up, and offers no move past either end", async ({ page }) => {
    const local = await openWorkspace(page);
    await rowOf(page, MACHINE_NAME).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Move down" }).click();
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await rowOf(page, MACHINE_NAME).click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Move down" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
  });

  test("an order another client writes reaches the open page live, and never pulls focus back to a moved row", async ({
    page,
  }) => {
    const local = await openWorkspace(page);
    await rowOf(page, MACHINE_NAME).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move down" }).click();
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    // A closing menu hands focus back to its row once its exit ends; focus is moved away only after that.
    await expect(page.getByRole("menu")).toHaveCount(0);
    const written = getCoreDoc(ORDER_DOC);
    if (typeof written !== "object" || written === null || !("machine_order" in written)) throw new Error("no order");
    const ids = written.machine_order;
    if (!Array.isArray(ids)) throw new Error("not a list");
    const elsewhere = page.getByRole("button", { name: "Add machine" });
    await elsewhere.focus();
    await expect(elsewhere).toBeFocused();
    setCoreDoc(ORDER_DOC, { ...anotherClientsOrder(ids.toReversed()), kept: { by: "another client" } });
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    await expect(elsewhere).toBeFocused();
  });
});

/** The chords that move a focused row up and down on the page's platform: the tab move keys (#123). */
async function moveKeys(page: Page): Promise<readonly [string, string]> {
  return [await shortcut(page, "tab.move:left"), await shortcut(page, "tab.move:right")];
}

/**
 * An order another client writes on top of the one this page wrote: stamped one write later, as every client of the
 * shared order stamps its writes (#2531), so it is the newest copy whichever core holds it.
 */
function anotherClientsOrder(ids: readonly string[]): Record<string, unknown> {
  const written = getCoreDoc(ORDER_DOC);
  const stamp = typeof written === "object" && written !== null ? Reflect.get(written, "order_stamp") : undefined;
  const n = typeof stamp === "object" && stamp !== null ? Number(Reflect.get(stamp, "n")) : 0;
  return { machine_order: [...ids], order_stamp: { n: n + 1, at: Date.now(), by: "another client", order: [...ids] } };
}

/** The ids the order document holds, after a move this page made. */
function writtenOrder(): readonly string[] {
  const written = getCoreDoc(ORDER_DOC);
  if (typeof written !== "object" || written === null || !("machine_order" in written)) throw new Error("no order");
  const ids = written.machine_order;
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) throw new Error("not a list");
  return ids;
}

test.describe("machine order follow-ups (#205, #161)", () => {
  test("a rebound Move tab right moves a focused machine row with the new chord", async ({ page }) => {
    await page.goto("/settings");
    await page
      .getByRole("tab", { name: "Keybindings" })
      .or(page.getByRole("button", { name: "Keybindings" }))
      .first()
      .click();
    await page.getByRole("button", { name: "Record a shortcut for Move tab right" }).click();
    await expect(page.getByRole("status")).toHaveText("Press keys…");
    await page.keyboard.press("Control+Alt+J");
    await expect(page.getByText("Changed")).toBeVisible();
    const local = await openWorkspace(page);
    const button = page.getByRole("button", { name: new RegExp(`^${MACHINE_NAME}\\b`) });
    await button.focus();
    await page.keyboard.press("Control+Alt+J");
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await expect(button).toBeFocused();
  });

  test("the announcement names this person's move, and an order another client writes clears it, never rewords it", async ({
    page,
  }) => {
    const local = await openWorkspace(page);
    const [up] = await moveKeys(page);
    await rowButton(page, local).focus();
    await page.keyboard.press(up);
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
    await expect(status(page)).toHaveText(new RegExp(`^Moved ${local} to position 1 of 2`));
    setCoreDoc(ORDER_DOC, anotherClientsOrder(writtenOrder().toReversed()));
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local]);
    await expect(status(page)).toHaveText("");
  });

  test("a move the order document cannot take says why in the machine order's words, and Retry makes it once it can", async ({
    page,
  }) => {
    setCoreDoc(ORDER_DOC, { machine_order: "not a list" });
    const local = await openWorkspace(page);
    await rowOf(page, MACHINE_NAME).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move down" }).click();
    const toasts = page.getByRole("region", { name: "Notifications" });
    await expect(toasts.getByText("The machine order was not saved")).toBeVisible();
    await expect(
      toasts.getByText("The machine order cannot be changed now: a machine order that is not a list of machine ids."),
    ).toBeVisible();
    await expect(toasts.getByText(/layout/i)).toHaveCount(0);
    expect(await order(page)).toEqual([MACHINE_NAME, local]);
    setCoreDoc(ORDER_DOC, null);
    await toasts.getByRole("button", { name: "Retry" }).click();
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME]);
  });
});

test.describe("machine order with a third machine (#161)", () => {
  const THIRD = "third-box";
  let stop: (() => void) | undefined;
  let root = "";
  // A third core reached the way the host reaches the added machine (machine.ts), through Node: specs do not run in Bun.
  test.beforeEach(() => {
    const { hc, env } = readSavedEnv(E2E_HOST_ENV);
    root = mkdtempSync(join(tmpdir(), "doriface-e2e-third-"));
    const session = `web-e2e-c-${randomUUID().slice(0, 8)}`;
    const own = {
      HC_SESSION: session,
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "run"),
      HC_SOCKET: join(root, "c.sock"),
      PATH: `${dirname(hc)}:${env["PATH"] ?? "/usr/bin:/bin"}`,
    };
    const coreDir = join(own.XDG_STATE_HOME, "herdr-core", session);
    mkdirSync(coreDir, { recursive: true });
    writeFileSync(join(coreDir, "core.json"), JSON.stringify({ id: randomUUID().replace(/-/g, ""), name: "third" }));
    const spec = { name: THIRD, dir: join(root, "switch"), seeds: [] };
    mkdirSync(spec.dir, { recursive: true });
    execFileSync(hc, ["machine", "add", "--via", viaCommand(own, spec), "--name", THIRD], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    stop = () =>
      void execFileSync(hc, ["connect", "--session", session], {
        env: { ...process.env, ...env, ...own },
        input: '{"jsonrpc":"2.0","id":1,"method":"server.stop"}\n',
        stdio: ["pipe", "ignore", "ignore"],
      });
  });
  test.afterEach(() => {
    hcOn("host", ["machine", "rm", THIRD]);
    stop?.();
    stop = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  test("the move keys keep focus on the moved row when it is the one the list re-inserts", async ({ page }) => {
    await page.goto("/");
    await expect(machineRow(page)).toContainText("connected", { timeout: 30_000 });
    await expect(rowOf(page, THIRD)).toBeVisible({ timeout: 30_000 });
    // By name (#2531): build-box, this core, third-box.
    const local = await rows(page).nth(1).locator("span[title]").getAttribute("title");
    if (local === null) throw new Error("no local machine row");
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local, THIRD]);
    const [up, down] = await moveKeys(page);
    const button = page.getByRole("button", { name: new RegExp(`^${local}\\b`) });
    await button.focus();
    await page.keyboard.press(up);
    await expect.poll(() => order(page)).toEqual([local, MACHINE_NAME, THIRD]);
    await expect(button).toBeFocused();
    await page.keyboard.press(down);
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, local, THIRD]);
    await expect(button).toBeFocused();
    await page.keyboard.press(down);
    await expect.poll(() => order(page)).toEqual([MACHINE_NAME, THIRD, local]);
    await expect(button).toBeFocused();
  });
});

// Pinned tabs and the close sets (#1561): a pinned tab leads its space as its icon alone with no close button, keeps to
// the pinned side when moved, and every device reads the pin from the machine's pins document, which survives herdr-app
// rewriting its layout document; "Close tabs to the right" and
// "Close other tabs" close exactly those tabs and never a pinned one.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "@playwright/test";
import { E2E_HOST_PORT, E2E_TOKEN } from "./config.ts";
import { getCoreDoc, updateCoreDoc } from "./core-doc.ts";
import { expect, test } from "./fixtures.ts";
import { LAYOUT_DOC, PINS_DOC, seedSpaces } from "./layout-doc.ts";
import { hcOn } from "./machine-switch.ts";
import { endOwnTerminals } from "./own-terminals.ts";
import { PHONE } from "./phone-key-bar.ts";

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });

endOwnTerminals();

/** A second device: its own browser context on the same host, as tabs-parity's. */
async function secondDevice(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 800 } });
  const settings = {
    mode: "loopback",
    relayUrl: "wss://relay-doriface.omo.dev",
    directUrl: "",
    hostId: "",
    loopbackUrl: `ws://127.0.0.1:${E2E_HOST_PORT}/v1/hc`,
    token: E2E_TOKEN,
  };
  await context.addInitScript((value) => localStorage.setItem("doriface.connection", value), JSON.stringify(settings));
  return context.newPage();
}
const spaceRow = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Workspace" })
    .getByRole("region", { name: "Spaces" })
    .getByRole("button", { name: new RegExp(`^${name}\\b`) });
/** Drags a tab by the pointer until it sits before another one, as a person drags a tab to the left. */
async function dragBefore(page: Page, from: Locator, before: Locator): Promise<void> {
  const [start, end] = [await from.boundingBox(), await before.boundingBox()];
  if (start === null || end === null) throw new Error("no tab box");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 4, end.y + end.height / 2, { steps: 16 });
  await page.mouse.up();
}
const tabBar = (page: Page) => page.getByRole("tablist", { name: "Tabs" }).getByRole("tab");
const menu = (page: Page) => page.getByRole("menu");

function shellIn(cwd: string): string {
  const out = hcOn("host", ["run", "--bg", "--cwd", cwd, "--", "env", "PS1=$ ", "sh"]);
  return String((JSON.parse(out) as { address: string }).address);
}

/** One space of four named tabs, each a shell at its prompt (nothing to confirm on close). */
function fourTabs(): void {
  const folder = mkdtempSync(join(tmpdir(), "tab-pins-"));
  seedSpaces([
    {
      id: "spc-pins",
      name: "pins",
      folder,
      tabs: ["one", "two", "three", "four"].map((name) => ({ id: `tb-${name}`, name, terminal: shellIn(folder) })),
    },
  ]);
}

type Saved = { spaces?: { tabs?: Record<string, unknown>[] }[] } | null;

/** The pinned space's tabs in the layout document's order: name, and a star for one the pins document names. */
const saved = (): string[] => {
  const doc = getCoreDoc(LAYOUT_DOC) as Saved;
  const pins = (getCoreDoc(PINS_DOC) as { pinned_tabs?: string[] } | null)?.pinned_tabs ?? [];
  const tabs = doc?.spaces?.[0]?.tabs ?? [];
  return tabs.map((tab) => `${String(tab["name"] ?? "")}${pins.includes(String(tab["id"])) ? "*" : ""}`);
};

/** herdr-app saving its layout (`src/mirror.rs`): every tab rebuilt with only `id`, `name` and `root`. */
const herdrResave = (): void =>
  updateCoreDoc(LAYOUT_DOC, (current) => {
    const doc = current as Saved;
    return {
      spaces: (doc?.spaces ?? []).map((space) =>
        Object.assign({}, space, {
          tabs: (space.tabs ?? []).map((tab) => ({ id: tab["id"], name: tab["name"], root: tab["root"] })),
        }),
      ),
    };
  });

async function fromMenu(page: Page, tab: string, item: string): Promise<void> {
  await tabBar(page).filter({ hasText: tab }).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: item, exact: true }).click();
}

test("a pinned tab leads as its icon alone, with no close button, and another page reads the pin", async ({
  page,
  browser,
}) => {
  fourTabs();
  await page.goto("/");
  await expect(tabBar(page)).toHaveText(["one", "two", "three", "four"], { timeout: 20_000 });
  await fromMenu(page, "three", "Pin tab");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["three*", "one", "two", "four"]);
  const pinned = tabBar(page).first();
  await expect(pinned).toHaveAttribute("data-pinned", "");
  await expect(pinned).toHaveAccessibleName(/three/);
  await expect(pinned).toHaveAttribute("title", "three");
  await pinned.click();
  await expect(page.getByRole("button", { name: "Close three" })).toHaveCount(0);
  // The layout document never holds the pin, so herdr-app saving it leaves the tab pinned (#1621 review).
  expect(JSON.stringify(getCoreDoc(LAYOUT_DOC))).not.toContain("pinned");
  herdrResave();
  expect(saved()).toEqual(["three*", "one", "two", "four"]);

  const other = await secondDevice(browser);
  try {
    await other.goto("/");
    await spaceRow(other, "pins").click({ timeout: 20_000 });
    await expect(tabBar(other).first()).toHaveAttribute("data-pinned", "", { timeout: 20_000 });
    await expect(tabBar(other)).toHaveText(["three", "one", "two", "four"]);
  } finally {
    await other.context().close();
  }

  await fromMenu(page, "three", "Unpin tab");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["three", "one", "two", "four"]);
});

test("a pinned tab keeps its size selected or not (#1621 review)", async ({ page }) => {
  fourTabs();
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(4, { timeout: 20_000 });
  await fromMenu(page, "two", "Pin tab");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["two*", "one", "three", "four"]);
  const item = page.locator("[data-tab-id]").first();
  await tabBar(page).nth(1).click();
  await expect(tabBar(page).first()).toHaveAttribute("aria-selected", "false");
  const rest = await item.boundingBox();
  await tabBar(page).first().click();
  await expect(tabBar(page).first()).toHaveAttribute("aria-selected", "true");
  const selected = await item.boundingBox();
  expect(selected?.width).toBe(rest?.width);
  expect(selected?.height).toBe(rest?.height);
});

test("pinned tabs stay in view in a group of their own while the other tabs scroll (#1621 review)", async ({
  page,
}) => {
  const folder = mkdtempSync(join(tmpdir(), "tab-pins-"));
  const names = Array.from({ length: 12 }, (_unused, at) => `ordinary tab ${String(at + 1).padStart(2, "0")} long`);
  seedSpaces([
    {
      id: "spc-pins",
      name: "pins",
      folder,
      tabs: names.map((name, at) => ({ id: `tb-${at}`, name, terminal: shellIn(folder) })),
    },
  ]);
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(12, { timeout: 20_000 });
  // Pinning moves the tab into the pinned group, a DOM move that must not replay its arrival: the box measured below
  // would be a frame of that scale-in, not where the tab rests (#2013).
  await page.evaluate(() => {
    const ran: string[] = [];
    Object.defineProperty(window, "__tabTransitions", { value: ran });
    document.addEventListener(
      "transitionrun",
      (event) => {
        const tab = event.target instanceof HTMLElement ? event.target.dataset["tabId"] : undefined;
        if (tab !== undefined) ran.push(`${tab}:${event.propertyName}`);
      },
      true,
    );
  });
  await fromMenu(page, "tab 01", "Pin tab");
  await expect(tabBar(page).first()).toHaveAttribute("data-pinned", "", { timeout: 15_000 });
  const pinned = page.locator("[data-tab-id]").first();
  // Two frames let a transition the pin started dispatch its transitionrun.
  const ran = await page.evaluate(
    () =>
      new Promise<unknown>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(Reflect.get(window, "__tabTransitions")))),
      ),
  );
  expect(ran).toEqual([]);
  const before = await pinned.boundingBox();
  // Selecting the last tab scrolls the ordinary tabs to it.
  await tabBar(page).last().click();
  await expect(tabBar(page).last()).toHaveAttribute("aria-selected", "true");
  const geometry = await page.evaluate(() => {
    const items = [...document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Tabs"] [data-tab-id]')];
    const [first] = items;
    // The element each of the first and last tabs scrolls in, if any.
    const [pinnedScroller, lastScroller] = [first, items.at(-1)].map((item) => {
      let node = item?.parentElement ?? null;
      while (node !== null && !/^(auto|scroll)$/.test(getComputedStyle(node).overflowX)) node = node.parentElement;
      return node;
    });
    const box = first?.getBoundingClientRect();
    const hit = box === undefined ? null : document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      // The pinned group scrolls on its own only past half the strip (#1916), never with the other tabs.
      pinnedScrolls: pinnedScroller !== null && pinnedScroller === lastScroller,
      othersScrolled: (lastScroller?.scrollLeft ?? 0) > 0,
      pinnedOnTop: hit !== null && first?.contains(hit) === true,
    };
  });
  expect(geometry).toEqual({ pinnedScrolls: false, othersScrolled: true, pinnedOnTop: true });
  expect(await pinned.boundingBox()).toEqual(before);
});

test("a move keeps a tab on its side of the pinned ones", async ({ page }) => {
  fourTabs();
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(4, { timeout: 20_000 });
  await fromMenu(page, "two", "Pin tab");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["two*", "one", "three", "four"]);
  await tabBar(page).filter({ hasText: "one" }).click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Move tab left" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await tabBar(page).first().click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Move tab right" })).toBeDisabled();
});

test("Close tabs to the right closes the tabs after it, and a pinned tab before it stays", async ({ page }) => {
  fourTabs();
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(4, { timeout: 20_000 });
  await fromMenu(page, "four", "Pin tab");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["four*", "one", "two", "three"]);
  await fromMenu(page, "one", "Close tabs to the right");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["four*", "one"]);
  await expect(tabBar(page)).toHaveText(["four", "one"]);
});

test("Close other tabs closes every other tab but the pinned one, and has nothing to close then", async ({ page }) => {
  fourTabs();
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(4, { timeout: 20_000 });
  await fromMenu(page, "one", "Pin tab");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["one*", "two", "three", "four"]);
  await fromMenu(page, "three", "Close other tabs");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["one*", "three"]);
  await tabBar(page).filter({ hasText: "three" }).click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Close other tabs" })).toBeDisabled();
  await expect(menu(page).getByRole("menuitem", { name: "Close tabs to the right" })).toBeDisabled();
});

test("dragging reorders pinned tabs among themselves, and an unpinned tab stops behind them, on every device", async ({
  page,
  browser,
}) => {
  fourTabs();
  await page.goto("/");
  await expect(tabBar(page)).toHaveCount(4, { timeout: 20_000 });
  await fromMenu(page, "one", "Pin tab");
  await fromMenu(page, "two", "Pin tab");
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["one*", "two*", "three", "four"]);

  await dragBefore(page, tabBar(page).nth(1), tabBar(page).nth(0));
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["two*", "one*", "three", "four"]);

  await dragBefore(page, tabBar(page).nth(3), tabBar(page).nth(0));
  await expect.poll(saved, { timeout: 15_000 }).toEqual(["two*", "one*", "four", "three"]);

  const other = await secondDevice(browser);
  try {
    await other.goto("/");
    await spaceRow(other, "pins").click({ timeout: 20_000 });
    await expect(tabBar(other)).toHaveText(["two", "one", "four", "three"], { timeout: 20_000 });
  } finally {
    await other.context().close();
  }
});

test.describe("phone", () => {
  test.use(PHONE);

  test("the space's tab sheet marks a pinned tab and lists it first", async ({ page }) => {
    fourTabs();
    const folder = mkdtempSync(join(tmpdir(), "tab-pins-phone-"));
    seedSpaces([
      {
        id: "spc-pins",
        name: "pins",
        folder,
        tabs: [
          { id: "tb-p", name: "pinned-one", terminal: shellIn(folder), pinned: true },
          { id: "tb-q", name: "plain-two", terminal: shellIn(folder) },
        ],
      },
    ]);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible({ timeout: 20_000 });
    // The phone lists spaces on their own Spaces tab (#1398).
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Spaces", exact: true })
      .click();
    await page
      .getByRole("button", { name: /^pins\b/ })
      .first()
      .click();
    const sheetRows = page.getByRole("button", { name: /pinned-one|plain-two/ });
    await expect(sheetRows.first()).toContainText("pinned-one", { timeout: 15_000 });
    await expect(page.getByRole("img", { name: "Pinned" }).first()).toBeVisible();
  });
});
